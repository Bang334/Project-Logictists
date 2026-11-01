"""Run the daytime multi-day benchmark for the 5 compared engines.

Every fixture in ``benchmarks/cases`` is normalized to branch daytime shifts
(default 08:00-17:00 per service day, no night driving, carry-over to later
days allowed) by :mod:`daytime_cases`, then audited and re-costed uniformly by
:mod:`unified_audit`.

Usage (from ``optimizer/``)::

    .venv/Scripts/python.exe -m benchmarks.algorithm_comparison.run_daytime_benchmark \
        --budget 2.0 --seeds 0 1 2 [--cases day_novel_1 ...] [--engines "Hybrid ALNS" ILS]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from typing import Iterable, List, Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.ils_engine import PackingAwareILSOptimizer
from app.models import FleetOptimizationRequest
from benchmarks.algorithm_comparison.algo1_hybrid_genetic import _HGSEngine
from benchmarks.algorithm_comparison.algo2_set_partitioning import _GVNSPoolEngine
from benchmarks.algorithm_comparison.algo3_cp_sat_benders import _CASAILSEngine
from benchmarks.algorithm_comparison.common import convert_request_to_hybrid
from benchmarks.algorithm_comparison.benchmark_selection import load_selection
from benchmarks.algorithm_comparison.benchmark_objective import PRODUCTION_PROFILE
from benchmarks.algorithm_comparison.daytime_cases import (
    DaytimeShift,
    describe_case,
    list_case_files,
    load_daytime_case,
    parse_clock,
)
from benchmarks.algorithm_comparison.unified_audit import audit_solution

ENGINES = ["Hybrid ALNS", "ILS", "HGS", "GVNS-Pool", "CASA-ILS"]
DEFAULT_OUTPUT = ROOT / "benchmarks" / "algorithm_comparison" / "experiments" / "daytime_latest.json"


def _experiment_fingerprint(budget: float, shift: DaytimeShift) -> str:
    """Resume only identical code, fixtures, dependencies and objective policy."""
    digest = hashlib.sha256()
    metadata = {
        "objective_profile": PRODUCTION_PROFILE, "budget": budget,
        "shift": [shift.open_sec, shift.close_sec], "python": sys.version,
        "packages": {name: version(name) for name in ("ortools", "pydantic", "numpy", "scipy")},
    }
    digest.update(json.dumps(metadata, sort_keys=True).encode("utf-8"))
    sources = sorted([*(ROOT / "app").rglob("*.py"),
        *(ROOT / "benchmarks" / "algorithm_comparison").rglob("*.py"),
        *(ROOT / "benchmarks" / "cases").glob("*.json")])
    for source in sources:
        digest.update(source.relative_to(ROOT).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _solve(request: FleetOptimizationRequest, engine: str, budget: float, seed: int):
    if engine == "Hybrid ALNS":
        return PackingAwareHybridALNSOptimizer(request, time_budget_seconds=budget, random_seed=seed,
            include_benchmarks=False).solve(), False
    if engine == "ILS":
        return PackingAwareILSOptimizer(request, time_budget_seconds=budget, random_seed=seed,
            include_benchmarks=False).solve(), False

    args = convert_request_to_hybrid(request)
    spatial_limit = min(3.0, max(2.0, budget * 0.3))
    repair_limit = min(4.0, max(2.5, budget * 0.4))
    if engine == "HGS":
        solver = _HGSEngine(*args, time_limit_sec=budget, max_iterations=400, random_seed=seed,
                            final_spatial_time_limit_sec=spatial_limit)
    elif engine == "GVNS-Pool":
        solver = _GVNSPoolEngine(*args, time_limit_sec=budget, max_iterations=350, random_seed=seed + 7,
                                 final_spatial_time_limit_sec=spatial_limit,
                                 final_repair_time_limit_sec=repair_limit,
                                 max_elite_audit_candidates=8)
    elif engine == "CASA-ILS":
        solver = _CASAILSEngine(*args, time_limit_sec=budget, max_iterations=350, random_seed=seed + 19,
                                final_spatial_time_limit_sec=spatial_limit,
                                final_repair_time_limit_sec=repair_limit,
                                max_elite_audit_candidates=8)
    else:
        raise ValueError(f"unknown engine {engine}")
    return solver.solve(), True


def run_single(
    request: FleetOptimizationRequest,
    engine: str,
    budget: float,
    seed: int,
    shift: DaytimeShift,
) -> dict:
    started = time.perf_counter()
    plan, is_raw_hybrid = _solve(request, engine, budget, seed)
    solve_wall = round(time.perf_counter() - started, 3)
    audit = audit_solution(request, plan, is_raw_hybrid, shift)
    return {"solve_wall_seconds": solve_wall, "includes_dedicated_baseline": False, **audit}


def _select_cases(filters: Sequence[str]) -> List[str]:
    files = list_case_files()
    if not filters:
        return files
    return [name for name in files if any(token in "day_" + name for token in filters)]


def _format_row(row: dict) -> str:
    if "error" in row:
        return f"ERROR: {row['error']}"
    cost = row["cost_vnd"]
    cost_text = f"{cost:,d}" if isinstance(cost, int) else "n/a"
    return (
        f"served {row['served_requests']}/{row['total_requests']}, routes {row['routes']}, "
        f"days {row['service_days_used']}, cost {cost_text} VND, solve {row['solve_wall_seconds']:.2f}s, "
        f"spatial {row['spatial_valid']}, schedule {row['basic_schedule_valid']}"
    )


def _safe_write_json(path: Path, data: list) -> None:
    resolved = path.resolve()
    temp_path = resolved.with_suffix(".tmp")
    text = json.dumps(data, ensure_ascii=False, indent=2)
    for attempt in range(5):
        try:
            temp_path.write_text(text, encoding="utf-8")
            temp_path.replace(resolved)
            return
        except OSError:
            time.sleep(0.1 * (attempt + 1))
    resolved.write_text(text, encoding="utf-8")


def run_benchmark(
    case_files: Iterable[str],
    engines: Sequence[str],
    seeds: Sequence[int],
    budget: float,
    shift: DaytimeShift,
    output: Path,
) -> List[dict]:
    resolved_output = output.resolve()
    resolved_output.parent.mkdir(parents=True, exist_ok=True)
    trials: List[dict] = []
    completed_keys = set()
    fingerprint = _experiment_fingerprint(budget, shift)
    if resolved_output.exists():
        try:
            loaded = json.loads(resolved_output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Cannot resume {resolved_output}: {error}") from error
        if not isinstance(loaded, list):
            raise ValueError("Resume file must contain a list of trials")
        for row in loaded:
            if (not isinstance(row, dict) or row.get("experiment_fingerprint") != fingerprint
                or row.get("objective_profile") != PRODUCTION_PROFILE):
                raise ValueError("Output belongs to a different experiment (code/fixtures/budget/shift/objective). Use a new --output file.")
            key = (row["case"], row["algorithm"], row["seed"])
            if key in completed_keys:
                raise ValueError(f"Duplicate trial in resume file: {key}")
            completed_keys.add(key)
        trials = loaded
        print(f"Resuming benchmark: loaded {len(trials)} matching trials from {resolved_output}", flush=True)

    for case_file in case_files:
        case = load_daytime_case(case_file, shift)
        print(f"\n>> {describe_case(case)}", flush=True)
        for seed in seeds:
            for engine in engines:
                if (case.name, engine, seed) in completed_keys:
                    continue
                row = {"case": case.name, "algorithm": engine, "seed": seed, "budget": budget,
                       "objective_profile": PRODUCTION_PROFILE, "experiment_fingerprint": fingerprint,
                       "shift_open_sec": shift.open_sec, "shift_close_sec": shift.close_sec,
                       "service_days_available": case.service_days}
                try:
                    row.update(run_single(case.request, engine, budget, seed, shift))
                except Exception as error:  # recorded per trial, never hidden
                    row["error"] = f"{type(error).__name__}: {error}"
                print(f"  [{engine:11s} | seed {seed}] {_format_row(row)}", flush=True)
                trials.append(row)
                completed_keys.add((case.name, engine, seed))
                _safe_write_json(resolved_output, trials)
    if _experiment_fingerprint(budget, shift) != fingerprint:
        raise RuntimeError("Code or fixtures changed during the run; results must not be treated as one fixed experiment")
    return trials


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--budget", type=float, default=2.0)
    parser.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    parser.add_argument("--cases", nargs="*", default=[], help="substring filters on day_<file> names")
    parser.add_argument("--engines", nargs="*", default=ENGINES, choices=ENGINES)
    parser.add_argument("--selection-file", type=Path, help="INI file with [cases]/[engines] 0/1 switches")
    parser.add_argument("--dry-run", action="store_true", help="show selected trials without running solvers or writing output")
    parser.add_argument("--shift-open", default="08:00")
    parser.add_argument("--shift-close", default="17:00")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args(argv)

    shift = DaytimeShift(parse_clock(args.shift_open), parse_clock(args.shift_close))
    case_files = _select_cases(args.cases)
    if args.selection_file:
        try:
            selected_cases, selected_engines = load_selection(args.selection_file, list_case_files(), ENGINES)
        except ValueError as error:
            parser.error(str(error))
        case_files = [case for case in selected_cases if case in case_files]
        args.engines = [engine for engine in selected_engines if engine in args.engines]
    if not case_files or not args.engines:
        parser.error("Selection is empty: enable at least one case and one engine; check CLI filters too")
    if args.output is None:
        if args.selection_file:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
            args.output = DEFAULT_OUTPUT.with_name(f"daytime_selected_{stamp}.json")
        else:
            args.output = DEFAULT_OUTPUT
    total = len(case_files) * len(args.seeds) * len(args.engines)
    print(f"=== Daytime benchmark: {len(case_files)} cases x {len(args.seeds)} seeds x "
          f"{len(args.engines)} engines = {total} trials, budget {args.budget}s ===", flush=True)
    print("Cases: " + ", ".join(case_files), flush=True)
    print("Engines: " + ", ".join(args.engines), flush=True)
    print(f"Output: {args.output}", flush=True)
    if args.dry_run:
        return
    run_benchmark(case_files, args.engines, args.seeds, args.budget, shift, args.output)
    print(f"\nSaved {total} trials to {args.output}", flush=True)


if __name__ == "__main__":
    main()
