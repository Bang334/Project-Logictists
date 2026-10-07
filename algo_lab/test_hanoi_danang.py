"""Runs Hybrid ALNS, Standard ALNS, and Greedy on Hanoi and Danang."""

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
    ("6. Hà Nội (16 đơn, 21 xe)", "algo_lab/datasets/db_hanoi_16_orders.json", 2.5),
    ("7. Đà Nẵng (30 đơn, 42 xe)", "algo_lab/datasets/db_danang_30_orders.json", 3.0),
]

for label, path, budget in DATASETS:
    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx = load_dataset(path)
    tot = len(orders)
    
    # 1. Hybrid ALNS
    t0 = time.perf_counter()
    sol_hy = solve_hybrid_alns(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, time_limit_sec=budget)
    t_hy = time.perf_counter() - t0
    aud_hy = audit_solution(sol_hy, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)
    
    # 2. Standard ALNS
    t0 = time.perf_counter()
    sol_alns = ALNSSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, max_iterations=60).solve()
    t_alns = time.perf_counter() - t0
    aud_alns = audit_solution(sol_alns, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)

    # 3. Greedy
    t0 = time.perf_counter()
    sol_gr = solve_greedy(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    t_gr = time.perf_counter() - t0
    aud_gr = audit_solution(sol_gr, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)

    print(f"\n=== {label} ===", flush=True)
    print(f"Hybrid ALNS:   {t_hy:>5.2f}s | {len(sol_hy.routes)} xe | {aud_hy.served_order_count:>2}/{tot} ({aud_hy.served_order_count/tot*100:>4.0f}%) | {sol_hy.real_economic_cost_vnd:>12,.0f} đ | {'PASS' if aud_hy.is_valid else 'FAIL'}", flush=True)
    print(f"Standard ALNS: {t_alns:>5.2f}s | {len(sol_alns.routes)} xe | {aud_alns.served_order_count:>2}/{tot} ({aud_alns.served_order_count/tot*100:>4.0f}%) | {sol_alns.real_economic_cost_vnd:>12,.0f} đ | {'PASS' if aud_alns.is_valid else 'FAIL'}", flush=True)
    print(f"Greedy (Mới):  {t_gr:>5.2f}s | {len(sol_gr.routes)} xe | {aud_gr.served_order_count:>2}/{tot} ({aud_gr.served_order_count/tot*100:>4.0f}%) | {sol_gr.real_economic_cost_vnd:>12,.0f} đ | {'PASS' if aud_gr.is_valid else 'FAIL'}", flush=True)
