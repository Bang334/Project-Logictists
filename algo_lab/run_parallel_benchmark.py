"""Run production-valid routing algorithms on diverse datasets.

Datasets run concurrently in separate processes. Algorithms within one dataset
run sequentially so they see the same CPU conditions and share no random state.
Every solution is independently audited before it is eligible for PASS or a
per-dataset cost win.
"""

import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.advanced_metaheuristics import (
    solve_ils,
    solve_late_acceptance,
    solve_tabu,
    solve_vns,
)
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
    "Greedy",
    "Hybrid ALNS",
    "Packing-aware VNS",
    "Packing-aware Tabu",
    "Packing-aware ILS",
    "Packing-aware Late Acceptance",
]


def _run_dataset(
    dataset_index: int,
    label: str,
    filename: str,
    search_budget_sec: float,
    spatial_audit_budget_sec: float,
    repair_budget_sec: float,
) -> Dict[str, Any]:
    dataset_path = os.path.join(project_root, "algo_lab", "datasets", filename)
    args = load_dataset(dataset_path)
    vehicles, drivers, orders, policy, dist, dur, node_map = args
    total_orders = len(orders)

    def ensure_audited(solution):
        # Thuật toán dùng audit ngắn trong lúc tìm kiếm. Benchmark phải audit
        # độc lập với ngân sách lớn hơn để không đánh đồng timeout với vô nghiệm.
        repair_and_audit_solution(
            solution,
            *args,
            spatial_time_limit_sec=spatial_audit_budget_sec,
            repair_time_limit_sec=repair_budget_sec,
        )
        return solution

    runners = [
        ("Greedy", lambda: solve_greedy(*args)),
        (
            "Hybrid ALNS",
            lambda: solve_hybrid_alns(
                *args, time_limit_sec=search_budget_sec, random_seed=0
            ),
        ),
        (
            "Packing-aware VNS",
            lambda: solve_vns(
                *args,
                time_limit_sec=search_budget_sec,
                random_seed=0,
                final_spatial_time_limit_sec=spatial_audit_budget_sec,
                final_repair_time_limit_sec=repair_budget_sec,
            ),
        ),
        (
            "Packing-aware Tabu",
            lambda: solve_tabu(
                *args, time_limit_sec=search_budget_sec, random_seed=0
            ),
        ),
        (
            "Packing-aware ILS",
            lambda: solve_ils(
                *args, time_limit_sec=search_budget_sec, random_seed=0
            ),
        ),
        (
            "Packing-aware Late Acceptance",
            lambda: solve_late_acceptance(
                *args, time_limit_sec=search_budget_sec, random_seed=0
            ),
        ),
    ]

    rows: List[Dict[str, Any]] = []
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
        except Exception as error:  # benchmark must preserve failures as evidence
            rows.append(
                {
                    "dataset": label,
                    "file": filename,
                    "algorithm": algorithm,
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
        "rows": rows,
    }


def _aggregate(dataset_results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    summaries: Dict[str, Dict[str, Any]] = {
        name: {
            "algorithm": name,
            "pass_count": 0,
            "validated_served": 0,
            "orders": 0,
            "validated_cost_vnd": 0,
            "total_time_sec": 0.0,
            "validated_vehicles": 0,
            "wins": 0,
        }
        for name in ALGORITHM_NAMES
    }
    for dataset in dataset_results:
        valid_full = [
            row
            for row in dataset["rows"]
            if row["audit"] == "PASS" and row["served"] == row["orders"]
        ]
        best_cost = min((row["cost_vnd"] for row in valid_full), default=None)
        for row in dataset["rows"]:
            summary = summaries[row["algorithm"]]
            is_valid = row["audit"] == "PASS"
            summary["pass_count"] += int(is_valid)
            summary["validated_served"] += row["served"] if is_valid else 0
            summary["orders"] += row["orders"]
            summary["validated_cost_vnd"] += row["cost_vnd"] if is_valid else 0
            summary["total_time_sec"] += row["time_sec"]
            summary["validated_vehicles"] += row["vehicles"] if is_valid else 0
            summary["wins"] += int(
                best_cost is not None
                and row["audit"] == "PASS"
                and row["served"] == row["orders"]
                and row["cost_vnd"] == best_cost
            )
    return sorted(
        summaries.values(),
        key=lambda row: (
            -row["pass_count"],
            -row["validated_served"],
            row["validated_cost_vnd"],
            row["total_time_sec"],
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
    lines = [
        f"# So sánh {len(ALGORITHM_NAMES)} thuật toán trên {len(DATASETS)} bộ dữ liệu",
        "",
        (
            f"Ngân sách tìm kiếm: `{search_budget_sec:.1f}s` cho mỗi metaheuristic; "
            f"chạy song song tối đa `{workers}` dataset; tổng wall time `{wall_time_sec:.2f}s`."
        ),
        (
            f"Ngân sách audit bố trí: `{spatial_audit_budget_sec:.1f}s` mỗi lần kiểm tra; "
            f"ngân sách sửa và audit lại: `{repair_budget_sec:.1f}s`."
        ),
        "Mọi dòng PASS đã qua cùng contract, time-window và production SpatialValidator.",
        "Thời gian là wall-clock khi chạy song song nên chỉ dùng để so sánh gần đúng.",
        "",
        "## Kết quả chi tiết",
        "",
        "| Tệp dữ liệu | Dataset | Thuật toán | Thời gian | Xe | Giao | Chi phí | Km | Audit |",
        "|---|---|---|---:|---:|---:|---:|---:|:---:|",
    ]
    for dataset in dataset_results:
        for row in dataset["rows"]:
            cost_cell = _money(row["cost_vnd"]) if row["audit"] == "PASS" else "—"
            lines.append(
                f"| `{row['file']}` | {row['dataset']} | {row['algorithm']} | {row['time_sec']:.2f}s | "
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
                lines.append(f"- **{row['algorithm']} ({row['audit']}):** {issues}")
            lines.append("")

    lines.extend(
        [
            "",
            "## Tổng hợp",
            "",
            "| Hạng | Thuật toán | PASS | Phục vụ đã kiểm chứng | Tổng chi phí so sánh | Tổng thời gian | Xe ở lượt PASS | Thắng chi phí |",
            "|---:|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for rank, row in enumerate(aggregate, 1):
        fulfillment = row["validated_served"] / max(1, row["orders"]) * 100.0
        comparable_cost = (
            _money(row["validated_cost_vnd"])
            if row["pass_count"] == len(DATASETS)
            else f"— (chưa PASS đủ {len(DATASETS)}/{len(DATASETS)})"
        )
        lines.append(
            f"| {rank} | {row['algorithm']} | {row['pass_count']}/{len(DATASETS)} | "
            f"{row['validated_served']}/{row['orders']} ({fulfillment:.1f}%) | "
            f"{comparable_cost} | {row['total_time_sec']:.2f}s | "
            f"{row['validated_vehicles']} | {row['wins']} |"
        )
    lines.extend(
        [
            "",
            "Xếp hạng ưu tiên: số dataset PASS, số đơn đã kiểm chứng, tổng chi phí của lượt PASS, rồi thời gian.",
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
            ): label
            for index, (label, filename) in enumerate(DATASETS)
        }
        for future in as_completed(futures):
            result = future.result()
            completed.append(result)
            pass_count = sum(row["audit"] == "PASS" for row in result["rows"])
            print(
                f"[{len(completed)}/{len(DATASETS)}] {result['dataset']}: "
                f"{pass_count}/{len(ALGORITHM_NAMES)} thuật toán PASS",
                flush=True,
            )

    completed.sort(key=lambda result: result["dataset_index"])
    aggregate = _aggregate(completed)
    wall_time = time.perf_counter() - started_at
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    markdown_path = output_dir / "benchmark_6_algorithms_12_datasets.md"
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
    print(f"Markdown: {markdown_path}")


if __name__ == "__main__":
    main()
