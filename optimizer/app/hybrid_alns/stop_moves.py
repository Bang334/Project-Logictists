"""Index-only stop relocation probes shared by search and post-audit polish."""
import time
from typing import List, Sequence, Tuple

StopMove = Tuple[float, int, int, int]
OrderMove = Tuple[int, float, int, int, int, int, int, int]
SubtripMove = Tuple[int, float, int, int, int, int, int]


def ranked_subtrip_moves(
    node_routes: Sequence[Sequence[int]],
    actions: Sequence[Sequence[Tuple[str, str]]],
    depots: Sequence[int],
    ends: Sequence[int],
    distances: Sequence[Sequence[float]],
    deadline: float,
) -> List[SubtripMove]:
    """Move a contiguous closed multi-order subtrip to another route position."""
    moves: List[SubtripMove] = []
    for source, nodes in enumerate(node_routes):
        n = len(nodes)
        if n < 4:
            continue
        route_actions = actions[source]
        for start in range(n - 3):
            if time.perf_counter() >= deadline:
                return sorted(moves)
            if route_actions[start][1] != "PICKUP":
                continue
            open_orders = set()
            closed_count = 0
            valid_prefix = True
            for end in range(start + 1, n + 1):
                order_id, kind = route_actions[end - 1]
                if not order_id:
                    valid_prefix = False
                    break
                if kind == "PICKUP":
                    open_orders.add(order_id)
                elif order_id in open_orders:
                    open_orders.remove(order_id)
                    closed_count += 1
                else:
                    valid_prefix = False
                    break
                if not valid_prefix:
                    break
                if open_orders or closed_count < 2:
                    continue
                sub_first = nodes[start]
                sub_last = nodes[end - 1]
                empties_source = start == 0 and end == n
                if empties_source:
                    removal = (
                        -distances[depots[source]][sub_first]
                        - distances[sub_last][ends[source]]
                    )
                else:
                    prev_s = nodes[start - 1] if start > 0 else depots[source]
                    next_s = nodes[end] if end < n else ends[source]
                    removal = (
                        distances[prev_s][next_s]
                        - distances[prev_s][sub_first]
                        - distances[sub_last][next_s]
                    )
                reduced = list(nodes[:start]) + list(nodes[end:])
                for target, target_nodes in enumerate(node_routes):
                    if target != source and not target_nodes:
                        continue
                    if target == source and empties_source:
                        continue
                    base = reduced if target == source else list(target_nodes)
                    trip_delta = -int(target != source and empties_source)
                    for pos in range(len(base) + 1):
                        if target == source and pos == start:
                            continue
                        prev_t = base[pos - 1] if pos > 0 else depots[target]
                        next_t = base[pos] if pos < len(base) else ends[target]
                        insert_delta = (
                            distances[prev_t][sub_first]
                            + distances[sub_last][next_t]
                            - (distances[prev_t][next_t] if base else 0.0)
                        )
                        moves.append(
                            (trip_delta, removal + insert_delta, source, start, end, target, pos)
                        )
    return sorted(moves)


def ranked_order_moves(
    node_routes: Sequence[Sequence[int]],
    actions: Sequence[Sequence[Tuple[str, str]]],
    depots: Sequence[int],
    ends: Sequence[int],
    distances: Sequence[Sequence[float]],
    deadline: float,
) -> List[OrderMove]:
    """Move a complete pickup/delivery pair, including between vehicles.

    Positions in the destination refer to the route after removing the pair.
    Trip reduction precedes distance only as a probe priority; the caller must
    still check the production objective, resource compatibility and geometry.
    """
    moves: List[OrderMove] = []

    def length(nodes: Sequence[int], vehicle: int) -> float:
        if not nodes:
            return 0.0
        return (distances[depots[vehicle]][nodes[0]]
            + sum(distances[a][b] for a, b in zip(nodes, nodes[1:]))
            + distances[nodes[-1]][ends[vehicle]])

    def insertion(nodes: Sequence[int], vehicle: int, node: int, position: int) -> float:
        previous = nodes[position-1] if position else depots[vehicle]
        following = nodes[position] if position < len(nodes) else ends[vehicle]
        return (distances[previous][node] + distances[node][following]
            - (distances[previous][following] if nodes else 0.0))

    for source, nodes in enumerate(node_routes):
        positions = {action: index for index, action in enumerate(actions[source])}
        for pickup, (order_id, kind) in enumerate(actions[source]):
            if time.perf_counter() >= deadline:
                return sorted(moves)
            delivery = positions.get((order_id, "DELIVERY"))
            if kind != "PICKUP" or delivery is None or delivery <= pickup:
                continue
            reduced = [node for index, node in enumerate(nodes) if index not in (pickup, delivery)]
            removal = length(reduced, source) - length(nodes, source)
            for target, target_nodes in enumerate(node_routes):
                # Opening an unused route cannot consolidate trips. Vehicle
                # reassignment has its own compatibility-aware neighborhood.
                if target != source and not target_nodes:
                    continue
                base = reduced if target == source else list(target_nodes)
                trip_delta = -int(target != source and not reduced)
                for p in range(len(base)+1):
                    if time.perf_counter() >= deadline:
                        return sorted(moves)
                    pickup_delta = insertion(base, target, nodes[pickup], p)
                    with_pickup = base[:p] + [nodes[pickup]] + base[p:]
                    for d in range(p+1, len(with_pickup)+1):
                        if target == source and p == pickup and d == delivery:
                            continue
                        delta = removal + pickup_delta + insertion(with_pickup, target, nodes[delivery], d)
                        moves.append((trip_delta, delta, source, pickup, delivery, target, p, d))
    return sorted(moves)


def ranked_stop_moves(
    node_routes: Sequence[Sequence[int]],
    actions: Sequence[Sequence[Tuple[str, str]]],
    depots: Sequence[int],
    ends: Sequence[int],
    distances: Sequence[Sequence[float]],
    deadline: float,
) -> List[StopMove]:
    """Rank all routes together, preserving each pair's pickup precedence.

    Distance is only a probe priority. Callers must schedule, price and check
    geometry; no move here is declared feasible or financially improving.
    """
    moves: List[StopMove] = []
    for vehicle_index, nodes in enumerate(node_routes):
        if time.perf_counter() >= deadline:
            break
        if len(nodes) < 3:
            continue
        positions = {action: index for index, action in enumerate(actions[vehicle_index])}
        for source, (order_id, kind) in enumerate(actions[vehicle_index]):
            if time.perf_counter() >= deadline:
                return sorted(moves)
            counterpart = positions.get((order_id, "DELIVERY" if kind == "PICKUP" else "PICKUP"))
            if counterpart is None:
                continue
            counterpart -= int(counterpart > source)
            reduced = list(nodes[:source]) + list(nodes[source+1:])
            previous = nodes[source-1] if source else depots[vehicle_index]
            following = nodes[source+1] if source+1 < len(nodes) else ends[vehicle_index]
            removed = (distances[previous][following] - distances[previous][nodes[source]]
                - distances[nodes[source]][following])
            for target in range(len(nodes)):
                if source == target or (kind == "PICKUP" and target > counterpart) or (
                    kind == "DELIVERY" and target <= counterpart
                ):
                    continue
                previous = reduced[target-1] if target else depots[vehicle_index]
                following = reduced[target] if target < len(reduced) else ends[vehicle_index]
                delta = (removed + distances[previous][nodes[source]]
                    + distances[nodes[source]][following] - distances[previous][following])
                moves.append((delta, vehicle_index, source, target))
    return sorted(moves)
