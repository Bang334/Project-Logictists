from app.search_policy import (
    SearchProgressTracker,
    calculate_search_policy,
)


def test_small_job_uses_two_short_searches():
    policy = calculate_search_policy(
        order_count=2,
        item_count=2,
        physical_vehicle_count=1,
        virtual_vehicle_count=7,
        requested_max_time_seconds=120,
    )

    assert policy.time_budget_seconds == 3
    assert policy.strategy_count == 2
    assert 0 < policy.stagnation_seconds < policy.time_budget_seconds
    assert policy.routing_budget_share == 0.60
    assert policy.validation_budget_share == 0.25
    assert policy.consolidation_budget_share == 0.15


def test_search_budget_increases_with_complexity_and_is_capped_at_two_minutes():
    small = calculate_search_policy(
        order_count=2,
        item_count=2,
        physical_vehicle_count=1,
        virtual_vehicle_count=7,
        requested_max_time_seconds=120,
    )
    medium = calculate_search_policy(
        order_count=20,
        item_count=30,
        physical_vehicle_count=5,
        virtual_vehicle_count=35,
        requested_max_time_seconds=120,
    )
    large = calculate_search_policy(
        order_count=200,
        item_count=400,
        physical_vehicle_count=20,
        virtual_vehicle_count=140,
        requested_max_time_seconds=120,
    )

    assert small.time_budget_seconds < medium.time_budget_seconds < large.time_budget_seconds
    assert medium.time_budget_seconds == 49
    assert medium.strategy_count >= 3
    assert large.time_budget_seconds == 120
    assert large.strategy_count == 6
    assert small.routing_budget_share < medium.routing_budget_share < large.routing_budget_share
    for policy in (small, medium, large):
        assert round(
            policy.routing_budget_share
            + policy.validation_budget_share
            + policy.consolidation_budget_share,
            2,
        ) == 1.0


def test_nha_trang_two_orders_with_nine_packages_gets_more_validation_budget():
    policy = calculate_search_policy(
        order_count=2,
        item_count=9,
        physical_vehicle_count=1,
        virtual_vehicle_count=7,
        requested_max_time_seconds=120,
    )

    assert policy.time_budget_seconds == 12
    assert policy.strategy_count == 3
    assert policy.stagnation_seconds == 1.5
    assert policy.routing_budget_share == 0.65


def test_package_heavy_job_scales_all_search_phases_from_complexity():
    policy = calculate_search_policy(
        order_count=16,
        item_count=297,
        physical_vehicle_count=3,
        virtual_vehicle_count=21,
        requested_max_time_seconds=120,
    )

    assert policy.time_budget_seconds == 92
    assert policy.strategy_count == 6
    assert policy.routing_budget_share == 0.78
    assert policy.validation_budget_share == 0.14
    assert policy.consolidation_budget_share == 0.08
    assert policy.stagnation_seconds == 17.94


def test_search_policy_respects_a_stricter_caller_cap():
    policy = calculate_search_policy(
        order_count=2,
        item_count=2,
        physical_vehicle_count=1,
        virtual_vehicle_count=7,
        requested_max_time_seconds=2,
    )

    assert policy.time_budget_seconds == 2
    assert policy.strategy_count == 2


def test_explicit_user_budget_is_used_instead_of_adaptive_shortening():
    policy = calculate_search_policy(
        order_count=2,
        item_count=2,
        physical_vehicle_count=1,
        virtual_vehicle_count=7,
        requested_max_time_seconds=120,
        requested_search_time_seconds=90,
    )

    assert policy.time_budget_seconds == 90
    assert policy.strategy_count == 6


def test_progress_tracker_stops_only_after_full_solution_stagnates():
    tracker = SearchProgressTracker(stagnation_seconds=0.5)

    tracker.observe(objective=100, fully_served=False, elapsed_seconds=0.0)
    assert tracker.should_stop(1.0) is False

    tracker.observe(objective=90, fully_served=True, elapsed_seconds=1.1)
    assert tracker.should_stop(1.5) is False

    tracker.observe(objective=95, fully_served=True, elapsed_seconds=1.7)
    assert tracker.should_stop(1.7) is True


def test_progress_tracker_resets_stagnation_after_improvement():
    tracker = SearchProgressTracker(stagnation_seconds=0.5)

    tracker.observe(objective=100, fully_served=True, elapsed_seconds=0.0)
    tracker.observe(objective=80, fully_served=True, elapsed_seconds=0.4)

    assert tracker.should_stop(0.8) is False
    assert tracker.should_stop(0.91) is True
