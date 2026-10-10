# TMS Optimization Engine

FastAPI service dùng Google OR-Tools cho routing và validator riêng cho tải từng chặng, pickup trước delivery và bố trí kiện không chồng/lối thao tác.

`POST /optimize-fleet/candidates` tự chọn cơ chế tìm kiếm. Bài toán 1–3 đơn với tối đa 2 xe vật lý dùng vét cạn các chuỗi pickup–delivery, phân xe/ngày và kiểm tra hình học. Bài toán lớn hơn chạy song song nhiều lượt OR-Tools độc lập qua process pool, đồng thời chạy thêm Packing-aware Hybrid ALNS với seed cố định. Response chỉ giữ nghiệm đã qua time window, ca xe, hạng bằng và `SpatialValidator`, sau đó lọc và xếp tối đa 3 phương án giao đủ 100% đơn theo objective chung.

Thứ hạng candidate dùng `planning_objective.selection_score_vnd`, không dùng riêng `total_cost_vnd`. Điểm này giữ chi phí route để báo cáo nhưng thay phần lương cố định phân bổ theo phút chạy bằng lương lịch của toàn bộ đội tài xế trong suốt số ngày kế hoạch còn mở. Nếu chi nhánh chưa cấu hình phạt giao trễ tài chính, objective cộng một penalty vận hành theo thời gian trễ; đây chỉ là trọng số quyết định và được trả riêng trong `operational_late_penalty_vnd`, không phải khoản phạt phải trả khách. `total_cost_vnd` vẫn là chi phí vận hành dự toán và không chứa penalty vận hành này.

Hybrid ALNS dùng portfolio tương thích với kết quả phòng thử nghiệm: profile legacy cho bài toán đa depot, profile evolved cho bài toán một depot, và nhánh simulated annealing chuyên biệt cho các case hàng dày hoặc tái sử dụng sàn. Solver nhận warm-start OR-Tools, dùng destroy/repair thích nghi, local search và audit tập elite. Mọi kiện chữ nhật được phép đổi hướng trên mặt sàn theo bội số 90° (0/90/180/270); không lật kiện để hoán đổi chiều cao. Fast packing chỉ dùng để tỉa tìm kiếm; tuyến trả về luôn được kiểm tra lại bằng `SpatialValidator` production. Kết quả vẫn là best-found trong ngân sách, không phải chứng minh tối ưu toàn cục.

Mốc tốt nhất lịch sử của từng testcase được lưu tập trung tại `benchmarks/best_known_results.json`; 12 input tương ứng nằm trong `benchmarks/cases/`. Chạy `python benchmark_hybrid_regression.py` để chạy lại Hybrid ALNS production với seed và ngân sách tìm kiếm đã ghi nhận, hoặc thêm `--cases <tên-file>` để chạy một phần. Runner luôn audit lại bằng availability, service-day, giới hạn xe theo đơn và `SpatialValidator` production. Case legacy không bảo toàn các ràng buộc này được đánh dấu `cost_comparable_to_production=false` và không làm CI báo hồi quy chi phí.

Trước khi tìm kiếm, optimizer loại các slot xe-ngày không thể phục vụ bất kỳ đơn nào ngay cả khi giả sử thời gian di chuyển bằng 0. Ma trận được cắt đồng bộ với danh sách xe, nên không làm lệch node index. Phép lọc này chỉ loại slot chắc chắn không khả thi theo ca và time window.

Mặc định, số lượt và ngân sách được chọn thích ứng theo số đơn, số kiện, số xe vật lý và số slot xe theo ngày. Nếu request gửi `search_time_seconds` (số nguyên từ 1 đến 120), giá trị này trở thành ngân sách tối đa tường minh cho mỗi lượt tìm kiếm chính và không bị policy tự rút ngắn; `max_time_seconds` vẫn là trần an toàn phía server:

- job 1–3 đơn, tối đa 2 xe vật lý dùng 1 lượt vét cạn trong ngân sách chung;
- job ngoài ngưỡng vét cạn dùng 2–4 chiến lược khi nhỏ/trung bình;
- job lớn dùng tối đa 6 chiến lược;
- trần cứng của một lượt là 120 giây;
- một lượt được dừng sớm khi đã có nghiệm giao đủ đơn ở tầng routing và objective không còn cải thiện trong khoảng stagnation của policy.

Với job ngoài ngưỡng rất nhỏ, ngân sách mong muốn là `ceil(5 + 1,30 × complexity)` và bị chặn bởi trần caller/120 giây. Phân bổ theo tổng ngân sách thực:

| Ngân sách | Routing | Validator | Gom tuyến | Stagnation |
|---:|---:|---:|---:|---:|
| ≤ 3 giây | 60% | 25% | 15% | 0,5 giây |
| 4–20 giây | 65% | 20% | 15% | 1,5 giây |
| 21–60 giây | 72% | 18% | 10% | 20% ngân sách routing, trong khoảng 4–12 giây |
| 61–120 giây | 78% | 14% | 8% | 25% ngân sách routing, trong khoảng 12–24 giây |

Ngân sách trên vẫn dành phần riêng cho validator hình học và gom tuyến. Nhánh vét cạn chỉ tuyên bố tối ưu trong không gian đã mô hình hóa khi routing, ghép xe và validator đều duyệt xong; nếu chạm giới hạn thì diagnostics ghi rõ đây chỉ là nghiệm tốt nhất đã tìm thấy. Mọi kết quả trả về vẫn phải vượt validator.

## Chạy

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Chạy kiểm tra bằng `python -m pytest -q`. Solver phân biệt `TIMEOUT` với `INFEASIBLE` từ trạng thái OR-Tools; kết quả vẫn phải qua validator trước khi backend lưu hoặc áp dụng.

Ma trận khoảng cách/thời gian phải đến từ provider đã kiểm chứng. Script debug có hệ số Haversine chỉ phục vụ dữ liệu thử nghiệm, không phải tuyến thật và không được dùng làm kết quả vận hành.

Benchmark lặp lại được: `python benchmark.py --sizes 50 200 500 --time-limit 5`. Dữ liệu và matrix do script sinh là synthetic, chỉ dùng đo hồi quy hiệu năng; không đại diện KPI vận hành hay chất lượng tuyến Mapbox.
