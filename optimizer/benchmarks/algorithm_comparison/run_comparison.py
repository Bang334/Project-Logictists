"""Benchmark runner comparing all 4 algorithms on TMS datasets.

Algorithms evaluated:
0. Production Packing-aware Hybrid ALNS (Optimized)
1. Hybrid Genetic Search (HGS / Packing-aware Memetic)
2. Route Pool Generation + CP-SAT Set Partitioning Matheuristic
3. Logic-based Benders Decomposition (CP-SAT with Spatial Lazy Cuts)
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
from typing import Dict, List

# Ensure project root is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
OPTIMIZER_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(OPTIMIZER_DIR))

from app.models import FleetOptimizationRequest
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.planning_objective import apply_planning_objective

from benchmarks.algorithm_comparison.common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
)
from benchmarks.algorithm_comparison.algo1_hybrid_genetic import PackingAwareHGS
from benchmarks.algorithm_comparison.algo2_set_partitioning import SetPartitioningMatheuristic
from benchmarks.algorithm_comparison.algo3_cp_sat_benders import LogicBasedBendersOptimizer

CASES_DIR = OPTIMIZER_DIR / "benchmarks" / "cases"
DEFAULT_TEST_CASES = [
    "db_nhatrang_2_orders.json",
    "db_songthan_4_orders.json",
    "scenario_1_multi_item.json",
    "scenario_2_heavy_cargo.json",
]


def run_production_hybrid(request: FleetOptimizationRequest, case_file: str, time_limit_sec: float) -> BenchmarkMetric:
    started_at = time.perf_counter()
    optimizer = PackingAwareHybridALNSOptimizer(
        request,
        time_budget_seconds=time_limit_sec,
        random_seed=0,
    )
    plan = optimizer.solve()
    apply_planning_objective(request, plan)
    elapsed = round(time.perf_counter() - started_at, 3)

    all_spatial_pass = all(
        r.spatial_validation and r.spatial_validation.is_valid
        for r in plan.routes
    )
    served = len(request.orders) - len(plan.unassigned_orders)
    fulfillment = (served / max(1, len(request.orders))) * 100.0

    return BenchmarkMetric(
        algorithm_name="0. Production Hybrid ALNS",
        case_file=case_file,
        status="SUCCESS" if not plan.unassigned_orders and all_spatial_pass else "PARTIAL",
        orders_served=served,
        total_orders=len(request.orders),
        fulfillment_rate_pct=round(fulfillment, 1),
        vehicles_used=len(plan.routes),
        total_cost_vnd=plan.total_cost_vnd,
        selection_score_vnd=plan.planning_objective.selection_score_vnd if plan.planning_objective else plan.total_cost_vnd,
        total_distance_km=round(plan.total_distance_km, 2),
        runtime_sec=elapsed,
        spatial_audit_pass=all_spatial_pass,
        diagnostic="Production Optimized Engine",
    )


def print_comparison_table(metrics: List[BenchmarkMetric]):
    header = f"{'Algorithm':<36} | {'Case':<22} | {'Served':<8} | {'Vehs':<5} | {'Cost (VND)':<12} | {'Dist (km)':<9} | {'Time (s)':<8} | {'Spatial':<8}"
    separator = "-" * len(header)
    print("\n" + separator)
    print(header)
    print(separator)
    for m in metrics:
        spatial_str = "PASS" if m.spatial_audit_pass else "FAIL"
        served_str = f"{m.orders_served}/{m.total_orders}"
        print(
            f"{m.algorithm_name:<36} | {m.case_file:<22} | {served_str:<8} | {m.vehicles_used:<5} | "
            f"{m.total_cost_vnd:<12,d} | {m.total_distance_km:<9.1f} | {m.runtime_sec:<8.2f} | {spatial_str:<8}"
        )
    print(separator + "\n")


def main():
    parser = argparse.ArgumentParser(description="Run comparison benchmark across 4 TMS algorithms.")
    parser.add_argument("--cases", nargs="*", default=DEFAULT_TEST_CASES, help="Case files to test")
    parser.add_argument("--time-limit", type=float, default=6.0, help="Per-algorithm budget in seconds")
    parser.add_argument("--output", type=str, default="comparison_results.json", help="Output JSON path")
    args = parser.parse_args()

    results: List[BenchmarkMetric] = []

    for case_file in args.cases:
        case_path = CASES_DIR / case_file
        if not case_path.exists():
            print(f"Skipping missing case: {case_file}")
            continue

        print(f"\n=======================================================")
        print(f"== BENCHMARKING CASE: {case_file} (Time limit: {args.time_limit}s)")
        print(f"=======================================================")

        payload = json.loads(case_path.read_text(encoding="utf-8"))
        payload.pop("scenario_profile", None)
        request = FleetOptimizationRequest.model_validate(payload)

        # 0. Production Hybrid ALNS (Optimized)
        print("-> Running 0. Production Hybrid ALNS...")
        try:
            m0 = run_production_hybrid(request, case_file, args.time_limit)
            results.append(m0)
        except Exception as exc:
            print(f"   Error: {exc}")

        # 1. Hybrid Genetic Search (HGS)
        print("-> Running 1. Hybrid Genetic Search (HGS)...")
        try:
            m1 = PackingAwareHGS(request, time_limit_sec=args.time_limit).solve(case_file)
            results.append(m1)
        except Exception as exc:
            print(f"   Error: {exc}")

        # 2. Set Partitioning Matheuristic
        print("-> Running 2. Set Partitioning Matheuristic...")
        try:
            m2 = SetPartitioningMatheuristic(request, time_limit_sec=args.time_limit).solve(case_file)
            results.append(m2)
        except Exception as exc:
            print(f"   Error: {exc}")

        # 3. Logic-based Benders Decomposition
        print("-> Running 3. Logic-based Benders Decomposition...")
        try:
            m3 = LogicBasedBendersOptimizer(request, time_limit_sec=args.time_limit).solve(case_file)
            results.append(m3)
        except Exception as exc:
            print(f"   Error: {exc}")

    print_comparison_table(results)

    # Save to JSON
    output_path = SCRIPT_DIR / args.output
    output_path.write_text(
        json.dumps([m.to_dict() for m in results], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Results successfully saved to: {output_path}")


if __name__ == "__main__":
    main()
