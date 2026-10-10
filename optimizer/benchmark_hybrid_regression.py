"""Re-run production Hybrid ALNS against the preserved algo-lab fixtures.

The historical manifest can contain a winner produced by another algorithm.
Those rows are still useful as a best-known quality ceiling, but are never
presented as proof that Hybrid ALNS reproduced the same search process.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import time
from typing import Dict, Iterable, List, Optional, Sequence

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import FleetOptimizationRequest


BENCHMARK_ROOT = Path(__file__).resolve().parent / "benchmarks"
MANIFEST_PATH = BENCHMARK_ROOT / "best_known_results.json"
CASE_ROOT = BENCHMARK_ROOT / "cases"


@dataclass(frozen=True)
class HybridBenchmarkResult:
    file: str
    reference_algorithm: str
    seed: int
    budget_seconds: float
    elapsed_seconds: float
    status: str
    served: int
    orders: int
    routes: int
    cost_vnd: int
    distance_km: float
    production_valid: bool
    cost_comparable: bool
    reference_served: int
    reference_cost_vnd: int
    cost_ratio: Optional[float]
    meets_reference: Optional[bool]


def load_manifest() -> Dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def load_request(file_name: str) -> FleetOptimizationRequest:
    payload = json.loads((CASE_ROOT / file_name).read_text(encoding="utf-8"))
    payload.pop("scenario_profile", None)
    return FleetOptimizationRequest.model_validate(payload)


def run_case(
    reference: Dict[str, object],
    *,
    seed: int,
    budget_seconds: float,
    cost_tolerance_percent: float = 5.0,
) -> HybridBenchmarkResult:
    request = load_request(str(reference["file"]))
    started_at = time.perf_counter()
    response = PackingAwareHybridALNSOptimizer(
        request,
        time_budget_seconds=budget_seconds,
        random_seed=seed,
    ).solve()
    elapsed_seconds = time.perf_counter() - started_at

    served = len(request.orders) - len(response.unassigned_orders)
    production_valid = bool(response.routes) and all(
        route.spatial_validation.is_valid for route in response.routes
    )
    reference_served = int(reference["served"])
    reference_cost = int(reference["cost_vnd"])
    cost_comparable = bool(reference.get("cost_comparable_to_production", True))
    cost_ratio = (
        response.total_cost_vnd / reference_cost
        if served == len(request.orders) and reference_cost > 0
        else None
    )
    allowed_ratio = 1.0 + max(0.0, cost_tolerance_percent) / 100.0
    meets_reference = (
        bool(
            production_valid
            and served >= reference_served
            and cost_ratio is not None
            and cost_ratio <= allowed_ratio
        )
        if cost_comparable
        else None
    )
    return HybridBenchmarkResult(
        file=str(reference["file"]),
        reference_algorithm=str(reference["algorithm"]),
        seed=seed,
        budget_seconds=round(budget_seconds, 3),
        elapsed_seconds=round(elapsed_seconds, 3),
        status=response.status,
        served=served,
        orders=len(request.orders),
        routes=len(response.routes),
        cost_vnd=response.total_cost_vnd,
        distance_km=response.total_distance_km,
        production_valid=production_valid,
        cost_comparable=cost_comparable,
        reference_served=reference_served,
        reference_cost_vnd=reference_cost,
        cost_ratio=round(cost_ratio, 6) if cost_ratio is not None else None,
        meets_reference=meets_reference,
    )


def select_best(results: Iterable[HybridBenchmarkResult]) -> HybridBenchmarkResult:
    return min(
        results,
        key=lambda result: (
            -result.served,
            not result.production_valid,
            result.cost_vnd,
            result.elapsed_seconds,
        ),
    )


def run_benchmark(
    *,
    case_names: Optional[Sequence[str]] = None,
    seeds: Optional[Sequence[int]] = None,
    time_limit_seconds: Optional[float] = None,
    cost_tolerance_percent: float = 5.0,
) -> List[HybridBenchmarkResult]:
    manifest = load_manifest()
    recorded_search_budget = float(manifest["search_budget_sec"])
    requested = set(case_names or [])
    references = [
        reference
        for reference in manifest["cases"]
        if not requested or reference["file"] in requested
    ]
    missing = requested.difference(
        str(reference["file"]) for reference in references
    )
    if missing:
        raise ValueError(
            "Không tìm thấy benchmark case: " + ", ".join(sorted(missing))
        )

    best_results: List[HybridBenchmarkResult] = []
    for reference in references:
        case_seeds = list(seeds) if seeds else [int(reference["seed"])]
        budget = (
            float(time_limit_seconds)
            if time_limit_seconds is not None
            else float(reference.get("search_budget_sec", recorded_search_budget))
        )
        attempts = [
            run_case(
                reference,
                seed=seed,
                budget_seconds=budget,
                cost_tolerance_percent=cost_tolerance_percent,
            )
            for seed in case_seeds
        ]
        best_results.append(select_best(attempts))
    return best_results


def _print_results(results: Sequence[HybridBenchmarkResult]) -> None:
    print(
        "case | seed | served | routes | cost_vnd | reference | ratio | valid | target"
    )
    for result in results:
        ratio = f"{result.cost_ratio:.3f}" if result.cost_ratio is not None else "n/a"
        print(
            f"{result.file} | {result.seed} | {result.served}/{result.orders} | "
            f"{result.routes} | {result.cost_vnd} | {result.reference_cost_vnd} | "
            f"{ratio} | {'PASS' if result.production_valid else 'FAIL'} | "
            f"{'N/A' if result.meets_reference is None else 'PASS' if result.meets_reference else 'REGRESSION'}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", nargs="*", help="Tên file case cần chạy")
    parser.add_argument("--seeds", nargs="*", type=int)
    parser.add_argument("--time-limit", type=float)
    parser.add_argument("--cost-tolerance-percent", type=float, default=5.0)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--fail-on-regression", action="store_true")
    args = parser.parse_args()
    if args.time_limit is not None and args.time_limit <= 0:
        parser.error("--time-limit phải lớn hơn 0")

    results = run_benchmark(
        case_names=args.cases,
        seeds=args.seeds,
        time_limit_seconds=args.time_limit,
        cost_tolerance_percent=args.cost_tolerance_percent,
    )
    _print_results(results)
    if args.json_output is not None:
        args.json_output.write_text(
            json.dumps(
                [asdict(result) for result in results],
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    return int(
        args.fail_on_regression
        and any(result.meets_reference is False for result in results)
    )


if __name__ == "__main__":
    raise SystemExit(main())
