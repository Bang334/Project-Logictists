# Benchmark portfolio Hybrid ALNS

Baseline gọi trực tiếp hàm xử lý `/optimize-fleet/candidates` (`optimize_fleet_candidates`) và lấy ứng viên hạng 1. Portfolio chạy `direct-alns` trong tiến trình chính, đồng thời thử `ortools-alns` với seed từ hai chiến lược OR-Tools và `adaptive-sa-alns` với nghiệm khởi đầu Simulated Annealing. Portfolio chọn ứng viên theo cùng bộ tiêu chí audit với runner. JSON ghi ứng viên thắng, kết quả audit từng nhánh và thời gian CPU của mỗi nhánh khi portfolio được kích hoạt.

Chạy từ thư mục `optimizer` bằng PowerShell.

```powershell
.venv/Scripts/python.exe -m benchmarks.savings_warm_start.run --budget 15 --repeats 2 --cases db_hanoi_16_orders.json novel_5_rolling_3day_horizon.json scenario_4_tight_windows.json scenario_6_dynamic_reuse.json scenario_8_dense_fragmentation.json --output benchmarks/savings_warm_start/results_smoke_b15.json
```

Hai bên nhận cùng snapshot, bao gồm ma trận thời gian và khoảng cách. Runner đảo thứ tự hai pipeline giữa các lượt. Portfolio dùng seed gốc 0 mặc định, hoặc thử nhiều seed với `--seeds 0 1 2`. Production giữ cách chọn seed hiện hành. JSON ghi hash snapshot, seed, thời gian từng lượt, số đơn/kiện phục vụ và kết quả audit.

Hai trường `startup_source_sha256` và `source_sha256_at_result` giúp phát hiện khi mã optimizer hoặc benchmark đổi trong lúc đo.

Thêm `--cache-load-cycles` để thử tái sử dụng chứng nhận đã kiểm tra cho đoạn xếp/dỡ giữa hai trạng thái xe rỗng. Với một lần lấy và một lần giao các kiện cùng mặt đáy, nhánh thử dựng bố trí theo hàng và kiểm tra đường ra cửa của từng kiện trước khi dùng. Các trường hợp còn lại dùng bộ tìm kiếm bố trí. Trong các worker, thử nghiệm cũng tính sẵn cạnh kiện khi kiểm tra các vị trí xếp động. JSON ghi số chứng nhận theo hàng và số lượt thử vị trí từng nhánh.

Thêm `--stop-at-budget` để chạy các nhánh trong tiến trình con. Mỗi nhánh có thể lưu một nghiệm một phần đã qua audit trong khi tiếp tục tìm nghiệm giao đủ. Các nhánh `direct-alns`, `ortools-alns` và `diversified-sa-alns` ưu tiên lưu nghiệm giao đủ trước khi tinh chỉnh phân công xe. Tiến trình chính chọn trong các kết quả đã ghi hoàn chỉnh, rồi thu hồi worker và giải mã nghiệm. JSON ghi cờ vượt ngân sách và vị trí đang thực thi của các nhánh bị dừng nếu lấy được stack trace.

Thứ tự so sánh là audit hợp lệ, số đơn/kiện phục vụ, rồi thứ tự mục tiêu hiện hành của TMS. Thời gian thực tế và cờ vượt ngân sách được ghi riêng. Thời gian gồm các bước trong pipeline gọi trực tiếp, kể cả phần tính báo cáo nếu pipeline thực hiện. Audit chung chạy sau khi dừng đồng hồ. Ngân sách yêu cầu là tham số của solver và có thể bị vượt trong các bước dựng, thẩm định hoặc tạo báo cáo.

Phép thử so sánh hai pipeline trên dữ liệu lập kế hoạch tĩnh. Dynamic Re-optimization với điểm khóa, hàng đã lên xe và dữ liệu chạy thực tế cần benchmark riêng. Chỉ cân nhắc tích hợp sau khi đo được lợi ích lặp lại về tỷ lệ phục vụ, chất lượng nghiệm hoặc thời gian, đồng thời giữ các kiểm tra T21–T27.

## Kết quả ngày 14/11/2026 (sau tối ưu biến thể)

Ngân sách yêu cầu 5 giây, hai lượt cho 5 fixture hoàn chỉnh (10 cặp so sánh trong `results.json`):
- **Tỷ lệ phục vụ:** Cả baseline (`production`) và biến thể (`savings_hybrid`) đều phục vụ **100% đơn hàng ở 10/10 lượt**, vượt audit không gian và lịch trình hợp lệ.
- **Chất lượng nghiệm:** Biến thể **thắng 3/10** (`scenario_8_dense_fragmentation` cả 2 lượt, `scenario_6_dynamic_reuse` lượt 1), **hòa 4/10** (`db_songthan_4_orders` 2 lượt, `scenario_1_multi_item` 2 lượt), **thua 3/10** (`scenario_4_tight_windows` 2 lượt — 4 routes so với 3 routes của baseline; `scenario_6_dynamic_reuse` lượt 2).
- **Thời gian chạy thực tế:** Baseline `5,00–14,97 giây`; biến thể `4,42–18,05 giây` (nhanh hơn ở `scenario_6` và `scenario_8`, tương đương ở `db_songthan`, chậm hơn ở `scenario_1` và `scenario_4`).

T21–T27 và các test chứng nhận bố trí đạt 22/22 test (`pytest tests/test_t21_t27.py tests/test_benchmark_layout_certificate.py -q`). Khi tăng ngân sách lên `--budget 10` giây ([results_19cases_b10.json](file:///e:/Projects/Coursework/Project-Logictists/optimizer/benchmarks/savings_warm_start/results_19cases_b10.json)), cả hai thuật toán đều phục vụ **100% đơn ở 19/19 ca**, `savings_hybrid` hòa hoặc thắng **16/19 ca** (thắng 4, hòa 12, thua 3) và chạy nhanh hơn ở 14/19 ca.
