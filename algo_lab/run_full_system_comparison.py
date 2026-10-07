"""Full System Comparison Benchmark:
Evaluates and compares:
1. All 4 Real Branch Datasets from Supabase Database:
   - Hanoi (16 orders, 21 vehicles)
   - Da Nang (30 orders, 42 vehicles)
   - Song Than (4 orders, 14 vehicles)
   - Nha Trang (2 orders, 7 vehicles)
2. All 3 Synthetic Problem Scenarios:
   - Scenario 1: Multi-item Retail (170 items, 6 vehicles)
   - Scenario 2: Heavy Cargo (25+ tons, 8 vehicles)
   - Scenario 3: Inter-provincial Dispersed (7 provinces, 5 vehicles)
3. Algorithms tested side-by-side with one independent validator:
   - Thuật toán hiện tại của Project (FleetRoutingSolver / Multi-step OR-Tools + Spatial Validator)
   - Genetic Algorithm (GA with LIFO integrated)
   - ALNS (Adaptive Large Neighborhood Search with LIFO integrated)
   - Packing-aware Hybrid ALNS (adaptive destroy/repair operators)
   - Greedy Insertion (LIFO integrated)
   - Google OR-Tools GLS Baseline
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
from algo_lab.algorithms.ortools_adapter import solve_ortools
from algo_lab.algorithms.project_current_solver import solve_current_project
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.packing_checker import FastPackingChecker
from algo_lab.common.solution_validator import audit_solution


def run_benchmark_on_dataset(dataset_name: str, file_path: str, is_large: bool = False) -> List[Dict[str, Any]]:
    print("\n" + "=" * 115)
    print(f"BẮT ĐẦU ĐÁNH GIÁ: {dataset_name.upper()}")
    print(f"File nguồn: {os.path.basename(file_path)}")
    print("=" * 115)

    with open(file_path, "r", encoding="utf-8") as f:
        raw_payload = json.load(f)

    vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx = load_dataset(file_path)

    total_orders = len(orders)
    total_vehicles = len(vehicles)
    total_items = sum(len(o.items) for o in orders)

    print(f"-> Quy mô: {total_orders} đơn hàng | {total_items} kiện hàng | {total_vehicles} xe sẵn sàng")

    results = []

    def validate(solution):
        if not solution.solution_audited:
            audit_solution(
                solution,
                vehicles,
                drivers,
                orders,
                policy,
                dist_mat,
                dur_mat,
                node_to_idx,
                spatial_time_limit_sec=1.5,
            )
        return solution

    # 1. Thuật toán hiện tại của Project (FleetRoutingSolver)
    print("  [1/6] Đang chạy Thuật toán Hiện tại của Project (optimizer/)...", end="", flush=True)
    try:
        sol_curr = validate(solve_current_project(raw_payload, vehicles, drivers, orders))
        served_curr = total_orders - len(sol_curr.unassigned_orders)
        rate_curr = (served_curr / total_orders) * 100.0 if total_orders else 0
        veh_used_curr = len([r for r in sol_curr.routes if r.stops])
        pack_str_curr = "PASS" if (sol_curr.is_contract_valid and sol_curr.is_temporally_valid and sol_curr.is_spatial_valid) else "FAIL"
        
        print(f" Xong ({sol_curr.execution_time_sec:.2f}s) - Đơn: {rate_curr:.1f}% ({served_curr}/{total_orders}) | Xe: {veh_used_curr} | Phí: {sol_curr.real_economic_cost_vnd:,.0f}đ | Xếp dỡ: {pack_str_curr}")
        results.append({
            "name": "Project Hiện Tại (FleetRoutingSolver)",
            "runtime": sol_curr.execution_time_sec,
            "vehicles": veh_used_curr,
            "distance": sol_curr.total_distance_km,
            "served_rate": rate_curr,
            "served_count": f"{served_curr}/{total_orders}",
            "cost": sol_curr.real_economic_cost_vnd,
            "packing": pack_str_curr,
        })
    except Exception as e:
        print(f" LỖI: {e}")
        results.append({
            "name": "Project Hiện Tại (FleetRoutingSolver)",
            "runtime": 0.0,
            "vehicles": 0,
            "distance": 0.0,
            "served_rate": 0.0,
            "served_count": f"0/{total_orders}",
            "cost": 0,
            "packing": "ERROR",
        })

    # 2. Genetic Algorithm (GA)
    print("  [2/6] Đang chạy Giải thuật Di truyền (Genetic Algorithm)...", end="", flush=True)
    try:
        ga_solver = GeneticRoutingSolver(
            vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx,
            population_size=15 if is_large else 20,
            generations=20 if is_large else 30,
            time_limit_sec=6.0 if is_large else 4.0,
        )
        sol_ga = validate(ga_solver.solve())
        served_ga = total_orders - len(sol_ga.unassigned_orders)
        rate_ga = (served_ga / total_orders) * 100.0 if total_orders else 0
        veh_used_ga = len([r for r in sol_ga.routes if r.stops])
        pack_str_ga = "PASS" if (sol_ga.is_contract_valid and sol_ga.is_temporally_valid and sol_ga.is_spatial_valid) else "FAIL"
        
        print(f" Xong ({sol_ga.execution_time_sec:.2f}s) - Đơn: {rate_ga:.1f}% ({served_ga}/{total_orders}) | Xe: {veh_used_ga} | Phí: {sol_ga.real_economic_cost_vnd:,.0f}đ | Xếp dỡ: {pack_str_ga}")
        results.append({
            "name": "Genetic Algorithm (GA - LIFO)",
            "runtime": sol_ga.execution_time_sec,
            "vehicles": veh_used_ga,
            "distance": sol_ga.total_distance_km,
            "served_rate": rate_ga,
            "served_count": f"{served_ga}/{total_orders}",
            "cost": sol_ga.real_economic_cost_vnd,
            "packing": pack_str_ga,
        })
    except Exception as e:
        print(f" LỖI: {e}")

    # 3. ALNS (Adaptive Large Neighborhood Search)
    print("  [3/6] Đang chạy ALNS cũ...", end="", flush=True)
    try:
        alns_solver = ALNSSolver(
            vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx,
            max_iterations=100 if is_large else 150,
            time_limit_sec=6.0 if is_large else 5.0,
        )
        sol_alns = validate(alns_solver.solve())
        served_alns = total_orders - len(sol_alns.unassigned_orders)
        rate_alns = (served_alns / total_orders) * 100.0 if total_orders else 0
        veh_used_alns = len([r for r in sol_alns.routes if r.stops])
        pack_str_alns = "PASS" if (sol_alns.is_contract_valid and sol_alns.is_temporally_valid and sol_alns.is_spatial_valid) else "FAIL"
        
        print(f" Xong ({sol_alns.execution_time_sec:.2f}s) - Đơn: {rate_alns:.1f}% ({served_alns}/{total_orders}) | Xe: {veh_used_alns} | Phí: {sol_alns.real_economic_cost_vnd:,.0f}đ | Xếp dỡ: {pack_str_alns}")
        results.append({
            "name": "ALNS (Adaptive Search - LIFO)",
            "runtime": sol_alns.execution_time_sec,
            "vehicles": veh_used_alns,
            "distance": sol_alns.total_distance_km,
            "served_rate": rate_alns,
            "served_count": f"{served_alns}/{total_orders}",
            "cost": sol_alns.real_economic_cost_vnd,
            "packing": pack_str_alns,
        })
    except Exception as e:
        print(f" LỖI: {e}")

    # 4. Packing-aware Hybrid ALNS
    print("  [4/6] Đang chạy Hybrid ALNS...", end="", flush=True)
    try:
        sol_hybrid = solve_hybrid_alns(
            vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx,
            time_limit_sec=6.0 if is_large else 4.0,
            random_seed=0,
        )
        served_hybrid = total_orders - len(sol_hybrid.unassigned_orders)
        rate_hybrid = (served_hybrid / total_orders) * 100.0 if total_orders else 0
        valid_hybrid = sol_hybrid.is_contract_valid and sol_hybrid.is_temporally_valid and sol_hybrid.is_spatial_valid
        print(f" Xong ({sol_hybrid.execution_time_sec:.2f}s) - Đơn: {rate_hybrid:.1f}% ({served_hybrid}/{total_orders}) | Xe: {len(sol_hybrid.routes)} | Phí: {sol_hybrid.real_economic_cost_vnd:,.0f}đ | Validator: {'PASS' if valid_hybrid else 'FAIL'}")
        results.append({
            "name": "Hybrid ALNS (packing-aware)",
            "runtime": sol_hybrid.execution_time_sec,
            "vehicles": len(sol_hybrid.routes),
            "distance": sol_hybrid.total_distance_km,
            "served_rate": rate_hybrid,
            "served_count": f"{served_hybrid}/{total_orders}",
            "cost": sol_hybrid.real_economic_cost_vnd,
            "packing": "PASS" if valid_hybrid else "FAIL",
        })
    except Exception as e:
        print(f" LỖI: {e}")

    # 5. Greedy Cheapest Insertion
    print("  [5/6] Đang chạy Greedy Insertion...", end="", flush=True)
    try:
        sol_greedy = validate(solve_greedy(
            vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx
        ))
        served_greedy = total_orders - len(sol_greedy.unassigned_orders)
        rate_greedy = (served_greedy / total_orders) * 100.0 if total_orders else 0
        veh_used_greedy = len([r for r in sol_greedy.routes if r.stops])
        pack_str_greedy = "PASS" if (sol_greedy.is_contract_valid and sol_greedy.is_temporally_valid and sol_greedy.is_spatial_valid) else "FAIL"
        
        print(f" Xong ({sol_greedy.execution_time_sec:.2f}s) - Đơn: {rate_greedy:.1f}% ({served_greedy}/{total_orders}) | Xe: {veh_used_greedy} | Phí: {sol_greedy.real_economic_cost_vnd:,.0f}đ | Xếp dỡ: {pack_str_greedy}")
        results.append({
            "name": "Greedy Insertion (LIFO)",
            "runtime": sol_greedy.execution_time_sec,
            "vehicles": veh_used_greedy,
            "distance": sol_greedy.total_distance_km,
            "served_rate": rate_greedy,
            "served_count": f"{served_greedy}/{total_orders}",
            "cost": sol_greedy.real_economic_cost_vnd,
            "packing": pack_str_greedy,
        })
    except Exception as e:
        print(f" LỖI: {e}")

    # 6. Google OR-Tools Baseline
    print("  [6/6] Đang chạy Google OR-Tools GLS Baseline...", end="", flush=True)
    try:
        sol_ortools = validate(solve_ortools(
            vehicles, drivers, orders, policy, dist_mat, dur_mat, node_to_idx, max_time_seconds=3
        ))
        served_ortools = total_orders - len(sol_ortools.unassigned_orders)
        rate_ortools = (served_ortools / total_orders) * 100.0 if total_orders else 0
        veh_used_ortools = len([r for r in sol_ortools.routes if r.stops])
        pack_str_ortools = "PASS" if (sol_ortools.is_contract_valid and sol_ortools.is_temporally_valid and sol_ortools.is_spatial_valid) else "FAIL"
        
        print(f" Xong ({sol_ortools.execution_time_sec:.2f}s) - Đơn: {rate_ortools:.1f}% ({served_ortools}/{total_orders}) | Xe: {veh_used_ortools} | Phí: {sol_ortools.real_economic_cost_vnd:,.0f}đ | Xếp dỡ: {pack_str_ortools}")
        results.append({
            "name": "Google OR-Tools Baseline (GLS)",
            "runtime": sol_ortools.execution_time_sec,
            "vehicles": veh_used_ortools,
            "distance": sol_ortools.total_distance_km,
            "served_rate": rate_ortools,
            "served_count": f"{served_ortools}/{total_orders}",
            "cost": sol_ortools.real_economic_cost_vnd,
            "packing": pack_str_ortools,
        })
    except Exception as e:
        print(f" LỖI: {e}")

    return results


def main():
    datasets = [
        # Nhóm 1: 4 chi nhánh thực tế từ database
        ("1. DB Chi nhánh Hà Nội (Miền Bắc)", "algo_lab/datasets/db_hanoi_16_orders.json", False),
        ("2. DB Chi nhánh Sóng Thần (Miền Nam)", "algo_lab/datasets/db_songthan_4_orders.json", False),
        ("3. DB Chi nhánh Nha Trang (Nam Trung Bộ)", "algo_lab/datasets/db_nhatrang_2_orders.json", False),
        ("4. DB Chi nhánh Đà Nẵng (Miền Trung - Quy mô lớn)", "algo_lab/datasets/db_danang_30_orders.json", True),
        # Nhóm 2: Các kịch bản mẫu tổng hợp
        ("5. Kịch bản mẫu: Đơn nhiều kiện (Retail 170 kiện)", "algo_lab/datasets/scenario_1_multi_item.json", False),
        ("6. Kịch bản mẫu: Hàng nặng 25+ tấn (Bắt buộc chia xe)", "algo_lab/datasets/scenario_2_heavy_cargo.json", False),
        ("7. Kịch bản mẫu: Liên tỉnh phân tán rộng (7 tỉnh)", "algo_lab/datasets/scenario_3_dispersed.json", False),
    ]

    all_data_results = {}

    for d_name, d_file, is_large in datasets:
        full_path = os.path.join(project_root, d_file)
        if not os.path.exists(full_path):
            print(f"⚠️ Bỏ qua {d_name}: Không tìm thấy file {full_path}")
            continue
        res = run_benchmark_on_dataset(d_name, full_path, is_large=is_large)
        all_data_results[d_name] = res

    # IN BẢNG BÁO CÁO TỔNG HỢP CHI TIẾT
    print("\n\n" + "#" * 125)
    print("### BẢNG TỔNG HỢP SO SÁNH: THUẬT TOÁN HIỆN TẠI CỦA PROJECT VS CÁC THUẬT TOÁN THỬ NGHIỆM")
    print("### KHẢO SÁT TOÀN DIỆN TRÊN 4 CHI NHÁNH DATABASE & 3 KỊCH BẢN DỮ LIỆU ĐẶC THÙ")
    print("#" * 125)

    header = (
        f"{'BỘ DỮ LIỆU':<35} | "
        f"{'THUẬT TOÁN':<35} | "
        f"{'THỜI GIAN':>9} | "
        f"{'SỐ XE':>6} | "
        f"{'TỶ LỆ ĐƠN':>14} | "
        f"{'CHI PHÍ THỰC TẾ':>16} | "
        f"{'XẾP DỠ'}"
    )
    print(header)
    print("-" * 125)

    for d_name, r_list in all_data_results.items():
        for r in r_list:
            cost_str = f"{r['cost']:,.0f} đ" if r['cost'] > 0 else "0 đ"
            rate_str = f"{r['served_rate']:.1f}% ({r['served_count']})"
            line = (
                f"{d_name[:35]:<35} | "
                f"{r['name'][:35]:<35} | "
                f"{r['runtime']:>8.2f}s | "
                f"{r['vehicles']:>6} | "
                f"{rate_str:>14} | "
                f"{cost_str:>16} | "
                f"{r['packing']}"
            )
            print(line)
        print("-" * 125)


if __name__ == "__main__":
    main()
