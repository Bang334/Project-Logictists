"""Select Hybrid/Standard ALNS and isolate only the cases Hybrid loses.

The first pass compares both ALNS variants with the four reliable challengers
from the 10-algorithm selection benchmark.  It writes an exact dataset/seed
weak-case manifest.  Later improvement rounds can pass that manifest through
``--weak-from`` so already-won cases are not rerun.
"""

import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.advanced_metaheuristics import (
    solve_grasp,
    solve_memetic,
    solve_simulated_annealing,
    solve_vns,
)
from algo_lab.algorithms.alns_solver import solve_alns
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import repair_and_audit_solution
from algo_lab.run_parallel_benchmark import DATASETS, _parse_seeds


STANDARD_ALNS_NAME = "Standard ALNS"
HYBRID_ALNS_NAME = "Hybrid ALNS"
ALGORITHM_NAMES = [
    STANDARD_ALNS_NAME,
    HYBRID_ALNS_NAME,
    "Packing-aware VNS",
    "Packing-aware Simulated Annealing",
    "Packing-aware GRASP",
    "Packing-aware Memetic Search",
]


def _is_full_valid(row: Dict[str, Any]) -> bool:
    return row["audit"] == "PASS" and row["served"] == row["orders"]


def _run_dataset(
    dataset_index: int,
    label: str,
    filename: str,
    budget: float,
    spatial_budget: float,
    repair_budget: float,
    seeds: Sequence[int],
) -> Dict[str, Any]:
    dataset_path = os.path.join(project_root, "algo_lab", "datasets", filename)
    args = load_dataset(dataset_path)
    vehicles, drivers, orders, policy, dist, dur, node_map = args
    shared_initial = solve_greedy(*args)
    rows: List[Dict[str, Any]] = []

    def ensure_audited(solution):
        if not (
            solution.solution_audited
            and solution.is_contract_valid
            and solution.is_temporally_valid
            and solution.is_spatial_valid
        ):
            repair_and_audit_solution(
                solution,
                *args,
                spatial_time_limit_sec=spatial_budget,
                repair_time_limit_sec=repair_budget,
            )
        return solution

    for seed in seeds:
        common = {
            "time_limit_sec": budget,
            "random_seed": seed,
            "final_spatial_time_limit_sec": spatial_budget,
            "initial_solution": shared_initial,
        }
        audited_common = dict(
            common,
            final_repair_time_limit_sec=repair_budget,
        )
        runners = [
            (STANDARD_ALNS_NAME, lambda common=common: solve_alns(*args, **common)),
            (
                HYBRID_ALNS_NAME,
                lambda kwargs=audited_common: solve_hybrid_alns(*args, **kwargs),
            ),
            ("Packing-aware VNS", lambda kwargs=audited_common: solve_vns(*args, **kwargs)),
            (
                "Packing-aware Simulated Annealing",
                lambda kwargs=audited_common: solve_simulated_annealing(*args, **kwargs),
            ),
            ("Packing-aware GRASP", lambda kwargs=audited_common: solve_grasp(*args, **kwargs)),
            (
                "Packing-aware Memetic Search",
                lambda kwargs=audited_common: solve_memetic(*args, **kwargs),
            ),
        ]
        for algorithm, runner in runners:
            started_at = time.perf_counter()
            try:
                solution = ensure_audited(runner())
                valid = bool(
                    solution.is_contract_valid
                    and solution.is_temporally_valid
                    and solution.is_spatial_valid
                )
                served = round(len(orders) * solution.fulfillment_rate / 100.0)
                rows.append(
                    {
                        "dataset": label,
                        "file": filename,
                        "algorithm": algorithm,
                        "solver_name": solution.solver_name,
                        "seed": seed,
                        "time_sec": round(time.perf_counter() - started_at, 3),
                        "vehicles": len(solution.routes),
                        "served": served,
                        "orders": len(orders),
                        "cost_vnd": solution.real_economic_cost_vnd,
                        "distance_km": solution.total_distance_km,
                        "audit": "PASS" if valid else "FAIL",
                        "issues": list(solution.validation_notes),
                    }
                )
            except Exception as error:
                rows.append(
                    {
                        "dataset": label,
                        "file": filename,
                        "algorithm": algorithm,
                        "solver_name": algorithm,
                        "seed": seed,
                        "time_sec": round(time.perf_counter() - started_at, 3),
                        "vehicles": 0,
                        "served": 0,
                        "orders": len(orders),
                        "cost_vnd": 0,
                        "distance_km": 0.0,
                        "audit": "ERROR",
                        "issues": [f"{type(error).__name__}: {error}"],
                    }
                )
    return {
        "dataset_index": dataset_index,
        "dataset": label,
        "file": filename,
        "rows": rows,
    }


def _aggregate(results: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries = {
        name: {
            "algorithm": name,
            "runs": 0,
            "full_valid": 0,
            "wins": 0,
            "gaps": [],
            "times": [],
        }
        for name in ALGORITHM_NAMES
    }
    for result in results:
        seeds = sorted({int(row["seed"]) for row in result["rows"]})
        for seed in seeds:
            case_rows = [row for row in result["rows"] if row["seed"] == seed]
            valid_rows = [row for row in case_rows if _is_full_valid(row)]
            best_cost = min(
                (row["cost_vnd"] for row in valid_rows),
                default=None,
            )
            for row in case_rows:
                summary = summaries[row["algorithm"]]
                summary["runs"] += 1
                summary["times"].append(row["time_sec"])
                if not _is_full_valid(row):
                    continue
                summary["full_valid"] += 1
                if best_cost is not None and best_cost > 0:
                    gap = (row["cost_vnd"] - best_cost) / best_cost * 100.0
                    summary["gaps"].append(gap)
                    summary["wins"] += int(row["cost_vnd"] == best_cost)

    aggregate = []
    for summary in summaries.values():
        gaps = summary.pop("gaps")
        times = summary.pop("times")
        summary["mean_gap_percent"] = statistics.fmean(gaps) if gaps else None
        summary["gap_stdev_percent"] = (
            statistics.pstdev(gaps) if len(gaps) > 1 else 0.0 if gaps else None
        )
        summary["median_time_sec"] = statistics.median(times) if times else 0.0
        aggregate.append(summary)
    return sorted(
        aggregate,
        key=lambda row: (
            -row["full_valid"],
            row["mean_gap_percent"]
            if row["mean_gap_percent"] is not None
            else float("inf"),
            row["median_time_sec"],
        ),
    )


def _identify_weak_cases(
    results: Sequence[Dict[str, Any]],
    primary: str = HYBRID_ALNS_NAME,
) -> List[Dict[str, Any]]:
    weak: List[Dict[str, Any]] = []
    for result in results:
        seeds = sorted({int(row["seed"]) for row in result["rows"]})
        for seed in seeds:
            case_rows = [row for row in result["rows"] if row["seed"] == seed]
            primary_row = next(
                (row for row in case_rows if row["algorithm"] == primary),
                None,
            )
            valid_competitors = [
                row
                for row in case_rows
                if row["algorithm"] != primary and _is_full_valid(row)
            ]
            best = (
                min(valid_competitors, key=lambda row: row["cost_vnd"])
                if valid_competitors
                else None
            )
            if primary_row is None or not _is_full_valid(primary_row):
                weak.append(
                    {
                        "dataset": result["dataset"],
                        "file": result["file"],
                        "seed": seed,
                        "reason": "PRIMARY_NOT_FULL_VALID",
                        "primary_audit": primary_row["audit"] if primary_row else "MISSING",
                        "primary_served": primary_row["served"] if primary_row else 0,
                        "orders": primary_row["orders"] if primary_row else None,
                        "issues": primary_row.get("issues", []) if primary_row else ["Missing result"],
                        "best_competitor": best["algorithm"] if best else None,
                        "best_cost_vnd": best["cost_vnd"] if best else None,
                        "best_vehicles": best.get("vehicles") if best else None,
                        "cost_gap_percent": None,
                        "focus": "VALIDATION_OR_REPAIR",
                    }
                )
                continue
            if best is None:
                continue
            if primary_row["cost_vnd"] <= best["cost_vnd"]:
                continue
            gap = (
                (primary_row["cost_vnd"] - best["cost_vnd"])
                / best["cost_vnd"]
                * 100.0
            )
            primary_vehicles = primary_row.get("vehicles")
            best_vehicles = best.get("vehicles")
            if (
                primary_vehicles is not None
                and best_vehicles is not None
                and primary_vehicles > best_vehicles
            ):
                focus = "FLEET_CONSOLIDATION_OR_VEHICLE_SELECTION"
            elif primary_vehicles == best_vehicles:
                focus = "ROUTE_SEQUENCE_OR_ORDER_ASSIGNMENT"
            else:
                focus = "ROUTE_DISTANCE_OR_VEHICLE_COST"
            weak.append(
                {
                    "dataset": result["dataset"],
                    "file": result["file"],
                    "seed": seed,
                    "reason": "HIGHER_COST",
                    "primary_audit": primary_row["audit"],
                    "primary_served": primary_row["served"],
                    "orders": primary_row["orders"],
                    "primary_cost_vnd": primary_row["cost_vnd"],
                    "primary_vehicles": primary_vehicles,
                    "best_competitor": best["algorithm"],
                    "best_cost_vnd": best["cost_vnd"],
                    "best_vehicles": best_vehicles,
                    "cost_gap_percent": round(gap, 2),
                    "issues": primary_row.get("issues", []),
                    "focus": focus,
                }
            )
    return weak


def _load_weak_case_seeds(path: Path) -> Dict[str, List[int]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Weak-case manifest phải là JSON array")
    known_files = {filename for _label, filename in DATASETS}
    selected: Dict[str, List[int]] = {}
    for row in payload:
        if not isinstance(row, dict) or "file" not in row or "seed" not in row:
            raise ValueError("Mỗi weak case phải có file và seed")
        filename = str(row["file"])
        if filename not in known_files:
            raise ValueError(f"Dataset không hợp lệ trong weak manifest: {filename}")
        selected.setdefault(filename, []).append(int(row["seed"]))
    return {
        filename: sorted(set(seeds))
        for filename, seeds in sorted(selected.items())
    }


def _money(value: int) -> str:
    return f"{value:,}".replace(",", ".") + " đ"


def _markdown(
    results: Sequence[Dict[str, Any]],
    aggregate: Sequence[Dict[str, Any]],
    weak_cases: Sequence[Dict[str, Any]],
    budget: float,
    wall_time: float,
) -> str:
    lines = [
        "# Tuyển chọn Hybrid ALNS và phát hiện case yếu",
        "",
        f"Budget: `{budget:.1f}s`; wall time: `{wall_time:.2f}s`.",
        "Xếp hạng ưu tiên đủ đơn + PASS trước, sau đó mới xét gap chi phí.",
        "",
        "## Tổng hợp",
        "",
        "| Hạng | Thuật toán | Đủ đơn + PASS | Gap TB ± σ | Trung vị thời gian | Thắng |",
        "|---:|---|---:|---:|---:|---:|",
    ]
    for rank, row in enumerate(aggregate, start=1):
        gap = (
            f"{row['mean_gap_percent']:.2f}% ± {row['gap_stdev_percent']:.2f}%"
            if row["mean_gap_percent"] is not None
            else "—"
        )
        lines.append(
            f"| {rank} | {row['algorithm']} | {row['full_valid']}/{row['runs']} | "
            f"{gap} | {row['median_time_sec']:.2f}s | {row['wins']} |"
        )
    lines.extend(
        [
            "",
            "## Case Hybrid ALNS cần cải thiện",
            "",
            "| Dataset | Seed | Lý do | Trọng tâm chẩn đoán | Đối thủ tốt nhất | Gap |",
            "|---|---:|---|---|---|---:|",
        ]
    )
    for row in weak_cases:
        gap = (
            f"{row['cost_gap_percent']:.2f}%"
            if row["cost_gap_percent"] is not None
            else "—"
        )
        lines.append(
            f"| {row['dataset']} | {row['seed']} | {row['reason']} | "
            f"{row['focus']} | {row['best_competitor'] or '—'} | {gap} |"
        )
    lines.extend(
        [
            "",
            "## Chi tiết",
            "",
            "| Dataset | Seed | Thuật toán | Xe | Giao | Chi phí | Thời gian | Audit |",
            "|---|---:|---|---:|---:|---:|---:|:---:|",
        ]
    )
    for result in results:
        for row in result["rows"]:
            cost = _money(row["cost_vnd"]) if _is_full_valid(row) else "—"
            lines.append(
                f"| {row['dataset']} | {row['seed']} | {row['algorithm']} | "
                f"{row['vehicles']} | {row['served']}/{row['orders']} | {cost} | "
                f"{row['time_sec']:.2f}s | {row['audit']} |"
            )
    return "\n".join(lines) + "\n"


def _select_datasets(raw: str) -> List[Tuple[str, str]]:
    if raw.strip().lower() == "all":
        return list(DATASETS)
    requested = [token.strip() for token in raw.split(",") if token.strip()]
    selected = [row for row in DATASETS if row[1] in requested]
    missing = sorted(set(requested) - {row[1] for row in selected})
    if missing:
        raise ValueError("Dataset không hợp lệ: " + ", ".join(missing))
    return selected


def main() -> None:
    if sys.platform.startswith("win"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=10.0)
    parser.add_argument("--spatial-audit-budget", type=float, default=5.0)
    parser.add_argument("--repair-budget", type=float, default=8.0)
    parser.add_argument("--seeds", type=_parse_seeds, default=[0, 1, 2])
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--datasets", default="all")
    parser.add_argument(
        "--weak-from",
        type=Path,
        help="Manifest alns_weak_cases.json để chỉ chạy lại đúng dataset/seed thua",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join(project_root, "algo_lab", "results"),
    )
    args = parser.parse_args()
    if min(args.budget, args.spatial_audit_budget, args.repair_budget) <= 0:
        parser.error("Các budget phải lớn hơn zero")
    if args.workers <= 0:
        parser.error("--workers must be greater than zero")

    if args.weak_from:
        try:
            seed_map = _load_weak_case_seeds(args.weak_from)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            parser.error(str(error))
        selected = [row for row in DATASETS if row[1] in seed_map]
        if not selected:
            parser.error("Weak-case manifest không có case nào để chạy lại")
        prefix = "alns_weak_recheck"
    else:
        try:
            selected = _select_datasets(args.datasets)
        except ValueError as error:
            parser.error(str(error))
        if not selected:
            parser.error("Phải chọn ít nhất một dataset")
        seed_map = {filename: list(args.seeds) for _label, filename in selected}
        prefix = "alns_selection"

    started_at = time.perf_counter()
    completed: List[Dict[str, Any]] = []
    max_workers = min(args.workers, len(selected))
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                _run_dataset,
                index,
                label,
                filename,
                args.budget,
                args.spatial_audit_budget,
                args.repair_budget,
                seed_map[filename],
            ): label
            for index, (label, filename) in enumerate(selected)
        }
        for future in as_completed(futures):
            result = future.result()
            completed.append(result)
            full_valid = sum(_is_full_valid(row) for row in result["rows"])
            print(
                f"[{len(completed)}/{len(selected)}] {result['dataset']}: "
                f"{full_valid}/{len(result['rows'])} đủ đơn + PASS",
                flush=True,
            )

    completed.sort(key=lambda row: row["dataset_index"])
    aggregate = _aggregate(completed)
    weak_cases = _identify_weak_cases(completed)
    wall_time = time.perf_counter() - started_at
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    markdown_path = output_dir / f"{prefix}.md"
    json_path = output_dir / f"{prefix}.json"
    weak_path = output_dir / "alns_weak_cases.json"
    markdown_path.write_text(
        _markdown(completed, aggregate, weak_cases, args.budget, wall_time),
        encoding="utf-8",
    )
    json_path.write_text(
        json.dumps(
            {
                "config": {
                    "algorithms": ALGORITHM_NAMES,
                    "budget_sec": args.budget,
                    "spatial_audit_budget_sec": args.spatial_audit_budget,
                    "repair_budget_sec": args.repair_budget,
                    "workers": max_workers,
                    "wall_time_sec": round(wall_time, 3),
                },
                "datasets": completed,
                "ranking": aggregate,
                "weak_cases": weak_cases,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    weak_path.write_text(
        json.dumps(weak_cases, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Markdown: {markdown_path}")
    print(f"JSON: {json_path}")
    print(f"Weak cases: {weak_path} ({len(weak_cases)} cases)")


if __name__ == "__main__":
    main()
