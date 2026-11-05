import pytest

from benchmarks.algorithm_comparison.challenge import Trial, find_challenges


def trial(algorithm, **changes):
    data=dict(case="generated-case",algorithm=algorithm,seed=1,budget=2,
        served_requests=3,total_requests=3,delivered_packages=7,total_packages=7,
        routes=2,extra_order_trips=0,cost_vnd=100,complete_manifest=True,
        unique_balanced_manifest=True,spatial_valid=True,basic_schedule_valid=True)
    return Trial.model_validate({**data,**changes})


def test_partial_or_unverified_cheaper_plan_is_not_a_challenger_win():
    assert find_challenges([trial("Hybrid ALNS"),trial("HGS",cost_vnd=1,
        served_requests=2,complete_manifest=False),trial("ILS",cost_vnd=2,spatial_valid=False)]) == []


def test_grouping_then_trip_count_take_priority_over_lower_cost():
    findings=find_challenges([trial("Hybrid ALNS",extra_order_trips=1,cost_vnd=10),
        trial("HGS",routes=1,cost_vnd=1000),trial("ILS",extra_order_trips=2,cost_vnd=1)])
    assert findings[0]["challenger"] == "HGS"
    assert findings[0]["dimension"] == "extra_order_trips"


def test_cost_challenge_requires_same_higher_priority_metrics():
    result=find_challenges([trial("Hybrid ALNS"),trial("HGS",cost_vnd=90)])
    assert result[0]["dimension"] == "operating_cost_vnd"
    assert result[0]["operating_cost_gap_vnd"] == 10


def test_different_search_budgets_are_never_compared_as_one_trial():
    with pytest.raises(ValueError,match="Expected one"):
        find_challenges([trial("Hybrid ALNS"),trial("HGS",budget=20,cost_vnd=1)])
