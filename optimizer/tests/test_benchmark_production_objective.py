"""Every engine is compared using one audited production objective."""
import pytest

from app.models import PlanningObjectiveBreakdown
from benchmarks.algorithm_comparison.challenge import Trial, find_challenges
from benchmarks.algorithm_comparison.summarize_daytime import compare


def row(algorithm, cost=1000, salary=900):
    objective = PlanningObjectiveBreakdown(
        planning_span_days=1, operating_cost_vnd=cost,
        driver_active_salary_allocation_vnd=salary, driver_calendar_salary_vnd=1000,
        driver_idle_salary_allocation_vnd=1000-salary,
        selection_score_vnd=cost-salary+1000,
        active_route_count=2, physical_vehicle_count=2,
    )
    return dict(case="objective-tradeoff",algorithm=algorithm,seed=0,budget=2,
        objective_profile="production_v1",production_objective=objective.model_dump(),
        served_requests=3,total_requests=3,delivered_packages=7,total_packages=7,
        routes=2,physical_vehicles=2,extra_order_trips=0,cost_vnd=cost,
        complete_manifest=True,unique_balanced_manifest=True,
        spatial_valid=True,basic_schedule_valid=True)


def test_production_comparison_keeps_operating_cost_tradeoff_visible():
    result = compare([row("Hybrid ALNS"),row("ILS",500,0)])[0]
    assert result["outcome"] == "WIN"
    assert result["operating_outcome"] == "LOSS"
    assert result["cost_gap_vnd"] == 500
    assert not find_challenges([Trial.model_validate(row("Hybrid ALNS")),Trial.model_validate(row("ILS",500,0))])


def test_legacy_files_keep_their_original_operating_cost_ranking():
    trials = [row("Hybrid ALNS"),row("ILS",500,0)]
    for trial in trials:
        trial.pop("objective_profile")
        trial.pop("production_objective")
    assert compare(trials)[0]["outcome"] == "LOSS"


@pytest.mark.parametrize("problem", ["mixed_profile", "mixed_budget", "mixed_snapshot", "duplicate"])
def test_summary_rejects_incomparable_or_duplicate_trials(problem):
    trials = [row("Hybrid ALNS"),row("ILS",500,0)]
    if problem == "mixed_profile":
        trials[1].pop("objective_profile")
        trials[1].pop("production_objective")
    elif problem == "mixed_budget":
        trials[1]["budget"] = 10
    elif problem == "mixed_snapshot":
        trials[0]["experiment_fingerprint"] = "snapshot-before"
        trials[1]["experiment_fingerprint"] = "snapshot-after"
    else:
        trials.append(dict(trials[0]))
    with pytest.raises(ValueError):
        compare(trials)


def test_production_profile_cannot_fall_back_to_zero_or_operating_cost_when_score_is_missing():
    data = row("Hybrid ALNS")
    data.pop("production_objective")
    with pytest.raises(ValueError):
        Trial.model_validate(data)


@pytest.mark.parametrize("engine", ["Hybrid ALNS", "ILS", "HGS", "GVNS-Pool", "CASA-ILS"])
def test_all_engines_receive_a_uniform_audited_production_objective(engine):
    from benchmarks.algorithm_comparison.daytime_cases import DaytimeShift
    from benchmarks.algorithm_comparison.run_daytime_benchmark import run_single
    from test_benchmark_contract import comparison_request
    request = comparison_request()
    request.vehicles[0].source_vehicle_id = "physical-vehicle"
    request.vehicles[0].available_start_sec = 8*3600
    request.vehicles[0].available_end_sec = 17*3600
    request.drivers[0].source_driver_id = "physical-driver"
    request.drivers[0].fixed_salary_monthly_vnd = 1_000_000
    audit = run_single(request,engine,.05,0,DaytimeShift())
    assert audit["complete_manifest"]
    assert audit["spatial_valid"] and audit["basic_schedule_valid"]
    assert audit["objective_profile"] == "production_v1"
    objective = audit["production_objective"]
    assert objective["operating_cost_vnd"] == audit["cost_vnd"]
    assert objective["active_route_count"] == audit["routes"]
    assert objective["selection_score_vnd"] == (audit["cost_vnd"]
        - objective["driver_active_salary_allocation_vnd"]
        + objective["driver_calendar_salary_vnd"] + objective["operational_late_penalty_vnd"])


def test_raw_missing_manifest_is_not_filled_in_by_the_auditor():
    from benchmarks.algorithm_comparison.common import convert_request_to_hybrid
    from app.hybrid_alns.greedy_insertion import solve_greedy
    from benchmarks.algorithm_comparison.daytime_cases import DaytimeShift
    from benchmarks.algorithm_comparison.unified_audit import audit_solution
    from test_benchmark_contract import comparison_request
    request = comparison_request()
    request.vehicles[0].available_start_sec = 8*3600
    request.vehicles[0].available_end_sec = 17*3600
    plan = solve_greedy(*convert_request_to_hybrid(request))
    pickup = next(stop for route in plan.routes for stop in route.stops if stop.stop_type == "PICKUP")
    pickup.items_loaded = []
    audit = audit_solution(request,plan,True,DaytimeShift())
    assert not audit["complete_manifest"]
