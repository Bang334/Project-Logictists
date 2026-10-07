"""Multi-Scenario Benchmark Suite for TMS Algorithm Lab.

Runs and evaluates optimization algorithms concurrently across diverse data scenarios:
1. Multi-item intensive (Đơn có rất nhiều kiện hàng nhỏ/vừa).
2. Heavy cargo (Hàng tải trọng nặng, bắt buộc điều động nhiều xe).
3. Dispersed geography (Địa bàn liên tỉnh cách xa nhau, thử thách gom tuyến).
4. Real Database: Chi nhánh Hà Nội (16 đơn, 21 xe, 268 kiện).
5. Real Database: Chi nhánh Đà Nẵng (30 đơn, 42 xe, 102 điểm giao thông).
"""

import os
import sys
import time
from typing import Dict, List

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
from algo_lab.common.solution_validator import audit_solution


def run_scenario(name: str, desc: str, filepath: str) -> List[OptimizationSolution]:
    print("\n" + "=" * 115, flush=True)
    print(f"KỊCH BẢN: {name.upper()}", flush=True)
    print(f"Đặc điểm: {desc}", flush=True)
    print(f"File dữ liệu: {os.path.basename(filepath)}", flush=True)
    print("=" * 115, flush=True)

    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map = load_dataset(filepath)
    total_items = sum(len(o.items) for o in orders)
    print(f"-> Quy mô: {len(orders)} đơn hàng | {total_items} kiện hàng | {len(vehicles)} xe sẵn sàng\n", flush=True)

    results = []

    def validate(solution: OptimizationSolution) -> OptimizationSolution:
        if not solution.solution_audited:
            audit_solution(
                solution,
                vehicles,
                drivers,
                orders,
                policy,
                dist_mat,
                dur_mat,
                node_map,
                spatial_time_limit_sec=1.5,
            )
        return solution

    # 1. Genetic Algorithm
    print("  [1/5] Đang chạy Genetic Algorithm (GA)...", end=" ", flush=True)
    t0 = time.perf_counter()
    sol_ga = validate(solve_genetic(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map, time_limit_sec=2.5))
    print(f"Xong ({time.perf_counter()-t0:.2f}s) - Đơn: {sol_ga.fulfillment_rate}% | Xe: {len(sol_ga.routes)} | Phí: {sol_ga.real_economic_cost_vnd:,}đ", flush=True)
    results.append(sol_ga)

    # 2. Greedy Insertion
    print("  [2/5] Đang chạy Greedy Insertion...", end=" ", flush=True)
    t0 = time.perf_counter()
    sol_greedy = validate(solve_greedy(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map))
    print(f"Xong ({time.perf_counter()-t0:.2f}s) - Đơn: {sol_greedy.fulfillment_rate}% | Xe: {len(sol_greedy.routes)} | Phí: {sol_greedy.real_economic_cost_vnd:,}đ", flush=True)
    results.append(sol_greedy)

    # 3. ALNS
    print("  [3/5] Đang chạy ALNS cũ...", end=" ", flush=True)
    t0 = time.perf_counter()
    sol_alns = validate(solve_alns(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map, time_limit_sec=3.0))
    print(f"Xong ({time.perf_counter()-t0:.2f}s) - Đơn: {sol_alns.fulfillment_rate}% | Xe: {len(sol_alns.routes)} | Phí: {sol_alns.real_economic_cost_vnd:,}đ", flush=True)
    results.append(sol_alns)

    # 4. Packing-aware Hybrid ALNS
    print("  [4/5] Đang chạy Hybrid ALNS...", end=" ", flush=True)
    t0 = time.perf_counter()
    sol_hybrid = solve_hybrid_alns(
        vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map,
        time_limit_sec=3.0, random_seed=0,
    )
    print(f"Xong ({time.perf_counter()-t0:.2f}s) - Đơn: {sol_hybrid.fulfillment_rate}% | Xe: {len(sol_hybrid.routes)} | Phí: {sol_hybrid.real_economic_cost_vnd:,}đ | Validator: {'PASS' if sol_hybrid.is_contract_valid and sol_hybrid.is_temporally_valid and sol_hybrid.is_spatial_valid else 'FAIL'}", flush=True)
    results.append(sol_hybrid)

    # 5. Google OR-Tools
    print("  [5/5] Đang chạy Google OR-Tools...", end=" ", flush=True)
    t0 = time.perf_counter()
    sol_ortools = validate(solve_ortools(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_map, max_time_seconds=3))
    print(f"Xong ({time.perf_counter()-t0:.2f}s) - Đơn: {sol_ortools.fulfillment_rate}% | Xe: {len(sol_ortools.routes)} | Phí: {sol_ortools.real_economic_cost_vnd:,}đ | Xếp dỡ: {'PASS' if sol_ortools.is_spatial_valid else 'FAIL'}", flush=True)
    results.append(sol_ortools)

    return results


def print_summary_table(all_results: Dict[str, List[OptimizationSolution]]):
    print("\n" + "#" * 120, flush=True)
    print("BẢNG TỔNG HỢP SO SÁNH HIỆU NĂNG QUA TẤT CẢ CÁC KỊCH BẢN DỮ LIỆU", flush=True)
    print("#" * 120, flush=True)

    header = f"{'KỊCH BẢN':<28} | {'THUẬT TOÁN':<28} | {'THỜI GIAN':<10} | {'SỐ XE':<6} | {'TỶ LỆ ĐƠN':<11} | {'CHI PHÍ THỰC TẾ':<16} | {'XẾP DỠ'}"
    print(header, flush=True)
    print("-" * 120, flush=True)

    for sc_name, sols in all_results.items():
        for sol in sols:
            short_algo = sol.solver_name.split("(")[0].strip()
            spatial_str = "PASS" if (
                sol.is_contract_valid and sol.is_temporally_valid and sol.is_spatial_valid
            ) else "FAIL"
            print(
                f"{sc_name:<28} | "
                f"{short_algo:<28} | "
                f"{sol.execution_time_sec:>8.2f}s | "
                f"{len(sol.routes):>6} | "
                f"{sol.fulfillment_rate:>10.1f}% | "
                f"{sol.real_economic_cost_vnd:>12,d} đ | "
                f"{spatial_str}",
                flush=True,
            )
        print("-" * 120, flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    dataset_dir = os.path.join(os.path.dirname(__file__), "datasets")

    scenarios = [
        ("1. Đơn nhiều kiện (Retail)", "Đơn 15-22 kiện/đơn, thử thách xếp dỡ 2D LIFO", os.path.join(dataset_dir, "scenario_1_multi_item.json")),
        ("2. Hàng nặng chia nhiều xe", "Tải trọng nặng 25+ tấn, bắt buộc điều động nhiều xe", os.path.join(dataset_dir, "scenario_2_heavy_cargo.json")),
        ("3. Liên tỉnh phân tán rộng", "Điểm lấy/giao trải dài 7 tỉnh thành Miền Bắc", os.path.join(dataset_dir, "scenario_3_dispersed.json")),
        ("4. Thực tế: Chi nhánh Hà Nội", "Dữ liệu database thực: 16 đơn, 21 xe, 268 kiện", os.path.join(dataset_dir, "db_hanoi_16_orders.json")),
    ]

    all_results = {}
    for name, desc, fpath in scenarios:
        if os.path.exists(fpath):
            all_results[name] = run_scenario(name, desc, fpath)

    print_summary_table(all_results)

    # Analyze champion from independently validated runs only.
    print("\n" + "=" * 120, flush=True)
    print("KẾT LUẬN: THUẬT TOÁN NÀO TỐT NHẤT QUA MỌI DẠNG DỮ LIỆU?", flush=True)
    print("=" * 120, flush=True)
    valid = [
        (scenario, solution)
        for scenario, solutions in all_results.items()
        for solution in solutions
        if solution.is_contract_valid
        and solution.is_temporally_valid
        and solution.is_spatial_valid
    ]
    if not valid:
        print("Không có nghiệm nào vượt qua toàn bộ validator; không công bố thuật toán thắng.")
    else:
        by_solver = {}
        for _, solution in valid:
            name = solution.solver_name.split("(")[0].strip()
            by_solver.setdefault(name, []).append(solution)
        ranking = sorted(
            by_solver.items(),
            key=lambda item: (
                -sum(sol.fulfillment_rate for sol in item[1]) / len(item[1]),
                sum(sol.penalized_objective_vnd for sol in item[1]) / len(item[1]),
            ),
        )
        winner, winner_runs = ranking[0]
        print(
            f"Best-found theo trung bình các kịch bản có nghiệm hợp lệ: {winner}; "
            f"đã có {len(winner_runs)} lượt PASS."
        )
        print("Kết quả là best-found theo ngân sách chạy, không chứng minh tối ưu toàn cục.")
    print("=" * 120 + "\n", flush=True)


if __name__ == "__main__":
    main()
