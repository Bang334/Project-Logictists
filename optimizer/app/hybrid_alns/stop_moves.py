"""Index-only stop relocation probes shared by search and post-audit polish."""
import time
from functools import cache
from heapq import heappush, heapreplace
from typing import List, Optional, Sequence, Tuple

StopMove = Tuple[float, int, int, int]
OrderMove = Tuple[int, float, int, int, int, int, int, int]
SubtripMove = Tuple[int, float, int, int, int, int, int]


# Bound the exponential DP state space per window, independently of fleet size.
MAX_RESEQUENCE_STOPS = 14


class _ResequenceDeadlineReached(Exception):
    pass


def is_single_stop_relocation(sequence: Sequence[int]) -> bool:
    """Whether the existing single-stop neighborhood already covers this permutation."""
    misplaced = [i for i, source in enumerate(sequence) if i != source]
    if not misplaced:
        return True
    first, last = misplaced[0], misplaced[-1]
    middle = sequence[first:last + 1]
    return (
        list(middle) == [*range(first + 1, last + 1), first]
        or list(middle) == [last, *range(first, last)]
    )


def _edge_distance(
    distances: Sequence[Sequence[float]],
    origin: Optional[int],
    destination: Optional[int],
) -> float:
    if origin is None or destination is None:
        return 0.0
    return float(distances[origin][destination])


def ranked_short_route_sequences(
    nodes: Sequence[int],
    actions: Sequence[Tuple[str, str]],
    depot: int,
    distances: Sequence[Sequence[float]],
    deadline: float,
    *,
    end_node: int | None = None,
    open_end: bool = False,
) -> List[Tuple[float, Tuple[int, ...]]]:
    """Reorder a window of an audited route while its outside prefix/suffix stay fixed."""
    if not 2 <= len(nodes) <= MAX_RESEQUENCE_STOPS or len(nodes) != len(actions):
        return []
    pickups = {order: i for i, (order, kind) in enumerate(actions) if kind == "PICKUP"}
    deliveries = {order: i for i, (order, kind) in enumerate(actions) if kind == "DELIVERY"}
    if len(pickups) + len(deliveries) != len(actions):
        return []
    predecessors = [0] * len(nodes)
    for order in pickups.keys() & deliveries.keys():
        predecessors[deliveries[order]] = 1 << pickups[order]
    end: Optional[int] = None if open_end else (depot if end_node is None else end_node)
    path_nodes = [depot, *nodes, *([end] if end is not None else [])]
    incumbent = sum(distances[a][b] for a, b in zip(path_nodes, path_nodes[1:]))
    all_pending = (1 << len(nodes)) - 1

    def available(pending: int):
        while pending:
            bit = pending & -pending
            yield bit.bit_length() - 1, bit
            pending ^= bit

    @cache
    def next_visits(pending: int) -> Tuple[Tuple[int, int], ...]:
        return tuple(
            (nodes[i], pending ^ bit)
            for i, bit in available(pending)
            if not (pending & predecessors[i])
        )

    @cache
    def shortest_suffix(previous: int, pending: int) -> float:
        if time.perf_counter() >= deadline:
            raise _ResequenceDeadlineReached
        if not pending:
            return _edge_distance(distances, previous, end)
        row = distances[previous]
        best_cost = float("inf")
        for node, next_pending in next_visits(pending):
            cost = row[node] + shortest_suffix(node, next_pending)
            if cost < best_cost:
                best_cost = cost
        return best_cost

    try:
        shortest = shortest_suffix(depot, all_pending)
    except _ResequenceDeadlineReached:
        return []
    if shortest >= incumbent:
        return []

    best: List[Tuple[float, Tuple[int, ...]]] = []

    def visit(previous: int, pending: int, path: Tuple[int, ...], cost: float) -> None:
        cutoff = -best[0][0] if len(best) == 12 else incumbent
        if time.perf_counter() >= deadline:
            return
        remaining = shortest_suffix(previous, pending)
        if cost + remaining >= cutoff:
            return
        if not pending:
            total = cost + _edge_distance(distances, previous, end)
            if total < cutoff and all(previous_path != path for _, previous_path in best):
                entry = (-total, path)
                if len(best) == 12:
                    heapreplace(best, entry)
                else:
                    heappush(best, entry)
            return

        for i, node in enumerate(nodes):
            bit = 1 << i
            if pending & bit and not (pending & predecessors[i]):
                visit(node, pending ^ bit, (*path, i), cost + distances[previous][node])

    # Keep the best complete path even if the remaining budget permits no alternatives.
    path = []
    previous, pending = depot, all_pending
    while pending:
        i, bit = min(
            ((i, bit) for i, bit in available(pending) if not (pending & predecessors[i])),
            key=lambda entry: distances[previous][nodes[entry[0]]]
            + shortest_suffix(nodes[entry[0]], pending ^ entry[1]),
        )
        path.append(i)
        previous, pending = nodes[i], pending ^ bit
    # Sum the reconstructed path in travel order, as for the incumbent.
    path_nodes = [depot, *(nodes[i] for i in path), *([end] if end is not None else [])]
    path_cost = sum(distances[a][b] for a, b in zip(path_nodes, path_nodes[1:]))
    if path_cost < incumbent:
        best.append((-path_cost, tuple(path)))

    visit(depot, all_pending, (), 0.0)
    return sorted((-total - incumbent, path) for total, path in best)


def ranked_subtrip_moves(
    node_routes: Sequence[Sequence[int]],
    actions: Sequence[Sequence[Tuple[str, str]]],
    depots: Sequence[int],
    ends: Sequence[Optional[int]],
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
                        - _edge_distance(distances, sub_last, ends[source])
                    )
                else:
                    prev_s = nodes[start - 1] if start > 0 else depots[source]
                    next_s = nodes[end] if end < n else ends[source]
                    removal = (
                        _edge_distance(distances, prev_s, next_s)
                        - distances[prev_s][sub_first]
                        - _edge_distance(distances, sub_last, next_s)
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
                            + _edge_distance(distances, sub_last, next_t)
                            - (_edge_distance(distances, prev_t, next_t) if base else 0.0)
                        )
                        moves.append(
                            (trip_delta, removal + insert_delta, source, start, end, target, pos)
                        )
    return sorted(moves)


def ranked_order_moves(
    node_routes: Sequence[Sequence[int]],
    actions: Sequence[Sequence[Tuple[str, str]]],
    depots: Sequence[int],
    ends: Sequence[Optional[int]],
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
            + _edge_distance(distances, nodes[-1], ends[vehicle]))

    def insertion(nodes: Sequence[int], vehicle: int, node: int, position: int) -> float:
        previous = nodes[position-1] if position else depots[vehicle]
        following = nodes[position] if position < len(nodes) else ends[vehicle]
        return (distances[previous][node] + _edge_distance(distances, node, following)
            - (_edge_distance(distances, previous, following) if nodes else 0.0))

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
    ends: Sequence[Optional[int]],
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
            removed = (_edge_distance(distances, previous, following) - distances[previous][nodes[source]]
                - _edge_distance(distances, nodes[source], following))
            for target in range(len(nodes)):
                if source == target or (kind == "PICKUP" and target > counterpart) or (
                    kind == "DELIVERY" and target <= counterpart
                ):
                    continue
                previous = reduced[target-1] if target else depots[vehicle_index]
                following = reduced[target] if target < len(reduced) else ends[vehicle_index]
                delta = (removed + distances[previous][nodes[source]]
                    + _edge_distance(distances, nodes[source], following) - _edge_distance(distances, previous, following))
                moves.append((delta, vehicle_index, source, target))
    return sorted(moves)
