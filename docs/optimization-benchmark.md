# Optimization benchmark — 2026-10-03

Lệnh đã chạy trên máy phát triển Windows/Python 3.8:

```powershell
cd optimizer
python benchmark.py --sizes 50 200 500 --time-limit 2 --wall-timeout 15
```

| Đơn | Xe ứng viên | Thời gian | Trạng thái | Đơn phục vụ |
|---:|---:|---:|---|---:|
| 50 | 2 | 2.079 giây | PARTIAL | 21/50 |
| 200 | 8 | 9.182 giây | PARTIAL | 17/200 |
| 500 | 20 (theo generator) | 15 giây | PROCESS_TIMEOUT | Chưa xác định |

Dữ liệu và ma trận là synthetic, không phải dữ liệu Mapbox hay bộ dữ liệu vận hành đại diện. Kết quả này chỉ là baseline hồi quy: với cấu hình thử nghiệm rất ngắn, quy mô 500 đơn chưa đạt giới hạn tiến trình 15 giây và không được diễn giải là `INFEASIBLE`. Cần profiling/benchmark trên dữ liệu đại diện trước khi chốt SLO hoặc năng lực production.

## Chẩn đoán tỷ lệ phục vụ thấp (2026-10-03)

Cùng dataset 50 đơn, chỉ tăng time budget:

```powershell
cd optimizer
python benchmark.py --sizes 50 --time-limit 20 --wall-timeout 90
```

| Đơn | Time budget | Thời gian | Trạng thái | Đơn phục vụ | Tuyến | Km | Chi phí dự toán (VND) |
|---:|---:|---:|---|---:|---:|---:|---:|
| 50 | 20 giây | 19.317 giây | SUCCESS | 50/50 | 1 | 178.7 | 1.160.359 |

## Thử nghiệm quy mô lớn 200 và 500 đơn (2026-10-03)

```powershell
cd optimizer
python benchmark.py --sizes 200 500 --time-limit 60 --wall-timeout 180
```

| Đơn | Xe ứng viên | Time budget | Thời gian thực | Trạng thái | Đơn phục vụ | Ghi chú |
|---:|---:|---:|---:|---|---:|---|
| 200 | 8 | 60 giây | 64.246 giây | TIMEOUT | 0/200 (200 unassigned) | Hết time budget trước khi OR-Tools tìm được nghiệm khả thi toàn cục |
| 500 | 20 | 60 giây | 180 giây | PROCESS_TIMEOUT | Chưa xác định | Vượt giới hạn thời gian tiến trình (wall-clock timeout 180s) |

**Kết luận về giới hạn hiệu năng:**
- Với dataset synthetic và bài toán VRP kết hợp pickup-delivery, time window và 3D floor packing validator, solver OR-Tools chạy tối ưu tốt nhất ở quy mô $\le 50$ đơn trong ngân sách 20 giây.
- Ở quy mô $\ge 200$ đơn, solver cần phân cụm (clustering/batching theo khu vực địa lý) trước khi đưa vào routing solver, hoặc cần ngân sách thời gian lớn hơn nhiều.
- Trạng thái `TIMEOUT` và `PROCESS_TIMEOUT` được phân biệt rành mạch, không bị suy diễn thành `INFEASIBLE`.

## Hồi quy job nhỏ Nha Trang — 2026-10-04

Đo trực tiếp `MultiStartFleetOptimizer` trên fixture 2 đơn, 9 kiện, 1 xe và 1 tài xế được trải thành 7 slot ngày, dùng ma trận Nha Trang trong regression test:

| Policy | Chiến lược | Thời gian thực | Trạng thái | Tuyến | Đơn chưa xếp |
|---|---:|---:|---|---:|---:|
| Cũ: tối thiểu 60 giây, 6 lượt | 6 | khoảng 41,5 giây trên payload nhỏ tương đương | SUCCESS | 1 | 0 |
| Thích ứng: budget 10 giây, stagnation 1,5 giây | 3 | 3,518 giây | SUCCESS | 1 | 0 |
| Vét cạn tuyến nhỏ, budget chung 12 giây | 1 | 0,36 giây | SUCCESS | 1 | 0 |

Phép đo chạy trên Windows/Python 3.8 bằng test process mới; `pytest --durations=1` ghi nhận 0,36 giây cho phần call test sau khi import. Nhánh vét cạn đã duyệt 56 chuỗi tuyến trên 7 slot ngày và 77 phân công giao đủ đơn. Tầng routing đã duyệt hết, nhưng một số chuỗi không hợp lệ chạm giới hạn tìm bố trí; vì vậy kết quả không được tuyên bố tối ưu toàn cục. Đây là benchmark hồi quy cục bộ, không phải SLA production.

Với snapshot miền Bắc 16 đơn, 297 kiện, 3 xe vật lý và 21 slot xe-ngày, policy tổng thể cho complexity `66,5` là 92 giây/lượt: routing 78%, validator 14%, gom tuyến 8% và stagnation 17,94 giây. Đây là policy được suy ra từ công thức chung, không phải ngoại lệ hardcode theo chi nhánh.
