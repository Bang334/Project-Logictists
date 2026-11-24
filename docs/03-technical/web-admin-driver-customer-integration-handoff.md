# Bàn giao Web Admin — tích hợp Mobile Driver và Customer

Baseline ngày 22/11/2026, nhánh local `feat/phase-1-core-tms`, HEAD `2f42fc49` cùng thay đổi trong working tree. **IMPLEMENTED** nghĩa là có đường chạy trong source local này. **PROPOSED** là thiết kế đang chờ duyệt. **BLOCKED** là việc tích hợp có trở ngại cụ thể. **NOT VERIFIED** là thiếu API phù hợp hoặc chưa có bằng chứng chạy xuyên nhánh. Scope trong bảng cuối dùng baseline local. Các nhánh remote mới hơn có khác biệt được ghi ở mục B.

## A. Kiến trúc và ranh giới

| Thành phần | Dữ liệu và trách nhiệm | Owner theo chức năng |
| --- | --- | --- |
| Customer Mobile | Tạo Order DRAFT, đọc Order và Tracking theo JWT của Customer. Server xác định ownership. | Mobile Customer |
| Driver Mobile | Nhận Trip đã phân công, lưu lệnh offline, thực thi điểm dừng, gửi GPS, POD và Incident. | Mobile Driver |
| NestJS Backend | Auth, quyền Branch/assignment, Order, Trip và validation. Trả projection theo từng đối tượng sử dụng. | Backend dùng chung · **OWNER TO CONFIRM** |
| PostgreSQL | Lưu Order, Trip, StopTask, GPS, DeliveryAttempt, PodFile, Incident và audit. Sự kiện đã persist là bằng chứng phía server. | Schema và migration · **OWNER TO CONFIRM** |
| Planner/Optimizer | Nhận Order đủ điều kiện, tạo phương án. Backend áp dụng và publish sau khi kiểm trạng thái, version và tài nguyên. | Planner/Optimizer |
| Web Admin | Duyệt đơn, điều phối và xem tiến độ qua API vận hành. Nhóm Web sở hữu UI và tích hợp client. | Web Admin |

Đường dữ liệu dự kiến cho demo xuyên module là Customer DRAFT → Web Confirm → Planner snapshot → apply/publish → Driver → trạng thái và bằng chứng lưu trong Backend → Tracking Customer và màn vận hành. G1 có test qua snapshot. E2E toàn chuỗi sau khi hợp nhất nhánh là **NOT VERIFIED**. Tên/số thành viên trong tài liệu phân công khác nhau, nên bảng dùng chức năng để xác định phạm vi. [Phân công](../../PHAN_CONG_3_NGUOI.md) · [Phạm vi Mobile](../01-project-overview/member-2-scope.md) · [Audit G0](graduation-requirements-coverage-audit.md)

## B. G1/M2.3 — duyệt Customer Order

**IMPLEMENTED trên baseline.** Customer gọi `POST /customer/orders` tạo DRAFT. Web đọc `GET /orders?status=DRAFT` hoặc `GET /orders/:id`. Chỉ ADMIN, hoặc DISPATCHER đúng Branch, được gọi `POST /orders/:id/confirm`. Order cần có nguồn CUSTOMER_APP và đạt validation G1. Backend chuyển sang CONFIRMED, tăng version một lần, ghi audit và receipt trong một transaction. Planner chỉ xét CONFIRMED thuộc Branch và đủ tiêu chí hiện hành. [API G1](api-contracts.md#m23--xác-nhận-đơn-customer-từ-web-admin) · [Service](../../backend/src/orders/customer-order-confirmation.service.ts) · [Test](../../backend/test/orders/customer-order-confirmation.postgres.spec.ts)

| Thao tác | Contract local |
| --- | --- |
| Confirm | Body `{ expectedVersion: number, idempotencyKey: UUID }`. HTTP 200 trả `{ orderId, orderNumber, status: "CONFIRMED", version, confirmedAt }`. |
| Retry chưa biết kết quả | Gửi lại cùng Order ID, version, key và tài khoản. Server kiểm quyền hiện tại và trả receipt gốc nếu đã commit. UI tải lại Order để hiển thị trạng thái hiện hành. |
| Lỗi 401/403/404 | Xử lý phiên đăng nhập, hiển thị thiếu quyền hoặc tải lại danh sách nếu đơn không tồn tại. |
| Lỗi 409 | `ORDER_VERSION_CONFLICT` hoặc `ORDER_STATE_CONFLICT` yêu cầu tải bản mới và xác nhận lại. Tạo key mới chỉ khi người dùng gửi lượt xác nhận mới. `ORDER_CONFIRM_IDEMPOTENCY_CONFLICT` nghĩa là key đã dùng cho payload khác. `ORDER_NOT_CONFIRMABLE` cần kiểm tra nguồn hoặc Package. |
| Lỗi 422 | `ORDER_BRANCH_INACTIVE` / `ORDER_VALIDATION_FAILED`. Giữ DRAFT và chỉ rõ dữ liệu cần kiểm tra. |
| PATCH | `PATCH /orders/:id` nhận thêm `expectedVersion` tùy chọn. Web nên gửi version lúc mở form. PATCH có thay đổi tăng version, no-op giữ version. Field `status` bị từ chối. |

**UI Web đề xuất.** Có bộ lọc DRAFT, màn review dữ liệu, dialog xác nhận với version đang hiển thị và một request khi submit. Trong lúc gửi, vô hiệu nút. Sau thành công tải lại detail/list và trạng thái eligibility. Khi conflict, giữ nội dung đang rà soát cho người dùng đối chiếu nhưng yêu cầu lấy version mới và quyết định lại. Khi timeout, giữ nguyên key và payload của lần đang chờ xác nhận.

### Blocker hợp nhất với Web hiện có

`origin/feat/web-admin@7d1012f` đã có UI/client Confirm và `origin/master@400897f` cũng có Backend Confirm khác baseline. Client Web gửi body `{ version }` và header `Idempotency-Key`, dùng `parseOrder` cho response. Remote Backend dùng `RequirePermission('orders.write')`, bắt package manifest và chuyển Package sang READY trong Confirm. Local dùng JWT/role/Branch, body `expectedVersion` + UUID, receipt HTTP 200 và policy Customer DRAFT chưa có Package vật lý. PATCH và list cũng khác request/response. Cùng URL chưa đủ để client hoạt động với cả hai. **BLOCKED** tới khi owner chốt canonical contract hoặc adapter/versioned contract có test. Cần đối chiếu G1 replay/audit, Customer DRAFT package-free, policy manifest của Web, Branch scope, lỗi và planner eligibility. Hợp nhất UI Confirm đang có theo quyết định này. [Baseline controller](../../backend/src/orders/orders.controller.ts) · [Baseline DTO](../../backend/src/orders/dto/confirm-customer-order.dto.ts) · [Thiết kế G1](g1-customer-order-confirmation-contract.md)

## C. Driver Trip Execution và quyền Web

### API thực thi dành cho Driver

| Endpoint local | Dữ liệu và điều kiện |
| --- | --- |
| `GET /driver/trips`, `GET /driver/trips/:id` | DRIVER đã liên kết hồ sơ và có assignment ASSIGNED. Detail chứa assignment, Trip version, stops, tasks, actual quantities và attempt metadata theo projection. PRIMARY và RELIEF đọc Trip được phân công. |
| `POST /driver/trips/:id/start` | PRIMARY/ASSIGNED, trạng thái phù hợp. Ghi START_TRIP, actual start, chuyển IN_PROGRESS. |
| `POST /driver/trips/:tripId/stops/:stopId/arrive` | PRIMARY/ASSIGNED, đúng stop và sequence. Ghi ARRIVE_STOP và actual arrival. `occurredAt` tùy chọn theo DTO và policy replay. |
| `POST /driver/trips/:tripId/stops/:stopId/complete` | PRIMARY/ASSIGNED. Gửi `tasks[{taskId,actualQuantity}]`, `occurredAt` tùy chọn, kèm `deliveryResult`, `reasonCode`, note/recipient khi áp dụng. Ghi actual departure, update kiện/Order, ghi attempt cho DELIVERY. |
| `POST /driver/trips/:id/complete` | PRIMARY/ASSIGNED. Kiểm các stop và quy tắc POD, ghi COMPLETE_TRIP và actual end. |

Các lệnh dùng UUID `idempotencyKey` và `expectedTripVersion`. Replay cùng payload theo contract và version conflict xử lý qua cơ chế hiện có. `PARTIAL` nghĩa có phần giao và còn thiếu, `FAILED` có actual delivery quantity bằng 0. Cần đọc kết quả DeliveryAttempt để phân biệt vì event DELIVERY_COMPLETED có thể là PARTIAL. Stop đã xử lý hay Trip đã kết thúc không tự chứng minh Order đã giao đủ. RELIEF chỉ đọc trong luồng này. [Controller](../../backend/src/trips/driver-trip-execution.controller.ts) · [DTO](../../backend/src/trips/dto/driver-trip-command.dto.ts) · [Service](../../backend/src/trips/driver-trip-execution.service.ts) · [Test PG](../../backend/test/trips/driver-trip-execution.postgres.spec.ts)

### Web đọc và điều phối

`GET /trips?status=...` và `GET /trips/:id` cho ADMIN/DISPATCHER, scoped theo `managingBranchId ?? vehicle.homeBranchId`. Có version, Trip status, assignments, sequence, planned/actual arrival và departure, stop status và tasks với planned/actual quantities. Detail có quan hệ Order/Package trong projection hiện tại. UI nên dùng field cần thiết cho vai trò điều phối. `PATCH /trips/:id/publish` là thao tác điều phối với version, sau đó Driver đọc chuyến đã được phân công. Cần API vận hành mới nếu Web cần timeline ExecutionEvent, đầy đủ kết quả DeliveryAttempt hoặc export theo quyền. Giữ các endpoint `/driver` trong phạm vi DRIVER. [Trips controller](../../backend/src/trips/trips.controller.ts) · [Trips service](../../backend/src/trips/trips.service.ts) · [Driver read](../../backend/src/trips/driver-trips.controller.ts)

## D. GPS Tracking

- DRIVER PRIMARY/ASSIGNED gửi `POST /driver/trips/:tripId/gps`. `measuredAt` là mốc đo, `receivedAt` là mốc server nhận. Chống trùng theo device/session/sequence. Marker nhận muộn vẫn có thể xuất hiện trong lịch sử lưu, latest ưu tiên thời điểm đo.
- ADMIN/DISPATCHER đúng phạm vi gọi `GET /trips/:tripId/tracking/latest`. UI có thể hiển thị điểm mới nhất của Trip được chọn, tuổi tín hiệu, `isStale`, accuracy nếu có và mốc nhận. `GPS_POSITION_NOT_FOUND` trả 404 cho Trip hợp lệ chưa có điểm. Phân biệt trạng thái đó với lỗi thiếu Trip/quyền. Vị trí thiếu/cũ cần nhãn riêng và không được diễn giải thành xe đứng yên. `isStale` hiện true khi tuổi đo vượt 2 phút.
- **G3 realtime background NO-GO.** Pixel API 33 gửi được ở một số cửa sổ khóa/reconnect. G3.2 ghi 45 giây chỉ được xét khi callback chạy. Realme có ca chờ trước `onStartJob`. Web hiển thị last known với thời điểm cập nhật. API latest chưa cung cấp timeline GPS hoặc kênh streaming GPS đã kiểm chứng. [API GPS](api-contracts.md) · [Controller](../../backend/src/trips/trip-tracking.controller.ts) · [Test](../../backend/test/trips/driver-gps.postgres.spec.ts) · [QA G3](../04-testing/g31-android-emulator-api33-gps-qa.md)

## E. e-POD và Incident

| Tính năng | Đã triển khai trên baseline | Khoảng trống Web |
| --- | --- | --- |
| POD metadata | `POST` upload và `GET` metadata tại `/driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod`. PRIMARY/ASSIGNED của Trip hợp lệ. Metadata có `evidenceType`, `mediaType`, `sizeBytes`, `uploadStatus`, capture/upload timestamps, trạng thái thay thế và `requirements`. | Cần projection vận hành có quyền Branch/Order để Web xem điều kiện và bằng chứng. Generic Trip detail chưa đưa PodFile/DeliveryAttempt metadata vào response. |
| PHOTO và SIGNATURE | PHOTO UPLOADED còn hiệu lực là điều kiện Complete Trip cho SUCCESS/PARTIAL và nhóm FAILED có lý do ADDRESS_ISSUE, ACCESS_RESTRICTED hoặc PACKAGE_DAMAGED. SIGNATURE tùy chọn. | UI Web cần hiển thị chính sách theo từng attempt, tránh gom tất cả lỗi FAILED vào cùng yêu cầu. |
| Private asset | `GET .../pod/:podFileId/view` cấp signed URL 5 phút cho file UPLOADED sau khi kiểm Trip/stop/attempt/file và Driver assignment. | Cần API ký riêng theo quyền Web. Chỉ hiển thị URL tạm do server cấp khi người xem đủ quyền. Không đưa đường dẫn vào log, bảng công khai hoặc cache dùng chung. |
| Incident | `POST/GET /driver/trips/:tripId/incidents`, `GET .../:incidentId`. Projection có type như VEHICLE_BREAKDOWN, ACCIDENT, TRAFFIC_JAM, ROAD_BLOCKED, PACKAGE_DAMAGED, PACKAGE_MISSING, SECURITY_ISSUE, OTHER, cùng severity, status, occurredAt và affectedOrders. Backend xác minh Order nằm trong Trip. Tạo ở DISPATCHED/IN_PROGRESS. Các trạng thái gồm OPEN, ACKNOWLEDGED, RESOLVED. | Chưa thấy API vận hành đọc/lọc Incident theo Branch hoặc chuyển ACK/RESOLVE trong baseline này. Các enum hiện có không chứng minh đã có luồng xử lý Web. |

[POD controller](../../backend/src/trips/driver-pod.controller.ts) · [POD service](../../backend/src/trips/driver-pod.service.ts) · [PHOTO policy](../../backend/src/trips/driver-pod-policy.ts) · [POD PG](../../backend/test/trips/driver-pod.postgres.spec.ts) · [Incident service](../../backend/src/trips/driver-incidents.service.ts) · [Incident PG](../../backend/test/trips/driver-incidents.postgres.spec.ts)

## F. Customer Tracking và History

`GET /customer/orders/:id/tracking` dành cho CUSTOMER sở hữu Order. Liên kết Order → StopTask → Trip hỗ trợ nhiều Trip. Mỗi Trip trả latest GPS theo chính Trip, `vehicleLocation: null` khi chưa có GPS, timestamps và `isStale`. `plannedDeliveryAt` của stop UNLOAD cuối theo sequence thuộc Order và `etaSource: "PLANNED"`. Trip đã hoàn thành có thể giữ vị trí cuối của Trip đó. Mobile poll khi màn Tracking hoạt động, và đọc lịch sử từ Order list/filter như `GET /customer/orders?status=COMPLETED`. `GET /driver/trips/history` là lịch sử riêng theo assignment cho DRIVER, không dùng làm Customer hoặc Web history. Web lấy Order/Trip và latest từ API vận hành tương ứng. [Customer controller](../../backend/src/orders/customer-orders.controller.ts) · [Tracking service](../../backend/src/orders/customer-order-tracking.service.ts) · [Tracking PG](../../backend/test/orders/customer-order-tracking.postgres.spec.ts) · [Driver history](../../backend/src/trips/driver-trips.controller.ts)

## G. G2 — ETA và cảnh báo trễ

**PROPOSED.** Planned là giờ kế hoạch của stop. Predicted là ước tính từ tiến độ xác nhận, GPS fresh và road matrix. Deadline đề xuất là hạn cam kết giao đủ với nguồn và revision rõ. Giờ planned không tự tạo commitment. `ON_TRACK` là tiến độ phù hợp, `AT_RISK` là nguy cơ theo dự báo, `LATE` có bằng chứng giao trễ thực tế, `UNKNOWN` là thiếu dữ liệu. Planned tracking tiếp tục dùng contract hiện có. Đề xuất Dashboard lấy `GET /trips/delivery-risks` theo Branch khi Backend hoàn tất. Owner cần duyệt deadline, hysteresis, pin/quality, quyền Branch và DTO. [Contract G2.1](g2-dynamic-eta-late-risk-contract.md)

## H. Checklist bàn giao và nghiệm thu

| Tính năng | Endpoint thực tế baseline | Quyền | Field quan trọng | UI Web cần làm | Owner | Dependency | Status | Acceptance / Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Duyệt đơn | `GET /orders?status=DRAFT`, `POST /orders/:id/confirm`, `PATCH /orders/:id` | ADMIN / DISPATCHER Branch | version, key, confirmedAt | Review, submit, refresh và xử lý 409 | Web + Shared Backend **OWNER TO CONFIRM** | Canonical Confirm/PATCH, manifest | IMPLEMENTED local · BLOCKED cross-branch | Cùng Order DRAFT → CONFIRMED → snapshot. Same key chỉ phát sinh một lần. [Test](../../backend/test/orders/customer-order-confirmation.postgres.spec.ts) |
| Điều phối và tiến độ | `GET /trips/:id`, `PATCH /trips/:id/publish`, nhóm `/driver/trips` chỉ Driver | Web Branch, Driver ASSIGNED | version, stops, actual, assignment | Tiến độ từ dữ liệu kế hoạch và actual | Planner + Driver + Web | Publish, quyền và state machine | IMPLEMENTED local · NOT VERIFIED timeline Web | Driver nhận Trip đã publish. RELIEF đọc, PRIMARY thực thi. [Tests](../../backend/test/trips/driver-trips.postgres.spec.ts) |
| Latest GPS | `GET /trips/:tripId/tracking/latest` | ADMIN / DISPATCHER Branch | measuredAt, receivedAt, isStale | Last known, no fix, stale | Web + Backend | GPS ingest, QA thiết bị | IMPLEMENTED local · G3 realtime NO-GO | Trip đúng Branch trả đúng điểm. Điểm đến muộn không lấn điểm đo mới. [Test](../../backend/test/trips/driver-gps.postgres.spec.ts) |
| POD | `GET /driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod` và view | Driver PRIMARY/ASSIGNED | PHOTO, uploadStatus, expiresAt | Metadata và preview riêng tư | Web + Shared Backend **OWNER TO CONFIRM** | API đọc/ký cho Web | IMPLEMENTED Driver · BLOCKED Web | User sai quyền không lấy URL. Photo bắt buộc mới khóa Complete đúng ca. [Test](../../backend/test/trips/driver-pod.postgres.spec.ts) |
| Incident | `GET /driver/trips/:tripId/incidents` | Driver theo assignment | severity, status, affectedOrders | Inbox và xử lý theo Branch | Web + Shared Backend **OWNER TO CONFIRM** | API vận hành Incident | IMPLEMENTED Driver · BLOCKED Web | Chỉ thấy Trip/Order đủ quyền. Quy tắc ACK/RESOLVE cần duyệt. [Test](../../backend/test/trips/driver-incidents.postgres.spec.ts) |
| Customer tracking/history | `GET /customer/orders`, `GET /customer/orders/:id/tracking` | Customer owner | trips, plannedDeliveryAt, isStale | Web lấy API vận hành riêng | Mobile Customer + Web | Ownership, latest | IMPLEMENTED local · NOT VERIFIED E2E hợp nhất | Nhiều Trip đúng Order. Sai owner 404. [Test](../../backend/test/orders/customer-order-tracking.postgres.spec.ts) |
| ETA động/risk | API vận hành chưa triển khai | Branch scope dự kiến | predicted, deadline, state, evaluatedAt | Risk panel khi có API đã duyệt | Mobile/Backend + Planner + Web | G2 signoff và evidence | PROPOSED | Tách planned/predicted/actual, data stale và alert trùng. [G2.1](g2-dynamic-eta-late-risk-contract.md) |
