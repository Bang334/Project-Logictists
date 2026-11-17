"""Compare the production candidate pipeline with a three-stream ALNS portfolio."""

from __future__ import annotations

import argparse
from hashlib import sha256
from itertools import product
import json
from pathlib import Path
from time import perf_counter

from app.main import optimize_fleet_candidates
from app.models import FleetOptimizationRequest, FleetOptimizationResponse
from app.request_preprocessor import prune_unserviceable_virtual_resources
from benchmarks.algorithm_comparison.benchmark_objective import audited_quality as quality
from benchmarks.algorithm_comparison.daytime_cases import load_daytime_case
from benchmarks.algorithm_comparison.unified_audit import audit_solution
from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer


DEFAULT_CASES = (
    "db_songthan_4_orders.json",
    "scenario_1_multi_item.json",
    "scenario_4_tight_windows.json",
    "scenario_6_dynamic_reuse.json",
    "scenario_8_dense_fragmentation.json",
    "db_hanoi_16_orders.json",
)


def source_fingerprint() -> str:
    optimizer_dir = Path(__file__).resolve().parents[2]
    sources = [
        *(optimizer_dir / "app").rglob("*.py"),
        *(optimizer_dir / "benchmarks" / "algorithm_comparison").glob("*.py"),
        *Path(__file__).resolve().parent.glob("*.py"),
    ]
    digest = sha256()
    for source in sorted(sources):
        digest.update(source.relative_to(optimizer_dir).as_posix().encode())
        digest.update(b"\0")
        digest.update(sha256(source.read_bytes()).digest())
    return digest.hexdigest()


def production(request: FleetOptimizationRequest) -> FleetOptimizationResponse:
    batch = optimize_fleet_candidates(request)
    if batch.candidates:
        return min(batch.candidates, key=lambda candidate: candidate.rank).result
    return FleetOptimizationResponse(
        job_id=request.job_id, status="PARTIAL", diagnostics=batch.diagnostics
    )


def savings_hybrid(
    request: FleetOptimizationRequest, budget: int, seed: int = 0,
    *, cache_load_cycles: bool = True, stop_at_budget: bool = False,
) -> tuple[FleetOptimizationResponse, dict]:
    deadline = perf_counter() + budget
    pruned, _ = prune_unserviceable_virtual_resources(request)
    optimizer = VariantHybridALNSOptimizer(
        pruned,
        time_budget_seconds=budget,
        random_seed=seed,
        include_benchmarks=False,
        cache_load_cycles=cache_load_cycles,
        audit_request=request,
        stop_at_budget=stop_at_budget,
    )
    plan = optimizer.solve(hard_deadline=deadline)
    seed_meta = optimizer._seed_meta
    details = {
        "cache_load_cycles": cache_load_cycles,
        "stop_at_budget": stop_at_budget,
        "savings_seconds": round(float(seed_meta.get("seed_seconds", 0.0)), 4),
        "savings_routes": int(seed_meta.get("seed_routes", 0)),
        "seed_strategy": seed_meta.get("seed_strategy"),
        "seed_served_orders": int(seed_meta.get("seed_served_orders", 0)),
        "portfolio_streams": list(seed_meta.get("portfolio_streams", ())),
        "winner_stream": seed_meta.get("winner_stream"),
        "stream_metrics": seed_meta.get("stream_metrics", {}),
        "worker_errors": seed_meta.get("worker_errors", []),
        "alns_requested_seconds": round(float(budget), 4),
    }
    return plan, details


def measure(
    case: str, request: FleetOptimizationRequest, budget: int, algorithm: str, seed: int = 0,
    *, cache_load_cycles: bool = True, stop_at_budget: bool = False,
) -> dict:
    started = perf_counter()
    if algorithm == "production":
        plan, details = production(request), {}
    else:
        plan, details = savings_hybrid(
            request, budget, seed,
            cache_load_cycles=cache_load_cycles, stop_at_budget=stop_at_budget,
        )
    elapsed = perf_counter() - started
    return {
        "case": case, "algorithm": algorithm, "seed": seed, "budget": budget,
        "wall_seconds": round(elapsed, 4), "over_budget": elapsed > budget,
        "solver_status": plan.status, **details,
        **audit_solution(request, plan, is_raw_hybrid=False),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget", type=int, default=5, choices=range(2, 121),
                        metavar="SECONDS")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--seeds", type=int, nargs="+", default=[0],
                        help="Portfolio seeds; production retains its configured seeds.")
    parser.add_argument("--cache-load-cycles", action=argparse.BooleanOptionalAction, default=True,
                        help="Reuse certified empty-to-empty loading cycles in the portfolio.")
    parser.add_argument("--stop-at-budget", action="store_true",
                        help="Stop portfolio workers at the deadline and keep published audited plans.")
    parser.add_argument("--cases", nargs="+", default=DEFAULT_CASES)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if any(seed < 0 for seed in args.seeds) or len(set(args.seeds)) != len(args.seeds):
        parser.error("--seeds must contain distinct nonnegative integers")

    results = []
    startup_source_sha256 = source_fingerprint()
    for case in args.cases:
        request = type_request(case, args.budget)
        fingerprint = sha256(request.model_dump_json().encode()).hexdigest()
        for trial_index, (seed, repeat) in enumerate(product(args.seeds, range(args.repeats))):
            engines = ("production", "savings_hybrid")
            if trial_index % 2:
                engines = engines[::-1]
            rows = {
                engine: measure(case, request.model_copy(deep=True), args.budget, engine,
                                seed=seed if engine == "savings_hybrid" else 0,
                                cache_load_cycles=args.cache_load_cycles,
                                stop_at_budget=args.stop_at_budget)
                for engine in engines
            }
            baseline = rows["production"]
            candidate = rows["savings_hybrid"]
            baseline_quality, candidate_quality = quality(baseline), quality(candidate)
            if baseline_quality == candidate_quality:
                winner = "tie" if candidate_quality[0] == 0 else "no_valid_plan"
            else:
                winner = "savings_hybrid" if candidate_quality < baseline_quality else "production"
            print(f"{case} seed {seed} #{repeat + 1}: {winner} | "
                  f"{baseline['served_requests']}/{candidate['served_requests']} orders | "
                  f"{baseline['wall_seconds']:.2f}/{candidate['wall_seconds']:.2f} s", flush=True)
            results.append({
                "repeat": repeat + 1, "request_sha256": fingerprint,
                "startup_source_sha256": startup_source_sha256,
                "source_sha256_at_result": source_fingerprint(),
                "quality_winner": winner, **rows,
            })
            args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")


def type_request(case: str, budget: int) -> FleetOptimizationRequest:
    request = load_daytime_case(case).request
    return request.model_copy(update={"max_time_seconds": budget, "search_time_seconds": budget})


if __name__ == "__main__":
    main()
