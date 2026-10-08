"""Direct benchmark test for Hybrid ALNS vs Standard ALNS vs Greedy vs GA.
Prints realtime results with flush=True.
"""

import os
import sys
import time

# Ensure UTF-8 and unbuffered output
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

TEST_DATASETS = [
    ("Nha Trang (2 đơn, 7 xe)", "algo_lab/datasets/db_nhatrang_2_orders.json", 100, 20, 2.0),
    ("Sóng Thần (4 đơn, 14 xe)", "algo_lab/datasets/db_songthan_4_orders.json", 120, 20, 2.0),
    ("Hà Nội (16 đơn, 21 xe)", "algo_lab/datasets/db_hanoi_16_orders.json", 150, 15, 2.5),
    ("Hàng lẻ (170 kiện, 6 xe)", "algo_lab/datasets/scenario_1_multi_item.json", 120, 15, 2.0),
    ("Hàng nặng 25T (8 xe)", "algo_lab/datasets/scenario_2_heavy_cargo.json", 120, 15, 2.0),
    ("Liên tỉnh 7 tỉnh (5 xe)", "algo_lab/datasets/scenario_3_dispersed.json", 120, 15, 2.0),
    ("Đà Nẵng (30 đơn, 42 xe)", "algo_lab/datasets/db_danang_30_orders.json", 80, 5, 3.0),
]

print("\n" + "=" * 115, flush=True)
print("BENCHMARK TOÀN DIỆN: HYBRID ALNS VS STANDARD ALNS VS GREEDY VS GENETIC ALGORITHM", flush=True)
print("=" * 115, flush=True)

all_results = {}

for label, path, alns_it, ga_gen, hy_sec in TEST_DATASETS:
    print(f"\n>>> ĐANG CHẠY: {label} ...", flush=True)
    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx = load_dataset(path)
    tot_o = len(orders)
    
    # 1. Greedy
    t0 = time.perf_counter()
    sol_gr = solve_greedy(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx)
    t_gr = time.perf_counter() - t0
    aud_gr = audit_solution(sol_gr, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)
    
    # 2. Standard ALNS
    t0 = time.perf_counter()
    sol_alns = ALNSSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, max_iterations=alns_it).solve()
    t_alns = time.perf_counter() - t0
    aud_alns = audit_solution(sol_alns, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)
    
    # 3. Hybrid ALNS
    t0 = time.perf_counter()
    sol_hy = solve_hybrid_alns(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, time_limit_sec=hy_sec)
    t_hy = time.perf_counter() - t0
    aud_hy = audit_solution(sol_hy, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)

    # 4. Genetic Algorithm
    t0 = time.perf_counter()
    sol_ga = GeneticRoutingSolver(vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, generations=ga_gen).solve()
    t_ga = time.perf_counter() - t0
    aud_ga = audit_solution(sol_ga, vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, spatial_time_limit_sec=0.5)
    
    row = [
        ("Greedy (Mới)", t_gr, len(sol_gr.routes), aud_gr.served_order_count, tot_o, sol_gr.real_economic_cost_vnd, sol_gr.total_distance_km, aud_gr.is_valid),
        ("Standard ALNS (Mới)", t_alns, len(sol_alns.routes), aud_alns.served_order_count, tot_o, sol_alns.real_economic_cost_vnd, sol_alns.total_distance_km, aud_alns.is_valid),
        ("Hybrid ALNS (Mới)", t_hy, len(sol_hy.routes), aud_hy.served_order_count, tot_o, sol_hy.real_economic_cost_vnd, sol_hy.total_distance_km, aud_hy.is_valid),
        ("Genetic Algorithm", t_ga, len(sol_ga.routes), aud_ga.served_order_count, tot_o, sol_ga.real_economic_cost_vnd, sol_ga.total_distance_km, aud_ga.is_valid),
    ]
    all_results[label] = row
    
    # In ngay bảng kết quả của kịch bản này
    hdr = f"{'Thuật toán':<23} | {'Thời gian':<8} | {'Số xe':<6} | {'Tỷ lệ':<12} | {'Chi phí (VNĐ)':<15} | {'Số km':<8} | {'Kiểm toán':<8}"
    print(hdr, flush=True)
    print("-" * len(hdr), flush=True)
    for name, t_s, n_v, s_cnt, t_cnt, cost_vnd, km, is_val in row:
        pct = (s_cnt / t_cnt) * 100
        val_str = "PASS" if is_val else "FAIL"
        print(f"{name:<23} | {t_s:>6.2f}s | {n_v:>4} xe | {pct:>5.1f}% ({s_cnt}/{t_cnt}) | {cost_vnd:>13,.0f} đ | {km:>6.1f}km | {val_str}", flush=True)
    print("-" * len(hdr), flush=True)

# TỔNG KẾT
print("\n" + "=" * 115, flush=True)
print("BẢNG TỔNG KẾT TOÀN DIỆN CẢ 7 BỘ DỮ LIỆU", flush=True)
print("=" * 115, flush=True)

algos = ["Greedy (Mới)", "Standard ALNS (Mới)", "Hybrid ALNS (Mới)", "Genetic Algorithm"]
sum_data = {a: {"cost": 0, "time": 0.0, "served": 0, "total": 0, "vehicles": 0, "pass": 0} for a in algos}

for label, row in all_results.items():
    for name, t_s, n_v, s_cnt, t_cnt, cost_vnd, km, is_val in row:
        sum_data[name]["cost"] += cost_vnd
        sum_data[name]["time"] += t_s
        sum_data[name]["served"] += s_cnt
        sum_data[name]["total"] += t_cnt
        sum_data[name]["vehicles"] += n_v
        if is_val:
            sum_data[name]["pass"] += 1

hdr2 = f"{'Thuật toán':<23} | {'Tổng chi phí':<22} | {'Tổng thời gian':<14} | {'Phục vụ đơn':<14} | {'Tổng xe':<8} | {'Hợp lệ':<10}"
print(hdr2, flush=True)
print("-" * len(hdr2), flush=True)
for a in algos:
    sd = sum_data[a]
    pct = (sd["served"] / sd["total"]) * 100
    print(f"{a:<23} | {sd['cost']:>18,.0f} đ | {sd['time']:>12.2f}s | {pct:>5.1f}% ({sd['served']}/{sd['total']}) | {sd['vehicles']:>6} xe | {sd['pass']}/7 kịch bản", flush=True)
print("-" * len(hdr2), flush=True)
