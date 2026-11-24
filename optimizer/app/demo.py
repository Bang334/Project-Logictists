"""Demo and benchmark scenario endpoints for TMS Optimization Engine.

Provides listing of pre-configured benchmark datasets and one-click execution
with Production Hybrid ALNS + Multi-start candidate ranking.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .models import (
    CostPolicy,
    DemoStackingPolicy,
    FleetOptimizationBatchResponse,
    FleetOptimizationRequest,
)
from .multi_start import MultiStartFleetOptimizer

router = APIRouter(prefix="/demo", tags=["Demo Benchmarks"])

CASES_DIR = Path(__file__).resolve().parent.parent / "benchmarks" / "demo"


class DemoCaseSummary(BaseModel):
    id: str
    filename: str
    name: str
    category: Literal["NOVEL", "SCENARIO", "REAL_DATA"]
    category_name: str
    description: str
    orders_count: int
    vehicles_count: int
    drivers_count: int
    total_weight_kg: float
    total_volume_cbm: float
    suggested_time_limit_sec: float
    supports_stacking: bool = False


class DemoRunRequest(BaseModel):
    case_id: Optional[str] = Field(default=None, description="Mã kịch bản mẫu có sẵn")
    time_budget_seconds: Optional[float] = Field(
        default=None, ge=1.0, le=1000.0, description="Ngân sách thời gian tìm kiếm (giây)"
    )
    custom_request: Optional[FleetOptimizationRequest] = Field(
        default=None, description="Tùy chọn tải lên tệp JSON FleetOptimizationRequest riêng"
    )
    hybrid_seed_count: Optional[int] = Field(default=None, ge=0, le=20)
    early_stop_patience: Optional[int] = Field(default=None, ge=0, le=1000)
    max_time_seconds: Optional[int] = Field(default=None, ge=1, le=1000)
    demo_stacking_enabled: Optional[bool] = None
    demo_stacking_owner_mode: Optional[Literal["SAME_CUSTOMER", "ANY_CUSTOMER"]] = None
    demo_stacking_max_tiers: Optional[int] = Field(default=None, ge=2, le=20)
    demo_stacking_lift_clearance_cm: Optional[float] = Field(default=None, gt=0)
    demo_stacking_max_top_load_percent: Optional[int] = Field(default=None, ge=1, le=100)
    policy_overrides: Optional[Dict[str, Any]] = None


def _load_catalog() -> dict:
    catalog_path = CASES_DIR / "catalog.json"
    if not catalog_path.is_file():
        return {}
    return json.loads(catalog_path.read_text(encoding="utf-8"))


def _load_case_dict(case_id: str) -> dict:
    if not case_id or not case_id.replace("_", "").isalnum():
        raise HTTPException(status_code=404, detail="Không tìm thấy kịch bản demo")
    catalog = _load_catalog()
    if case_id not in catalog:
        raise HTTPException(status_code=404, detail="Không tìm thấy kịch bản demo")
    path = CASES_DIR / f"{case_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy kịch bản demo")
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/cases", response_model=List[DemoCaseSummary])
def list_demo_cases() -> List[DemoCaseSummary]:
    summaries = []
    catalog = _load_catalog()
    for case_id, profile in catalog.items():
        data = _load_case_dict(case_id)
        items = [item for order in data["orders"] for item in order["items"]]
        summaries.append(DemoCaseSummary(
            id=case_id,
            filename=f"{case_id}.json",
            name=profile["name"],
            description=profile["description"],
            category=profile.get("category", "SCENARIO"),
            category_name=profile.get("category_name", "Xếp chồng 3D & Đường bộ thực tế"),
            orders_count=len(data["orders"]),
            vehicles_count=len(data["vehicles"]),
            drivers_count=len(data["drivers"]),
            total_weight_kg=sum(item["weight_kg"] for item in items),
            total_volume_cbm=round(
                sum(
                    item["length_cm"] * item["width_cm"] * item["height_cm"]
                    for item in items
                ) / 1_000_000,
                3,
            ),
            suggested_time_limit_sec=data["max_time_seconds"],
            supports_stacking=data.get("demo_stacking") is not None,
        ))
    return summaries


@router.get("/cases/{case_id}")
def get_demo_case_payload(case_id: str) -> dict:
    """Trả về toàn bộ dữ liệu cấu hình input của kịch bản demo."""
    return _load_case_dict(case_id)


@router.post("/run", response_model=FleetOptimizationBatchResponse)
def run_demo_case(payload: DemoRunRequest) -> FleetOptimizationBatchResponse:
    """Chạy trực tiếp bài toán tối ưu với Production Hybrid ALNS trên kịch bản đã chọn."""
    if payload.custom_request is not None:
        request = payload.custom_request
    elif payload.case_id:
        raw_dict = _load_case_dict(payload.case_id)
        raw_dict.pop("scenario_profile", None)
        request = FleetOptimizationRequest(**raw_dict)
    else:
        raise HTTPException(
            status_code=400, detail="Vui lòng cung cấp case_id hoặc custom_request"
        )

    if payload.max_time_seconds is not None:
        request.max_time_seconds = payload.max_time_seconds
        if payload.time_budget_seconds is not None:
            request.search_time_seconds = min(
                payload.max_time_seconds, int(round(payload.time_budget_seconds))
            )
    elif payload.time_budget_seconds is not None:
        budget_sec = int(round(payload.time_budget_seconds))
        request.max_time_seconds = budget_sec
        request.search_time_seconds = budget_sec

    # Áp dụng cấu hình xếp chồng và policy giống bản gốc
    if payload.demo_stacking_enabled is False:
        stacking_policy = None
    elif request.demo_stacking is not None or payload.demo_stacking_enabled is True:
        base_stacking = request.demo_stacking or DemoStackingPolicy(
            max_tiers=3,
            lift_clearance_cm=5.0,
            owner_mode="ANY_CUSTOMER",
            max_top_load_percent=30,
        )
        stacking_updates: Dict[str, Any] = {}
        if payload.demo_stacking_owner_mode:
            stacking_updates["owner_mode"] = payload.demo_stacking_owner_mode
        if payload.demo_stacking_max_tiers is not None:
            stacking_updates["max_tiers"] = payload.demo_stacking_max_tiers
        if payload.demo_stacking_lift_clearance_cm is not None:
            stacking_updates["lift_clearance_cm"] = payload.demo_stacking_lift_clearance_cm
        if payload.demo_stacking_max_top_load_percent is not None:
            stacking_updates["max_top_load_percent"] = payload.demo_stacking_max_top_load_percent
        stacking_policy = (
            base_stacking.model_copy(update=stacking_updates)
            if stacking_updates
            else base_stacking
        )
    else:
        stacking_policy = None

    resolved_policy = request.policy
    if payload.policy_overrides:
        resolved_policy = CostPolicy(**{
            **request.policy.model_dump(),
            **payload.policy_overrides,
        })

    solver_request = request.model_copy(update={
        "demo_stacking": stacking_policy,
        "policy": resolved_policy,
        "hybrid_seed_count": request.hybrid_seed_count if payload.hybrid_seed_count is None else payload.hybrid_seed_count,
        "early_stop_patience": request.early_stop_patience if payload.early_stop_patience is None else payload.early_stop_patience,
    })
    optimizer = MultiStartFleetOptimizer(solver_request)
    batch = optimizer.solve(max_candidates=3)

    # Đính kèm thông tin depot và baseline route_geometry cho từng route
    vehicle_map = {v.id: v for v in request.vehicles}
    for candidate in batch.candidates:
        if not candidate.result or not candidate.result.routes:
            continue
        for route in candidate.result.routes:
            v = vehicle_map.get(route.vehicle_id) or vehicle_map.get(route.route_id)
            if v and v.depot:
                route.depot = v.depot

            # Nếu chưa có route_geometry, tạo GeoJSON LineString nối depot và các stops
            if not route.route_geometry:
                coords = []
                if route.depot:
                    coords.append([route.depot.longitude, route.depot.latitude])
                for stop in (route.stops or []):
                    coords.append([stop.longitude, stop.latitude])
                if route.depot and len(coords) > 0:
                    coords.append([route.depot.longitude, route.depot.latitude])

                if len(coords) >= 2:
                    route.route_geometry = {
                        "type": "LineString",
                        "coordinates": coords,
                    }

    return batch
