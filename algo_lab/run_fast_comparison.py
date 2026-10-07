"""Fast Algorithm Benchmark Suite (No slow OR-Tools legacy solver).
Compares:
1. Greedy Insertion (Mới)
2. Standard ALNS (Mới)
3. Genetic Algorithm (Mới)
4. Hybrid ALNS (Mới)

Across all 7 realistic TMS benchmark datasets.
"""

import copy
import json
import os
import sys
import time
from typing import Any, Dict, List, Tuple

# Fix Windows console UTF-8 output encoding
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.alns_solver import ALNSSolver
from algo_lab.algorithms.genetic_solver import GeneticRoutingSolver
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import audit_solution


DATASETS = [
    ("1. DB Hà Nội (Bắc Bộ)", "algo_lab/datasets/db_hanoi_16_orders.json", False),
    ("2. DB Đà Nẵng (Trung Bộ)", "algo_lab/datasets/db_danang_30_orders.json", True),
    ("3. DB Sóng Thần (Nam Bộ)", "algo_lab/datasets/db_songthan_4_orders.json", False),
    ("4. DB Nha Trang (Nam Trung Bộ)", "algo_lab/datasets/db_nhatrang_2_orders.json", False),
    ("5. Kịch bản 1: Hàng lẻ nhiều kiện", "algo_lab/datasets/scenario_1_multi_item.json", False),
    ("6. Kịch bản 2: Hàng nặng 25+ tấn", "algo_lab/datasets/scenario_2_heavy_cargo.json", False),
    ("7. Kịch bản 3: Liên tỉnh 7 tỉnh", "algo_lab/datasets/scenario_3_dispersed.json", False),
]


def run_benchmark_dataset(dataset_label: str, file_path: str, is_large: bool = False):
    print("\n" + "=" * 110)
    print(f">>> ĐÁNH GIÁ: {dataset_label.upper()} ({os.path.basename(file_path)})")
    print("=" * 110)

    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx = load_dataset(file_path)
    total_orders = len(orders)
    total_vehicles = len(vehicles)
    print(f"Quy mô: {total_orders} đơn hàng, {total_vehicles} xe tải")

    results = []

    # 1. Greedy
    t0 = time.perf_counter()
    sol_greedy = solve_greedy(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    t_greedy = time.perf_counter() - t0
    audit_greedy = audit_solution(sol_greedy, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    results.append({
        "algo": "Greedy (Mới)",
        "time": t_greedy,
        "vehicles": len(sol_greedy.routes),
        "served": f"{audit_greedy.served_order_count}/{total_orders}",
        "rate": audit_greedy.served_order_count / total_orders * 100,
        "cost": sol_greedy.real_economic_cost_vnd,
        "distance": sol_greedy.total_distance_km,
        "status": "PASS" if audit_greedy.is_valid else "FAIL",
    })

    # 2. Standard ALNS
    t0 = time.perf_counter()
    alns_iter = 120 if is_large else 250
    alns_solver = ALNSSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, max_iterations=alns_iter)
    sol_alns = alns_solver.solve()
    t_alns = time.perf_counter() - t0
    audit_alns = audit_solution(sol_alns, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    results.append({
        "algo": "Standard ALNS (Mới)",
        "time": t_alns,
        "vehicles": len(sol_alns.routes),
        "served": f"{audit_alns.served_order_count}/{total_orders}",
        "rate": audit_alns.served_order_count / total_orders * 100,
        "cost": sol_alns.real_economic_cost_vnd,
        "distance": sol_alns.total_distance_km,
        "status": "PASS" if audit_alns.is_valid else "FAIL",
    })

    # 3. Genetic Algorithm
    t0 = time.perf_counter()
    ga_gen = 15 if is_large else 35
    ga_solver = GeneticRoutingSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, generations=ga_gen)
    sol_ga = ga_solver.solve()
    t_ga = time.perf_counter() - t0
    audit_ga = audit_solution(sol_ga, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    results.append({
        "algo": "Genetic Algorithm (Mới)",
        "time": t_ga,
        "vehicles": len(sol_ga.routes),
        "served": f"{audit_ga.served_order_count}/{total_orders}",
        "rate": audit_ga.served_order_count / total_orders * 100,
        "cost": sol_ga.real_economic_cost_vnd,
        "distance": sol_ga.total_distance_km,
        "status": "PASS" if audit_ga.is_valid else "FAIL",
    })

    # 4. Hybrid ALNS
    t0 = time.perf_counter()
    time_budget = 4.0 if is_large else 2.5
    sol_hybrid = solve_hybrid_alns(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, time_limit_sec=time_budget)
    t_hybrid = time.perf_counter() - t0
    audit_hybrid = audit_solution(sol_hybrid, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    results.append({
        "algo": "Hybrid ALNS (Mới)",
        "time": t_hybrid,
        "vehicles": len(sol_hybrid.routes),
        "served": f"{audit_hybrid.served_order_count}/{total_orders}",
        "rate": audit_hybrid.served_order_count / total_orders * 100,
        "cost": sol_hybrid.real_economic_cost_vnd,
        "distance": sol_hybrid.total_distance_km,
        "status": "PASS" if audit_hybrid.is_valid else "FAIL",
    })

    # Print summary table for this dataset
    header = f"{'Thuật toán':<26} | {'Thời gian':<9} | {'Số xe':<6} | {'Tỷ lệ giao':<12} | {'Chi phí (VNĐ)':<15} | {'Số km':<9} | {'Kiểm toán':<8}"
    print("-" * len(header))
    print(header)
    print("-" * len(header))
    for r in results:
        status_str = f"HỢP LỆ ({r['status']})" if r['status'] == "PASS" else f"LỖI ({r['status']})"
        print(f"{r['algo']:<26} | {r['time']:>7.2f}s | {r['vehicles']:>4} xe | {r['rate']:>5.1f}% ({r['served']:<5}) | {r['cost']:>13,.0f} đ | {r['distance']:>7.1f}km | {status_str}")
    print("-" * len(header))

    return results


def main():
    print("\n" + "#" * 110)
    print("CHƯƠNG TRÌNH SO SÁNH BENCHMARK NHANH 4 THUẬT TOÁN (BỎ QUA SOLVER CŨ)")
    print("#" * 110)

    all_data = {}
    for label, path, is_large in DATASETS:
        all_data[label] = run_benchmark_dataset(label, path, is_large)

    print("\n\n" + "=" * 110)
    print("TỔNG KẾT TOÀN DIỆN CẢ 7 KỊCH BẢN CHO HYBRID ALNS VS CÁC THUẬT TOÁN")
    print("=" * 110)

    # Summarize per algorithm
    algos = ["Greedy (Mới)", "Standard ALNS (Mới)", "Genetic Algorithm (Mới)", "Hybrid ALNS (Mới)"]
    summary = {a: {"total_cost": 0, "total_time": 0.0, "total_served": 0, "total_orders": 0, "total_vehicles": 0, "pass_count": 0} for a in algos}

    for label, res_list in all_data.items():
        for r in res_list:
            a = r["algo"]
            summary[a]["total_cost"] += r["cost"]
            summary[a]["total_time"] += r["time"]
            s, tot = r["served"].split("/")
            summary[a]["total_served"] += int(s)
            summary[a]["total_orders"] += int(tot)
            summary[a]["total_vehicles"] += r["vehicles"]
            if r["status"] == "PASS":
                summary[a]["pass_count"] += 1

    print(f"{'Thuật toán':<26} | {'Tổng chi phí 7 kịch bản':<25} | {'Tổng thời gian':<14} | {'Phục vụ đơn':<14} | {'Tổng xe':<8} | {'Hợp lệ':<10}")
    print("-" * 105)
    for a in algos:
        s = summary[a]
        rate = s['total_served'] / s['total_orders'] * 100
        print(f"{a:<26} | {s['total_cost']:>21,.0f} đ | {s['total_time']:>12.2f}s | {rate:>5.1f}% ({s['total_served']}/{s['total_orders']}) | {s['total_vehicles']:>6} xe | {s['pass_count']}/7 kịch bản")
    print("-" * 105)


if __name__ == "__main__":
    main()
