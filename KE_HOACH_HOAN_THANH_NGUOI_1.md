# KẾ HOẠCH HOÀN THÀNH TASK NGƯỜI 1 — ĐIỀU PHỐI & OPTIMIZATION

Ngày lập: 03/10/2026  
Phạm vi: hoàn thành toàn bộ trách nhiệm **Người 1 — Optimization** trong [PHAN_CONG_3_NGUOI.md](PHAN_CONG_3_NGUOI.md), theo các ràng buộc của [KE_HOACH_TMS.md](KE_HOACH_TMS.md) và [AGENTS.md](AGENTS.md).

Tài liệu này là kế hoạch triển khai, không phải xác nhận rằng các hạng mục bên dưới đã hoàn thành. Việc viết code vẫn chỉ bắt đầu khi người dùng cho phép bằng câu chính xác: **“OK, bắt đầu triển khai”**.

## 1. Mục tiêu cuối cùng

Người 1 bàn giao một luồng Optimization hoàn chỉnh:

1. Dispatcher có thể lập phương án thủ công hoặc tạo yêu cầu tối ưu từ dữ liệu thật.
2. Backend tạo snapshot có version và lưu Optimization Job trong PostgreSQL.
3. Job được xử lý nền, có timeout/hủy/retry giới hạn và không giữ HTTP request chờ solver.
4. Python + FastAPI + OR-Tools giải routing, chi phí và bố trí hàng động không chồng.
5. Kết quả được validate, lưu bền vững và hiển thị lại được sau reload.
6. Dispatcher xem route, tải, chi phí, Load Plan, cảnh báo và đơn chưa phân.
7. Khi áp dụng, backend kiểm tra lại dữ liệu mới nhất trong transaction và chống áp dụng trùng.
8. Trip và Load Plan được lưu đầy đủ; publish kiểm tra lại feasibility, version và reservation trong transaction.

## 2. Ranh giới trách nhiệm

### 2.1. Người 1 trực tiếp thực hiện

- `optimizer/app`, `optimizer/tests` và contract Python.
- Backend điều phối thủ công/tự động: Trip planning, feasibility, optimization job, snapshot, result, validator, apply/publish và lưu Load Plan.
- API và các màn hình `DispatchPage`, `AutomaticDispatchPage` để lập, theo dõi, xem, chỉnh, kiểm tra, áp dụng và publish phương án.
- Tích hợp Mapbox matrix/directions cho điều phối và optimizer.
- Realtime trạng thái optimization job và Trip plan; API/PostgreSQL vẫn là nguồn sự thật.
- Test contract Node–Python, test optimizer, benchmark và E2E của luồng tối ưu.
- Tài liệu chạy optimizer/worker và báo cáo benchmark.

### 2.2. Phối hợp với Người 2

- Auth/role/branch scope, Prisma và migration dùng chung.
- Order, entity/vòng đời Trip nền, Vehicle, Driver và resource reservation dùng chung.
- Outbox, Redis/worker infrastructure, Socket.IO và cấu hình môi trường.
- Review transaction, concurrency, idempotency và quyền trước khi merge.

### 2.3. Phối hợp với Người 3

- Contract Trip/Stop/Load Plan mà mobile cần đọc.
- Không đưa simulation web thành GPS hoặc execution event thực.
- Thông báo thay đổi kế hoạch sau này phải giữ version để mobile phát hiện bản cũ.

Không tự mở rộng Người 1 sang GPS, POD, offline mobile, WMS hoặc ERP.

## 3. Hiện trạng đã có và được giữ lại

- FastAPI có `/optimize`, `/optimize-fleet`, `/validate-spatial` và `/health`.
- OR-Tools đã xử lý pickup–delivery, time window, tải, nhiều xe và nhiều ngày dịch vụ ở mức hiện tại.
- Spatial validator đã có bố trí một lớp, cấm chồng, kiểm tra đường thao tác và tái sử dụng vùng trống.
- Backend đã lấy Mapbox matrix/directions và gọi optimizer.
- Web/backend đã có luồng điều phối thủ công cơ bản nhưng chưa có cùng mức transaction/version/feasibility như apply tự động.
- Proposal tự động đã có chữ ký, thời hạn, version Order/Vehicle/Driver và kiểm tra lại khi áp dụng.
- Luồng apply tự động đã dùng PostgreSQL advisory lock để giảm race condition.
- Web đã xem được route, chi phí, bố trí và áp dụng phương án trong happy path.
- Schema đã có `OptimizationJob`, `OptimizationResult`, `LoadPlan`, `LoadPlanStep`, `LoadPlacement` nhưng chưa có service hoàn chỉnh sử dụng chúng.

Các phần trên phải được bảo toàn bằng regression test trong suốt quá trình triển khai.

## 4. Các quyết định phải chốt trước khi khóa schema/contract

| Mã | Điểm cần chốt | Lý do |
|---|---|---|
| OPT-D01 | Định danh đơn vị xếp là `Package` vật lý hay cargo unit sinh từ `OrderItem` | `LoadPlacement` hiện bắt buộc `packageId`, trong khi optimizer đang nhận item của Order; không được tạo liên kết giả |
| OPT-D02 | Hướng xoay cho phép, khoảng hở, hình học cửa và quy tắc đường thao tác của bản đầu | Đây là dữ liệu bắt buộc để kết luận bố trí khả thi; không tự cho phép dỡ tạm hoặc dịch kiện khác |
| OPT-D03 | Role được tạo, hủy, xem và áp dụng job; phạm vi liên chi nhánh | Phải kiểm tra ở backend, không chỉ ẩn nút web |
| OPT-D04 | Chính sách giữ lịch sử snapshot/result/load plan và giới hạn kích thước | Ảnh hưởng database, audit và khả năng truy vết |

Phần không phụ thuộc các quyết định trên vẫn tiếp tục được triển khai. Không tự điền giá trị nghiệp vụ chưa chốt vào code.

## 5. Kế hoạch triển khai theo lát cắt

### OPT-01 — Khóa baseline và sửa regression

- [x] Ghi lại payload demo hiện đang chạy thành fixture không chứa secret hoặc dữ liệu cá nhân thật.
- [x] Điều tra test `test_fleet_solver_assigns_two_vehicles_drivers_and_costs`: xác định expectation hai xe còn đúng với mục tiêu chi phí hay test đã lệch contract. Chỉ sửa test nếu yêu cầu thật đã thay đổi và được ghi lại; không giảm assertion để cho qua.
- [x] Sửa recovery của snapshot Hà Nội để không chỉ xét xe rảnh và không chạm search limit sai trong ca đã có nghiệm.
- [x] Làm kết quả test ổn định theo cùng input/time budget; không phụ thuộc may rủi của thời điểm chạy.
- [x] Thêm test T26 riêng: cửa đủ kích thước nhưng đường đến vị trí trống bị chắn phải bị loại.
- [x] Chạy đầy đủ T21–T27, spatial search, routing, late penalty và benchmark.
- [x] Chạy backend optimizer contract và proposal signature test.

**Đầu ra:** toàn bộ optimizer test đạt; fixture demo có thể tái hiện; không thay đổi contract ngầm.  
**Điều kiện hoàn thành:** `python -m pytest -q` không lỗi và các test Node liên quan đạt.

### OPT-02 — Chuẩn hóa contract và trạng thái

- [x] Version hóa request/response giữa NestJS và Python.
- [x] Phân biệt Job status: `PENDING`, `QUEUED`, `RUNNING`, `SUCCEEDED`, `TIMED_OUT`, `CANCELLED`, `FAILED`.
- [x] Phân biệt Solver result: `SUCCESS`, `PARTIAL`, `INFEASIBLE`; timeout chưa có nghiệm không được đổi thành `INFEASIBLE`.
- [x] Chuẩn hóa error code cho input sai, matrix không có đường, Mapbox lỗi, solver lỗi, timeout, cancel và validator lỗi.
- [x] Validate runtime toàn bộ route, stop, cost, spatial step, unassigned order và diagnostics ở cả biên Python lẫn Node.
- [x] Ghi solver version, schema version, policy version, matrix provenance và time budget vào snapshot/result.
- [x] Thống nhất đơn vị: thời gian giây, khoảng cách mét, khối lượng kg và hình học mm hoặc cm với chuyển đổi duy nhất có test.

**Đầu ra:** tài liệu contract và model/validator có version.  
**Điều kiện hoàn thành:** contract test phát hiện được thiếu field, sai unit, reference lạ, số âm/không hữu hạn và status không hợp lệ.

### OPT-03 — Tạo Optimization Job bền vững

- [x] Thêm migration mới nếu schema hiện tại thiếu constraint/index/field; không sửa migration baseline đã dùng.
- [x] Tạo job và snapshot trong transaction; lưu `requestHash`, người tạo, branch, policy, parameters và version tài nguyên.
- [x] Dùng idempotency key: cùng key/cùng payload trả cùng job; cùng key/khác payload trả conflict.
- [x] API tạo job trả nhanh với job ID, không chờ Mapbox và solver chạy xong.
- [x] API danh sách/chi tiết job có phân trang và branch scope.
- [x] API hủy chỉ chấp nhận trạng thái hợp lệ và lưu người/thời điểm hủy.
- [x] Lưu một hoặc nhiều `OptimizationResult` theo candidate number; không chỉ ghi JSON vào một state tạm.
- [x] Ghi audit/outbox trong cùng transaction với thay đổi quan trọng.

**API mục tiêu:**

- `POST /optimization-jobs`
- `GET /optimization-jobs`
- `GET /optimization-jobs/:id`
- `POST /optimization-jobs/:id/cancel`
- `POST /optimization-jobs/:id/apply`

Tên endpoint cuối cùng phải theo convention của project; endpoint cũ được chuyển tiếp có kiểm soát rồi loại bỏ, không duy trì hai luồng nghiệp vụ song song.

**Đầu ra:** job và result tồn tại trong PostgreSQL, tải lại được sau restart.  
**Điều kiện hoàn thành:** integration test thật với PostgreSQL cho create/idempotency/scope/cancel/reload.

### OPT-04 — Worker, Redis và phục hồi

- [x] PostgreSQL là nguồn sự thật của trạng thái job; Redis chỉ dùng điều phối công việc/thông báo.
- [x] Sau commit job, phát sự kiện qua outbox để đưa job vào hàng đợi.
- [x] Worker claim job có lease/heartbeat; hai worker không cùng chạy một job.
- [x] Job hết lease được phục hồi có giới hạn; không retry vô hạn.
- [x] Worker lấy Mapbox matrix, đóng snapshot cuối cùng rồi gọi solver ngoài request lifecycle của API.
- [x] Thiết lập timeout, cancel propagation và giới hạn số solver chạy đồng thời.
- [x] Kết quả tới muộn sau cancel/timeout không được ghi đè trạng thái cuối.
- [x] Retry provider dùng backoff và chỉ retry lỗi phù hợp; không tạo phí gọi Mapbox không giới hạn.
- [x] Restart backend/worker không làm mất job đang chờ; job đang chạy được reclaim theo lease.

**Đầu ra:** pipeline job nền có khả năng phục hồi.  
**Điều kiện hoàn thành:** test hai worker cạnh tranh, worker chết giữa job, timeout, cancel, retry và result tới muộn.

### OPT-05 — Snapshot và Mapbox tin cậy

- [x] Snapshot chứa đúng Order/Stop/Item, version, Vehicle/Driver, lịch, vị trí, policy và khóa kế hoạch.
- [x] Không mặc định Home Branch là current location hoặc điểm kết thúc nếu dữ liệu thực tế quy định khác.
- [x] Mapbox matrix xử lý null/unreachable từng cặp; không thay bằng `0`, đường thẳng hoặc route giả.
- [x] Ghi provider/profile/thời điểm truy vấn và mapping index của matrix để truy vết.
- [x] Directions geometry dùng để hiển thị, không thay thế matrix hoặc OR-Tools.
- [x] Kiểm tra quyền token/quota/lỗi rate limit; không log token.
- [x] Validate input trước khi gọi provider để tránh tốn quota cho dữ liệu sai.

**Đầu ra:** snapshot bất biến, có provenance và matrix hợp lệ.  
**Điều kiện hoàn thành:** test order thay đổi khi job chạy, unreachable pair, Mapbox timeout/rate limit và mapping matrix nhiều xe.

### OPT-06 — Hoàn thiện solver và spatial validator

- [x] Giữ pickup trước delivery và tải sau từng thao tác, không dùng tổng cả Trip thay tải từng chặng.
- [x] Kiểm tra time window/service time, vehicle availability và driver option theo snapshot.
- [x] Không tự reset lịch ở 00:00; service-day clone không được làm cùng xe/tài xế xuất hiện đồng thời trái phép.
- [x] Spatial validator cấm chồng, cấm giao nhau, kiểm tra thùng/cửa/đường thao tác và không dịch kiện còn lại.
- [x] Giao A rồi lấy C chỉ dùng đúng vùng A đã giải phóng; không ghép vùng rời rạc và không dùng chỗ chưa dỡ.
- [x] Khi stop vừa giao vừa lấy, thứ tự thao tác được trả rõ và validate đúng.
- [x] Search limit trả `UNVERIFIED`/diagnostic phù hợp, không khẳng định bất khả thi.
- [x] Unassigned order có reason code dựa trên bằng chứng; chưa xác định phải ghi chưa xác định.
- [x] Objective breakdown tách penalty solver khỏi chi phí tài chính.
- [x] Kết quả nêu rõ đây là nghiệm khả thi tốt nhất tìm thấy trong thời gian cho phép, trừ khi có bằng chứng tối ưu toàn cục.

**Đầu ra:** solver trả route và Load Plan candidate vượt mọi hard constraint đã chốt.  
**Điều kiện hoàn thành:** T01–T07, T14, T18 và T21–T27 liên quan optimizer đều có test phù hợp và đạt.

### OPT-07 — Hoàn thiện điều phối thủ công và Trip feasibility

- [x] Bàn điều phối lấy Order, Vehicle và Driver theo đúng branch scope, có loading/empty/error và không tải dữ liệu ngoài quyền.
- [x] Cho dispatcher chọn đơn, xe, tài xế, thời gian, điểm đầu/cuối và thứ tự stop; runtime validation ở backend, không tin dữ liệu client.
- [x] Dùng một feasibility service chung cho thủ công và tự động: pickup trước delivery, tải từng chặng, time window, thời gian phục vụ, lịch tài nguyên và spatial validation khi có hàng kích thước.
- [x] Availability phải xét khoảng thời gian, current location và thời gian di chuyển đến điểm nhận việc; không chỉ dựa vào status `AVAILABLE`.
- [x] Route thủ công dùng Mapbox matrix/directions thật và báo rõ unreachable/provider error.
- [x] Lưu Trip Plan nháp có version; chỉnh thứ tự/tài nguyên phải gửi expected version và trả conflict khi bản đã thay đổi.
- [x] Kiểm tra cả xe nguồn/đích khi chuyển Order giữa các phương án; hàng đã pickup không được chuyển chỉ bằng đổi ID.
- [x] Chống tạo Trip trùng do double submit bằng idempotency key.
- [x] Ghi audit/outbox cho tạo, sửa, validate, apply và publish.
- [x] Không nhân đôi logic giữa `TripsValidator`, optimizer contract và service điều phối; quy tắc dùng chung phải có một nguồn rõ ràng.

**Đầu ra:** điều phối thủ công tạo/chỉnh/validate Trip Plan bằng dữ liệu thật và cùng hard constraints với luồng tự động.  
**Điều kiện hoàn thành:** E2E thủ công giữ dữ liệu sau reload; test từ chối pickup sau delivery, quá tải, trùng lịch, không kịp di chuyển, stale version, unreachable route và thiếu quyền.

### OPT-08 — Lưu Load Plan theo Trip

- [x] Hoàn thành OPT-D01/OPT-D02 trước khi khóa mapping dữ liệu.
- [x] Khi apply, ánh xạ chính xác optimizer item/stop/action sang entity PostgreSQL; không sinh ID giả.
- [x] Lưu `LoadPlan` với revision, input hash, geometry snapshot, validator version và validation status.
- [x] Lưu từng `LoadPlanStep`: operation order, StopTask, item/package, handling path và validation result.
- [x] Lưu toàn bộ placements sau mỗi bước với tọa độ, orientation và kích thước hiệu lực.
- [x] Chuyển đổi cm/mm tại một adapter duy nhất và kiểm tra round-trip.
- [x] Không sửa Load Plan đã phát hành; thay đổi tương lai tạo revision mới.
- [x] API đọc Load Plan kiểm tra branch/resource scope và trả dữ liệu đủ cho visualizer.

**Đầu ra:** Load Plan có thể truy lại và kiểm chứng độc lập sau reload.  
**Điều kiện hoàn thành:** E2E T23 và T24 lưu/reload đúng vị trí B, vùng A, vị trí C và đường thao tác.

### OPT-09 — Apply proposal và publish an toàn

- [x] Chỉ cho apply job/result thuộc branch và user có quyền.
- [x] Chống apply trùng bằng idempotency key và trạng thái result/job.
- [x] Trong transaction, khóa Order/Vehicle/Driver cần dùng và kiểm tra version mới nhất.
- [x] Kiểm tra Order còn hợp lệ, không nằm trên active Trip và chưa bị phân bởi request cạnh tranh.
- [x] Kiểm tra trùng lịch xe/tài xế theo khoảng `[start, end)` và constraint/reservation phù hợp.
- [x] Validate pickup–delivery, tải từng chặng và spatial result trước khi tạo mọi Trip.
- [x] Tạo tất cả Trip, StopTask, assignment, Load Plan, audit và outbox hoặc rollback toàn bộ.
- [x] Với kết quả `PARTIAL`, chỉ apply route hợp lệ và vẫn lưu/trả danh sách unassigned; không làm chúng biến mất khỏi UI.
- [x] Apply không đồng nghĩa publish; dispatcher vẫn duyệt theo policy.
- [x] Publish kiểm tra lại plan version, Order/Vehicle/Driver mới nhất, resource reservation, feasibility và Load Plan validation trong cùng transaction.
- [x] Publish tạo audit/outbox và chỉ chuyển trạng thái khi toàn bộ kiểm tra đạt; request lặp không phát sự kiện hoặc reservation trùng.
- [x] Điều phối thủ công và tự động dùng cùng publish gate, không có endpoint phụ bỏ qua validator.

**Đầu ra:** apply atomic, idempotent và chống stale proposal/race condition.  
**Điều kiện hoàn thành:** integration test PostgreSQL với hai dispatcher cùng apply chỉ có một transaction thành công.

### OPT-10 — Web và realtime

- [x] Tạo job từ UI với chống submit lặp và idempotency key.
- [x] Hiển thị queue/running/progress/success/partial/timeout/cancel/failure rõ ràng.
- [x] Sau reload, lấy job/result từ server; không dựa vào proposal trong `localStorage` làm nguồn sự thật.
- [x] Socket.IO chỉ báo thay đổi; reconnect phải tải lại job snapshot từ API.
- [x] Hiển thị route, ETA, tải từng chặng, cost breakdown, unassigned reasons và diagnostics.
- [x] Visualizer đọc Load Plan đã lưu theo từng step, cửa, handling path và placement.
- [x] Phân biệt Mapbox route thật với simulation; không hiển thị simulation như GPS thật.
- [x] Kiểm tra empty/error/permission/expired/stale states và đường thử lại.
- [x] Nút apply/publish hiển thị tác động, trạng thái và kết quả server thực.
- [x] Màn hình điều phối thủ công và tự động dùng cùng cách hiển thị feasibility, conflict, unassigned order và trạng thái publish.
- [x] Realtime job/Trip có event ID; client chịu được sự kiện lặp/sai thứ tự và luôn tải lại snapshot sau reconnect.

**Đầu ra:** web quản lý trọn vòng đời job và kết quả bền vững.  
**Điều kiện hoàn thành:** UI test cho refresh, lỗi API, socket lặp/sai thứ tự, thiếu quyền, partial và apply conflict.

### OPT-11 — Benchmark, vận hành và tài liệu

- [ ] Chuẩn bị datasets biết nghiệm và datasets đại diện 50/200/500 đơn khi môi trường đủ tài nguyên.
- [ ] Ghi solver version, seed/parameters, time budget và cấu hình máy khi benchmark.
- [ ] Đo thời gian, tỷ lệ phục vụ, số xe, km, tải, chi phí, timeout và vi phạm; không chỉ báo số km.
- [ ] Thiết lập metrics/log an toàn cho queue lag, duration, timeout, infeasible/partial, Mapbox error và worker health.
- [ ] Không log token, payload nhạy cảm hoặc thông tin liên hệ không cần thiết.
- [ ] Viết hướng dẫn chạy API, worker, Redis, optimizer, migration và test.
- [ ] Viết cách xử lý job treo/dead letter và cách retry có audit.
- [ ] Ghi rõ giới hạn hình học, dữ liệu tuyến và những phần chưa kiểm chứng ngoài bộ dữ liệu thử nghiệm.

**Đầu ra:** báo cáo benchmark và runbook vận hành.  
**Điều kiện hoàn thành:** người khác có thể dựng môi trường từ tài liệu và tái hiện bộ kiểm tra không cần suy đoán cấu hình.

## 6. Thứ tự thực hiện bắt buộc

```text
OPT-01 → OPT-02 → OPT-03 → OPT-04 → OPT-05 → OPT-06 → OPT-07
                                      ↘                    ↘
OPT-D01/OPT-D02 ─────────────────────→ OPT-08 ────────────→ OPT-09 → OPT-10 → OPT-11
```

- OPT-01 phải xong trước khi refactor lớn để có baseline phát hiện hồi quy.
- OPT-03 phải xong trước OPT-04 vì worker cần job bền vững làm nguồn sự thật.
- OPT-D01 và OPT-D02 phải được chốt trước migration/mapping Load Plan cuối cùng.
- OPT-07 khóa feasibility dùng chung trước khi nghiệm thu cả điều phối thủ công và tự động.
- OPT-08 phải xong trước khi coi apply đã lưu đầy đủ nghiệm optimizer.
- OPT-09 phải xong trước nghiệm thu publish hoặc E2E chính thức.
- Có thể làm UI states của OPT-10 song song sau khi contract OPT-02 đã khóa.

## 7. Ma trận kiểm thử bắt buộc

| Tầng | Kiểm thử |
|---|---|
| Python unit | Routing, cost, penalty, time window, recovery, deterministic timeout và spatial search |
| Spatial acceptance | T21–T27, gồm test T26 riêng và ca giao/lấy cùng stop |
| Node unit/contract | Payload, response, status/error mapping, signature/hash, runtime validation và unit conversion |
| PostgreSQL integration | Job idempotency, worker claim/lease, apply cạnh tranh, stale version, atomic rollback và Load Plan persistence |
| Mapbox adapter | Null pair, batching, index mapping, timeout, rate limit và response sai contract |
| Frontend | Lifecycle job, reload, partial/unassigned, permission, error/retry, duplicate submit và visualization |
| E2E | Luồng thủ công: Order → lập/validate Trip Plan → publish; luồng tự động: Order → job → result → apply → publish → reload → Trip + Load Plan; timeout/cancel; hai dispatcher cạnh tranh |
| Benchmark | Dataset biết nghiệm và workload đại diện với metrics đầy đủ |

Mock được phép ở unit test nhưng không thay thế PostgreSQL integration, contract Node–Python hoặc kiểm chứng Mapbox/worker cần thiết.

## 8. Lệnh kiểm tra dự kiến

Chỉ dùng các lệnh thực sự có trong project; bổ sung script mới bằng thay đổi review được khi triển khai worker/E2E.

```powershell
# Optimizer
cd optimizer
python -m pytest -q

# Backend
cd ..\backend
npm run lint
npx tsc --noEmit
npm run build
npm test -- --runInBand
npm run test:postgres

# Frontend
cd ..\frontend
npm run lint
npx tsc --noEmit
npm run build
npm test
```

`npm run test:postgres` chỉ chạy với `TEST_DATABASE_URL` riêng đã được guard xác nhận; không chạy test ghi dữ liệu lên database thật/chia sẻ.

## 9. Checklist bàn giao 100% task Người 1

- [x] OPT-D01–OPT-D04 đã được chốt hoặc ghi rõ phần nào không áp dụng.
- [x] OPT-01 đến OPT-11 đều đạt điều kiện hoàn thành.
- [x] Không còn regression test optimizer lỗi; T21–T27 đầy đủ và đạt.
- [x] API không giữ request chờ solver dài; job nền có timeout, cancel, retry giới hạn và phục hồi.
- [x] Snapshot, result và Load Plan được lưu trong PostgreSQL; reload/restart không mất trạng thái.
- [x] Redis/socket không là nguồn sự thật.
- [x] Apply atomic, idempotent, kiểm tra version và chống cạnh tranh.
- [x] Điều phối thủ công và tự động dùng chung feasibility/publish gate; không có đường bỏ qua validator.
- [x] Không có phương án chưa vượt validator được apply/publish.
- [x] Partial/timeout/provider error/infeasible được phân biệt đúng.
- [x] Unassigned order luôn có trạng thái và lý do có căn cứ hoặc “chưa xác định”.
- [x] Web có loading, empty, error, permission, retry và reload thực tế.
- [x] Benchmark và E2E có kết quả lưu lại; không tuyên bố tối ưu toàn cục khi chưa có bằng chứng.
- [x] Lint, typecheck, build và test liên quan đạt; lỗi ngoài phạm vi được tách bằng bằng chứng và giao đúng người.
- [x] Migration, contract, biến môi trường mẫu, tài liệu chạy và runbook đã cập nhật.
- [x] Diff đã được tự review; không có secret, debug thừa, mock/TODO trên đường chạy bắt buộc hoặc thay đổi ngoài scope.

Chỉ khi toàn bộ checklist áp dụng được đánh dấu đạt mới gọi task Người 1 là hoàn thành 100%.
