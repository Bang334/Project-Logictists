from __future__ import annotations

import sys

if sys.version_info < (3, 11):
    raise RuntimeError("Optimizer requires Python 3.11+. On Windows run start_optimizer.ps1 from the project root.")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from typing import List

from .models import (
    DemoStackingPolicy,
    FleetOptimizationRequest,
    FleetOptimizationBatchResponse,
    FleetOptimizationResponse,
    OptimizationRequest,
    OptimizationResponse,
    VehicleFloor,
    StopAction,
    SpatialValidationResult,
    StrictContractModel,
)
from .spatial_validator import SpatialValidator
from .routing_solver import FleetRoutingSolver, OrToolsRoutingSolver
from .multi_start import MultiStartFleetOptimizer
from .demo import router as demo_router
from .stacking import DemoStacks

app = FastAPI(
    title="TMS Optimization & Spatial Packing Engine",
    description="Google OR-Tools VRP Solver phối hợp cùng Dynamic Non-stacking 2D Spatial Packing Engine (Người 3)",
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
    demo_stacking: DemoStackingPolicy | None = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "optimizer",
        "engine": "Packing-aware Hybrid ALNS + bounded OR-Tools fallback + Dynamic 2D Spatial Validator",
    }

@app.post("/validate-spatial", response_model=SpatialValidationResult)
def validate_spatial(request: ValidatePlanRequest):
    """
    Thẩm định tính khả thi hình học và xếp dỡ động cho một chuỗi điểm dừng (Stops).
    Kiểm tra triệt để các kịch bản T21-T27: cấm chồng, kiểm tra lối dỡ ra cửa, tái sử dụng không gian.
    """
    validator = SpatialValidator(request.vehicle)
    if request.demo_stacking is None:
        return validator.validate_plan(request.stops)
    stacks = DemoStacks(request.demo_stacking, [request.vehicle])
    return stacks.validate_stops(validator, request.stops)

@app.post("/optimize", response_model=OptimizationResponse)
def optimize(request: OptimizationRequest):
    """
    Chạy bài toán tối ưu tuyến (OR-Tools VRPPDTW) kết hợp thẩm định hình học động.
    """
    if request.demo_stacking is None:
        return OrToolsRoutingSolver(request).solve()
    stacks = DemoStacks(request.demo_stacking, [request.vehicle])
    result = OrToolsRoutingSolver(request.model_copy(update={"orders": stacks.bundle_orders(request.orders)})).solve()
    stops = stacks.expand_stops(result.stops)
    return result.model_copy(update={
        "stops": stops,
        "spatial_validation": stacks.improve_route_layout(stops, stacks.expand_layout(result.spatial_validation), request.vehicle) if result.spatial_validation else None,
    })


@app.post("/optimize-fleet", response_model=FleetOptimizationResponse)
def optimize_fleet(request: FleetOptimizationRequest):
    """Tự chọn xe, tài xế và tuyến cho toàn bộ đơn trong snapshot của một chi nhánh."""
    if request.demo_stacking is None:
        return FleetRoutingSolver(request).solve()
    stacks = DemoStacks(request.demo_stacking, request.vehicles)
    result = FleetRoutingSolver(request.model_copy(update={"orders": stacks.bundle_orders(request.orders)})).solve()
    return stacks.expand_fleet(result)


@app.post("/optimize-fleet/candidates", response_model=FleetOptimizationBatchResponse)
def optimize_fleet_candidates(request: FleetOptimizationRequest):
    """Chạy Hybrid-first, OR-Tools fallback và trả tối đa 3 phương án đã kiểm chứng."""
    if request.demo_stacking is None:
        return MultiStartFleetOptimizer(request).solve(max_candidates=3)
    stacks = DemoStacks(request.demo_stacking, request.vehicles)
    batch = MultiStartFleetOptimizer(request.model_copy(update={"orders": stacks.bundle_orders(request.orders)})).solve(max_candidates=3)
    return stacks.expand_batch(batch)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
