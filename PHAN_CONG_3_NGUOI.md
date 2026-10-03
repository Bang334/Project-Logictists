# PHÂN CÔNG XÂY DỰNG TMS — 3 NGƯỜI

Phiên bản 1.0 · Cập nhật theo hiện trạng ngày 03/10/2026

Đọc cùng [Kế hoạch TMS](KE_HOACH_TMS.md) và [quy tắc dự án](AGENTS.md). Tài liệu này phân công theo mã nguồn đang tồn tại; không tự chuyển các đề xuất chưa chốt trong kế hoạch thành yêu cầu đã duyệt.

## 1. Hiện trạng dùng để phân công lại

Project hiện có ba nhóm chức năng lớn:

1. TMS cốt lõi và điều phối: Auth, Branch, Customer, Order, Vehicle, Driver, Trip, Mapbox, điều phối thủ công và tự động.
2. Optimization: FastAPI, OR-Tools, routing, chi phí, bố trí hàng động không chồng và giao diện xem phương án.
3. Bán lẻ và fulfillment đã được bổ sung: Catalog, Inventory, Sales Order, Allocation, Order Processing, Pickup Point, Customer Portal, Feedback và Retail Analytics.

Các bảng cho GPS, POD, execution event, incident, optimization job/result và load plan đã có trong schema nhưng phần lớn chưa có luồng nghiệp vụ hoàn chỉnh. Project chưa có ứng dụng React Native/Expo. Không coi việc có bảng hoặc màn hình demo là đã hoàn thành tính năng.

## 2. Phân công chính

| Thành viên | Phạm vi chịu trách nhiệm chính |
|---|---|
| **Người 1 — Điều phối & Optimization** | Làm trọn phần điều phối thủ công và tự động: Trip planning, feasibility/validator, Mapbox routing/matrix, Python/FastAPI/OR-Tools, chi phí, benchmark, xếp/dỡ hàng động, Optimization Job, Load Plan, apply/publish và realtime trạng thái tối ưu; đồng thời phụ trách backend, database/API và các màn hình Dispatch/Automatic Dispatch liên quan. |
| **Người 2 — Web & Backend** | Làm nền tảng web/backend còn lại ngoài điều phối–Optimization và API thực thi dành riêng cho mobile: auth/quyền, chi nhánh, khách hàng, Order/Trip entity nền, xe/tài xế, catalog, inventory, sales order, allocation, fulfillment, pickup point, feedback, analytics, dashboard, outbox/storage, Prisma/migration dùng chung, CI và tài liệu chạy. |
| **Người 3 — Mobile** | Làm trọn ứng dụng mobile khách hàng và tài xế bằng React Native/Expo; đồng thời phụ trách backend, database/API cho nhận chuyến và thực thi vận chuyển: stop actions, pickup/delivery, GPS, POD, sự cố, thông báo, upload, offline queue, idempotency và đồng bộ/xử lý xung đột version. |

Phân công theo **lát cắt tính năng xuyên suốt**. Người sở hữu tính năng chịu trách nhiệm cả DTO/validation, service, database, API, UI, test và tài liệu liên quan; không bàn giao một màn hình chưa nối API hoặc một bảng chưa có luồng sử dụng.

## 3. Công việc ưu tiên theo người

### 3.1. Người 1 — Điều phối & Optimization

Luồng demo đã chạy được từ web → Mapbox → OR-Tools/spatial validator → xem phương án → áp dụng thành Trip. Phần còn lại tập trung vào độ tin cậy, khả năng phục hồi và bằng chứng nghiệm thu; demo chạy thành công chưa đồng nghĩa toàn bộ task đã hoàn thành.

#### Mốc O1 — Ổn định kết quả hiện có

- Sửa hai regression đang lỗi trong `optimizer/tests/test_routing_solver.py`: phân xe/tài xế theo kỳ vọng và recovery đơn Hà Nội khi mọi xe đã có tuyến.
- Chạy đạt toàn bộ test optimizer, đặc biệt T21–T27, spatial layout search, routing, penalty và benchmark.
- Chốt contract Node–Python cho `SUCCESS`, `PARTIAL`, `TIMEOUT`, `INFEASIBLE`, provider error và input error; không đổi ngầm field đang được web/backend sử dụng.
- Giữ Mapbox matrix/directions làm dữ liệu tuyến và OR-Tools làm engine tối ưu; cặp điểm không có đường phải bị báo lỗi đúng, không thay bằng khoảng cách giả.

**Điều kiện qua mốc:** `python -m pytest -q` đạt toàn bộ; backend contract test đạt; bộ dữ liệu demo đang chạy không bị hồi quy.

#### Mốc O2 — Optimization Job bền vững

- Chuyển lời gọi optimizer dài sang job chạy nền, không giữ HTTP request chờ solver tối đa hàng phút.
- Lưu `OptimizationJob`, snapshot/version, policy, trạng thái, tiến độ, timeout, lỗi và `OptimizationResult` trong PostgreSQL.
- API hỗ trợ tạo job, xem trạng thái/kết quả và hủy khi còn hợp lệ; retry có giới hạn và không tạo job/tác dụng phụ trùng.
- Web lấy lại được trạng thái sau refresh hoặc đăng nhập lại; `localStorage` chỉ hỗ trợ trải nghiệm, không là nguồn sự thật.
- Kết quả luôn gắn đúng job và snapshot; job cũ không được ghi đè hoặc áp dụng vào dữ liệu mới.

**Điều kiện qua mốc:** tạo job trả nhanh; restart/reload vẫn xem lại được job; timeout, hủy và optimizer lỗi có trạng thái riêng; có integration test backend–PostgreSQL và contract test Node–Python.

#### Mốc O3 — Điều phối thủ công và Trip feasibility

- Hoàn thiện bàn điều phối thủ công trên backend và web: chọn đơn, xe, tài xế, thứ tự stop, thời gian bắt đầu/kết thúc và điểm đầu/cuối.
- Dùng chung validator với luồng tự động cho pickup–delivery, tải từng chặng, lịch xe/tài xế, khả năng đến điểm nhận việc và điều kiện không chồng lịch.
- Mapbox matrix/directions phải xử lý đúng cặp không có đường, timeout và lỗi provider; không dùng route hoặc khoảng cách giả.
- Tạo/sửa Trip Plan có version; bản chỉnh thủ công phải validate lại trước khi áp dụng hoặc publish.
- Bảo vệ API điều phối theo role/branch, chống submit lặp và lưu audit cho thao tác quan trọng.

**Điều kiện qua mốc:** tạo và chỉnh được Trip thủ công bằng dữ liệu thật; reload còn dữ liệu; phương án vi phạm tải, lịch, thứ tự hoặc quyền bị từ chối.

#### Mốc O4 — Lưu Load Plan, apply và publish an toàn

- Lưu Load Plan, từng bước thao tác, vị trí/hướng kiện, cửa sử dụng và đường xếp/dỡ khi phương án được áp dụng.
- Không chỉ tin cờ `spatial_validation.is_valid`; validate cấu trúc đầy đủ và từ chối kết quả thiếu step state hoặc tham chiếu kiện/stop sai.
- Trước khi áp dụng, kiểm tra lại order version, trạng thái xe/tài xế, trùng lịch, tải từng chặng và phần tài nguyên đã bị thay đổi.
- Phối hợp Người 2 để transaction áp dụng proposal chống race condition; toàn bộ thao tác phải rollback nếu một Trip không thể tạo.
- Chỉ cho publish phương án đã vượt validator; nghiệm `PARTIAL` chỉ áp dụng các route hợp lệ và vẫn giữ danh sách đơn chưa được phân.
- Publish phải kiểm tra lại version, resource reservation và feasibility trong transaction; không chỉ đổi trạng thái Trip.

**Điều kiện qua mốc:** sau khi áp dụng và reload vẫn xem được bố trí từng bước; proposal cũ hoặc bị sửa bị từ chối; test cạnh tranh chỉ cho một lần áp dụng hợp lệ.

#### Mốc O5 — Hoàn thiện trải nghiệm, realtime và chẩn đoán

- Web hiển thị loading/progress, kết quả một phần, đơn chưa xếp cùng lý do, timeout, provider lỗi và nút thử lại phù hợp.
- Phân biệt rõ chưa tìm được nghiệm trong thời gian cho phép với bất khả thi đã được chứng minh.
- Hiển thị route, ETA, tải từng chặng, chi phí thành phần và bố trí hàng từ dữ liệu đã lưu; không trình bày simulation như dữ liệu GPS thực.
- Bảo vệ thao tác chạy/áp dụng theo role và branch scope; chống submit lặp.
- Không tự publish; dispatcher phải xem và xác nhận phương án theo policy đã chốt.
- Realtime chỉ thông báo job/Trip thay đổi; reconnect phải tải lại trạng thái từ API và chịu được sự kiện lặp hoặc sai thứ tự.

**Điều kiện qua mốc:** chạy được các luồng thành công, một phần, timeout, lỗi Mapbox, optimizer lỗi, proposal hết hạn và thiếu quyền trên giao diện/API.

#### Mốc O6 — Nghiệm thu và bàn giao Người 1

- Chạy benchmark trên bộ dữ liệu nhỏ biết nghiệm và bộ dữ liệu đại diện; ghi thời gian, tỷ lệ phục vụ, số xe, quãng đường, chi phí và vi phạm.
- Có E2E thủ công và tự động: tạo Order → lập/validate phương án → áp dụng → publish → reload → xem Trip và Load Plan đã lưu.
- Chạy đạt lint, typecheck, build và test liên quan ở backend, frontend và optimizer.
- Cập nhật hướng dẫn chạy optimizer/worker, biến môi trường, cách tái hiện benchmark và giới hạn thực tế.
- Tự review diff, không còn mock/TODO trên đường chạy bắt buộc và không khẳng định tối ưu toàn cục khi solver chưa chứng minh.

**Hoàn thành task Người 1 khi:** O1–O6 đều đạt, không còn test bắt buộc lỗi, điều phối thủ công/tự động dùng dữ liệu thật, job/result/load plan được lưu bền vững và một phương án chỉ có thể áp dụng/publish sau khi vượt đầy đủ validator và kiểm tra dữ liệu mới nhất.

### 3.2. Người 2 — Web & Backend

- Hoàn thiện auth/quyền, branch scope, Customer, Order, Vehicle, Driver và entity/vòng đời Trip nền trên backend lẫn web; bàn giao contract tài nguyên cho Người 1 làm điều phối.
- Hoàn thiện và kiểm thử chuỗi Catalog → Sales Order → Reservation/Allocation → Preparation → Package/Handover → Pickup/Delivery.
- Bảo vệ tồn kho và số lượng bằng transaction/idempotency; bổ sung integration test PostgreSQL cho các ca cạnh tranh.
- Rà soát phạm vi bán lẻ/WMS đã thêm: chỉ giữ phần phục vụ luồng hiện có, không tiếp tục mở rộng thành ERP/WMS đầy đủ khi chưa được duyệt.
- Hoàn thiện quyền Customer/Staff theo từng đơn, location, feedback và file; không chỉ ẩn chức năng trên giao diện.
- Cập nhật frontend và API contract cùng lúc; bổ sung test lỗi API, retry, reload và quyền truy cập.
- Duy trì Socket.IO, outbox, storage, Prisma/migration, cấu hình môi trường, CI và tài liệu chạy dùng chung.

### 3.3. Người 3 — Mobile

- Xây dựng ứng dụng React Native + Expo cho tài xế và phần khách hàng đã được duyệt.
- Làm backend/API và dữ liệu cho nhận/từ chối chuyến, bắt đầu chuyến, đến điểm, pickup, delivery, nghỉ, sự cố và kết thúc chuyến.
- Hoàn thiện GPS với `measured_at`, `received_at`, nguồn, chất lượng và xử lý sự kiện trùng/sai thứ tự; kiểm thử tracking nền trên thiết bị thật.
- Hoàn thiện POD gồm chụp/chọn tệp, upload, trạng thái chờ đồng bộ, server xác nhận và retry không tạo bản ghi trùng.
- Xây dựng offline queue có idempotency, thứ tự gửi, phát hiện kế hoạch cũ và xử lý xung đột version khi kết nối lại.
- Phối hợp với Người 2 về auth, Socket.IO, storage và schema dùng chung; phối hợp với Người 1 về Trip version, ETA và thay đổi kế hoạch.
- Viết test cho mobile/API thực thi và ghi rõ phần chỉ kiểm thử trên simulator hay đã kiểm thử bằng thiết bị thật.

## 4. Ranh giới và người review bắt buộc

| Thay đổi | Người chủ trì | Người review bắt buộc |
|---|---|---|
| Snapshot, solver, spatial/load plan, kết quả tối ưu | Người 1 | Người 2 review transaction, quyền và version; Người 3 review khả năng thực hiện pickup/delivery |
| Trip planning, điều phối thủ công/tự động, feasibility, apply và publish | Người 1 | Người 2 review dữ liệu nền, transaction và quyền; Người 3 review contract mobile bị ảnh hưởng |
| Trip entity/vòng đời nền, Catalog, tồn kho, đơn bán lẻ và web còn lại | Người 2 | Người 1 hoặc Người 3 review theo consumer bị ảnh hưởng |
| GPS, POD, stop actions, offline và mobile | Người 3 | Người 2 review auth/realtime/storage; Người 1 review ảnh hưởng Trip và ETA |
| Auth, branch scope, outbox, file, Socket.IO hạ tầng và Prisma dùng chung | Người 2 | Chủ tính năng bị ảnh hưởng review hành vi nghiệp vụ; event/job optimization do Người 1 sở hữu |
| API contract hoặc schema dùng chung | Người thực hiện thay đổi | Tất cả consumer liên quan phải được cập nhật và có ít nhất một review chéo |

- **Điều phối và Optimization thuộc Người 1**; gồm thủ công, tự động, Mapbox, Trip feasibility, apply/publish và realtime job; không tạo thêm validator/optimizer khác trong backend hoặc frontend.
- **Web/backend ngoài điều phối–Optimization và mobile execution thuộc Người 2**; không trộn `Order` vận tải và Sales Order nếu vòng đời khác nhau.
- **Mobile và luồng thực thi vận chuyển thuộc Người 3**; không tự thay đổi Trip plan hoặc kết quả optimizer để làm thuận tiện cho client.
- Mỗi người tự viết migration trong phạm vi của mình, nhưng migration chạm bảng dùng chung phải được Người 2 review và thông báo cho cả nhóm.
- Không sửa migration đã dùng trên môi trường chia sẻ; tạo migration sửa tiếp theo.

## 5. Quy trình phối hợp

Luồng chung: **chốt yêu cầu → chốt contract → triển khai lát cắt đầy đủ → tự kiểm tra → review chéo → tích hợp**.

1. Trước khi sửa contract dùng chung, ghi rõ producer, consumer, bảng và test bị ảnh hưởng.
2. Người chủ trì làm trọn luồng thành công và các lỗi quan trọng; không giao file rời cho người khác tự đoán cách nối.
3. Test unit không thay thế integration test PostgreSQL, Mapbox/optimizer contract hoặc test thiết bị khi các phần đó bị ảnh hưởng.
4. Khi merge, người chủ trì cung cấp migration, biến môi trường mẫu, lệnh kiểm tra và dữ liệu seed/demo an toàn nếu cần.
5. Nếu một hạng mục bị chặn bởi quyết định nghiệp vụ chưa chốt, hoàn thành phần độc lập và ghi rõ điểm chặn; không tự đặt policy.

## 6. Mốc tích hợp chung

### Mốc A — Làm sạch nền hiện tại

- Backend và frontend lint đạt.
- Toàn bộ optimizer test đạt, đặc biệt các regression routing và T21–T27.
- CI chạy build, typecheck và test cho ba thành phần.
- Có README hướng dẫn chạy backend, frontend, optimizer và database test.

### Mốc B — MVP điều phối đáng tin cậy

- Tạo Order vận tải → điều phối thủ công hoặc tối ưu → kiểm tra → áp dụng → publish bằng dữ liệu thật.
- Chống phân công trùng xe/tài xế và áp dụng proposal cũ bằng transaction/version.
- Optimization job và load plan được lưu, tải lại được sau refresh; không phụ thuộc `localStorage` làm nguồn sự thật.
- Quyền role/branch được kiểm tra trên API và socket.

### Mốc C — Thực thi vận chuyển

- Mobile tài xế nhận Trip có version, thực hiện stop, GPS, POD và báo sự cố.
- Offline/retry không tạo thao tác hoặc tệp trùng; server xác nhận trạng thái rõ ràng.
- Có E2E PostgreSQL → backend → optimizer → web/mobile cho một chuyến ghép nhiều đơn.

### Mốc D — Pilot

- Benchmark với dữ liệu đại diện, UAT, log/metrics, backup/restore và hướng dẫn vận hành.
- Không còn mock/demo trên đường chạy bắt buộc; giới hạn chưa kiểm chứng được ghi rõ.

## 7. Điều kiện hoàn thành của mỗi hạng mục

Một phần việc chỉ được đánh dấu hoàn thành khi:

- Đã nối API và dữ liệu thật trong phạm vi liên quan; dữ liệu còn đúng sau reload/reconnect.
- Có validation, quyền, xử lý lỗi, transaction/concurrency và idempotency ở nơi cần.
- Không còn TODO, placeholder, dữ liệu giả hoặc nhánh thành công giả trên đường chạy bắt buộc.
- Test phù hợp đã chạy đạt; test cần PostgreSQL thật hoặc thiết bị thật không được thay bằng mock rồi coi là đủ.
- Diff đã được tự review, không chứa secret/debug thừa và không thay đổi ngoài phạm vi.
- Contract, migration và tài liệu chạy được cập nhật đồng thời.

AI có thể hỗ trợ viết, phân tích và review nhưng người phụ trách vẫn phải kiểm tra kết quả. Không commit, push, deploy hoặc thay đổi dữ liệu thật ngoài quyền đã được cấp.
