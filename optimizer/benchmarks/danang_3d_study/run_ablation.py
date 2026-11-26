"""Run and compare multiple 3D-aware routing methods on the Da Nang 150-order dataset."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.models import FleetOptimizationRequest
from benchmarks.danang_3d_study.methods import (
    run_cross_route_savings_3d,
    run_ortools_pdptw_repair,
    run_prod_hybrid_alns,
    run_spatial_regret_insertion,
    summarize_response,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=15.0, help="Per-method time budget in seconds")
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    dataset_path = here / "dataset_danang_150_3d.json"
    raw = json.loads(dataset_path.read_text(encoding="utf-8"))
    request = FleetOptimizationRequest(**raw)

    runners = [
        ("1_prod_hybrid_alns", run_prod_hybrid_alns),
        ("2_ortools_pdptw_repair", run_ortools_pdptw_repair),
        ("3_cross_route_savings_3d", run_cross_route_savings_3d),
        ("4_spatial_regret_insertion", run_spatial_regret_insertion),
    ]

    results = []
    for name, fn in runners:
        print(f"Running {name} (budget={args.budget}s)...", flush=True)
        resp, elapsed = fn(request, args.budget)
        summary = summarize_response(name, resp, elapsed)
        results.append(summary)
        print(" ->", summary, flush=True)

    (here / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== SUMMARY ===")
    header = (
        f"{'Method':<28} {'Served':>6} {'Routes':>6} {'Days':>4} "
        f"{'Dist(km)':>9} {'OpCost(đ)':>12} {'Score(đ)':>12} {'Peak>1':>6} {'MaxPk':>5} {'Time(s)':>7}"
    )
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r['method']:<28} {r['served_orders']:>6} {r['routes']:>6} {str(r['span_days']):>4} "
            f"{r['total_distance_km']:>9.1f} {str(r['operating_cost_vnd']):>12} {str(r['selection_score_vnd']):>12} "
            f"{r['peaks_gt_1']:>6} {r['max_peak']:>5} {r['elapsed_sec']:>7.2f}"
        )


if __name__ == "__main__":
    main()
