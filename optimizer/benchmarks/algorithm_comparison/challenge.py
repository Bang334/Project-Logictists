"""Find reproducible challenger wins without treating partial plans as cheap wins.

Input is the per-trial audit JSON, not a table of hand-entered target scores.
Only identical case/seed/search-budget trials can compete. Cost comparisons
are operating-cost challenges after coverage, grouping and route count.
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

from .benchmark_objective import Trial


def find_challenges(trials: List[Trial], reference: str = "Hybrid ALNS") -> List[dict]:
    if len({trial.objective_profile for trial in trials}) > 1:
        raise ValueError("Cannot mix objective profiles in one comparison")
    groups: Dict[Tuple[str,int,float], List[Trial]] = defaultdict(list)
    for trial in trials:
        groups[(trial.case, trial.seed, trial.budget)].append(trial)
    findings = []
    for (case,seed,budget), rows in sorted(groups.items()):
        incumbents = [r for r in rows if r.algorithm == reference]
        if len(incumbents) != 1:
            raise ValueError(f"Expected one {reference} trial for {case}, seed {seed}, budget {budget}")
        incumbent = incumbents[0]
        candidates = [r for r in rows if r.algorithm != reference and r.verified]
        if not candidates:
            continue
        best = min(candidates, key=lambda r: r.key)
        if incumbent.verified and best.key >= incumbent.key:
            continue
        dimension = "verified_full_service"
        if incumbent.verified:
            dimension = next(name for name,a,b in zip(
                incumbent.dimension_names, incumbent.key, best.key) if a != b)
        findings.append({"case":case,"seed":seed,"budget":budget,
            "reference":reference,"challenger":best.algorithm,"dimension":dimension,
            "reference_verified":incumbent.verified,"reference_key":list(incumbent.key) if incumbent.verified else None,
            "challenger_key":list(best.key),
            "operating_cost_gap_vnd":incumbent.cost_vnd-best.cost_vnd if incumbent.verified else None})
    return findings


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference", default="Hybrid ALNS")
    args=parser.parse_args()
    payload=json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(payload,list):
        raise ValueError("Expected a list of audited trials")
    failed_runs=[row for row in payload if "error" in row]
    trials=[Trial.model_validate(row) for row in payload if "error" not in row]
    output={"reference":args.reference,"trial_count":len(trials),
        "failed_run_count":len(failed_runs),"challenges":find_challenges(trials,args.reference)}
    args.output.write_text(json.dumps(output,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"{len(output['challenges'])} challenger wins across {len(trials)} audited trials")


if __name__ == "__main__":
    main()
