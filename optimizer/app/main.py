from __future__ import annotations

import asyncio
import math
import sys
import threading

if sys.version_info < (3, 11):
    raise RuntimeError("Optimizer requires Python 3.11+. On Windows run start_optimizer.ps1 from the project root.")

import anyio
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import Field
from typing import Dict, List

from .interprovincial import (
    DriverRestState,
    _apply_stop_rest_credit,
    is_item_hazmat,
    is_location_accessible_for_vehicle,
    is_temperature_compatible,
    items_have_compatibility_conflict,
    simulate_driving_leg,
    vehicle_allows_hazmat,
)

from .models import (
    DemoStackingPolicy,
    DrivingRestPolicy,
    FleetOptimizationRequest,
    FleetOptimizationBatchResponse,
    FleetOptimizationResponse,
    InProgressEvaluationRequest,
    InProgressEvaluationResponse,
    LocationPoint,
    OptimizationRequest,
    OptimizationResponse,
    VehicleFloor,
    StopAction,
    SpatialValidationResult,
    StrictContractModel,
    default_stacking_policy,
)
from .spatial_validator import SpatialValidator
from .routing_solver import OrToolsRoutingSolver
from .multi_start import MultiStartFleetOptimizer
from .demo import router as demo_router
from .stacking import DemoStacks
from .inprogress_evaluator import evaluate_inprogress_trip

app = FastAPI(
    title="TMS Optimization & Spatial Packing Engine",
    description="Google OR-Tools / Hybrid ALNS VRP Solver phối hợp cùng Dynamic 3D Stacking Spatial Packing Engine (mặc định 3D, hỗ trợ opt-out 2D)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(demo_router)


class ValidatePlanRequest(StrictContractModel):
    vehicle: VehicleFloor
    stops: List[StopAction]
    locations_by_stop_id: Dict[str, LocationPoint] = Field(default_factory=dict)
    demo_stacking: DemoStackingPolicy | None = Field(
        default_factory=default_stacking_policy
    )


class ManualScheduleStop(StrictContractModel):
    earliest_sec: int = Field(ge=0)
    service_sec: int = Field(ge=0)


class ManualScheduleRequest(StrictContractModel):
    travel_sec: List[float] = Field(min_length=2)
    stops: List[ManualScheduleStop]
    latest_end_sec: float = Field(gt=0)
    initial_weekly_driving_sec: int = Field(default=0, ge=0)
    driving_rest_policy: DrivingRestPolicy


@app.post("/schedule-manual")
def schedule_manual(request: ManualScheduleRequest):
    if len(request.travel_sec) != len(request.stops) + 2 or any(
        not math.isfinite(seconds) or seconds < 0 for seconds in request.travel_sec
    ):
        raise HTTPException(422, "Thiếu thời gian di chuyển hợp lệ")
    state = DriverRestState(total_driving_sec=request.initial_weekly_driving_sec)
    departure = 0.0
    stops = []
    policy = request.driving_rest_policy
    for index, travel in enumerate(request.travel_sec):
        arrival, _, _, state, error = simulate_driving_leg(
            departure, travel, state, policy, index,
        )
        if error:
            raise HTTPException(422, "Lịch chuyến vượt giới hạn giờ lái của tài xế")
        departure = arrival
        if 0 < index <= len(request.stops):
            stop = request.stops[index - 1]
            service_start = max(arrival, stop.earliest_sec)
            departure = service_start + stop.service_sec
            _apply_stop_rest_credit(state, round(service_start - arrival), stop.service_sec, policy)
            stops.append({"arrival_sec": arrival, "departure_sec": departure})
    if departure > request.latest_end_sec:
        raise HTTPException(422, "Khung giờ chuyến không đủ sau khi tính thời gian nghỉ bắt buộc")
    return {"stops": stops}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "optimizer",
        "engine": "Packing-aware Hybrid ALNS + bounded OR-Tools fallback + Dynamic 3D/2D Spatial Validator",
    }

@app.post("/validate-spatial", response_model=SpatialValidationResult)
def validate_spatial(request: ValidatePlanRequest):
    """
    Thẩm định tính khả thi hình học và xếp dỡ động cho một chuỗi điểm dừng (Stops).
    Kiểm tra triệt để các kịch bản T21-T27: cấm chồng, kiểm tra lối dỡ ra cửa, tái sử dụng không gian.
    """
    aboard = {}
    vehicle = request.vehicle
    allows_hazmat = vehicle_allows_hazmat(vehicle)
    for stop in sorted(request.stops, key=lambda action: action.sequence):
        handled = [
            *stop.items_to_load,
            *(aboard[item_id] for item_id in stop.items_to_unload if item_id in aboard),
        ]
        if not is_location_accessible_for_vehicle(
            request.locations_by_stop_id.get(stop.stop_id),
            vehicle,
            requires_lift=any(item.requires_lift_equipment for item in handled),
            requires_hazmat=any(is_item_hazmat(item) for item in handled),
        ):
            return SpatialValidationResult(
                is_valid=False,
                violation_code="STOP_ACCESS_INCOMPATIBLE",
                error_message=f"Xe hoặc thiết bị xếp dỡ không phù hợp tại điểm {stop.sequence}",
            )
        for item_id in stop.items_to_unload:
            aboard.pop(item_id, None)
        incoming = stop.items_to_load
        if any(
            (is_item_hazmat(item) and not allows_hazmat)
            or not is_temperature_compatible(
                item.required_temperature, vehicle.temperature_mode, allows_hazmat=allows_hazmat
            )
            for item in incoming
        ) or items_have_compatibility_conflict(
            incoming, [*aboard.values(), *incoming]
        ):
            return SpatialValidationResult(
                is_valid=False,
                violation_code="CARGO_INCOMPATIBLE",
                error_message=f"Hàng không tương thích với xe hoặc hàng đang chở tại điểm {stop.sequence}",
            )
        aboard.update((item.id, item) for item in incoming)
    validator = SpatialValidator(vehicle)
    if request.demo_stacking is None:
        return validator.validate_plan(request.stops)
    stacks = DemoStacks(request.demo_stacking, [request.vehicle])
    return stacks.validate_stops(validator, request.stops)


@app.post("/evaluate-inprogress-trip", response_model=InProgressEvaluationResponse)
def evaluate_inprogress(request: InProgressEvaluationRequest):
    """
    Đánh giá tiếp tục chuyến đang chạy sau sự cố giao hàng (A1 + A2):
    - Kiểm tra cản 3D / đè tầng / khung giờ cho các điểm đang chở trên xe.
    - Kiểm tra các đơn chưa lấy xem còn đủ tải/thể tích 3D/giờ hay phải tách cho xe rảnh.
    """
    return evaluate_inprogress_trip(request)

@app.post("/optimize", response_model=OptimizationResponse)
def optimize(request: OptimizationRequest):
    """
    Chạy bài toán tối ưu tuyến (OR-Tools VRPPDTW) kết hợp thẩm định hình học động.
    """
    return OrToolsRoutingSolver(request).solve()


_ACTIVE_JOB_EVENTS: Dict[str, threading.Event] = {}
_ACTIVE_JOB_LOCK = threading.Lock()


async def _run_cancellable_fleet_solve(
    raw_request: Request,
    request: FleetOptimizationRequest,
    max_candidates: int,
) -> FleetOptimizationBatchResponse:
    cancel_event = threading.Event()
    job_key = request.job_id.strip() if request.job_id else ""
    if job_key:
        with _ACTIVE_JOB_LOCK:
            previous = _ACTIVE_JOB_EVENTS.get(job_key)
            if previous is not None:
                previous.set()
            _ACTIVE_JOB_EVENTS[job_key] = cancel_event

    def _run_sync() -> FleetOptimizationBatchResponse:
        return MultiStartFleetOptimizer(
            request,
            cancel_event=cancel_event,
        ).solve(max_candidates=max_candidates)

    solve_task = asyncio.create_task(anyio.to_thread.run_sync(_run_sync))
    try:
        while not solve_task.done():
            await asyncio.wait({solve_task}, timeout=0.4)
            if solve_task.done():
                break
            try:
                if await raw_request.is_disconnected():
                    cancel_event.set()
                    break
            except Exception:
                pass
        return await solve_task
    finally:
        if job_key:
            with _ACTIVE_JOB_LOCK:
                if _ACTIVE_JOB_EVENTS.get(job_key) is cancel_event:
                    _ACTIVE_JOB_EVENTS.pop(job_key, None)


@app.post("/optimize-fleet/jobs/{job_id}/cancel")
def cancel_fleet_job(job_id: str):
    """Dừng chủ động job tối ưu đang chạy bằng signal cho worker pool."""
    with _ACTIVE_JOB_LOCK:
        event = _ACTIVE_JOB_EVENTS.get(job_id)
        if event is not None:
            event.set()
    return {"job_id": job_id, "cancelled": event is not None}


@app.post("/optimize-fleet", response_model=FleetOptimizationResponse)
async def optimize_fleet(request: FleetOptimizationRequest, raw_request: Request):
    """Tự chọn xe, tài xế và tuyến cho toàn bộ đơn trong snapshot của một chi nhánh."""
    batch = await _run_cancellable_fleet_solve(raw_request, request, max_candidates=1)
    if not batch.candidates:
        raise HTTPException(status_code=504 if batch.no_plan_status == "TIMEOUT" else 409,
                            detail="Chưa tìm được lịch giao đủ toàn bộ đơn và kiện.")
    return batch.candidates[0].result


@app.post("/optimize-fleet/candidates", response_model=FleetOptimizationBatchResponse)
async def optimize_fleet_candidates(request: FleetOptimizationRequest, raw_request: Request):
    """Chạy Hybrid-first, OR-Tools fallback và trả tối đa 3 phương án đã kiểm chứng."""
    return await _run_cancellable_fleet_solve(raw_request, request, max_candidates=3)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
