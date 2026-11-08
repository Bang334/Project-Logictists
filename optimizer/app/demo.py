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
    FleetOptimizationBatchResponse,
    FleetOptimizationRequest,
)
from .multi_start import MultiStartFleetOptimizer
from .stacking import DemoStacks

router = APIRouter(prefix="/demo", tags=["Demo Benchmarks"])

CASES_DIR = Path(__file__).resolve().parent.parent / "benchmarks" / "cases"

CASE_METADATA: Dict[str, Dict[str, Any]] = {
    "scenario_stack_customer_modes": {
        "name": "Xếp chồng cùng khách và khác khách",
        "category": "SCENARIO",
        "category_name": "Kịch bản demo",
        "description": "Hai khách có hai kiện cùng đáy. Thứ tự lấy và giao cho phép thử đặt kiện nhẹ của khách thứ hai lên kiện của khách thứ nhất.",
        "suggested_time_limit_sec": 6.0,
    },
    "scenario_stack_cost_comparison": {
        "name": "So sánh chi phí xếp chồng ba tầng",
        "category": "SCENARIO",
        "category_name": "Kịch bản demo",
        "description": "Một đơn, ba kiện cùng đáy và ba xe nhỏ. Bật hoặc tắt xếp chồng trên cùng ma trận quãng đường giả lập để so chi phí.",
        "suggested_time_limit_sec": 6.0,
    },
    "novel_1_mekong_hub_spoke": {
        "name": "Mê Kông 2 chiều (Star Topology, Fronthaul-Backhaul)",
        "category": "NOVEL",
        "category_name": "Novel Nâng Cao",
        "description": "Tuyến mạng hình sao ĐBSCL, phối hợp chiều đi giao vật tư và chiều về gom nông sản về kho trung tâm Cần Thơ.",
        "suggested_time_limit_sec": 6.0,
    },
    "novel_2_long_narrow_timber": {
        "name": "Gỗ dài 2.3m, sàn xe hẹp (Ràng buộc hình học 2D)",
        "category": "NOVEL",
        "category_name": "Novel Nâng Cao",
        "description": "12 kiện gỗ dài 2.3m, tổng tải 7.2 tấn. Xe chỉ chở tối đa 3.2 tấn và thùng hẹp, kiểm tra nghiêm ngặt cấm xếp chồng và lối dỡ ra cửa sau.",
        "suggested_time_limit_sec": 6.0,
    },
    "novel_3_three_shift_relay": {
        "name": "Cảng biển 3 ca xoay vòng xe (Sáng - Trưa - Tối)",
        "category": "NOVEL",
        "category_name": "Novel Nâng Cao",
        "description": "Điều phối 18 đơn phân bổ trải dài 3 ca làm việc trong ngày, tối ưu xoay vòng một xe tải phục vụ toàn bộ lộ trình liên tục.",
        "suggested_time_limit_sec": 6.0,
    },
    "novel_4_3tier_asymmetric_fleet": {
        "name": "Đội xe 3 tầng tải trọng lệch tâm (Tối ưu ghép xe)",
        "category": "NOVEL",
        "category_name": "Novel Nâng Cao",
        "description": "Đội xe phân tầng (1 tấn, 2.5 tấn, 5 tấn) với chi phí định mức khác biệt; tối ưu gom đơn vào các xe tải lớn nhất để tiết kiệm số xe.",
        "suggested_time_limit_sec": 6.0,
    },
    "novel_5_rolling_3day_horizon": {
        "name": "Cửa sổ thời gian trượt 3 ngày (Đơn liên ngày)",
        "category": "NOVEL",
        "category_name": "Novel Nâng Cao",
        "description": "Lập kế hoạch phân bổ đơn hàng qua chân trời thời gian 3 ngày, tối ưu ngày xuất phát xe và chi phí lưu kho.",
        "suggested_time_limit_sec": 6.0,
    },
    "scenario_1_multi_item": {
        "name": "Đa kiện hàng hóa (Nhiều kiện kích thước khác nhau)",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Mỗi đơn gồm nhiều kiện hàng có kích thước và trọng lượng khác nhau, kiểm tra xếp dỡ LIFO 2D theo kiện.",
        "suggested_time_limit_sec": 5.0,
    },
    "scenario_2_heavy_cargo": {
        "name": "Hàng nặng tiếp cận tải trọng xe",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Các kiện hàng có mật độ khối lượng lớn, kiểm tra tải trọng từng chặng (leg) và phụ trội nhiên liệu tải nặng.",
        "suggested_time_limit_sec": 5.0,
    },
    "scenario_3_dispersed": {
        "name": "Điểm giao nhận phân tán diện rộng",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Khoảng cách giữa các điểm giao nhận xa nhau, tối ưu giảm thiểu tổng quãng đường km và phụ phí tài xế.",
        "suggested_time_limit_sec": 5.0,
    },
    "scenario_4_tight_windows": {
        "name": "Khung giờ giao nhận ngặt nghèo (Tight Time Windows)",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Cửa sổ thời gian nhận và trả hàng rất hẹp; kiểm tra khả năng điều phối đúng giờ và phạt trễ hạn.",
        "suggested_time_limit_sec": 5.0,
    },
    "scenario_5_heterogeneous_fleet": {
        "name": "Đội xe hỗn hợp nhiều kích cỡ tải trọng",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Đội xe đa dạng kích thước thùng và tải trọng; thuật toán tự chọn loại xe tối ưu nhất cho từng tuyến.",
        "suggested_time_limit_sec": 6.0,
    },
    "scenario_6_dynamic_reuse": {
        "name": "Tái sử dụng không gian sàn xe động",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Sau khi giao đơn trước, khoảng trống trên sàn được giải phóng để bốc đơn tiếp theo mà không cản cửa.",
        "suggested_time_limit_sec": 5.0,
    },
    "scenario_7_multi_depot_overnight": {
        "name": "Đa kho xuất phát & lưu kho qua đêm",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Nhiều xe xuất phát từ các kho khác nhau (Hà Nội, Hải Phòng, Bắc Ninh); kiểm tra ma trận đa trạm liên tỉnh.",
        "suggested_time_limit_sec": 6.0,
    },
    "scenario_8_dense_fragmentation": {
        "name": "Phân mảnh đơn hàng mật độ cao",
        "category": "SCENARIO",
        "category_name": "Bài Toán Vận Tải Đặc Thù",
        "description": "Nhiều đơn lẻ nhỏ phân bố dày đặc trong nội thành, thử thách năng lực gom tuyến của Hybrid ALNS.",
        "suggested_time_limit_sec": 6.0,
    },
    "db_danang_30_orders": {
        "name": "Dữ liệu thực tế Đà Nẵng (30 đơn gom tải)",
        "category": "REAL_DATA",
        "category_name": "Dữ Liệu Thực Tế Doanh Nghiệp",
        "description": "Tập dữ liệu quy mô lớn 30 đơn hàng thực tế tại khu vực Đà Nẵng - Quảng Nam.",
        "suggested_time_limit_sec": 8.0,
    },
    "db_hanoi_16_orders": {
        "name": "Dữ liệu thực tế Hà Nội (16 đơn đa quận)",
        "category": "REAL_DATA",
        "category_name": "Dữ Liệu Thực Tế Doanh Nghiệp",
        "description": "16 đơn hàng thực tế giao nhận liên quận tại khu vực Hà Nội.",
        "suggested_time_limit_sec": 6.0,
    },
    "db_songthan_4_orders": {
        "name": "Dữ liệu thực tế KCN Sóng Thần (4 đơn phân phối)",
        "category": "REAL_DATA",
        "category_name": "Dữ Liệu Thực Tế Doanh Nghiệp",
        "description": "Tuyến phân phối hàng hóa xuất phát từ Tổng kho Sóng Thần (Bình Dương).",
        "suggested_time_limit_sec": 4.0,
    },
    "db_nhatrang_2_orders": {
        "name": "Dữ liệu thực tế Nha Trang (2 đơn cơ bản)",
        "category": "REAL_DATA",
        "category_name": "Dữ Liệu Thực Tế Doanh Nghiệp",
        "description": "Tập dữ liệu mẫu cơ bản 2 đơn hàng nội thành Nha Trang (Khánh Hòa).",
        "suggested_time_limit_sec": 3.0,
    },
}


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
        default=None, ge=1.0, le=180.0, description="Ngân sách thời gian tìm kiếm (giây)"
    )
    custom_request: Optional[FleetOptimizationRequest] = Field(
        default=None, description="Tùy chọn tải lên tệp JSON FleetOptimizationRequest riêng"
    )
    demo_stacking_enabled: Optional[bool] = None
    demo_stacking_owner_mode: Optional[Literal["SAME_CUSTOMER", "ANY_CUSTOMER"]] = None


def _load_case_dict(case_id: str) -> dict:
    if not CASES_DIR.exists():
        raise HTTPException(status_code=500, detail="Thư mục benchmarks/cases không tồn tại")
    case_file = CASES_DIR / f"{case_id}.json"
    if not case_file.exists():
        raise HTTPException(status_code=404, detail=f"Không tìm thấy kịch bản {case_id}")
    try:
        with open(case_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Lỗi khi đọc file kịch bản {case_id}: {exc}"
        )


@router.get("/cases", response_model=List[DemoCaseSummary])
def list_demo_cases() -> List[DemoCaseSummary]:
    """Danh sách 17 kịch bản benchmark chuẩn kèm metadata mô tả."""
    if not CASES_DIR.exists():
        return []

    summaries: List[DemoCaseSummary] = []
    case_files = sorted(CASES_DIR.glob("*.json"))

    for file_path in case_files:
        stem = file_path.stem
        meta = CASE_METADATA.get(
            stem,
            {
                "name": stem,
                "category": "SCENARIO",
                "category_name": "Kịch Bản Khác",
                "description": f"Kịch bản thử nghiệm {stem}",
                "suggested_time_limit_sec": 5.0,
            },
        )
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            orders = data.get("orders", [])
            vehicles = data.get("vehicles", [])
            drivers = data.get("drivers", [])

            total_weight = 0.0
            total_volume = 0.0
            for o in orders:
                for item in o.get("items", []):
                    total_weight += float(item.get("weight_kg", 0.0))
                    l = float(item.get("length_cm", 0.0)) / 100.0
                    w = float(item.get("width_cm", 0.0)) / 100.0
                    h = float(item.get("height_cm", 0.0)) / 100.0
                    total_volume += l * w * h

            summaries.append(
                DemoCaseSummary(
                    id=stem,
                    filename=file_path.name,
                    name=meta["name"],
                    category=meta["category"],
                    category_name=meta["category_name"],
                    description=meta["description"],
                    orders_count=len(orders),
                    vehicles_count=len(vehicles),
                    drivers_count=len(drivers),
                    total_weight_kg=round(total_weight, 2),
                    total_volume_cbm=round(total_volume, 3),
                    suggested_time_limit_sec=float(meta.get("suggested_time_limit_sec", 6.0)),
                    supports_stacking=data.get("demo_stacking") is not None,
                )
            )
        except Exception:
            continue

    # Sắp xếp: Novel trước, rồi Scenario, rồi Real Data
    category_order = {"NOVEL": 0, "SCENARIO": 1, "REAL_DATA": 2}
    summaries.sort(key=lambda s: (category_order.get(s.category, 99), s.orders_count, s.name))
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

    if payload.time_budget_seconds:
        request.max_time_seconds = float(payload.time_budget_seconds)

    # Chạy trực tiếp qua MultiStartFleetOptimizer (Hybrid ALNS first)
    stacking_policy = request.demo_stacking if payload.demo_stacking_enabled is not False else None
    if stacking_policy and payload.demo_stacking_owner_mode:
        stacking_policy = stacking_policy.model_copy(update={"owner_mode": payload.demo_stacking_owner_mode})
    stacks = DemoStacks(stacking_policy, request.vehicles) if stacking_policy else None
    solver_request = request.model_copy(update={
        "orders": stacks.bundle_orders(request.orders) if stacks else request.orders,
        "demo_stacking": stacking_policy,
    })
    optimizer = MultiStartFleetOptimizer(solver_request)
    batch = optimizer.solve(max_candidates=3)
    if stacks:
        batch = stacks.expand_batch(batch)

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
