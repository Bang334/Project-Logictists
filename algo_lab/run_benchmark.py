"""Fair CLI benchmark for TMS routing algorithms.

Every returned solution is independently re-scheduled and checked by the same
contract, time-window and production spatial validators before ranking.
"""

import argparse
import math
import os
import random
import sys
import time
from dataclasses import dataclass
from typing import Callable, List, Sequence

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.alns_solver import solve_alns
from algo_lab.algorithms.genetic_solver import solve_genetic
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.algorithms.ortools_adapter import solve_ortools
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.models import OptimizationSolution
from algo_lab.common.solution_validator import SolutionAudit, audit_solution


@dataclass
class BenchmarkRun:
    solution: OptimizationSolution
    audit: SolutionAudit
    seed: int


def _parse_seeds(raw: str) -> List[int]:
    try:
        seeds = [int(value.strip()) for value in raw.split(",") if value.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--seeds phải là danh sách số nguyên") from exc
    if not seeds:
        raise argparse.ArgumentTypeError("--seeds không được rỗng")
    return seeds


def _validity_label(audit: SolutionAudit) -> str:
    if audit.is_valid:
        return "PASS"
    failed = []
    if not audit.is_contract_valid:
        failed.append("CONTRACT")
    if not audit.is_temporally_valid:
        failed.append("TIME")
    if not audit.is_spatial_valid:
        failed.append("SPACE")
    return "FAIL:" + "+".join(failed)


def _print_header() -> None:
    print("=" * 136)
    print(
        f"{'THUẬT TOÁN':<34} | {'SEED':>4} | {'WALL TIME':>9} | {'XE':>3} | "
        f"{'ĐƠN':>11} | {'KM':>9} | {'CHI PHÍ':>14} | {'MỤC TIÊU':>14} | {'VALIDATOR':<20}"
    )
    print("=" * 136)


def _print_row(run: BenchmarkRun) -> None:
    solution = run.solution
    audit = run.audit
    served = f"{audit.served_order_count}/{audit.total_order_count}"
    print(
        f"{solution.solver_name[:34]:<34} | {run.seed:>4} | "
        f"{solution.execution_time_sec:>8.2f}s | {len(solution.routes):>3} | "
        f"{served:>11} | {solution.total_distance_km:>8.1f} | "
        f"{solution.real_economic_cost_vnd:>12,d}đ | "
        f"{solution.penalized_objective_vnd:>12,d}đ | {_validity_label(audit):<20}"
    )


def _run_and_audit(
    solver: Callable[[], OptimizationSolution],
    seed: int,
    dataset_args: Sequence,
    spatial_time_limit_sec: float,
) -> BenchmarkRun:
    random.seed(seed)
    started_at = time.perf_counter()
    solution = solver()
    if not solution.solution_audited:
        audit = audit_solution(
            solution,
            *dataset_args,
            spatial_time_limit_sec=spatial_time_limit_sec,
        )
    else:
        audit = SolutionAudit(
            is_valid=(
                solution.is_contract_valid
                and solution.is_temporally_valid
                and solution.is_spatial_valid
            ),
            is_contract_valid=solution.is_contract_valid,
            is_temporally_valid=solution.is_temporally_valid,
            is_spatial_valid=solution.is_spatial_valid,
            served_order_count=round(
                solution.fulfillment_rate * len(dataset_args[2]) / 100.0
            ),
            total_order_count=len(dataset_args[2]),
            issues=list(solution.validation_notes),
        )
    solution.execution_time_sec = round(time.perf_counter() - started_at, 3)
    solution.random_seed = seed
    return BenchmarkRun(solution=solution, audit=audit, seed=seed)


def _ranking_key(run: BenchmarkRun):
    return (
        -run.audit.served_order_count,
        run.solution.penalized_objective_vnd,
        run.solution.execution_time_sec,
    )


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Benchmark thuật toán TMS có validator độc lập")
    parser.add_argument(
        "--dataset",
        default=os.path.join(os.path.dirname(__file__), "datasets", "hanoi_11_orders.json"),
    )
    parser.add_argument("--time-limit", type=float, default=3.0)
    parser.add_argument("--spatial-time-limit", type=float, default=1.5)
    parser.add_argument("--seeds", type=_parse_seeds, default=[0])
    args = parser.parse_args()
    if args.time_limit <= 0 or args.spatial_time_limit <= 0:
        parser.error("Các time limit phải lớn hơn 0")
    if not os.path.exists(args.dataset):
        parser.error(f"Không tìm thấy dataset: {args.dataset}")

    dataset_args = load_dataset(args.dataset)
    vehicles, drivers, orders, policy, dist, dur, node_map = dataset_args
    print("\n" + "#" * 136)
    print("TMS ALGORITHM LAB — INDEPENDENTLY VALIDATED BENCHMARK")
    print(f"Dataset: {os.path.basename(args.dataset)}")
    print(
        f"Quy mô: {len(orders)} đơn | {sum(len(order.items) for order in orders)} kiện | "
        f"{len(vehicles)} xe | seeds={args.seeds}"
    )
    print("#" * 136 + "\n")

    stochastic_solvers = [
        (
            "Genetic Algorithm",
            lambda seed: solve_genetic(
                vehicles, drivers, orders, policy, dist, dur, node_map,
                time_limit_sec=args.time_limit,
                random_seed=seed,
            ),
        ),
        (
            "ALNS cũ",
            lambda seed: solve_alns(
                vehicles, drivers, orders, policy, dist, dur, node_map,
                time_limit_sec=args.time_limit,
                random_seed=seed,
            ),
        ),
        (
            "Hybrid ALNS",
            lambda seed: solve_hybrid_alns(
                vehicles, drivers, orders, policy, dist, dur, node_map,
                time_limit_sec=args.time_limit,
                random_seed=seed,
            ),
        ),
    ]
    deterministic_solvers = [
        (
            "Greedy Insertion",
            lambda: solve_greedy(vehicles, drivers, orders, policy, dist, dur, node_map),
        ),
        (
            "OR-Tools GLS baseline",
            lambda: solve_ortools(
                vehicles, drivers, orders, policy, dist, dur, node_map,
                max_time_seconds=max(1, int(math.ceil(args.time_limit))),
            ),
        ),
    ]

    runs: List[BenchmarkRun] = []
    for label, solver_factory in stochastic_solvers:
        for seed in args.seeds:
            print(f"Đang chạy {label}, seed={seed}...", flush=True)
            runs.append(
                _run_and_audit(
                    lambda seed=seed, factory=solver_factory: factory(seed),
                    seed,
                    dataset_args,
                    args.spatial_time_limit,
                )
            )
    for label, solver in deterministic_solvers:
        seed = args.seeds[0]
        print(f"Đang chạy {label}...", flush=True)
        runs.append(
            _run_and_audit(solver, seed, dataset_args, args.spatial_time_limit)
        )

    print()
    _print_header()
    for run in runs:
        _print_row(run)
    print("=" * 136)

    valid_runs = [run for run in runs if run.audit.is_valid]
    print("\nKẾT LUẬN TỪ DỮ LIỆU CHẠY:")
    if valid_runs:
        champion = min(valid_runs, key=_ranking_key)
        print(
            f"- Best-found hợp lệ: {champion.solution.solver_name}, seed={champion.seed}, "
            f"phục vụ {champion.audit.served_order_count}/{champion.audit.total_order_count} đơn, "
            f"mục tiêu {champion.solution.penalized_objective_vnd:,}đ."
        )
        print("- Đây là best-found trong ngân sách chạy, không phải chứng minh tối ưu toàn cục.")
    else:
        print("- Không có nghiệm nào vượt qua toàn bộ validator; không công bố thuật toán thắng.")

    invalid_runs = [run for run in runs if not run.audit.is_valid]
    for run in invalid_runs:
        reason = run.audit.issues[0] if run.audit.issues else "Không rõ nguyên nhân"
        print(f"- Loại {run.solution.solver_name} seed={run.seed}: {reason}")


if __name__ == "__main__":
    main()
