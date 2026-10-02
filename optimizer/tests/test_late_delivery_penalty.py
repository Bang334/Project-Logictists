from app.models import CostPolicy, OrderPair
from app.route_costing import calculate_late_delivery_penalty


def _policy(mode: str, value: float) -> CostPolicy:
    return CostPolicy(
        fuel_price_per_liter_vnd=23_000,
        monthly_working_minutes=10_560,
        delivery_grace_days=2,
        late_delivery_penalty_mode=mode,
        late_delivery_penalty_value=value,
    )


def _order(order_value_vnd: int = 2_000_000) -> OrderPair:
    return OrderPair.model_construct(
        id="order-1",
        order_number="ORD-1",
        ordered_at_sec=0,
        order_value_vnd=order_value_vnd,
    )


def test_no_penalty_during_first_two_days():
    assert calculate_late_delivery_penalty(
        _order(),
        delivery_time_sec=2 * 86_400,
        policy=_policy("FIXED_PER_DAY", 120_000),
    ) == 0


def test_fixed_penalty_grows_with_time_after_grace_period():
    policy = _policy("FIXED_PER_DAY", 120_000)

    assert calculate_late_delivery_penalty(
        _order(), delivery_time_sec=3 * 86_400, policy=policy
    ) == 120_000
    assert calculate_late_delivery_penalty(
        _order(), delivery_time_sec=4 * 86_400, policy=policy
    ) == 240_000


def test_percentage_penalty_uses_order_value():
    assert calculate_late_delivery_penalty(
        _order(order_value_vnd=2_000_000),
        delivery_time_sec=3 * 86_400,
        policy=_policy("PERCENT_ORDER_VALUE_PER_DAY", 1.5),
    ) == 30_000
