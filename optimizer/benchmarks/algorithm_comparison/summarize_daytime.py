"""Summarize daytime benchmark trials: Hybrid ALNS versus the best challenger.

Ranking key per trial (lower is better), aligned with the production
lexicographic objective: audit failure, unserved requests, extra order trips,
active routes, then the audited production key. Historical files without an
objective profile keep their original operating-cost ranking.

Usage (from ``optimizer/``)::

    .venv/Scripts/python.exe -m benchmarks.algorithm_comparison.summarize_daytime [path.json]
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from benchmarks.algorithm_comparison.run_daytime_benchmark import DEFAULT_OUTPUT, ENGINES
from benchmarks.algorithm_comparison.benchmark_objective import LEGACY_PROFILE, PRODUCTION_PROFILE, Trial

REFERENCE_ENGINE = "Hybrid ALNS"


def is_audit_valid(row: dict) -> bool:
    flags_valid = (
        "error" not in row
        and row.get("spatial_valid", False)
        and row.get("basic_schedule_valid", False)
        and row.get("unique_balanced_manifest", False)
        and isinstance(row.get("cost_vnd"), int)
    )
    return bool(flags_valid and Trial.model_validate(row).audit_valid)


def rank_key(row: dict, *, operating: bool = False) -> Tuple:
    if not is_audit_valid(row):
        return (1,)
    trial = Trial.model_validate(row)
    return (
        0,
        trial.total_requests - trial.served_requests,
        *(trial.operating_key if operating else trial.key),
    )


def _group(trials: Sequence[dict]) -> Dict[Tuple[str, int], Dict[str, dict]]:
    if len({row.get("objective_profile", LEGACY_PROFILE) for row in trials}) > 1:
        raise ValueError("Cannot mix objective profiles in one comparison")
    if len({row["budget"] for row in trials}) > 1:
        raise ValueError("Cannot mix search budgets in one comparison")
    if len({row.get("experiment_fingerprint") for row in trials}) > 1:
        raise ValueError("Cannot mix experiment snapshots in one comparison")
    grouped: Dict[Tuple[str, int], Dict[str, dict]] = defaultdict(dict)
    for row in trials:
        if row["algorithm"] in grouped[(row["case"], row["seed"])]:
            raise ValueError(f"Duplicate trial: {row['case']}, seed {row['seed']}, {row['algorithm']}")
        grouped[(row["case"], row["seed"])][row["algorithm"]] = row
    return grouped


def compare(trials: Sequence[dict]) -> List[dict]:
    rows = []
    for (case, seed), by_engine in sorted(_group(trials).items()):
        reference = by_engine.get(REFERENCE_ENGINE)
        challengers = [r for name, r in by_engine.items() if name != REFERENCE_ENGINE]
        if reference is None or not challengers:
            continue
        best = min(challengers, key=rank_key)
        ref_key, best_key = rank_key(reference), rank_key(best)
        outcome = "WIN" if ref_key < best_key else "TIE" if ref_key == best_key else "LOSS"
        best_operating = min(challengers, key=lambda row: rank_key(row, operating=True))
        ref_operating = rank_key(reference, operating=True)
        challenger_operating = rank_key(best_operating, operating=True)
        operating_outcome = ("WIN" if ref_operating < challenger_operating else
            "TIE" if ref_operating == challenger_operating else "LOSS")
        gap: Optional[int] = None
        if is_audit_valid(reference) and is_audit_valid(best):
            gap = reference["cost_vnd"] - best["cost_vnd"]
        rows.append({
            "case": case, "seed": seed, "outcome": outcome,
            "hybrid_key": ref_key, "best_challenger": best["algorithm"], "challenger_key": best_key,
            "cost_gap_vnd": gap,
            "objective_profile": reference.get("objective_profile", LEGACY_PROFILE),
            "operating_outcome": operating_outcome,
            "best_operating_challenger": best_operating["algorithm"],
            "operating_cost_gap_vnd": (reference["cost_vnd"] - best_operating["cost_vnd"]
                if is_audit_valid(reference) and is_audit_valid(best_operating) else None),
        })
    return rows


def engine_scoreboard(trials: Sequence[dict]) -> Dict[str, dict]:
    board = {name: {"valid": 0, "trials": 0, "fully_served": 0, "best": 0} for name in ENGINES}
    for by_engine in _group(trials).values():
        best_key = min(rank_key(r) for r in by_engine.values())
        for name, row in by_engine.items():
            stats = board.setdefault(name, {"valid": 0, "trials": 0, "fully_served": 0, "best": 0})
            stats["trials"] += 1
            stats["valid"] += int(is_audit_valid(row))
            stats["fully_served"] += int(is_audit_valid(row) and row["served_requests"] == row["total_requests"])
            stats["best"] += int(is_audit_valid(row) and rank_key(row) == best_key)
    return board


def _fmt_key(key: Tuple) -> str:
    if key[0]:
        return "INVALID"
    if len(key) == 7:
        return (f"unserved {key[1]}, extra {key[2]}, routes {key[3]}, "
            f"score {key[4]:,d}, operating {key[5]:,d} VND, physical {key[6]}")
    return f"unserved {key[1]}, extra {key[2]}, routes {key[3]}, {key[4]:,d} VND"


def render_markdown(trials: Sequence[dict]) -> str:
    comparison = compare(trials)
    production = any(row["objective_profile"] == PRODUCTION_PROFILE for row in comparison)
    profile = "production_v1: selection score, operating cost, physical vehicles" if production else "legacy: operating cost"
    lines = [f"Tiêu chí: audit → coverage → grouping → routes → {profile}.", "",
             "| Testcase | Seed | KQ | Hybrid ALNS | Đối thủ tốt nhất | Đối thủ | Δ operating vs đối thủ này (VND) |",
             "|---|:---:|:---:|---|:---:|---|---:|"]
    for row in comparison:
        gap = "" if row["cost_gap_vnd"] is None else f"{row['cost_gap_vnd']:+,d}"
        lines.append(
            f"| `{row['case']}` | {row['seed']} | {row['outcome']} | {_fmt_key(row['hybrid_key'])} | "
            f"{row['best_challenger']} | {_fmt_key(row['challenger_key'])} | {gap} |"
        )
    counts = defaultdict(int)
    for row in comparison:
        counts[row["outcome"]] += 1
    lines.append("")
    lines.append(f"Hybrid ALNS: WIN {counts['WIN']}, TIE {counts['TIE']}, LOSS {counts['LOSS']} / {len(comparison)}")
    if production:
        operating_counts = defaultdict(int)
        for row in comparison:
            operating_counts[row["operating_outcome"]] += 1
        lines.append(f"Operating cost riêng (giữ coverage/grouping/routes): WIN {operating_counts['WIN']}, "
            f"TIE {operating_counts['TIE']}, LOSS {operating_counts['LOSS']}")
        tradeoffs = [row for row in comparison if row["outcome"] != row["operating_outcome"]]
        if tradeoffs:
            lines.extend(["", "| Testcase | Seed | Production | Operating | Đối thủ operating | Δ operating (VND) |",
                "|---|---:|---|---|---|---:|"])
            for row in tradeoffs:
                gap = row["operating_cost_gap_vnd"]
                lines.append(f"| `{row['case']}` | {row['seed']} | {row['outcome']} | {row['operating_outcome']} | "
                    f"{row['best_operating_challenger']} | {gap:+,d} |" if gap is not None else
                    f"| `{row['case']}` | {row['seed']} | {row['outcome']} | {row['operating_outcome']} | n/a | n/a |")
    lines.append("")
    lines.append("| Engine | Hợp lệ | Giao đủ | Tốt nhất (kể cả hòa) |")
    lines.append("|---|---:|---:|---:|")
    for name, stats in engine_scoreboard(trials).items():
        lines.append(f"| {name} | {stats['valid']}/{stats['trials']} | {stats['fully_served']}/{stats['trials']} | {stats['best']} |")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    path = Path(args[0]) if args else DEFAULT_OUTPUT
    trials = json.loads(path.read_text(encoding="utf-8"))
    print(render_markdown(trials))


if __name__ == "__main__":
    main()
