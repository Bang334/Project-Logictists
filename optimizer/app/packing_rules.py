"""Shared physical packing rules: orientation locks, weight balance, and fragile protection."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable, Literal, Mapping, Optional, Sequence, Tuple

from .models import CargoItem, PlacedItem, WeightBalanceMetrics


_EPS = 0.01
_FRAGILE_PROXIMITY_CM = 2.0


def normalize_allowed_orientations(
    allowed_orientations: Optional[Sequence[str]],
) -> Optional[list[Literal["LWH", "WLH"]]]:
    """Validate and deduplicate floor-only orientation declarations."""
    if allowed_orientations is None:
        return None
    normalized: list[Literal["LWH", "WLH"]] = []
    for entry in allowed_orientations:
        if entry == "LWH" and "LWH" not in normalized:
            normalized.append("LWH")
        elif entry == "WLH" and "WLH" not in normalized:
            normalized.append("WLH")
        elif entry not in ("LWH", "WLH"):
            raise ValueError(f"Invalid floor orientation: {entry!r}")
    if not normalized:
        raise ValueError("allowed_orientations cannot be empty")
    return normalized


def is_floor_rotation_locked(item: Any) -> bool:
    """Return True when the package explicitly locks 90-degree floor rotation."""
    allowed = getattr(item, "allowed_orientations", None)
    if allowed is not None:
        return "WLH" not in allowed
    return not bool(getattr(item, "can_rotate", True))


def resolve_can_rotate(
    item: Any,
    *,
    d11_default: Optional[bool] = None,
) -> bool:
    """Resolve effective 0/90-degree floor rotation permission.

    When `allowed_orientations` is explicitly declared (e.g. `["LWH"]`), it always
    takes precedence over D11 defaults. When omitted (`None`), `d11_default` lets
    baseline production solvers honor D11 (`True`) while keeping direct checks true
    to `item.can_rotate`.
    """
    allowed = getattr(item, "allowed_orientations", None)
    if allowed is not None:
        return "WLH" in allowed
    if d11_default is not None:
        return bool(d11_default)
    return bool(getattr(item, "can_rotate", True))


def _split_weight_by_centerline(
    coord_start: float,
    span: float,
    split_line: float,
    weight_kg: float,
) -> Tuple[float, float]:
    if weight_kg <= 0:
        return 0.0, 0.0
    if span <= 1e-6:
        return (weight_kg, 0.0) if coord_start < split_line else (0.0, weight_kg)
    first_ratio = max(0.0, min(1.0, (split_line - coord_start) / span))
    first = weight_kg * first_ratio
    return first, weight_kg - first


def compute_center_of_gravity(
    placed_items: Iterable[Any],
    floor_length_cm: float,
    floor_width_cm: float,
) -> Tuple[float, float, float]:
    """Return (total_weight_kg, cg_x_cm, cg_y_cm)."""
    total_weight = 0.0
    moment_x = 0.0
    moment_y = 0.0
    for item in placed_items:
        weight = float(getattr(item, "weight_kg", 0.0) or 0.0)
        if weight <= 0:
            continue
        cx = float(item.x) + float(item.length_cm) / 2.0
        cy = float(item.y) + float(item.width_cm) / 2.0
        total_weight += weight
        moment_x += weight * cx
        moment_y += weight * cy
    if total_weight <= 1e-6:
        return 0.0, floor_length_cm / 2.0, floor_width_cm / 2.0
    return total_weight, moment_x / total_weight, moment_y / total_weight


def build_weight_balance_metrics(
    placed_items: Iterable[PlacedItem],
    floor_length_cm: float,
    floor_width_cm: float,
) -> WeightBalanceMetrics:
    """Calculate center of gravity and left/right/front/rear load distribution."""
    items = list(placed_items)
    half_l = floor_length_cm / 2.0 if floor_length_cm > 0 else 1.0
    half_w = floor_width_cm / 2.0 if floor_width_cm > 0 else 1.0
    total_w, cg_x, cg_y = compute_center_of_gravity(items, floor_length_cm, floor_width_cm)

    if total_w <= 1e-6:
        return WeightBalanceMetrics(
            total_weight_kg=0.0,
            cg_x_cm=round(floor_length_cm / 2.0, 2),
            cg_y_cm=round(floor_width_cm / 2.0, 2),
            cg_x_percent=50.0,
            cg_y_percent=50.0,
            lateral_offset_cm=0.0,
            longitudinal_offset_cm=0.0,
            lateral_imbalance_percent=0.0,
            longitudinal_imbalance_percent=0.0,
            left_weight_kg=0.0,
            right_weight_kg=0.0,
            front_weight_kg=0.0,
            rear_weight_kg=0.0,
            status="EMPTY",
        )

    left_w = 0.0
    right_w = 0.0
    front_w = 0.0
    rear_w = 0.0
    for item in items:
        w = float(item.weight_kg)
        lw, rw = _split_weight_by_centerline(float(item.y), float(item.width_cm), half_w, w)
        fw, bw = _split_weight_by_centerline(float(item.x), float(item.length_cm), half_l, w)
        left_w += lw
        right_w += rw
        front_w += fw
        rear_w += bw

    lat_offset = cg_y - half_w
    lon_offset = cg_x - half_l
    lat_imb_pct = abs(lat_offset) / half_w * 100.0
    lon_imb_pct = abs(lon_offset) / half_l * 100.0

    if lat_imb_pct <= 20.0 and lon_imb_pct <= 35.0:
        status: Literal["EMPTY", "BALANCED", "MODERATE", "IMBALANCED"] = "BALANCED"
    elif lat_imb_pct <= 35.0 and lon_imb_pct <= 55.0:
        status = "MODERATE"
    else:
        status = "IMBALANCED"

    return WeightBalanceMetrics(
        total_weight_kg=round(total_w, 3),
        cg_x_cm=round(cg_x, 2),
        cg_y_cm=round(cg_y, 2),
        cg_x_percent=round(cg_x / floor_length_cm * 100.0, 1) if floor_length_cm > 0 else 50.0,
        cg_y_percent=round(cg_y / floor_width_cm * 100.0, 1) if floor_width_cm > 0 else 50.0,
        lateral_offset_cm=round(lat_offset, 2),
        longitudinal_offset_cm=round(lon_offset, 2),
        lateral_imbalance_percent=round(lat_imb_pct, 1),
        longitudinal_imbalance_percent=round(lon_imb_pct, 1),
        left_weight_kg=round(left_w, 3),
        right_weight_kg=round(right_w, 3),
        front_weight_kg=round(front_w, 3),
        rear_weight_kg=round(rear_w, 3),
        status=status,
    )


def resolve_weight_balance_thresholds(
    stacking_policy: Any = None,
    cost_policy: Any = None,
) -> Tuple[bool, Optional[float], Optional[float]]:
    """Combine hard enforcement and lateral/longitudinal caps across stacking and cost policies."""
    enforce = bool(getattr(stacking_policy, "enforce_weight_balance", False)) or bool(
        getattr(cost_policy, "enforce_weight_balance", False)
    )
    lat_candidates = [
        float(v)
        for v in (
            getattr(stacking_policy, "max_lateral_imbalance_percent", None),
            getattr(cost_policy, "max_lateral_imbalance_percent", None),
        )
        if v is not None
    ]
    lon_candidates = [
        float(v)
        for v in (
            getattr(stacking_policy, "max_longitudinal_imbalance_percent", None),
            getattr(cost_policy, "max_longitudinal_imbalance_percent", None),
        )
        if v is not None
    ]
    return (
        enforce,
        min(lat_candidates) if lat_candidates else None,
        min(lon_candidates) if lon_candidates else None,
    )


def weight_balance_exceeds_limit(
    wb: Optional[WeightBalanceMetrics],
    max_lat_limit: Optional[float],
    max_lon_limit: Optional[float],
) -> Optional[Tuple[float, float]]:
    """Return (lat_pct, lon_pct) when weight balance violates configured thresholds."""
    if wb is None or float(getattr(wb, "total_weight_kg", 0.0) or 0.0) <= 1e-6:
        return None
    lat_pct = float(getattr(wb, "lateral_imbalance_percent", 0.0) or 0.0)
    lon_pct = float(getattr(wb, "longitudinal_imbalance_percent", 0.0) or 0.0)
    violated = False
    if max_lat_limit is not None and lat_pct > float(max_lat_limit) + 1e-6:
        violated = True
    if max_lon_limit is not None and lon_pct > float(max_lon_limit) + 1e-6:
        violated = True
    if (
        max_lat_limit is None
        and max_lon_limit is None
        and getattr(wb, "status", "EMPTY") == "IMBALANCED"
    ):
        violated = True
    return (lat_pct, lon_pct) if violated else None


def check_placed_items_weight_balance(
    placed_items: Iterable[PlacedItem],
    floor_length_cm: float,
    floor_width_cm: float,
    *,
    max_lat_limit: Optional[float],
    max_lon_limit: Optional[float],
) -> Optional[Tuple[float, float]]:
    """Compute WeightBalanceMetrics for placed items and check hard limits."""
    items = list(placed_items)
    if not items:
        return None
    wb = build_weight_balance_metrics(items, floor_length_cm, floor_width_cm)
    return weight_balance_exceeds_limit(wb, max_lat_limit, max_lon_limit)


def calculate_route_weight_balance_penalty_vnd(
    step_balances: Sequence[Optional[WeightBalanceMetrics]],
    cost_policy: Any,
    stacking_policy: Any = None,
) -> int:
    """Calculate soft route penalty in VND from peak lateral/longitudinal excess over target."""
    rate = int(getattr(cost_policy, "weight_balance_penalty_vnd_per_percent", 0) or 0)
    if rate <= 0 or not step_balances:
        return 0
    _, max_lat, max_lon = resolve_weight_balance_thresholds(stacking_policy, cost_policy)
    lat_target = float(max_lat) if max_lat is not None else 0.0
    lon_target = float(max_lon) if max_lon is not None else 0.0
    peak_excess = 0.0
    for wb in step_balances:
        if wb is None or float(getattr(wb, "total_weight_kg", 0.0) or 0.0) <= 1e-6:
            continue
        lat_excess = max(0.0, float(getattr(wb, "lateral_imbalance_percent", 0.0) or 0.0) - lat_target)
        lon_excess = max(0.0, float(getattr(wb, "longitudinal_imbalance_percent", 0.0) or 0.0) - lon_target)
        peak_excess = max(peak_excess, lat_excess + lon_excess)
    if peak_excess <= 1e-6:
        return 0
    return int(round(peak_excess * rate))


def _interval_overlap(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _are_adjacent(
    x1: float,
    y1: float,
    l1: float,
    w1: float,
    x2: float,
    y2: float,
    l2: float,
    w2: float,
    gap_cm: float = _FRAGILE_PROXIMITY_CM,
) -> bool:
    x_gap = max(x2 - (x1 + l1), x1 - (x2 + l2), 0.0)
    y_gap = max(y2 - (y1 + w1), y1 - (y2 + w2), 0.0)
    y_ov = _interval_overlap(y1, y1 + w1, y2, y2 + w2)
    x_ov = _interval_overlap(x1, x1 + l1, x2, x2 + l2)
    return (x_gap <= gap_cm and y_ov > _EPS) or (y_gap <= gap_cm and x_ov > _EPS)


class FloorBalanceContext:
    """Precomputed floor CG and fragility subsets reused across candidate points."""

    __slots__ = ("half_w", "base_total_w", "base_moment_y", "fragile_items", "non_fragile_items")

    def __init__(
        self,
        *,
        half_w: float,
        base_total_w: float,
        base_moment_y: float,
        fragile_items: Tuple[Tuple[float, float, float, float, float], ...],
        non_fragile_items: Tuple[Tuple[float, float, float, float, float], ...],
    ) -> None:
        self.half_w = half_w
        self.base_total_w = base_total_w
        self.base_moment_y = base_moment_y
        self.fragile_items = fragile_items
        self.non_fragile_items = non_fragile_items


def build_floor_balance_context(
    entries: Sequence[Tuple[float, float, float, float, float, str]],
    floor_width_cm: float,
) -> FloorBalanceContext:
    """Precompute floor moment and fragile/non-fragile item geometry tuples."""
    half_w = floor_width_cm / 2.0 if floor_width_cm > 0 else 1.0
    base_total_w = 0.0
    base_moment_y = 0.0
    fragile_items = []
    non_fragile_items = []
    for ox, oy, ol, ow, weight_kg, kind in entries:
        pw = float(weight_kg or 0.0)
        if pw > 0:
            base_total_w += pw
            base_moment_y += pw * (oy + ow / 2.0)
        geom = (ox, oy, ox + ol, oy + ow, pw)
        if kind == "FRAGILE":
            fragile_items.append(geom)
        else:
            non_fragile_items.append(geom)
    return FloorBalanceContext(
        half_w=half_w,
        base_total_w=base_total_w,
        base_moment_y=base_moment_y,
        fragile_items=tuple(fragile_items),
        non_fragile_items=tuple(non_fragile_items),
    )


def score_candidate_balance_and_fragility_ctx(
    ctx: FloorBalanceContext,
    *,
    cand_x: float,
    cand_y: float,
    cand_l: float,
    cand_w: float,
    cand_weight_kg: float,
    cand_cargo_kind: str,
    floor_width_cm: float,
) -> Tuple[float, float]:
    """Score lateral imbalance and fragile adjacency against a precomputed context."""
    cw = max(0.0, float(cand_weight_kg or 0.0))
    total_w = ctx.base_total_w + cw
    moment_y = ctx.base_moment_y + cw * (cand_y + cand_w / 2.0)
    new_cg_y = (moment_y / total_w) if total_w > 1e-6 else ctx.half_w
    lateral_imbalance = abs(new_cg_y - ctx.half_w) / ctx.half_w

    cand_is_fragile = cand_cargo_kind == "FRAGILE"
    if not cand_is_fragile and not ctx.fragile_items:
        return round(lateral_imbalance, 4), 0.0

    fragile_penalty = 0.0
    left_pinch = cand_y <= _FRAGILE_PROXIMITY_CM
    right_pinch = cand_y + cand_w >= floor_width_cm - _FRAGILE_PROXIMITY_CM
    cand_x2 = cand_x + cand_l
    cand_y2 = cand_y + cand_w

    if cand_is_fragile:
        for ox, oy, ox2, oy2, other_weight in ctx.non_fragile_items:
            x_gap = ox - cand_x2 if ox > cand_x2 else (cand_x - ox2 if cand_x > ox2 else 0.0)
            y_gap = oy - cand_y2 if oy > cand_y2 else (cand_y - oy2 if cand_y > oy2 else 0.0)
            y_ov = (cand_y2 if cand_y2 < oy2 else oy2) - (cand_y if cand_y > oy else oy)
            x_ov = (cand_x2 if cand_x2 < ox2 else ox2) - (cand_x if cand_x > ox else ox)
            if not ((x_gap <= _FRAGILE_PROXIMITY_CM and y_ov > _EPS) or (y_gap <= _FRAGILE_PROXIMITY_CM and x_ov > _EPS)):
                continue
            if other_weight >= max(20.0, cw * 1.5):
                fragile_penalty += min(4.0, other_weight / max(cw, 1.0) * 0.5)
            if x_ov > _EPS:
                if oy2 <= cand_y + _FRAGILE_PROXIMITY_CM:
                    left_pinch = True
                if oy >= cand_y2 - _FRAGILE_PROXIMITY_CM:
                    right_pinch = True
        if left_pinch and right_pinch:
            fragile_penalty += 0.6
    else:
        for ox, oy, ox2, oy2, other_weight in ctx.fragile_items:
            x_gap = ox - cand_x2 if ox > cand_x2 else (cand_x - ox2 if cand_x > ox2 else 0.0)
            y_gap = oy - cand_y2 if oy > cand_y2 else (cand_y - oy2 if cand_y > oy2 else 0.0)
            y_ov = (cand_y2 if cand_y2 < oy2 else oy2) - (cand_y if cand_y > oy else oy)
            x_ov = (cand_x2 if cand_x2 < ox2 else ox2) - (cand_x if cand_x > ox else ox)
            if not ((x_gap <= _FRAGILE_PROXIMITY_CM and y_ov > _EPS) or (y_gap <= _FRAGILE_PROXIMITY_CM and x_ov > _EPS)):
                continue
            if cw >= max(20.0, other_weight * 1.5):
                fragile_penalty += min(4.0, cw / max(other_weight, 1.0) * 0.5)

    return round(lateral_imbalance, 4), round(fragile_penalty, 4)


def score_candidate_balance_and_fragility(
    *,
    cand_x: float,
    cand_y: float,
    cand_l: float,
    cand_w: float,
    cand_weight_kg: float,
    cand_cargo_kind: str,
    current_placed: Sequence[PlacedItem],
    cargo_kind_by_id: Mapping[str, str],
    floor_length_cm: float,
    floor_width_cm: float,
) -> Tuple[float, float]:
    """Return (lateral_imbalance_norm [0..1], fragile_adjacency_penalty >= 0).

    - `lateral_imbalance_norm`: normalized lateral deviation of projected CG from
      floor centerline `floor_width_cm / 2`. Zero means perfectly centered left/right.
    - `fragile_adjacency_penalty`: discourages placing FRAGILE cargo tightly pinched
      next to much heavier items (or vice versa), and penalizes pinching FRAGILE on
      both lateral sides when a more open position exists.
    """
    del floor_length_cm
    ctx = build_floor_balance_context(
        [
            (
                float(p.x),
                float(p.y),
                float(p.length_cm),
                float(p.width_cm),
                float(getattr(p, "weight_kg", 0.0) or 0.0),
                cargo_kind_by_id.get(p.item_id, "UNCLASSIFIED"),
            )
            for p in current_placed
        ],
        floor_width_cm,
    )
    return score_candidate_balance_and_fragility_ctx(
        ctx,
        cand_x=cand_x,
        cand_y=cand_y,
        cand_l=cand_l,
        cand_w=cand_w,
        cand_weight_kg=cand_weight_kg,
        cand_cargo_kind=cand_cargo_kind,
        floor_width_cm=floor_width_cm,
    )


def is_heavy_package_blocking_center_preference(
    item: CargoItem,
    remaining_items_at_stop: Sequence[CargoItem],
    has_future_pickups: bool,
) -> bool:
    """Only prefer centering when this package stands alone laterally (wide or final cargo)."""
    if has_future_pickups or remaining_items_at_stop:
        return False
    return True


def exceeds_top_load_limit(
    above_weight_kg: Decimal,
    base_weight_kg: Any,
    max_top_load_g: Optional[int],
    max_top_load_percent: int,
) -> bool:
    """Reject stacking when cumulative upper weight exceeds policy percent or packaging max_top_load_g."""
    if max_top_load_g is None:
        return True
    base_w = Decimal(str(base_weight_kg))
    pct = Decimal(str(max_top_load_percent))
    if above_weight_kg * Decimal("100") > base_w * pct:
        return True
    if above_weight_kg * Decimal("1000") > Decimal(str(max_top_load_g)):
        return True
    return False
