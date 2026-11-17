"""Evaluate the existing dynamic placement order with precomputed box edges."""

from typing import Any

from app.hybrid_alns.models import CargoItem, PlacedItem
from app.hybrid_alns.packing_checker import FastPackingChecker, is_path_to_door_clear
from app.packing_rules import resolve_can_rotate, score_candidate_balance_and_fragility


class FastDynamicPackingChecker(FastPackingChecker):
    """Use the same placement candidates, overlap tolerance and rear access rule."""

    placements_tried = 0

    def find_placement(
        self,
        item: CargoItem,
        current_placed: list[PlacedItem],
        item_delivery_rank: int,
        delivery_ranks: dict[str, int],
    ) -> PlacedItem | None:
        epsilon = 0.01
        area = sum(box.length_cm * box.width_cm for box in current_placed)
        if (
            area + item.length_cm * item.width_cm > self.L * self.W + epsilon
            or item.height_cm > self.vehicle.height_cm + epsilon
        ):
            return None
        orientations = [(item.length_cm, item.width_cm)]
        if resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > epsilon:
            orientations.append((item.width_cm, item.length_cm))
        edges = [
            (box.x, box.y, box.x + box.length_cm, box.y + box.width_cm)
            for box in current_placed
        ]
        points = {(0.0, 0.0)}
        for x, y, right, top in edges:
            if right <= self.L:
                points.add((right, y))
                points.add((right, 0.0))
                points.add((right, top))
            if top <= self.W:
                points.add((x, top))
                points.add((0.0, top))
        for _, width in orientations:
            if width <= self.W:
                points.add((0.0, self.W - width))
                for _, _, right, _ in edges:
                    if right <= self.L:
                        points.add((right, self.W - width))

        sorted_points = sorted(points)
        min_y_penalty = min((min(0.0, py * 0.05) for _, py in sorted_points), default=0.0)

        earlier = [
            box for box in current_placed
            if delivery_ranks.get(box.order_id, 999999) < item_delivery_rank
        ]
        earlier_corridors: list[tuple[float, float, float, float]] = []
        for box in earlier:
            if not is_path_to_door_clear(box, self.L, current_placed)[0]:
                if box.item_id != item.id:
                    return None
            if box.item_id == item.id:
                continue
            epx = box.x + box.length_cm
            eplen = self.L - epx
            if eplen > epsilon:
                earlier_corridors.append((epx, box.y, epx + eplen, box.y + box.width_cm))

        edges_for_item = (
            [
                (box.x, box.y, box.x + box.length_cm, box.y + box.width_cm)
                for box in current_placed
                if box.item_id != item.id
            ]
            if any(box.item_id == item.id for box in current_placed)
            else edges
        )

        half_w = self.W / 2.0 if self.W > 0 else 1.0
        total_w_base = 0.0
        moment_y_base = 0.0
        kinds: dict[str, str] = {}
        has_fragile = False
        for box in current_placed:
            kinds[box.item_id] = box.cargo_kind
            if box.cargo_kind == "FRAGILE":
                has_fragile = True
            pw = float(getattr(box, "weight_kg", 0.0) or 0.0)
            if pw > 0:
                total_w_base += pw
                moment_y_base += pw * (float(box.y) + float(box.width_cm) / 2.0)

        cand_weight = float(item.weight_kg)
        cw = max(0.0, cand_weight)
        total_w = total_w_base + cw
        fragile_relevant = item.cargo_kind == "FRAGILE" or has_fragile
        corridor_limit = self.W - epsilon
        limit_l = self.L + epsilon
        limit_w = self.W + epsilon

        best_coords: tuple[float, float, float, float] | None = None
        best_score = float("inf")
        for length, width in orientations:
            if length > limit_l or width > limit_w:
                continue
            max_x = limit_l - length
            half_width = width / 2.0
            for x, y in sorted_points:
                if x > max_x + 1e-9 or x * 1000.0 + min_y_penalty >= best_score + 1e-9:
                    break
                end_x, end_y = x + length, y + width
                if end_x > limit_l or end_y > limit_w:
                    continue
                corridor = 150.0 if y > epsilon and end_y < corridor_limit else 0.0
                if total_w > 1e-6:
                    new_cg_y = (moment_y_base + cw * (y + half_width)) / total_w
                else:
                    new_cg_y = half_w
                imbalance = round(abs(new_cg_y - half_w) / half_w, 4)
                base_score = x * 1000.0 + corridor + imbalance * 120.0 + y * 0.05
                if base_score >= best_score + 1e-9:
                    continue

                overlapped = False
                for left, bottom, right, top in edges:
                    if not (
                        end_x <= left + epsilon or right <= x + epsilon
                        or end_y <= bottom + epsilon or top <= y + epsilon
                    ):
                        overlapped = True
                        break
                if overlapped:
                    continue

                cplen = self.L - end_x
                if cplen > epsilon:
                    c_end_x = end_x + cplen
                    blocked = False
                    for left, bottom, right, top in edges_for_item:
                        if not (
                            c_end_x <= left + epsilon or right <= end_x + epsilon
                            or end_y <= bottom + epsilon or top <= y + epsilon
                        ):
                            blocked = True
                            break
                    if blocked:
                        continue

                blocked_earlier = False
                for epx, ey, e_end_x, e_end_y in earlier_corridors:
                    if not (
                        e_end_x <= x + epsilon or end_x <= epx + epsilon
                        or e_end_y <= y + epsilon or end_y <= ey + epsilon
                    ):
                        blocked_earlier = True
                        break
                if blocked_earlier:
                    continue

                if fragile_relevant:
                    imbalance, fragility = score_candidate_balance_and_fragility(
                        cand_x=x, cand_y=y, cand_l=length, cand_w=width,
                        cand_weight_kg=cand_weight, cand_cargo_kind=item.cargo_kind,
                        current_placed=current_placed, cargo_kind_by_id=kinds,
                        floor_length_cm=self.L, floor_width_cm=self.W,
                    )
                    score = x * 1000.0 + corridor + imbalance * 120.0 + fragility * 140.0 + y * 0.05
                else:
                    score = base_score
                if score < best_score:
                    best_coords, best_score = (x, y, length, width), score

        if best_coords is None:
            return None
        bx, by, bl, bw = best_coords
        return PlacedItem(
            item_id=item.id, order_id=item.order_id, x=bx, y=by,
            length_cm=bl, width_cm=bw, weight_kg=cand_weight,
            cargo_kind=item.cargo_kind,
        )

    def _place_dynamic_box(
        self, item: CargoItem, placed_boxes: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        type(self).placements_tried += 1
        epsilon = 0.01
        area = sum(box["l"] * box["w"] for box in placed_boxes)
        if area + item.length_cm * item.width_cm > self.L * self.W + epsilon:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > epsilon:
            orientations.append((item.width_cm, item.length_cm))
        edges = [
            (box["id"], box["x"], box["y"], box["x"] + box["l"], box["y"] + box["w"])
            for box in placed_boxes
        ]
        positions = {(0.0, 0.0)}
        rear_edges = {0.0}
        for _, left, bottom, right, top in edges:
            if right <= self.L:
                positions.update(((right, bottom), (right, 0.0)))
                rear_edges.add(right)
            if top <= self.W:
                positions.update(((left, top), (0.0, top)))
        for _, width in orientations:
            if width <= self.W:
                positions.update((right, self.W - width) for right in rear_edges)
        sorted_positions = sorted(positions)

        for length, width in orientations:
            if length > self.L + epsilon or width > self.W + epsilon:
                continue
            for x, y in sorted_positions:
                end_x, end_y = x + length, y + width
                if end_x > self.L + epsilon or end_y > self.W + epsilon:
                    continue
                path_length = self.L - end_x
                path_end = end_x + path_length
                for box_id, left, bottom, right, top in edges:
                    if end_y <= bottom + epsilon or top <= y + epsilon:
                        continue
                    if not (end_x <= left + epsilon or right <= x + epsilon):
                        break
                    if path_length > epsilon and box_id != item.id and not (
                        path_end <= left + epsilon or right <= end_x + epsilon
                    ):
                        break
                else:
                    return {
                        "id": item.id, "order_id": item.order_id,
                        "x": x, "y": y, "l": length, "w": width,
                    }
        return None
