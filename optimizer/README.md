# TMS Optimization Engine

Điều phối tự động chỉ trả phương án đã đối soát đầy đủ đơn và kiện. API
`/optimize-fleet/candidates` trả danh sách rỗng kèm `no_plan_status` khi hết
thời gian hoặc chưa tìm được lịch đủ. Backend mở rộng lịch theo các ca tiếp
theo trong ngân sách tìm kiếm, giữ khung hẹn đã xác nhận và các ca bị giữ chỗ.
API `/optimize-fleet` trả lỗi nếu chưa có phương án giao đủ.


FastAPI service dùng Packing-aware Hybrid ALNS làm bộ tìm kiếm chính, Google OR-Tools làm fallback có giới hạn, và validator riêng cho tải từng chặng, pickup trước delivery và bố trí kiện 3D theo bước. Request gửi `demo_stacking: null` để dùng chế độ đặt sàn.

`POST /optimize-fleet/candidates` tự chọn cơ chế tìm kiếm. Bài toán 1–3 đơn với tối đa 2 xe vật lý dùng vét cạn các chuỗi pickup–delivery, phân xe/ngày và kiểm tra hình học. Bài toán lớn hơn chạy Hybrid-first: một seed dùng toàn bộ ngân sách dưới 48 giây; từ 48 giây và ít nhất 8 đơn thì hai seed chia đều ngân sách. OR-Tools chỉ chạy đúng một lượt fallback khi tất cả seed Hybrid không tạo được tuyến. Response chỉ giữ nghiệm đã qua time window, ca xe, hạng bằng và `SpatialValidator`, sau đó lọc và xếp tối đa 3 phương án giao đủ 100% đơn theo objective chung.

Khi có ca trong nhiều ngày, bộ điều phối Hybrid tính lịch Direct trên cùng đầu vào. Nếu Direct giao đủ, Hybrid dành tối đa 30% ngân sách tìm kiếm còn lại để thử ghép trong mốc ngày đó. Chuỗi chuyến Direct theo từng xe/ngày cung cấp thứ tự lấy và giao ban đầu. Khi chuỗi này đã qua kiểm tra, Hybrid giữ làm phương án dự phòng và thử đưa điểm lấy của đơn sau lên trước điểm giao của đơn trước. Phương án ghép phải giao đủ, qua kiểm tra xếp/dỡ, giảm quãng đường, giữ hoặc giảm thời gian và cải thiện điểm xếp hạng. Với lịch nhiều ngày, bảng ưu tiên điểm chi phí toàn đội trong các nghiệm giao đủ, giữ đại diện cho các số ngày khác nhau trước khi điền thêm lịch cùng số ngày. Seed 0 có thể tìm tiếp từ lịch ngắn đã kiểm chứng trên toàn bộ các ca.

Thứ hạng candidate dùng `planning_objective.selection_score_vnd`, không dùng riêng `total_cost_vnd`. Điểm này giữ chi phí route để báo cáo nhưng thay phần lương cố định phân bổ theo phút chạy bằng lương lịch của toàn bộ đội tài xế trong suốt số ngày kế hoạch còn mở. Nếu chi nhánh chưa cấu hình phạt giao trễ tài chính, objective cộng một penalty vận hành theo thời gian trễ; đây chỉ là trọng số quyết định và được trả riêng trong `operational_late_penalty_vnd`, không phải khoản phạt phải trả khách. `total_cost_vnd` vẫn là chi phí vận hành dự toán và không chứa penalty vận hành này.

Hybrid ALNS dùng portfolio tương thích với kết quả phòng thử nghiệm: profile legacy cho bài toán đa depot, profile evolved cho bài toán một depot, và nhánh simulated annealing chuyên biệt cho các case hàng dày hoặc tái sử dụng sàn. Solver tự dựng nghiệm đầu, dùng destroy/repair thích nghi, local search và audit tập elite; không còn phụ thuộc warm-start OR-Tools trên đường chạy chính. Mọi kiện chữ nhật được phép đổi hướng trên mặt sàn theo bội số 90° (0/90/180/270); không lật kiện để hoán đổi chiều cao. Fast packing chỉ dùng để tỉa tìm kiếm; tuyến trả về luôn được kiểm tra lại bằng `SpatialValidator` production. Kết quả vẫn là best-found trong ngân sách, không phải chứng minh tối ưu toàn cục.

Mốc tốt nhất lịch sử của từng testcase được lưu tập trung tại `benchmarks/best_known_results.json`; 12 input tương ứng nằm trong `benchmarks/cases/`. Chạy `python benchmark_hybrid_regression.py` để chạy lại Hybrid ALNS production với seed và ngân sách tìm kiếm đã ghi nhận, hoặc thêm `--cases <tên-file>` để chạy một phần. Runner luôn audit lại bằng availability, service-day, giới hạn xe theo đơn và `SpatialValidator` production. Case legacy không bảo toàn các ràng buộc này được đánh dấu `cost_comparable_to_production=false` và không làm CI báo hồi quy chi phí.

Trước khi tìm kiếm, optimizer loại các slot xe-ngày không thể phục vụ bất kỳ đơn nào ngay cả khi giả sử thời gian di chuyển bằng 0. Ma trận được cắt đồng bộ với danh sách xe, nên không làm lệch node index. Phép lọc này chỉ loại slot chắc chắn không khả thi theo ca và time window.

Khi bật `early_stop_patience`, `search_time_seconds` định hướng lượt tìm nghiệm đầu, còn `max_time_seconds` là trần của lượt điều phối solver. Pha cải thiện dừng sớm khi đạt số lần quan sát phương án hợp lệ liên tiếp mà không cải thiện. Mỗi lần tìm được phương án tốt hơn thì bộ đếm bắt đầu lại. Mặc định backend dùng 10 giây cho lượt đầu, trần 120 giây và patience 30. Với request tắt early stop, solver dùng ngân sách tìm kiếm đã chọn, giới hạn bởi `max_time_seconds`.

Với bài 3D lớn, Hybrid thử xác minh phương án ghép các chu kỳ lấy–giao độc lập trước khi tìm cách ghép nhiều đơn. Nếu đã có phương án giao đủ đã kiểm chứng, solver giữ phương án này trong lúc thử ứng viên khác. Vòng chính thường gỡ một nhóm nhỏ theo policy hiện hành. Khi có phương án đã kiểm chứng và còn ngân sách, solver cho bài từ 20 đơn thử gỡ khoảng 30% số đơn, tối đa 18, rồi chèn lại bằng regret-2. Kích thước thực tế còn phụ thuộc phép gỡ và số đơn trong nhóm.

Policy phân bổ lượt và thời gian theo quy mô đơn, kiện, xe vật lý và slot theo ngày:

- job 1–3 đơn, tối đa 2 xe vật lý dùng 1 lượt vét cạn trong ngân sách chung;
- job ngoài ngưỡng vét cạn dùng 2–4 chiến lược khi nhỏ/trung bình;
- job lớn dùng tối đa 6 chiến lược;
- các pha có ngân sách riêng để dành thời gian cho tìm tuyến và kiểm chứng xếp dỡ.

Với job ngoài ngưỡng rất nhỏ và chưa đặt ngân sách tìm kiếm, ngân sách mong muốn là `ceil(5 + 1,30 × complexity)` và bị chặn bởi trần từ request. Phân bổ theo tổng ngân sách thực:

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
