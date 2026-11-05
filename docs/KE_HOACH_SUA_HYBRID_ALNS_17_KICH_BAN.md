# Kế hoạch sửa Hybrid ALNS và chạy lại 17 kịch bản

Ngày: 01/11/2026. Phạm vi: optimizer Python và công cụ benchmark liên quan.

## 1. Trạng thái và quyền thực hiện

- Người dùng yêu cầu lập kế hoạch sửa và chạy lại sau bảng đối đầu 17 ca.
- Phiên này lập tài liệu và chạy lại mã hiện tại; chưa sửa mã ứng dụng. Chưa tìm thấy xác nhận triển khai optimizer đáp ứng điều kiện trong AGENTS.md ở ngữ cảnh hiện có. Việc repo đã có code không tự chứng minh quyền sửa.
- Các bước sửa dưới đây là đề xuất, chưa phải thay đổi đã triển khai. Chỉ bắt đầu sửa khi có xác nhận triển khai theo AGENTS.md hoặc bằng chứng quyền đã cấp áp dụng cho phạm vi này.
- Giữ nguyên thay đổi chưa commit của người dùng; không reset, commit, push, migration, gọi Mapbox hay thay dữ liệu nghiệp vụ.
- Không đổi policy xếp/dỡ, ca làm việc hoặc objective nghiệp vụ để làm điểm benchmark đẹp hơn.

## 2. Mốc đối chứng

Nguồn bảng người dùng: `optimizer/benchmarks/algorithm_comparison/EVOLUTION_2026_11_01.md`, khớp dữ liệu `experiments/daytime_round4_seed0.json`: 85 lượt = 17 ca × 5 engine × seed 0, budget 2.0 giây. Kết quả tính từ JSON bằng bộ tổng hợp hiện có: WIN 3, TIE 4, LOSS 10.

Theo báo cáo Vòng 4, cả 5 engine giao đủ và hợp lệ trên 17 ca. Đây là kết quả trên fixture/ma trận lưu sẵn, không chứng minh tích hợp Mapbox hoặc vận hành thực tế.

| Nhóm ưu tiên | Ca | Triệu chứng từ bảng cũ | Mục tiêu thử nghiệm |
|---|---|---|---|
| P1: giảm tuyến | Đà Nẵng; multi-depot overnight | 15/14 tuyến; 8/6 tuyến, chênh +7,77% và +25,89% | Tìm nghiệm giao đủ với số tuyến không vượt đối thủ, qua toàn bộ validator |
| P2: chi phí | dense fragmentation; three-shift relay; tight windows; long narrow timber; rolling 3day | +13,03%; +8,47%; +8,21%; +7,43%; +6,54% | Giảm chi phí khi coverage, grouping, số tuyến bằng nhau |
| P3: chi phí còn lại | dispersed; asymmetric fleet; Mekong | +4,70%; +0,51%; +0,03% | Tìm nguyên nhân và cải thiện nếu đo được ổn định |
| Bảo vệ hồi quy | multi-item; heavy cargo; dynamic reuse; 4 ca hòa | 3 thắng, 4 hòa | Không đánh đổi giao đủ/hình học; theo dõi thay đổi chất lượng ở mọi seed |

Trong bảng hiện tại, `routes` là số tuyến/slot xe-ngày hoạt động, không mặc định là số xe vật lý. Báo cáo mới phải phân biệt hai đại lượng nếu xuất được dữ liệu, không tiếp tục gắn nhãn “số xe” thiếu giải thích.

## 3. Những gì đã xác nhận từ mã, chưa kết luận là nguyên nhân thua

1. `app/hybrid_alns_engine.py::_build_hybrid_initial_solution` dành tối đa 0,9 giây cho pha ILS khởi tạo, trước khi gọi solver ALNS với toàn bộ `self.time_limit_sec`. Pha dựng seed và final audit còn có chi phí riêng. Budget danh nghĩa không phải trần thời gian toàn bộ.
2. `app/hybrid_alns/solver.py::solve_hybrid_alns` ở nhánh historical vẫn dùng `hybrid_initial = hybrid_initial or solve_greedy(...)`. Khi đã có seed, biểu thức này không dựng seed greedy thuần ở chỗ gọi này. Báo cáo Vòng 4 nói đã luôn so hai seed; cần kiểm thử đường chạy thực trước khi khẳng định điều đó còn đúng.
3. Wrapper Hybrid chọn tối đa 6 plan trước final audit; ILS giữ tối đa 3. Khác biệt chi phí audit cần được đo thay vì chỉ so budget 2 giây.
4. `planning_objective.py` xếp theo grouping, tuyến và điểm có lương lịch/penalty trễ; `summarize_daytime.py` xếp theo audit, đơn chưa phục vụ, extra trips, tuyến và chi phí vận hành audit. Chi phí vận hành thấp hơn chưa chắc tốt hơn theo objective production.
5. Runner hiện resume theo `(case, algorithm, seed)`, thiếu budget/hash mã/hash fixture/ca làm việc; bộ tổng hợp cũng nhóm theo `(case, seed)`. Không tái sử dụng file output giữa các biến thể hoặc budget. Mỗi lượt thử phải dùng tên file mới.

## 4. Giả thuyết và phép thử để bác bỏ

Chỉ thay một yếu tố mỗi lần, so với snapshot mốc và cùng điều kiện chạy.

| Thứ tự | Giả thuyết | Phép thử | Bằng chứng cần có |
|---|---|---|---|
| H1 | Seed và mức thời gian ILS của Hybrid khiến mất nghiệm ít tuyến mà ILS độc lập tìm được | Ghi chất lượng sau từng pha; giữ seed greedy và seed ILS thành hai candidate riêng; thử các tỷ lệ thời gian trong cùng tổng search budget | Tuyến/cost/grouping trước và sau từng pha, số vòng thực, chất lượng sau audit |
| H2 | Tìm relocation trước chiếm hết thời gian nên route elimination không có lượt hữu ích | Đo thời gian/lượt gọi/cải thiện từng operator; thử dành phần thời gian riêng cho elimination, ưu tiên tuyến ít đơn và chi phí biên cao | Tỷ lệ elimination được gọi/thành công, số tuyến giảm, không tăng unserved |
| H3 | Candidate tốt bị mất ở chuyển đổi, lọc elite hoặc final repair | Lưu chữ ký và key của từng candidate qua các biên; test seed đầy đủ, seed một phần, candidate mất kiện sau repair | Candidate hợp lệ tốt nhất được giữ đến bước chọn cuối; thiếu hàng không thắng nghiệm giao đủ |
| H4 | Gom được tuyến nhưng thứ tự pickup/delivery và đổi xe chưa đủ tốt | Ablation relocation cặp pickup–delivery, swap 1–1, segment exchange và vehicle reassignment; giữ kiểm tra packing theo thao tác | Cải thiện trên nhiều cấu trúc/seed, không hardcode fixture; không dùng vị trí trống trước khi dỡ |
| H5 | Một phần chênh chi phí đến từ thước đo thay vì chất lượng search | Cùng một plan tính lại cả operating cost audit và selection score production, ghi các thành phần lương/ngày/trễ | Phân biệt rõ plan kém thật với đánh đổi được objective đã chốt chấp nhận |

## 5. Các bước sửa đề xuất

### Bước A — Khóa mốc và sửa độ tin cậy của phép đo

- Lưu môi trường, dependency đang cài, git HEAD, trạng thái dirty, SHA-256 code/fixture và tham số chạy; không thu secret/nội dung .env.
- Tách budget tìm kiếm khỏi thời gian dựng seed, repair/audit và tổng solve; nếu đo được, tách audit ngoài runner khỏi solve nữa.
- Phát hiện trial trùng hoặc sai budget/ca/snapshot khi resume và tổng hợp; không âm thầm trộn dữ liệu hoặc bỏ qua trial lỗi.
- Chỉ tính thắng chi phí khi plan hợp lệ và các chiều coverage/grouping/tuyến bằng nhau. Ghi đầy đủ số kiện và manifest; dữ liệu thiếu không được suy là đã giao đủ.
- Bổ sung chỉ tiêu production bên cạnh operating cost, dùng contract đã có và kiểm tra cách quy đổi request sau normalization; không tự thay objective production bằng objective benchmark.

### Bước B — Giữ và chọn seed/candidate đúng

- Viết regression cho seed tốt bị bỏ qua, warm-start một phần, candidate bị repair mất hàng và conversion không bảo toàn package/split group.
- Kiểm chứng sự không khớp giữa báo cáo Vòng 4 và đường dựng greedy hiện tại; sửa điểm bỏ sót nếu phép thử tái hiện.
- Giữ tập elite có giới hạn nhưng đa dạng theo số tuyến và cấu trúc; giữ fallback giao đủ đã kiểm chứng.
- Chữ ký candidate phải phân biệt xe-ngày, thứ tự/thao tác và manifest có ý nghĩa; kiểm tra trước khi mở rộng chữ ký để tránh sửa không cần thiết.
- Chọn kết quả sau validator bằng objective production; benchmark tính lại thước đo của nó độc lập. Không gán nhãn audited cho seed chưa được audit.

### Bước C — Giảm tuyến trước, rồi giảm chi phí

- Ưu tiên thí nghiệm Đà Nẵng và multi-depot: loại tuyến có ít đơn/chi phí biên cao bằng repair sang tuyến khác; bỏ candidate nếu thiếu một phần split group hoặc vượt ca/tải/hình học.
- Không đánh đồng slot qua nhiều ngày với xe vật lý; giữ ràng buộc xe/tài xế và depot theo ngày đang mô hình hóa.
- Sau khi số tuyến ổn định, thử lần lượt relocation cặp, swap, đổi xe và cải thiện thứ tự stop trên nhóm P2/P3. Tái sử dụng operator hiện có trước khi thêm thuật toán.
- Tỷ lệ thời gian và lựa chọn operator dựa trên đặc trưng bài toán và ablation; không nhánh theo tên fixture, đáp án hoặc seed.
- Giữ quy tắc không chồng, đường xếp/dỡ và tái sử dụng vùng trống theo từng thao tác. Không chuyển optimizer sang route-only để lấy điểm.

### Bước D — Hồi quy và nghiệm thu

- Chạy test đúng phần sửa rồi toàn bộ `optimizer/tests`, không bỏ `overnight`/`seven_day` chỉ để suite xanh.
- Bắt buộc kiểm tra T21–T27, tái sử dụng sàn A/B/C, vùng trống rời rạc, đường thao tác bị chắn, split all-or-nothing, timeout khác infeasible, lịch ngày và bảo toàn package.
- Nếu lỗi có trước, ghi test/lệnh/bằng chứng ở mốc; không giảm assertion hoặc sửa policy để vượt qua.
- Không sửa backend/web/mobile/database nếu contract không đổi; nếu cần đổi contract phải đánh giá lại consumer trước khi triển khai.

## 6. Ma trận chạy lại

Các lệnh sau chạy từ thư mục `optimizer` bằng virtualenv hiện có, không thêm dependency hoặc nâng phiên bản.

1. Mốc hiện tại: 17 ca × 5 engine × seed 0 × budget 2.0 = 85 lượt; tệp riêng `daytime_replan_20261101_seed0.json`. Đây là chạy lại trước sửa.
2. Sau mỗi thay đổi: chạy test hồi quy tương ứng và các ca mục tiêu với Hybrid/đối thủ; output mới cho từng ablation. Không dùng số của lần chạy cũ như kết quả mới.
3. Sau khi chốt biến thể: chạy lại cả 17 ca, 5 engine, seed 0, budget 2.0 để xuất bảng cùng cấu hình bảng cũ.
4. Kiểm tra độ ổn định: mốc trước sửa và bản sau sửa cùng 17 ca × 5 engine × seeds 0–4 × budget 2.0; tổng 425 lượt mỗi phiên bản. Chạy tuần tự trong điều kiện máy tương đương, ghi nhiễu thời gian; cùng seed không bảo đảm cùng số vòng vì dừng theo thời gian.
5. Chạy mở rộng budget 10 giây cho cả hai phiên bản/đối thủ nếu cần phân biệt hạn chế search ngắn; báo cáo riêng, không so 10 giây của Hybrid với 2 giây của đối thủ.

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pytest -q tests/test_hybrid_alns_operators.py tests/test_audited_elite_retention.py tests/test_benchmark_contract.py tests/test_challenge_report.py tests/test_t21_t27.py tests/test_order_grouping_and_residual_packing.py tests/test_spatial_layout_search.py tests/test_planning_objective.py
.\.venv\Scripts\python.exe -X utf8 -m pytest -q tests
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.run_daytime_benchmark --budget 2.0 --seeds 0 --output benchmarks/algorithm_comparison/experiments/daytime_after_fix_seed0.json
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.summarize_daytime benchmarks/algorithm_comparison/experiments/daytime_after_fix_seed0.json
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.run_daytime_benchmark --budget 2.0 --seeds 0 1 2 3 4 --output benchmarks/algorithm_comparison/experiments/daytime_after_fix_seeds0_4.json
```

Tên output sau sửa là dự kiến, chỉ dùng nếu chưa tồn tại hoặc đã xác minh đúng manifest. Đo mốc nhiều seed cần snapshot riêng giữ nguyên toàn bộ code hiện tại, gồm cả thay đổi chưa commit; không chỉ checkout git HEAD rồi gọi đó là baseline này.

## 7. Tiêu chí chấp nhận

Điều kiện bắt buộc: không giảm giao đủ/bảo toàn kiện; không phát sinh vi phạm audit; các test liên quan đạt; không sửa dữ liệu/đối thủ/tiêu chí để tăng số thắng; không làm xấu các ưu tiên nghiệp vụ cao hơn để giảm VND.

Mục tiêu chất lượng cần đo, không phải cam kết đã đạt: giảm số tuyến hai ca P1; giảm số ca LOSS so với 10/17 ở seed 0; cải thiện gap trung vị trên các seed; bảo vệ ba ca đang thắng và bốn ca hòa. Báo tất cả ca hồi quy, kể cả tổng điểm cải thiện. Với cùng coverage/grouping/tuyến, so operating cost; đồng thời kiểm tra selection score production. Nếu hai chỉ tiêu xung đột, giữ quyết định nghiệp vụ đã chốt và trình bày đánh đổi.

Không kết luận thành công từ một seed, từ nghiệm chưa audit, từ thời gian danh nghĩa hoặc chỉ từ pass unit test. Không hứa thắng 17/17 hoặc tối ưu toàn cục.

## 8. Bằng chứng của phiên lập kế hoạch

- Python 3.12.3, OR-Tools 9.15.6755, Pydantic 2.14.2, NumPy 2.5.4, SciPy 1.18.1, pytest 9.2.0; Windows 11.
- Đã đọc runner, summary, challenge, audit, adapter Hybrid/ILS, objective và các vị trí test liên quan. Các mục 3–5 phân biệt điều xác nhận từ mã với giả thuyết và công việc dự kiến.
- Đã chạy xong 85/85 lượt trước sửa: WIN 3, TIE 4, LOSS 10. Cả 85 lượt giao đủ đơn/kiện và đạt các cờ kiểm tra của auditor hiện tại; không có lỗi thực thi. Các hash của 58 tệp nguồn/fixture/requirements không đổi trong khoảng thu manifest và hoàn tất lượt chạy.
- Nhóm kiểm tra hiện trạng `test_benchmark_contract.py`, `test_challenge_report.py`, `test_audited_elite_retention.py`: **14 passed in 3.70s**. Chưa chạy toàn suite vì phiên này không sửa ứng dụng; toàn suite là bước bắt buộc sau các thay đổi thuật toán theo kế hoạch.
- Kết quả, số tuyến/xe vật lý, chi phí, thời gian và giới hạn: [báo cáo chạy lại trước sửa](BAO_CAO_CHAY_LAI_HYBRID_ALNS_20261101.md). JSON và manifest riêng nằm trong `optimizer/benchmarks/algorithm_comparison/experiments/daytime_replan_20261101_*`.
- Đã hoàn tất lập kế hoạch và chạy lại mốc; **chưa hoàn tất sửa thuật toán hoặc benchmark sau sửa**. Không gọi kết quả hiện tại là cải tiến đã triển khai.


## 9. Cập nhật triển khai từ quyết định trực tiếp trong chat

Người dùng đã cho phép “OK, bắt đầu triển khai”, chốt “Không còn LOSS, chấp nhận TIE”, và “Giữ objective production; đối chứng và test theo objective đó”. Tiêu chí ở mục 7 được hiểu theo quyết định mới: bảng chính xếp production, vẫn báo operating riêng; không sửa trọng số/policy hay đối thủ để pass. Mục 8 là bằng chứng lịch sử của phiên lập kế hoạch, không còn là trạng thái code hiện tại.

Đã triển khai cơ chế chọn ca/engine bằng file 0/1, kiểm soát resume/snapshot, giữ seed/elite, sửa tìm stop và bố trí, dựng lại seed thiếu đơn và auditor kiểm chứng chứng chỉ. Toàn suite mới nhất 197 pass; đang nghiệm thu 17 ca × 5 seed × 5 engine, chưa tuyên bố mục tiêu toàn ma trận đạt. Trạng thái, ablation dừng, kết quả và giới hạn cập nhật trong [báo cáo triển khai](BAO_CAO_SUA_HYBRID_ALNS_17_KICH_BAN_20261101.md); cách chọn test trong [hướng dẫn chọn kịch bản](CHON_KICH_BAN_BENCHMARK.md).
