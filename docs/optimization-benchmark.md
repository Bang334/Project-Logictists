# Benchmark tối ưu lộ trình

## Baseline Hybrid-first cục bộ ngày 28/11/2026

Chạy một lượt trên Windows 11, Python 3.12.3, OR-Tools 9.15.6755, AMD Ryzen 5 5600H (6 nhân, 12 luồng). Bộ sinh đơn và ma trận tổng hợp giữ nguyên, dùng cấu hình xếp 3D mặc định. Cột thời gian gồm cả dựng đầu vào và kiểm tra phương án.

```powershell
cd optimizer
.\.venv\Scripts\python.exe benchmark.py --mode hybrid-first --sizes 50 100 200 500 --time-limit 20 --wall-timeout 45
```

| Đơn | Thời gian thực | Đơn phục vụ | Tuyến | Km | Điểm xếp hạng (VND) | Tuyến lỗi xếp hàng |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 21,089 giây | 50/50 | 1 | 106,00 | 795.246 | 0 |
| 100 | 20,605 giây | 100/100 | 4 | 225,90 | 2.059.516 | 0 |
| 200 | 22,949 giây | 200/200 | 8 | 555,05 | 4.637.650 | 0 |
| 500 | 22,065 giây | Hết thời gian, chưa có phương án trả về | — | — | — | — |

SHA-256 của payload theo số đơn

- 50 — `d39d58d5e60f550955916c3139110866e127b876e46885c0369cb10b052e5272`
- 100 — `9f51f63fee0f2eb2d22086dc87bb32f9e70d97da46c7e970d0abbbf6d32de72b`
- 200 — `f3f63f9a5fc8db4482e3856a8ea8e033b4493bbfd7699ab2e229e74d835951ac`
- 500 — `bb653d5b1c5a54b68e3deb9a941c17b973afa0bb737ac42ea4e2f56e86d2444f`

Mốc 500 đơn cần đo lặp với ngân sách phù hợp vận hành và trên snapshot đại diện trước khi quyết định phân cụm. Các số đo trên dùng ma trận tổng hợp.

### Lượt đo lại với cùng đầu vào và ngân sách 20 giây

Hash đầu vào ở cả bốn cỡ trùng với baseline ở trên. Thời gian thực bao gồm khởi tạo đầu vào và xử lý kết quả. Một phần lượt đo trùng với kiểm tra kiểu của backend và frontend.

| Đơn | Thời gian thực | Trạng thái | Đơn phục vụ | Tuyến | Km | Chi phí và điểm chọn (VND) | Tuyến lỗi kiểm định 3D |
|---:|---:|---|---:|---:|---:|---:|---:|
| 50 | 18,174 s | SUCCESS | 50/50 | 2 | 109,95 | 1.014.737 | 0 |
| 100 | 20,756 s | SUCCESS | 100/100 | 4 | 225,70 | 2.058.480 | 0 |
| 200 | 22,490 s | SUCCESS | 200/200 | 8 | 560,20 | 4.663.453 | 0 |
| 500 | 21,454 s | TIMEOUT | — | — | — | — | — |

Ca 500 đơn hết thời gian ở cả hai lượt đo. Ca 100 và 200 đơn trả đủ phương án nhưng vượt 20 giây khi tính đầu cuối ở lượt này.

Đo chẩn đoán ca 500 đơn bằng `cProfile` quanh `benchmark.run_one(500, 20, "hybrid-first", queue)` cho thấy thời gian tích lũy ở tạo nghiệm đầu là 8,94 giây, dựng phản hồi cuối 8,04 giây, kiểm định không gian 7,42 giây và tính đối chứng giao riêng 5,06 giây. Các hàm có quan hệ gọi lồng nhau nên các mốc này có thể trùng. Lượt gắn profiler mất 33,08 giây và trả `NO_COMPLETE_PLAN`, có chi phí đo riêng. Các mốc chỉ dùng để chọn điểm kiểm tra tiếp theo. Cần xác nhận trên dữ liệu vận hành trước khi chọn phương án chia cụm.

## Baseline OR-Tools ngày 03/10/2026

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

## A/B Hybrid-first và OR-Tools warm-start — 2026-10-11

Đo trực tiếp bốn fixture production trên Windows/Python 3.8. Pipeline cũ nhận preset 10 giây cho tầng OR-Tools và tối đa 6 giây cho Hybrid; nhánh Hybrid độc lập nhận 16 giây để giữ cùng ngân sách danh nghĩa đầu-cuối. Mỗi kết quả đều qua production `SpatialValidator`.

| Dataset | Pipeline cũ: phục vụ, tuyến, chi phí, thời gian | Hybrid độc lập: phục vụ, tuyến, chi phí, thời gian | Kết quả |
|---|---|---|---|
| `scenario_2_heavy_cargo.json` | 12/12, 5, 4.896.140 VND, 23,882s | 12/12, 2, 3.739.059 VND, 21,321s | Hybrid giao đủ với ít tuyến và chi phí thấp hơn |
| `scenario_4_tight_windows.json` | 5/18, 1, 560.374 VND, 25,590s | 18/18, 4, 2.578.084 VND, 26,138s | Hybrid phục vụ đủ; chi phí không so trực tiếp vì pipeline cũ bỏ 13 đơn |
| `scenario_6_dynamic_reuse.json` | 14/14, 3, 2.375.090 VND, 15,898s | 14/14, 1, 1.840.073 VND, 14,478s | Hybrid giao đủ với ít tuyến và chi phí thấp hơn |
| `scenario_8_dense_fragmentation.json` | 16/16, 4, 4.275.805 VND, 47,827s | 16/16, 3, 3.782.594 VND, 43,307s | Hybrid giao đủ với ít tuyến và chi phí thấp hơn |

Trong pipeline cũ, candidate đứng đầu cả 4/4 case vẫn là Hybrid ALNS; không có candidate OR-Tools nào thắng. Kết quả này đủ để chuyển đường chạy production sang Hybrid-first, nhưng chưa chứng minh OR-Tools vô dụng trên mọi input. Vì vậy OR-Tools được giữ lại đúng một lượt fallback khi mọi seed Hybrid không tạo được tuyến.

Sau thay đổi, chạy lại preset mặc định 30 giây:

| Dataset | Trạng thái | Phục vụ | Validator | Tuyến | Chi phí | Thời gian | Solver run |
|---|---|---:|---|---:|---:|---:|---:|
| `scenario_4_tight_windows.json` | SUCCESS | 18/18 | PASS | 2 | 1.771.413 VND | 37,831s | 1 Hybrid |
| `scenario_8_dense_fragmentation.json` | SUCCESS | 16/16 | PASS | 2 | 3.275.179 VND | 53,292s | 1 Hybrid |

Đây là benchmark hồi quy trên fixture đã biết, không phải SLA hoặc bằng chứng tối ưu toàn cục. OR-Tools fallback chưa được kích hoạt trong hai lần chạy sau thay đổi vì Hybrid đã trả tuyến hợp lệ.
