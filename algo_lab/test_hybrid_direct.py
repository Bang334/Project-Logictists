"""Direct test script for Hybrid ALNS across all datasets to evaluate its performance."""

import os
import sys
import time

if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.algorithms.alns_solver import ALNSSolver
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import audit_solution

DATASETS = [
    ("1. Nha Trang", "algo_lab/datasets/db_nhatrang_2_orders.json", 1.5),
    ("2. Sóng Thần", "algo_lab/datasets/db_songthan_4_orders.json", 2.0),
    ("3. Kịch bản 3 (Liên tỉnh)", "algo_lab/datasets/scenario_3_dispersed.json", 2.5),
    ("4. Kịch bản 2 (Hàng nặng)", "algo_lab/datasets/scenario_2_heavy_cargo.json", 2.0),
    ("5. Kịch bản 1 (Hàng lẻ)", "algo_lab/datasets/scenario_1_multi_item.json", 2.0),
    ("6. Hà Nội", "algo_lab/datasets/db_hanoi_16_orders.json", 2.5),
    ("7. Đà Nẵng", "algo_lab/datasets/db_danang_30_orders.json", 3.0),
]

print("=" * 105, flush=True)
print(f"{'Dataset':<26} | {'Thuật toán':<20} | {'Thời gian':<8} | {'Xe':<5} | {'Giao':<12} | {'Chi phí':<14} | {'Audit'}")
print("=" * 105, flush=True)

for label, path, budget in DATASETS:
    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx = load_dataset(path)
    tot = len(orders)
    
    # Test Hybrid ALNS
    t0 = time.perf_counter()
    sol_hy = solve_hybrid_alns(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, time_limit_sec=budget)
    t_hy = time.perf_counter() - t0
    aud_hy = audit_solution(sol_hy, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=1.5)
    
    # Test Standard ALNS
    t0 = time.perf_counter()
    sol_alns = ALNSSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, max_iterations=100).solve()
    t_alns = time.perf_counter() - t0
    aud_alns = audit_solution(sol_alns, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=1.5)

    # Test Greedy
    t0 = time.perf_counter()
    sol_gr = solve_greedy(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    t_gr = time.perf_counter() - t0
    aud_gr = audit_solution(sol_gr, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=1.5)

    print(f"{label:<26} | {'Hybrid ALNS':<20} | {t_hy:>6.2f}s | {len(sol_hy.routes):>3}xe | {aud_hy.served_order_count:>2}/{tot} ({aud_hy.served_order_count/tot*100:>4.0f}%) | {sol_hy.real_economic_cost_vnd:>11,.0f} đ | {'PASS' if aud_hy.is_valid else 'FAIL'}", flush=True)
    print(f"{'':<26} | {'Standard ALNS':<20} | {t_alns:>6.2f}s | {len(sol_alns.routes):>3}xe | {aud_alns.served_order_count:>2}/{tot} ({aud_alns.served_order_count/tot*100:>4.0f}%) | {sol_alns.real_economic_cost_vnd:>11,.0f} đ | {'PASS' if aud_alns.is_valid else 'FAIL'}", flush=True)
    print(f"{'':<26} | {'Greedy (Mới)':<20} | {t_gr:>6.2f}s | {len(sol_gr.routes):>3}xe | {aud_gr.served_order_count:>2}/{tot} ({aud_gr.served_order_count/tot*100:>4.0f}%) | {sol_gr.real_economic_cost_vnd:>11,.0f} đ | {'PASS' if aud_gr.is_valid else 'FAIL'}", flush=True)
    print("-" * 105, flush=True)
