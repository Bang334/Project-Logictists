"""Candidate ordering shared by the main search and its challengers.

Search may use scalar guidance for exploration. An audited winner must retain
the business priorities even when using a cheaper extra trip would look good.
"""
from collections import defaultdict
from typing import Dict, List, Set, Tuple

from .models import OptimizationSolution, OrderPair


def solution_key(
    solution: OptimizationSolution, orders: List[OrderPair],
) -> Tuple[int, int, int, int, float]:
    by_id = {order.id: order for order in orders}
    trips: Dict[str, Set[int]] = defaultdict(set)
    for route_index, route in enumerate(solution.routes):
        for stop in route.stops:
            if stop.stop_type == "PICKUP" and stop.order_id in by_id:
                order = by_id[stop.order_id]
                trips[order.source_order_id or order.id].add(route_index)
    return (
        len(set(solution.unassigned_orders)),
        sum(max(0, len(indices)-1) for indices in trips.values()),
        len(solution.routes),
        solution.real_economic_cost_vnd,
        solution.total_distance_km,
    )
