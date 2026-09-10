from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List
from pydantic import BaseModel

from .models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    OptimizationRequest,
    OptimizationResponse,
    VehicleFloor,
    StopAction,
    SpatialValidationResult,
)
from .spatial_validator import SpatialValidator
from .routing_solver import FleetRoutingSolver, OrToolsRoutingSolver

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

class ValidatePlanRequest(BaseModel):
    vehicle: VehicleFloor
    stops: List[StopAction]

@app.get("/health")
def health():
    return {"status": "ok", "service": "optimizer", "engine": "Google OR-Tools + Dynamic 2D Spatial Validator"}

@app.post("/validate-spatial", response_model=SpatialValidationResult)
def validate_spatial(request: ValidatePlanRequest):
    """
    Thẩm định tính khả thi hình học và xếp dỡ động cho một chuỗi điểm dừng (Stops).
    Kiểm tra triệt để các kịch bản T21-T27: cấm chồng, kiểm tra lối dỡ ra cửa, tái sử dụng không gian.
    """
    validator = SpatialValidator(request.vehicle)
    result = validator.validate_plan(request.stops)
    return result

@app.post("/optimize", response_model=OptimizationResponse)
def optimize(request: OptimizationRequest):
    """
    Chạy bài toán tối ưu tuyến (OR-Tools VRPPDTW) kết hợp thẩm định hình học động.
    """
    solver = OrToolsRoutingSolver(request)
    result = solver.solve()
    return result


@app.post("/optimize-fleet", response_model=FleetOptimizationResponse)
def optimize_fleet(request: FleetOptimizationRequest):
    """Tự chọn xe, tài xế và tuyến cho toàn bộ đơn trong snapshot của một chi nhánh."""
    solver = FleetRoutingSolver(request)
    return solver.solve()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
