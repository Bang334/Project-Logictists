"""Regression tests for multi-day self-discovery, screened repair, and fast scoring parity."""

from __future__ import annotations

import time
from typing import List

from app.alns_engine import ALNSFleetOptimizer
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    PlacedItem,
)
from app.multi_start import MultiStartFleetOptimizer, _estimate_hybrid_lower_bound_days
from app.packing_rules import (
    build_floor_balance_context,
    score_candidate_balance_and_fragility,
    score_candidate_balance_and_fragility_ctx,
)


def _loc(loc_id: str, lat: float, lon: float) -> LocationPoint:
    return LocationPoint(id=loc_id, name=loc_id, latitude=lat, longitude=lon)


def _build_multi_day_request(
    *,
    num_days: int = 4,
    vehicles_per_day: int = 2,
    num_orders: int = 12,
    delivery_min_day: int = 0,
    service_sec: int = 1200,
    hybrid_seed_count: int = 3,
    early_stop_patience: int = 2,
    max_time_seconds: int = 20,
) -> FleetOptimizationRequest:
    depot = _loc("depot-0", 16.0125, 108.1874)
    vehicles: List[FleetVehicle] = []
    drivers: List[DriverOption] = []
    for day in range(num_days):
        day_offset = day * 86400
        for v_i in range(vehicles_per_day):
            vehicles.append(
                FleetVehicle(
                    id=f"veh-{v_i}#day{day}",
                    source_vehicle_id=f"veh-{v_i}",
                    service_day_index=day,
                    plate_number=f"43C-00{v_i}",
                    length_cm=600,
                    width_cm=240,
                    height_cm=240,
                    payload_limit_kg=5000,
                    available_start_sec=day_offset + 28800,
                    available_end_sec=day_offset + 61200,
                    depot=depot,
                    fuel_consumption_liters_per_100_km=12.0,
                    fixed_operating_cost_vnd=100_000,
                )
            )
            drivers.append(
                DriverOption(
                    id=f"drv-{v_i}#day{day}",
                    source_driver_id=f"drv-{v_i}",
                    service_day_index=day,
                    full_name=f"Driver {v_i}",
                    license_class="C",
                    fixed_salary_monthly_vnd=15_000_000,
                    trip_base_pay_vnd=150_000,
                    per_km_pay_vnd=1_000,
                )
            )

    orders: List[OrderPair] = []
    horizon_end = num_days * 86400
    min_deliv_sec = delivery_min_day * 86400
    for idx in range(num_orders):
        oid = f"ord-{idx}"
        orders.append(
            OrderPair(
                id=oid,
                order_number=f"ORD-{idx:03d}",
                pickup_location=_loc(f"p-{idx}", 16.01 + 0.002 * idx, 108.18 + 0.002 * idx),
                delivery_location=_loc(f"d-{idx}", 16.02 + 0.002 * idx, 108.19 + 0.002 * idx),
                items=[
                    CargoItem(
                        id=f"item-{idx}",
                        order_id=oid,
                        length_cm=80,
                        width_cm=60,
                        height_cm=60,
                        weight_kg=120,
                    )
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=horizon_end,
                delivery_window_start_sec=min_deliv_sec,
                delivery_window_end_sec=horizon_end,
                pickup_service_time_sec=service_sec,
                delivery_service_time_sec=service_sec,
                package_contract_version="1",
            )
        )

    total_nodes = len(vehicles) + 2 * len(orders)
    dist = [[0.0 if i == j else 2_000.0 for j in range(total_nodes)] for i in range(total_nodes)]
    dur = [[0.0 if i == j else 300.0 for j in range(total_nodes)] for i in range(total_nodes)]
    return FleetOptimizationRequest(
        job_id="test-multi-day-self-discovery",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=CostPolicy(
            fuel_price_per_liter_vnd=24_000,
            monthly_working_minutes=12_480,
            unassigned_order_penalty_vnd=1_000_000_000,
        ),
        max_time_seconds=max_time_seconds,
        search_time_seconds=8,
        early_stop_patience=early_stop_patience,
        hybrid_seed_count=hybrid_seed_count,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )


def test_estimate_hybrid_lower_bound_days_respects_workload_and_windows() -> None:
    req_one_day = _build_multi_day_request(num_days=4, vehicles_per_day=2, num_orders=4, service_sec=1200)
    assert _estimate_hybrid_lower_bound_days(req_one_day) == 1

    # Two 9h shifts per day (18h/day capacity) with 12 orders * 2h service = 24h work => >= 2 days.
    req_two_days = _build_multi_day_request(num_days=4, vehicles_per_day=2, num_orders=12, service_sec=3600)
    assert _estimate_hybrid_lower_bound_days(req_two_days) >= 2

    # Window forces at least one delivery into day index 2 => span >= 3 days.
    req_day2_window = _build_multi_day_request(num_days=4, vehicles_per_day=2, num_orders=4, delivery_min_day=2)
    assert _estimate_hybrid_lower_bound_days(req_day2_window) >= 3


def test_multi_day_solve_self_discovers_span_without_direct_seeding_label() -> None:
    req = _build_multi_day_request(
        num_days=4,
        vehicles_per_day=2,
        num_orders=12,
        service_sec=600,
        hybrid_seed_count=3,
        early_stop_patience=2,
        max_time_seconds=20,
    )
    batch = MultiStartFleetOptimizer(req).solve()
    assert batch.candidates
    best = batch.candidates[0]
    assert best.result.status == "SUCCESS"
    assert best.result.unassigned_orders == []
    assert all("(Direct warm-start)" not in c.search_strategy for c in batch.candidates)
    assert all(not c.search_strategy.startswith("Hybrid ALNS trong ") for c in batch.candidates)
    used_days = {r.service_day_index for r in best.result.routes}
    assert max(used_days) <= 1


def test_alns_repair_greedy_screened_respects_deadline_and_prefers_early_days() -> None:
    req = _build_multi_day_request(num_days=3, vehicles_per_day=1, num_orders=2, service_sec=300)
    engine = ALNSFleetOptimizer(req, time_budget_seconds=5.0, random_seed=0)
    routes, missing = engine._repair_greedy_insert([[] for _ in engine.vehicles], [o.id for o in engine.orders])
    assert missing == []
    assert sum(bool(r) for r in routes) >= 1
    assert all(engine.vehicles[idx].service_day_index == 0 for idx, r in enumerate(routes) if r)

    # Already-expired deadline should abort cleanly without hanging on vehicle scans.
    expired_routes, expired_missing = engine._repair_greedy_insert(
        [[] for _ in engine.vehicles],
        [o.id for o in engine.orders],
        deadline=time.perf_counter() - 0.1,
    )
    assert all(not r for r in expired_routes)
    assert set(expired_missing) == {o.id for o in engine.orders}


def test_floor_balance_context_matches_legacy_score() -> None:
    placed = [
        PlacedItem(item_id="a", order_id="o1", x=0.0, y=10.0, length_cm=80.0, width_cm=60.0, height_cm=50.0, weight_kg=120.0, cargo_kind="STANDARD"),
        PlacedItem(item_id="b", order_id="o2", x=90.0, y=85.0, length_cm=70.0, width_cm=50.0, height_cm=40.0, weight_kg=40.0, cargo_kind="FRAGILE"),
    ]
    kind_map = {p.item_id: p.cargo_kind or "UNCLASSIFIED" for p in placed}
    ctx = build_floor_balance_context(
        [(p.x, p.y, p.length_cm, p.width_cm, p.weight_kg, kind_map[p.item_id]) for p in placed],
        240.0,
    )
    for cand_kind, cand_weight, cy in (("STANDARD", 200.0, 82.0), ("FRAGILE", 20.0, 72.0)):
        legacy = score_candidate_balance_and_fragility(
            cand_x=90.0,
            cand_y=cy,
            cand_l=60.0,
            cand_w=50.0,
            cand_weight_kg=cand_weight,
            cand_cargo_kind=cand_kind,
            current_placed=placed,
            cargo_kind_by_id=kind_map,
            floor_length_cm=600.0,
            floor_width_cm=240.0,
        )
        fast = score_candidate_balance_and_fragility_ctx(
            ctx,
            cand_x=90.0,
            cand_y=cy,
            cand_l=60.0,
            cand_w=50.0,
            cand_weight_kg=cand_weight,
            cand_cargo_kind=cand_kind,
            floor_width_cm=240.0,
        )
        assert fast == legacy
