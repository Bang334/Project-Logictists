"""Run production-valid routing algorithms on diverse datasets.

Datasets run concurrently in separate processes. Algorithms within one dataset
run sequentially so they see the same CPU conditions and share no random state.
Every solution is independently audited before it is eligible for PASS or a
per-dataset cost win.
"""

import argparse
import csv
import json
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.advanced_metaheuristics import (
    solve_grasp,
    solve_ils,
    solve_late_acceptance,
    solve_memetic,
    solve_simulated_annealing,
    solve_tabu,
    solve_vns,
)
from algo_lab.algorithms.alns_solver import solve_alns
from algo_lab.algorithms.genetic_solver import solve_genetic
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import repair_and_audit_solution


DATASETS: List[Tuple[str, str]] = [
    ("DB Hà Nội", "db_hanoi_16_orders.json"),
    ("DB Đà Nẵng", "db_danang_30_orders.json"),
    ("DB Sóng Thần", "db_songthan_4_orders.json"),
    ("DB Nha Trang", "db_nhatrang_2_orders.json"),
    ("Kịch bản 1 - nhiều kiện", "scenario_1_multi_item.json"),
    ("Kịch bản 2 - hàng nặng", "scenario_2_heavy_cargo.json"),
    ("Kịch bản 3 - liên tỉnh", "scenario_3_dispersed.json"),
    ("Kịch bản 4 - time window chặt", "scenario_4_tight_windows.json"),
    ("Kịch bản 5 - đội xe hỗn hợp", "scenario_5_heterogeneous_fleet.json"),
    ("Kịch bản 6 - tái sử dụng sàn", "scenario_6_dynamic_reuse.json"),
    ("Kịch bản 7 - đa depot qua ngày", "scenario_7_multi_depot_overnight.json"),
    ("Kịch bản 8 - phân mảnh mật độ cao", "scenario_8_dense_fragmentation.json"),
]

ALGORITHM_NAMES = [
    "Standard ALNS",
    "Genetic Algorithm",
    "Hybrid ALNS",
    "Packing-aware VNS",
    "Packing-aware Tabu",
    "Packing-aware ILS",
    "Packing-aware Late Acceptance",
    "Packing-aware Simulated Annealing",
    "Packing-aware GRASP",
    "Packing-aware Memetic Search",
]


def _parse_seeds(raw: str) -> List[int]:
    try:
        seeds = [int(value.strip()) for value in raw.split(",") if value.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError("--seeds phải là danh sách số nguyên") from error
    if not seeds:
        raise argparse.ArgumentTypeError("--seeds phải có ít nhất một seed")
    if len(seeds) != len(set(seeds)):
        raise argparse.ArgumentTypeError("--seeds không được chứa giá trị trùng")
    return seeds


def _run_dataset(
    dataset_index: int,
    label: str,
    filename: str,
    search_budget_sec: float,
    spatial_audit_budget_sec: float,
    repair_budget_sec: float,
    seeds: List[int],
) -> Dict[str, Any]:
    dataset_path = os.path.join(project_root, "algo_lab", "datasets", filename)
    args = load_dataset(dataset_path)
    vehicles, drivers, orders, policy, dist, dur, node_map = args
    total_orders = len(orders)
    preprocessing_started_at = time.perf_counter()
    shared_initial_solution = solve_greedy(*args)
    preprocessing_time_sec = time.perf_counter() - preprocessing_started_at

    def ensure_audited(solution):
        # Thuật toán dùng audit ngắn trong lúc tìm kiếm. Benchmark phải audit
        # độc lập với ngân sách lớn hơn để không đánh đồng timeout với vô nghiệm.
        if (
            solution.solution_audited
            and solution.is_contract_valid
            and solution.is_temporally_valid
            and solution.is_spatial_valid
        ):
            return solution
        repair_and_audit_solution(
            solution,
            *args,
            spatial_time_limit_sec=spatial_audit_budget_sec,
            repair_time_limit_sec=repair_budget_sec,
        )
        return solution

    rows: List[Dict[str, Any]] = []
    for seed in seeds:
        runners = [
            (
                "Standard ALNS",
                lambda seed=seed: solve_alns(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Genetic Algorithm",
                lambda seed=seed: solve_genetic(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                ),
            ),
            (
                "Hybrid ALNS",
                lambda seed=seed: solve_hybrid_alns(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware VNS",
                lambda seed=seed: solve_vns(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware Tabu",
                lambda seed=seed: solve_tabu(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware ILS",
                lambda seed=seed: solve_ils(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware Late Acceptance",
                lambda seed=seed: solve_late_acceptance(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware Simulated Annealing",
                lambda seed=seed: solve_simulated_annealing(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware GRASP",
                lambda seed=seed: solve_grasp(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
            (
                "Packing-aware Memetic Search",
                lambda seed=seed: solve_memetic(
                    *args,
                    time_limit_sec=search_budget_sec,
                    random_seed=seed,
                    final_spatial_time_limit_sec=spatial_audit_budget_sec,
                    final_repair_time_limit_sec=repair_budget_sec,
                    initial_solution=shared_initial_solution,
                ),
            ),
        ]

        for algorithm, runner in runners:
            started_at = time.perf_counter()
            try:
                solution = ensure_audited(runner())
                elapsed = time.perf_counter() - started_at
                is_valid = bool(
                    solution.is_contract_valid
                    and solution.is_temporally_valid
                    and solution.is_spatial_valid
                )
                served = round(total_orders * solution.fulfillment_rate / 100.0)
                rows.append(
                    {
                        "dataset": label,
                        "file": filename,
                        "algorithm": algorithm,
                        "seed": seed,
                        "time_sec": round(elapsed, 3),
                        "vehicles": len(solution.routes),
                        "served": served,
                        "orders": total_orders,
                        "fulfillment_percent": solution.fulfillment_rate,
                        "cost_vnd": solution.real_economic_cost_vnd,
                        "penalized_objective_vnd": solution.penalized_objective_vnd,
                        "distance_km": solution.total_distance_km,
                        "audit": "PASS" if is_valid else "FAIL",
                        "issues": list(solution.validation_notes),
                    }
                )
            except Exception as error:  # preserve failures as benchmark evidence
                rows.append(
                    {
                        "dataset": label,
                        "file": filename,
                        "algorithm": algorithm,
                        "seed": seed,
                        "time_sec": round(time.perf_counter() - started_at, 3),
                        "vehicles": 0,
                        "served": 0,
                        "orders": total_orders,
                        "fulfillment_percent": 0.0,
                        "cost_vnd": 0,
                        "penalized_objective_vnd": policy.unassigned_order_penalty_vnd
                        * total_orders,
                        "distance_km": 0.0,
                        "audit": "ERROR",
                        "issues": [f"{type(error).__name__}: {error}"],
                    }
                )

    return {
        "dataset_index": dataset_index,
        "dataset": label,
        "file": filename,
        "orders": total_orders,
        "vehicles_available": len(vehicles),
        "preprocessing_time_sec": round(preprocessing_time_sec, 3),
        "rows": rows,
    }


def _aggregate(dataset_results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries: Dict[str, Dict[str, Any]] = {
        name: {
            "algorithm": name,
            "run_count": 0,
            "pass_count": 0,
            "full_valid_count": 0,
            "validated_served": 0,
            "orders": 0,
            "validated_cost_vnd": 0,
            "total_time_sec": 0.0,
            "validated_vehicles": 0,
            "wins": 0,
            "cost_gaps_percent": [],
            "runtimes_sec": [],
        }
        for name in ALGORITHM_NAMES
    }
    for dataset in dataset_results:
        best_cost_by_seed: Dict[int, int] = {}
        for row in dataset["rows"]:
            if row["audit"] != "PASS" or row["served"] != row["orders"]:
                continue
            seed = int(row.get("seed", 0))
            current = best_cost_by_seed.get(seed)
            if current is None or row["cost_vnd"] < current:
                best_cost_by_seed[seed] = row["cost_vnd"]
        for row in dataset["rows"]:
            if row["algorithm"] not in summaries:
                summaries[row["algorithm"]] = {
                    "algorithm": row["algorithm"],
                    "run_count": 0,
                    "pass_count": 0,
                    "full_valid_count": 0,
                    "validated_served": 0,
                    "orders": 0,
                    "validated_cost_vnd": 0,
                    "total_time_sec": 0.0,
                    "validated_vehicles": 0,
                    "wins": 0,
                    "cost_gaps_percent": [],
                    "runtimes_sec": [],
                }
            summary = summaries[row["algorithm"]]
            is_valid = row["audit"] == "PASS"
            is_full_valid = is_valid and row["served"] == row["orders"]
            summary["run_count"] += 1
            summary["pass_count"] += int(is_valid)
            summary["full_valid_count"] += int(is_full_valid)
            summary["validated_served"] += row["served"] if is_valid else 0
            summary["orders"] += row["orders"]
            summary["validated_cost_vnd"] += row["cost_vnd"] if is_valid else 0
            summary["total_time_sec"] += row["time_sec"]
            summary["runtimes_sec"].append(row["time_sec"])
            summary["validated_vehicles"] += row["vehicles"] if is_valid else 0
            seed = int(row.get("seed", 0))
            best_cost = best_cost_by_seed.get(seed)
            if is_full_valid and best_cost is not None and best_cost > 0:
                gap = (row["cost_vnd"] - best_cost) / best_cost * 100.0
                summary["cost_gaps_percent"].append(gap)
                summary["wins"] += int(row["cost_vnd"] == best_cost)

    for summary in summaries.values():
        gaps = summary.pop("cost_gaps_percent")
        runtimes = summary.pop("runtimes_sec")
        summary["mean_cost_gap_percent"] = (
            statistics.fmean(gaps) if gaps else None
        )
        summary["cost_gap_stdev_percent"] = (
            statistics.pstdev(gaps) if len(gaps) > 1 else 0.0 if gaps else None
        )
        summary["median_time_sec"] = statistics.median(runtimes) if runtimes else 0.0
    return sorted(
        summaries.values(),
        key=lambda row: (
            -row["full_valid_count"],
            -row["pass_count"],
            -row["validated_served"],
            row["mean_cost_gap_percent"]
            if row["mean_cost_gap_percent"] is not None
            else float("inf"),
            row["median_time_sec"],
        ),
    )


def _money(value: int) -> str:
    return f"{value:,}".replace(",", ".") + " đ"


def _markdown(
    dataset_results: List[Dict[str, Any]],
    aggregate: List[Dict[str, Any]],
    search_budget_sec: float,
    spatial_audit_budget_sec: float,
    repair_budget_sec: float,
    workers: int,
    wall_time_sec: float,
) -> str:
    seed_values = sorted(
        {
            int(row.get("seed", 0))
            for dataset in dataset_results
            for row in dataset["rows"]
        }
    )
    preprocessing_time_sec = sum(
        float(dataset.get("preprocessing_time_sec", 0.0))
        for dataset in dataset_results
    )
    lines = [
        f"# Tuyển chọn {len(ALGORITHM_NAMES)} metaheuristic trên {len(DATASETS)} bộ dữ liệu",
        "",
        (
            f"Ngân sách tìm kiếm: `{search_budget_sec:.1f}s` cho mỗi metaheuristic; "
            f"chạy song song tối đa `{workers}` dataset; tổng wall time `{wall_time_sec:.2f}s`."
        ),
        f"Random seeds: `{','.join(str(seed) for seed in seed_values)}`.",
        (
            f"Heuristic dựng nghiệm chung chạy một lần mỗi dataset: "
            f"`{preprocessing_time_sec:.2f}s` cộng dồn; không phải ứng viên xếp hạng."
        ),
        (
            f"Ngân sách audit bố trí: `{spatial_audit_budget_sec:.1f}s` mỗi lần kiểm tra; "
            f"ngân sách sửa và audit lại: `{repair_budget_sec:.1f}s`."
        ),
        "Greedy và OR-Tools không phải ứng viên xếp hạng. Greedy chỉ có thể được dùng nội bộ để dựng nghiệm ban đầu.",
        "Mọi dòng PASS đã qua cùng contract, time-window và production SpatialValidator.",
        "Xếp hạng ưu tiên độ tin cậy qua nhiều seed, phục vụ đủ đơn, khoảng cách chi phí tương đối, rồi thời gian.",
        "Thời gian là end-to-end của từng lượt; các dataset chạy song song nên chỉ dùng để so sánh gần đúng.",
        "",
        "## Kết quả chi tiết",
        "",
        "| Tệp dữ liệu | Dataset | Seed | Thuật toán | Thời gian | Xe | Giao | Chi phí | Km | Audit |",
        "|---|---|---:|---|---:|---:|---:|---:|---:|:---:|",
    ]
    for dataset in dataset_results:
        for row in dataset["rows"]:
            cost_cell = _money(row["cost_vnd"]) if row["audit"] == "PASS" else "—"
            lines.append(
                f"| `{row['file']}` | {row['dataset']} | {row.get('seed', 0)} | {row['algorithm']} | {row['time_sec']:.2f}s | "
                f"{row['vehicles']} | {row['served']}/{row['orders']} "
                f"({row['fulfillment_percent']:.1f}%) | {cost_cell} | "
                f"{row['distance_km']:.1f} | {row['audit']} |"
            )

    failed_datasets = [
        dataset
        for dataset in dataset_results
        if any(row["audit"] != "PASS" for row in dataset["rows"])
    ]
    if failed_datasets:
        lines.extend(["", "## Vấn đề phát hiện khi audit", ""])
        for dataset in failed_datasets:
            failed_rows = [row for row in dataset["rows"] if row["audit"] != "PASS"]
            lines.append(f"### {dataset['dataset']}")
            lines.append("")
            for row in failed_rows:
                issues = "; ".join(row["issues"]) or "Không có mô tả lỗi."
                lines.append(
                    f"- **{row['algorithm']} seed={row.get('seed', 0)} "
                    f"({row['audit']}):** {issues}"
                )
            lines.append("")

    lines.extend(
        [
            "",
            "## Tổng hợp",
            "",
            "| Hạng | Thuật toán | Đủ đơn + PASS | PASS | Phục vụ đã kiểm chứng | Gap chi phí TB ± σ | Trung vị thời gian | Thắng chi phí |",
            "|---:|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for rank, row in enumerate(aggregate, 1):
        fulfillment = row["validated_served"] / max(1, row["orders"]) * 100.0
        gap = (
            f"{row['mean_cost_gap_percent']:.2f}% ± {row['cost_gap_stdev_percent']:.2f}%"
            if row["mean_cost_gap_percent"] is not None
            else "—"
        )
        lines.append(
            f"| {rank} | {row['algorithm']} | {row['full_valid_count']}/{row['run_count']} | "
            f"{row['pass_count']}/{row['run_count']} | "
            f"{row['validated_served']}/{row['orders']} ({fulfillment:.1f}%) | "
            f"{gap} | {row['median_time_sec']:.2f}s | {row['wins']} |"
        )
    eligible = [
        row
        for row in aggregate
        if row["run_count"] > 0
        and row["full_valid_count"] == row["run_count"]
        and row["pass_count"] == row["run_count"]
    ]
    lines.extend(
        [
            "",
            "## Kết luận tuyển chọn",
            "",
            (
                f"Ứng viên dẫn đầu đủ điều kiện để tối ưu tiếp: **{eligible[0]['algorithm']}**."
                if eligible
                else "Chưa có thuật toán PASS và phục vụ đủ đơn ở mọi dataset/seed; chưa chọn ứng viên production."
            ),
            "Chỉ dùng kết luận này như đầu vào cho bước tối ưu tiếp; cần benchmark ngân sách dài và dữ liệu vận hành trước khi thay solver production.",
            "Kết quả là best-found theo ngân sách chạy, không phải bằng chứng tối ưu toàn cục.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=2.0)
    parser.add_argument("--spatial-audit-budget", type=float, default=5.0)
    parser.add_argument("--repair-budget", type=float, default=8.0)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--seeds", type=_parse_seeds, default=[0, 1, 2])
    parser.add_argument(
        "--output-dir",
        default=os.path.join(project_root, "algo_lab", "results"),
    )
    args = parser.parse_args()
    if (
        args.budget <= 0
        or args.spatial_audit_budget <= 0
        or args.repair_budget <= 0
    ):
        parser.error("All budget values must be greater than zero")
    if args.workers <= 0:
        parser.error("--workers must be greater than zero")

    if sys.platform.startswith("win"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    started_at = time.perf_counter()
    completed: List[Dict[str, Any]] = []
    max_workers = min(args.workers, len(DATASETS))
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
                args.seeds,
            ): label
            for index, (label, filename) in enumerate(DATASETS)
        }
        for future in as_completed(futures):
            result = future.result()
            completed.append(result)
            pass_count = sum(row["audit"] == "PASS" for row in result["rows"])
            print(
                f"[{len(completed)}/{len(DATASETS)}] {result['dataset']}: "
                f"{pass_count}/{len(ALGORITHM_NAMES) * len(args.seeds)} lượt PASS",
                flush=True,
            )

    completed.sort(key=lambda result: result["dataset_index"])
    aggregate = _aggregate(completed)
    wall_time = time.perf_counter() - started_at
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    markdown_path = output_dir / "benchmark_10_metaheuristics_12_datasets.md"
    json_path = output_dir / "benchmark_10_metaheuristics_12_datasets.json"
    csv_path = output_dir / "benchmark_10_metaheuristics_12_datasets.csv"
    markdown_path.write_text(
        _markdown(
            completed,
            aggregate,
            args.budget,
            args.spatial_audit_budget,
            args.repair_budget,
            max_workers,
            wall_time,
        ),
        encoding="utf-8",
    )
    json_path.write_text(
        json.dumps(
            {
                "config": {
                    "algorithms": ALGORITHM_NAMES,
                    "datasets": [filename for _, filename in DATASETS],
                    "seeds": args.seeds,
                    "search_budget_sec": args.budget,
                    "spatial_audit_budget_sec": args.spatial_audit_budget,
                    "repair_budget_sec": args.repair_budget,
                    "workers": max_workers,
                    "wall_time_sec": round(wall_time, 3),
                },
                "datasets": completed,
                "ranking": aggregate,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    detail_rows = [row for dataset in completed for row in dataset["rows"]]
    if detail_rows:
        with csv_path.open("w", encoding="utf-8-sig", newline="") as csv_file:
            fieldnames = list(detail_rows[0])
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            for row in detail_rows:
                serializable = dict(row)
                serializable["issues"] = "; ".join(row["issues"])
                writer.writerow(serializable)
    print(f"Markdown: {markdown_path}")
    print(f"JSON: {json_path}")
    print(f"CSV: {csv_path}")


if __name__ == "__main__":
    main()
