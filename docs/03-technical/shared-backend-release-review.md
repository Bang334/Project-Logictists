# Shared Backend Release Review — feat/phase-1-core-tms

**Phạm vi lưu code feature hiện hành · 24/11/2026.** Dùng [Feature branch staging plan](git-release-staging-plan.md) cho quyết định commit/push lên nhánh feature. Các kết luận NO-GO về tích hợp hoặc triển khai ở tài liệu này vẫn là ghi nhận cho phạm vi tương ứng. Supabase schema drift, FK ordering và completion evidence tiếp tục là blocker triển khai.

**Điểm đọc hiện hành · 24/11/2026.** Contract Driver giữ `ASSIGNED` xuyên suốt. Mục 11 là audit mới nhất; các kết luận cũ được giữ cùng bằng chứng lịch sử. [Contract hiện hành](driver-assignment-availability-contract.md#1-trip-lifecycle)

**Đang chờ owner review.** Gói này đối chiếu Backend trong worktree với HEAD `2f42fc49f93dcbc6d8dcbb68a5523b79f45d638f`. Ref theo dõi `origin/feat/phase-1-core-tms` cùng commit trong lần kiểm tra. Index trống. Backend có 23 file sửa và 69 file mới, khớp cả đường dẫn lẫn SHA-256 với 92 mục Backend trong `file-review.json`. Đối chiếu ref Git hiện có, giữ nguyên worktree và index ngoài tài liệu này.

Nguồn phân công và contract. [AGENTS](../../AGENTS.md) · [Mobile AGENTS](../../mobile/AGENTS.md) · [Kế hoạch TMS](../../KE_HOACH_TMS.md) · [Phân công](../../PHAN_CONG_3_NGUOI.md) · [G1](g1-customer-order-confirmation-contract.md) · [API contracts](api-contracts.md) · [Bàn giao Web Admin](web-admin-driver-customer-integration-handoff.md)

## 1. Prisma schema và migration e-POD

| File | Thay đổi từ HEAD | Dependency và điểm duyệt |
| --- | --- | --- |
| `backend/prisma/schema.prisma` | Thêm enum `PodEvidenceType` gồm `PHOTO`, `SIGNATURE` và hai trường bắt buộc `PodFile.evidenceType`, `PodFile.sizeBytes`. | Phát hành cùng migration và Prisma Client generate từ schema này. Driver POD DTO/service, Complete Trip và test phụ thuộc trực tiếp. |
| `backend/prisma/migrations/20261116090000_driver_epod/migration.sql` | Tạo enum, thêm hai cột `NOT NULL` bằng default tạm `PHOTO` và `0`, rồi bỏ cả hai default. | Mọi bản ghi cũ nhận cùng cặp giá trị. Sau upgrade, writer phải cung cấp cả hai trường. Owner Prisma duyệt lịch sử migration đích, phân loại dữ liệu cũ và thứ tự triển khai DB/client/runtime. |

- **Khớp về kiểu và query.** `driver-pod.dto.ts` dùng enum từ Prisma Client. `driver-pod.service.ts` ghi loại bằng chứng và kích thước theo số byte thực, đọc cả hai trường trong projection. [DTO](../../backend/src/trips/dto/driver-pod.dto.ts) · [POD service](../../backend/src/trips/driver-pod.service.ts)
- **Khớp về điều kiện đóng chuyến với dữ liệu mới.** Complete Trip tìm PHOTO có `uploadStatus=UPLOADED` và không có replacement đã UPLOADED. Policy áp dụng cho SUCCESS/PARTIAL và FAILED với các lý do `ADDRESS_ISSUE`, `ACCESS_RESTRICTED`, `PACKAGE_DAMAGED`. Thiếu ảnh hợp lệ trả `POD_REQUIRED`. SIGNATURE là bằng chứng tùy chọn. [Policy](../../backend/src/trips/driver-pod-policy.ts) · [Complete Trip](../../backend/src/trips/driver-trip-execution.service.ts)
- **Ngữ nghĩa dữ liệu cũ cần duyệt.** Guard không lọc theo `sizeBytes` nên một hàng legacy đã upload, còn active, được gán PHOTO có thể thỏa điều kiện, kể cả khi nguồn gốc ảnh/chữ ký chưa xác minh được. `sizeBytes=0` là giá trị backfill. Kiểm tra writer trong Backend worktree chỉ thấy POD service ở runtime và fixture tạo PodFile trong test. Owner cần kiểm kê writer chạy trên môi trường đích và xác nhận quy tắc phân loại legacy, rehearsal upgrade trên dữ liệu thử và khả năng chạy hỗn hợp phiên bản trước khi phát hành.
- **Bằng chứng đã có.** PostgreSQL Driver POD 18/18, Driver Execution 17/17, POD policy 6/6, Cloudinary 2/2. Rehearsal nâng cấp từ bộ dữ liệu legacy đại diện chưa chạy trong lượt review này.

## 2. Auth, Branch và API vận hành

Tên file trong bảng tính từ `backend/src/`, trừ file test ghi rõ prefix.

| File | Thay đổi từ HEAD | Client/module phụ thuộc |
| --- | --- | --- |
| `auth/auth.controller.ts`, `auth/auth.service.ts` | Thêm đăng ký Customer, bcrypt và transaction User/Customer, xử lý trùng. Login dùng DTO và kiểm tra active. Profile có projection Customer liên kết theo tài khoản xác thực. | Mobile Auth, Web Admin login/profile và các caller đang dựa vào payload hiện có. |
| `auth/dto/login.dto.ts`, `auth/dto/register-customer.dto.ts` | DTO mới cho validation login và đăng ký; role đăng ký được gán tại service. | AuthController, contract form Mobile. |
| `auth/roles.guard.ts`, `auth/branch-scope.ts` | Bỏ quyền tự vượt role list của ADMIN. Thêm kiểm tra branch của tài nguyên đã đọc và chặn tài khoản thiếu branch khi cần scope. | Orders, Branches, Customer CRUD, Drivers, Vehicles, Trips và endpoint dùng RolesGuard. |
| `branches/branches.controller.ts`, `branches/branches.service.ts` | Giới hạn role vận hành; list nhánh active theo scope và kiểm branch ở detail/update. | Web branch picker, điều phối. Customer có API chi nhánh riêng. |
| `customers/customers.controller.ts` | Thêm role gate ADMIN/DISPATCHER cho API vận hành Customer. | Web Admin. Mobile đi qua `/customer/orders`. |
| `drivers/drivers.controller.ts`, `drivers/drivers.service.ts` | Phân quyền vận hành và kiểm branch trên detail/write, đồng thời bổ sung logic self-profile và Activity. | Web Admin Driver CRUD, Mobile Account/Activity. |
| `vehicles/vehicles.controller.ts`, `vehicles/vehicles.service.ts` | Giới hạn role, branch scope và quyền truy cập xe theo ID. | Web Fleet, điều phối xe. Mobile lấy xe trong Trip được phân công. |
| `trips/trips.controller.ts`, `trips/trips.service.ts` | Trip detail vận hành dành cho ADMIN/DISPATCHER. List kiểm scope kể cả dispatcher thiếu branch, dựa trên managing branch và fallback home branch của xe. | Web Trips/Planner; Driver có nhóm route riêng. |
| `backend/test/auth/branch-scope.spec.ts` | Bổ sung test kiểm tra branch tài nguyên. | Regression quyền dùng chung. |

API bổ sung là `POST /auth/register/customer`; login/profile và API vận hành có thay đổi validation, projection hoặc quyền. Schema nhóm này giữ nguyên. Đã PASS Customer Auth PostgreSQL 9/9, Transport Authorization PostgreSQL 15/15, Branch Scope 11/11, Transport Role Matrix 8/8. Backend/Prisma owner và Web Admin owner cần xác nhận role matrix, caller ADMIN có role list rõ ràng, dispatcher thiếu branch/sai branch bị từ chối và Web xử lý được validation/403 ở các luồng đang dùng. [Auth](../../backend/src/auth/auth.controller.ts) · [Branch scope](../../backend/src/auth/branch-scope.ts) · [Transport authorization](../../backend/test/auth/transport-authorization.postgres.spec.ts)

## 3. Orders — Customer API và G1 Confirm/PATCH

| File trong `backend/src/orders/` | Thay đổi từ HEAD |
| --- | --- |
| `orders.controller.ts` | Đăng ký Confirm HTTP 200, giới hạn API vận hành ADMIN/DISPATCHER và chuyển actor vào kiểm tra branch. |
| `orders.module.ts` | Đăng ký controller/service Customer và provider Confirm, gồm tracking; cần đi cùng các provider mới. |
| `orders.service.ts` | Scope Order theo branch; PATCH đọc và khóa Order nhất quán trước khi thay Items/Stops, kiểm trạng thái/version và tăng version một lần khi dữ liệu đổi. No-op giữ version. |
| `dto/update-order.dto.ts` | Bỏ `status` khỏi PATCH, thêm `expectedVersion` tùy chọn để caller cũ vẫn gửi được request. |
| `dto/confirm-customer-order.dto.ts`, `customer-order-confirmation.service.ts`, `customer-order-confirmation.validation.ts`, `order-write.ts` | Contract confirm, validation dữ liệu đã lưu, khóa chung với PATCH/apply, CAS và ghi command/event/receipt nguyên tử. |
| `customer-branches.controller.ts`, `customer-orders.controller.ts`, `customer-orders.service.ts`, `dto/create-customer-order.dto.ts`, `dto/query-customer-orders.dto.ts` | API chi nhánh active và Customer Create/List/Detail. Resolve Customer từ JWT, query theo owner. Customer tạo DRAFT; giữ đường tạo Order vận hành riêng. |
| `customer-order-tracking.service.ts` | Projection theo các Trip thực sự phục vụ Order qua StopTask. GPS cuối thuộc từng Trip, freshness và ETA kế hoạch. |

G1 không thêm schema. `POST /orders/:id/confirm` nhận `{ expectedVersion, idempotencyKey }`, trả `{ orderId, orderNumber, status, version, confirmedAt }`. Chỉ ADMIN hoặc DISPATCHER đúng Branch. Điều kiện gồm B2B_TRANSPORT, dấu vết CUSTOMER_APP, DRAFT, branch active, dữ liệu hợp lệ và chưa có Package vật lý. Replay cùng actor/key/payload sau kiểm tra branch trả receipt cũ. Payload khác cùng key hoặc bản ghi sai version/state trả 409. PATCH gửi `expectedVersion` để phát hiện bản chỉnh sửa cũ; client cũ thiếu field vẫn được xử lý tuần tự trên bản ghi hiện thời. Web phải tải lại khi version/state conflict và giữ nguyên key khi retry cùng payload chưa rõ kết quả. [G1 contract](g1-customer-order-confirmation-contract.md) · [Bàn giao retry](web-admin-driver-customer-integration-handoff.md)

Consumer gồm Mobile Customer, Web Orders và Planner. Đã PASS G1 unit 25/25, PostgreSQL G1 10/10, Customer Create 18/18, List/Detail 18/18, Tracking 10/10. G1 có race hai chiều, hai người duyệt, rollback ghi event/command, regression Admin create và generic PATCH. Owner Backend và Web cần duyệt cách client gửi version, xử lý replay/409, chính sách manifest và chọn contract chuẩn trước khi phối hợp nhánh. [G1 PostgreSQL](../../backend/test/orders/customer-order-confirmation.postgres.spec.ts)

## 4. Driver Trip, e-POD, GPS và API đọc

| File hoặc cụm file | Thay đổi từ HEAD | Dependency và rủi ro |
| --- | --- | --- |
| `trips/trips.module.ts` | Đăng ký Driver Trips, Execution, POD, GPS, Incident, Tracking và Cloudinary. | Cần commit cùng controllers, services, DTOs và provider; vẫn dùng module OptimizationJobs/Bull hiện có. |
| `drivers/drivers.module.ts`, `drivers/driver-self.controller.ts`, `drivers/driver-activity.query.ts`, `drivers/dto/query-driver-activity.dto.ts` | Thêm self-profile và aggregate Activity theo actor/time range; tái dùng DriversService và date range helper. | Mobile Account/Activity. Đối chiếu license, coverage và DTO dưới quyền DRIVER. |
| `trips/driver-trips.*`, `trips/driver-trip-history.query.ts`, query DTO và date range helper | Driver list/detail/history theo assignment; xe theo Trip; giới hạn phone theo trạng thái Trip. | Home, Calendar, Activity, Map, Stop Execution và C1 Dialer. PRIMARY/RELIEF đọc trong phạm vi; không cấp quyền theo chung branch. |
| `trips/driver-trip-execution.*`, `trips/dto/driver-trip-command.dto.ts` | Start/Arrive/Complete Stop/Complete Trip, version, replay, audit, delivery outcome và Order transition. | Driver offline queue; giữ payload, version và idempotency tương thích. |
| `trips/driver-pod.*`, `trips/driver-pod-policy.ts`, `trips/dto/driver-pod.dto.ts`, `common/services/cloudinary.service.ts` | Upload/list/view POD theo delivery attempt, private authenticated storage, signed view theo phạm vi Trip/attempt. | Driver e-POD và guard Complete Trip. Cần schema/migration ở mục 1 và cấu hình storage của môi trường đích. |
| `trips/driver-gps.*`, `trips/dto/driver-gps.dto.ts`, `trips/trip-tracking.controller.ts` | GPS ingest cho Driver, Web latest theo Trip/Branch. | Driver tracking, Customer polling, Web map. Tín hiệu quá hạn có trạng thái stale; realtime background vẫn NO-GO theo G3. |
| `trips/driver-incidents.*`, `trips/dto/driver-incident.dto.ts` | Driver tạo và đọc Incident theo Trip, kiểm Orders liên quan và idempotency. | Driver Incident; Web ACK/resolve ngoài gói. |

Tên file trong bảng tính từ `backend/src/`. Danh sách chọn commit ở mục 8 ghi từng đường dẫn đầy đủ. PostgreSQL đã PASS Driver Trips 41/41, Execution 17/17, e-POD 18/18, Incident 19/19, GPS 15/15. Owner Mobile/Driver cần duyệt PRIMARY thực thi, RELIEF read-only, queue/retry và lịch sử contact. Owner Backend/Prisma duyệt field whitelist, signed URL, storage và policy PHOTO legacy; owner Web xác nhận endpoint vận hành + trạng thái stale. [Driver tests](../../backend/test/trips/) · [Android GPS evidence](../04-testing/g31-android-emulator-api33-gps-qa.md)

## 5. Planner integration

| File thay đổi hoặc điểm đọc | Đối chiếu |
| --- | --- |
| `backend/src/orders/order-write.ts`, `orders.service.ts`, `customer-order-confirmation.service.ts` | Confirm và PATCH cùng khóa transaction theo Order với namespace 4103 mà Trip apply dùng. Confirm đưa Order vào trạng thái đủ điều kiện xem xét, PATCH làm mới version khi có thay đổi. |
| `backend/src/trips/trips.service.ts`, `trips.module.ts` | Thay đổi bên Trip chủ yếu là scope đọc/đăng ký provider. Snapshot/filter CONFIRMED và logic version apply hiện có được tái sử dụng. |
| `backend/test/orders/customer-order-confirmation.postgres.spec.ts` | Bằng chứng cùng Order ID không được chọn khi DRAFT, xuất hiện với version mới sau Confirm, lọc Branch, bảo toàn snapshot cũ và reject stale apply. |

Không có file mới trong Optimization Core hoặc hợp đồng solver. G1 kiểm chứng eligibility, không coi là bằng chứng solver thật. Split Order apply PostgreSQL 1/1 và Optimization Jobs 2/2 trong bộ test đã chạy. Owner Planner duyệt snapshot/version, giao điểm apply/publish với G1 và manifest do nhánh Web/master quy định. [Trips service](../../backend/src/trips/trips.service.ts) · [G1 PostgreSQL](../../backend/test/orders/customer-order-confirmation.postgres.spec.ts)

## 6. Khác biệt với các nhánh đối chiếu

| Ref hiện có | Khác biệt cần phối hợp |
| --- | --- |
| `origin/feat/web-admin@7d1012f20591878d81236dd12c241c86ffb006c4` · 22 commit sau baseline | Có UI/client Confirm hiện hữu và Backend permission-based. Migration chain khác baseline, gồm các migration Driver execution/delivery/POD lịch sử, shift/ready location, trip plan approval và frozen cargo. Không có migration e-POD trong gói này ở ref đó. |
| `origin/master@400897fdd53fde83c19d5f3d7ba8743a5f749514` · 24 commit sau baseline | Có Confirm/PATCH permission-based tương tự nhánh Web, cùng các thay đổi delivery appointment, remove retail, package handling, system settings và stacking. Migration chain khác baseline; tại ref này chưa có kiểu `PodEvidenceType` của gói. |

Hai nhánh cùng dùng Confirm body `{ version }`, header `Idempotency-Key`, `RequirePermission('orders.write')` và policy package manifest/Package READY. Client Web có `parseOrder`, trong khi G1 ở worktree trả receipt. Remote PATCH dùng `version` và header idempotency, list có phân trang với `page/pageSize/search`. Cần chốt contract chuẩn hoặc adapter có test với client trước khi hợp nhất nhánh. Cần đối chiếu migration chain trên môi trường đích riêng vì hai ref đã thay thế các migration nền so với HEAD. Chỉ đối chiếu ref hiện có, chưa merge hoặc thay nhánh. [Bàn giao Web Admin](web-admin-driver-customer-integration-handoff.md)

## 7. Bằng chứng và bảng ký duyệt

Kết quả đã ghi nhận ở worktree đã kiểm chứng hash cho Backend gồm **491/491 Jest (63 suite)**, trong đó **194/194 PostgreSQL (14 suite)**. Nest build và ESLint mục tiêu đạt. Mobile Jest 461/461 là bằng chứng lần sync trước, không nghiệm thu tích hợp client từ hai ref khác. Lượt review này chỉ kiểm tra source, Git và kết quả test đã lưu; không chạy lại test hoặc migration. [Development log](../05-development/development-log.md) · [Test cases](../04-testing/test-cases.md)

| Hạng mục | Người duyệt theo vai trò | Quyết định cần ghi | Trạng thái do owner điền |
| --- | --- | --- | --- |
| Prisma/e-POD | Backend/Prisma + owner Driver/Storage | Backfill legacy, writer/version compatibility, rehearsal migration, release sequencing. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |
| Auth/Branch | Shared Backend + Web Admin | Role matrix, fail-closed và tương thích login/profile/branch/transport CRUD. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |
| G1 Confirm/PATCH | Shared Backend + Web Admin | Contract chuẩn, manifest, replay, 409, client update và version. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |
| Driver API | Mobile/Driver + Shared Backend/Storage | Assignment, PII, idempotency, POD policy và phạm vi GPS mới nhất. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |
| Planner integration | Planner/Optimizer + Shared Backend | Eligibility, lock/version, snapshot/apply và ảnh hưởng publish. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |
| Gói để đưa lên nhánh đích | Backend/Prisma owner + ít nhất một consumer review chéo | Duyệt manifest, nhận diện reviewer theo tên, xác nhận các điều kiện còn mở và regression trước push. | ☐ APPROVED · ☐ APPROVED WITH CHANGES · ☐ BLOCKED |

Ghi tên người duyệt, ngày, điều kiện và bằng chứng vào từng dòng khi ký. **OWNER TO CONFIRM** cho danh tính cụ thể khi tài liệu phân công và cách gọi thành viên ở các milestone khác nhau. Trạng thái phát hành hiện tại **chờ signoff**.

## 8. Danh sách commit sau duyệt

**87 đường dẫn Backend** là tập ứng viên khi owner ký duyệt. `M` là file sửa từ HEAD; `A` là file mới trong worktree. Gói giữ đủ module wiring, contract/DTO/service/API, migration và tests. Với một clean checkout từ HEAD, đưa schema, migration, POD/Complete Trip và tests liên quan cùng gói; đưa wiring Orders/Trips/Drivers cùng provider tương ứng. Prisma Client sinh từ schema trong quy trình build. Tài liệu bàn giao có thể đi trong commit docs riêng gồm `docs/03-technical/shared-backend-release-review.md`, `docs/03-technical/g1-customer-order-confirmation-contract.md`, `docs/03-technical/api-contracts.md` và `docs/03-technical/web-admin-driver-customer-integration-handoff.md`, nếu được duyệt.

Tách khỏi gói Backend này `backend/package.json` (diff chỉ thêm ba lệnh QA), `backend/prisma/seed-customer-tracking-qa.ts`, `backend/prisma/seed-driver-customer-e2e-qa.ts`, `backend/prisma/seed-driver-demo.ts` và `backend/prisma/seed-driver-incident-qa.ts`. QA scripts/fixtures, Mobile, Web và các tài liệu ngoài phạm vi trên tiếp tục theo review riêng. Không lấy toàn bộ worktree để stage.

### Prisma

- A `backend/prisma/migrations/20261116090000_driver_epod/migration.sql`
- M `backend/prisma/schema.prisma`

### Auth, Branch và tài nguyên vận hành

- M `backend/src/auth/auth.controller.ts`
- M `backend/src/auth/auth.service.ts`
- M `backend/src/auth/branch-scope.ts`
- A `backend/src/auth/dto/login.dto.ts`
- A `backend/src/auth/dto/register-customer.dto.ts`
- M `backend/src/auth/roles.guard.ts`
- M `backend/src/branches/branches.controller.ts`
- M `backend/src/branches/branches.service.ts`
- M `backend/src/customers/customers.controller.ts`
- M `backend/src/vehicles/vehicles.controller.ts`
- M `backend/src/vehicles/vehicles.service.ts`
- A `backend/test/auth/auth.dto.spec.ts`
- A `backend/test/auth/auth.service.spec.ts`
- M `backend/test/auth/branch-scope.spec.ts`
- A `backend/test/auth/customer-auth.postgres.spec.ts`
- A `backend/test/auth/jwt.strategy.spec.ts`
- A `backend/test/auth/roles.guard.spec.ts`
- A `backend/test/auth/transport-authorization.postgres.spec.ts`
- A `backend/test/auth/transport-role-matrix.spec.ts`

### Orders và planner eligibility

- A `backend/src/orders/customer-branches.controller.ts`
- A `backend/src/orders/customer-order-confirmation.service.ts`
- A `backend/src/orders/customer-order-confirmation.validation.ts`
- A `backend/src/orders/customer-order-tracking.service.ts`
- A `backend/src/orders/customer-orders.controller.ts`
- A `backend/src/orders/customer-orders.service.ts`
- A `backend/src/orders/dto/confirm-customer-order.dto.ts`
- A `backend/src/orders/dto/create-customer-order.dto.ts`
- A `backend/src/orders/dto/query-customer-orders.dto.ts`
- M `backend/src/orders/dto/update-order.dto.ts`
- A `backend/src/orders/order-write.ts`
- M `backend/src/orders/orders.controller.ts`
- M `backend/src/orders/orders.module.ts`
- M `backend/src/orders/orders.service.ts`
- A `backend/test/orders/create-customer-order.dto.spec.ts`
- A `backend/test/orders/customer-create-order.postgres.spec.ts`
- A `backend/test/orders/customer-order-confirmation.postgres.spec.ts`
- A `backend/test/orders/customer-order-confirmation.spec.ts`
- A `backend/test/orders/customer-order-tracking.postgres.spec.ts`
- A `backend/test/orders/customer-order-tracking.service.spec.ts`
- A `backend/test/orders/customer-orders.postgres.spec.ts`
- A `backend/test/orders/customer-orders.service.spec.ts`
- A `backend/test/orders/query-customer-orders.dto.spec.ts`

### Driver, Trips, Storage và GPS

- M `backend/src/common/services/cloudinary.service.ts`
- A `backend/src/drivers/driver-activity.query.ts`
- A `backend/src/drivers/driver-self.controller.ts`
- M `backend/src/drivers/drivers.controller.ts`
- M `backend/src/drivers/drivers.module.ts`
- M `backend/src/drivers/drivers.service.ts`
- A `backend/src/drivers/dto/query-driver-activity.dto.ts`
- A `backend/src/trips/driver-gps.controller.ts`
- A `backend/src/trips/driver-gps.service.ts`
- A `backend/src/trips/driver-incidents.constants.ts`
- A `backend/src/trips/driver-incidents.controller.ts`
- A `backend/src/trips/driver-incidents.service.ts`
- A `backend/src/trips/driver-pod-policy.ts`
- A `backend/src/trips/driver-pod.controller.ts`
- A `backend/src/trips/driver-pod.service.ts`
- A `backend/src/trips/driver-trip-execution.constants.ts`
- A `backend/src/trips/driver-trip-execution.controller.ts`
- A `backend/src/trips/driver-trip-execution.service.ts`
- A `backend/src/trips/driver-trip-history.query.ts`
- A `backend/src/trips/driver-trips.controller.ts`
- A `backend/src/trips/driver-trips.service.ts`
- A `backend/src/trips/dto/driver-gps.dto.ts`
- A `backend/src/trips/dto/driver-incident.dto.ts`
- A `backend/src/trips/dto/driver-pod.dto.ts`
- A `backend/src/trips/dto/driver-trip-command.dto.ts`
- A `backend/src/trips/dto/driver-trip-date-range.ts`
- A `backend/src/trips/dto/query-driver-trip-history.dto.ts`
- A `backend/src/trips/dto/query-driver-trips.dto.ts`
- A `backend/src/trips/trip-tracking.controller.ts`
- M `backend/src/trips/trips.controller.ts`
- M `backend/src/trips/trips.module.ts`
- M `backend/src/trips/trips.service.ts`
- A `backend/test/common/services/cloudinary.service.spec.ts`
- A `backend/test/trips/driver-gps.postgres.spec.ts`
- A `backend/test/trips/driver-gps.service.spec.ts`
- A `backend/test/trips/driver-incidents.postgres.spec.ts`
- A `backend/test/trips/driver-incidents.service.spec.ts`
- A `backend/test/trips/driver-pod-policy.spec.ts`
- A `backend/test/trips/driver-pod.postgres.spec.ts`
- A `backend/test/trips/driver-trip-execution.postgres.spec.ts`
- A `backend/test/trips/driver-trip-execution.service.spec.ts`
- A `backend/test/trips/driver-trips.postgres.spec.ts`
- A `backend/test/trips/driver-trips.service.spec.ts`

## 9. Release Blocker Verification — 23/11/2026

**Kết luận hiện tại · NO-GO cho commit/push gói đầy đủ.** Rehearsal xác nhận migration thực thi được và giữ dữ liệu gốc, đồng thời xác nhận lỗi phân loại bằng chứng legacy và sự không tương thích khi writer cũ còn chạy. Kiểm tra cấu hình Android và quyền liên kết dự án EAS đạt ở mức ghi bên dưới. Native APK từ bản sao chưa build xong do thiếu toolchain. Quyết định ký duyệt ở mục 7 vẫn chờ owner. [Staging plan](git-release-staging-plan.md)

### 9.1 Prisma/e-POD — rehearsal có dữ liệu

Dùng PostgreSQL **16.16** trên Docker riêng `tms-release-pod-ff45ed9b71`, `--network none`, không publish port, PGDATA trên tmpfs, không bind mount hoặc volume. Đọc và áp dụng **năm file SQL trước e-POD** theo thứ tự thư mục vào DB mới `tms_release_pod_test`, tạo Branch/Vehicle/Trip/Stop/DeliveryAttempt và năm PodFile tổng hợp với các FK thực. Tiếp theo chạy nguyên byte SQL của `20261116090000_driver_epod` qua psql với `ON_ERROR_STOP=1`, bằng socket riêng trong container. Container dùng một lần đã dừng. Lượt này kiểm chứng nội dung SQL và query, không kiểm tra Prisma migration ledger của môi trường triển khai hay dữ liệu thật trong storage.

- SHA-256 của SQL rehearsal là `9f693458cf59b1def7e364f6fb5dd5dd9c6986b3843a66d74ce8da3a47d845fe`.
- Số hàng trước/sau **5 → 5**. Digest JSONB theo ID trên **toàn bộ cột cũ** trước/sau cùng là `efd0cbd2635a8c4d761044231ef39961`. Quan hệ replacement, upload status, MIME, checksum và storage key cũ đều được bảo toàn trong mẫu.
- Sau migration, cả hai trường là `NOT NULL` và không có default. Kiểm tra điều kiện SQL tương đương nhánh chọn bằng chứng của Complete Trip cho kết quả sau. Tất cả attempt trong mẫu đều `SUCCESS`, nên đều áp dụng yêu cầu PHOTO.

| Mẫu legacy | Sau nâng cấp | Qua điều kiện PHOTO của guard |
| --- | --- | --- |
| PHOTO JPEG đã upload | PHOTO, 0 byte | Có |
| SIGNATURE PNG đã upload, bằng chứng duy nhất | PHOTO, 0 byte | **Có · sai phân loại** |
| JPEG upload FAILED | PHOTO, 0 byte | Không |
| JPEG có replacement đã upload | PHOTO, 0 byte | Không |
| Replacement PNG đã upload, nguồn tổng hợp là chữ ký | PHOTO, 0 byte | **Có · sai phân loại** |

| Kiểm tra tương thích | Kết quả |
| --- | --- |
| Đọc cột mới trên schema cũ | PostgreSQL `42703` |
| Đọc projection cũ sau migration | PASS trên truy vấn mô phỏng |
| INSERT kiểu cũ, thiếu hai cột mới | PostgreSQL `23502` sau migration |
| INSERT kiểu mới có PHOTO/123 và SIGNATURE/456 | PASS và đọc lại đúng |
| `sizeBytes=0` | Guard hiện không xét kích thước. Giá trị 0 không tự chặn ảnh cũ và có thể làm metadata được hiểu sai là file rỗng. |

**Cần Backend/Prisma + Driver/Storage quyết định.** Kiểm kê bằng chứng và mọi writer trên đích được phê duyệt. Chỉ phân loại bằng nguồn metadata đã xác minh. Rehearsal dùng JPEG/PNG để tái hiện các loại đã biết, MIME legacy tự nó chưa chứng minh ảnh/chữ ký cho toàn bộ dataset. Với bằng chứng không xác minh được, đề xuất fail-closed cho yêu cầu PHOTO và giữ khả năng đối soát hoặc bổ sung ảnh. Chốt cách biểu diễn kích thước chưa biết, không coi `0` là số byte đã đo. Nếu migration đã được áp dụng trên môi trường chia sẻ, chuẩn bị migration hiệu chỉnh riêng theo quy trình, giữ nguyên migration đã áp dụng. Chọn một trong hai rollout cần phê duyệt, hoặc ngừng mọi writer cũ trong cửa sổ triển khai rồi nâng DB/client/app, hoặc thiết kế tương thích chuyển tiếp và kiểm chứng cả hai phiên bản trước khi rolling deploy. Cần rehearsal lại trên dữ liệu đã được làm sạch và xác nhận runbook phục hồi. [Migration](../../backend/prisma/migrations/20261116090000_driver_epod/migration.sql) · [Complete Trip](../../backend/src/trips/driver-trip-execution.service.ts)

### 9.2 Confirm/PATCH — phương án tương thích đề xuất

Đối chiếu cùng ba ref tại mục 6. **Đã duyệt cho local G1** gồm Customer DRAFT có dấu vết CUSTOMER_APP và chưa có Package vật lý, JWT ADMIN/DISPATCHER theo Branch, receipt 200, audit, version và replay có kiểm quyền hiện tại. **Chưa duyệt** contract chuẩn dùng chung khi tích hợp Web/master.

| Mặt contract | Local G1 | `feat/web-admin` và `master` |
| --- | --- | --- |
| Confirm input | Body `expectedVersion` và UUID `idempotencyKey` | Body `version`, header `Idempotency-Key` từ 16–100 ký tự theo pattern của ref. Master thêm `acceptedProtectionFeeVnd` tùy chọn trong DTO và có thể yêu cầu chấp nhận đúng phí. |
| Confirm output | HTTP 200, receipt có `orderId`, `orderNumber`, `status`, `version`, `confirmedAt` | Web client gọi `parseOrder` trên response Order đầy đủ. |
| Quyền | Role gate ADMIN/DISPATCHER và branch check tài nguyên | `orders.write`, branch scope và kiểm customer theo branch trong các đường ghi. Cần duyệt mapping principal/role và quy tắc quyền trên retry. |
| Idempotency | `CONFIRM_CUSTOMER_ORDER`, actor/key + hash ID/version, receipt ổn định sau kiểm quyền | `ORDER_CONFIRM` và `ORDER_UPDATE`, actor/command/key + canonical hash, replay snapshot Order đã lưu. Phải kiểm chứng lại quyền khi replay trong lớp dùng chung. |
| Package | G1 từ chối Customer DRAFT đã có Package vật lý | Hai ref đòi manifest và chuyển Package sang READY. Master còn xác nhận charge khi có. |
| PATCH | `expectedVersion` tùy chọn, không sửa status, lock/version và no-op; không có cùng contract header replay của các ref | `version` bắt buộc, DTO mở rộng CreateOrder, header idempotency, kiểm tham chiếu và cập nhật manifest. |

**Đề xuất ưu tiên** giữ G1 làm contract cho Customer-origin và cập nhật Web client bằng một adapter có test theo workflow được Backend xác nhận. Sau Confirm, Web dùng receipt rồi đọc lại Order khi màn hình cần dữ liệu đầy đủ. Adapter gửi version lúc mở form, giữ nguyên key/payload khi retry do mất phản hồi và refresh khi 409. Nếu cần hỗ trợ đồng thời hai workflow trong một Backend, tách operation/version hoặc dispatch theo policy đã được lưu và kiểm tra ở server, với contract và audit rõ ràng cho từng workflow. Tránh adapter đổi tên field rồi gửi mọi DRAFT qua cùng một policy. Web/Backend/Planner cần chốt manifest, thời điểm vật chất hóa Package, tính phí nếu master là đích tích hợp, actor/authorization trên replay, mô hình version và cách xử lý lệnh cũ khi chuyển contract. Cần regression có Web client thật cho hai nguồn Order trước khi ký. [G1](g1-customer-order-confirmation-contract.md) · [Bàn giao Web](web-admin-driver-customer-integration-handoff.md)

### 9.3 Auth/Branch, Driver và Planner

- Source local yêu cầu role được khai báo rõ, ADMIN đọc theo phạm vi endpoint và có quyền qua kiểm tra branch, DISPATCHER chỉ đúng Branch và bị từ chối nếu thiếu scope. Quyền Driver phụ thuộc assignment của Trip. PRIMARY/ASSIGNED có thể thực thi khi đủ guard, RELIEF/ASSIGNED chỉ đọc trong phạm vi projection; cùng Branch không cấp quyền đọc Trip của tài xế khác.
- PATCH và Confirm đồng bộ qua Order lock và version. Confirm tăng version một lần. Planner snapshot chỉ chọn CONFIRMED đủ tiêu chí và dùng version khi apply. Suite G1 PostgreSQL đã kiểm chứng hai thứ tự PATCH/Confirm, Order ID/version mới sau Confirm và reject stale apply.
- **Lượt này · 85/85 PASS**, 6 suite trên bản sao từ HEAD + 87 file ứng viên. Chạy `branch-scope.spec.ts`, `transport-role-matrix.spec.ts`, `customer-order-confirmation.spec.ts`, `driver-trips.service.spec.ts`, `driver-trip-execution.service.spec.ts` và `driver-pod-policy.spec.ts`.
- **Bằng chứng PostgreSQL đã có** gồm G1 10/10, transport authorization 15/15, Driver Trip 41/41, Driver Execution 17/17, POD 18/18. NOT RUN lại các suite HTTP tích hợp trong lượt này. Suite G1 có guard gắn với DB QA chung; giữ nguyên test và tách nó khỏi rehearsal SQL không có TCP. Không có kết quả owner approval suy ra từ PASS. [G1 integration test](../../backend/test/orders/customer-order-confirmation.postgres.spec.ts) · [Auth tests](../../backend/test/auth/) · [Driver tests](../../backend/test/trips/)

### 9.4 Expo/EAS và khả năng tái tạo APK

| Hạng mục | Kết quả |
| --- | --- |
| Secrets | Không thấy credential literal trong `app.json`, `eas.json` và `README.md` theo review cấu hình. Project ID là định danh dự án, API URL và Mapbox public token đi qua `EXPO_PUBLIC_*`. Các biến public được phép đưa vào bundle theo mục đích của chúng; signing, JWT, storage secret và private token phải nằm ngoài đó. |
| Liên kết EAS | `eas project:info` chỉ đọc, exit 0, trả project **`@truonganhtung9/smart-tms-mobile`**, khớp slug và project ID trong App config. **Cần Mobile/EAS owner xác nhận** namespace này là dự án dự kiến cho release và quyền access của nhóm. Không có upload, relink hoặc thay signing. |
| Plugin và permission | Prebuild Android từ bản sao **PASS**. Đã đọc manifest sinh ra có fine/coarse/background location, foreground service/location và POST_NOTIFICATIONS. Config khai báo Router, SecureStore, SQLite, ImagePicker, Location và Mapbox; Expo TaskManager nằm trong dependency. Có thêm RECORD_AUDIO và một số permission của dev/native template, cần owner quyết định quyền tối thiểu trên merged release manifest. Prebuild cảnh báo `userInterfaceStyle` cần expo-system-ui, không thay dependency trong lượt này. |
| APK local | `:app:assembleRelease -PreactNativeArchitectures=x86_64 --offline` **BLOCKED ở toolchain**. Gradle báo NDK chưa cấu hình và nêu preferred version `28.2.13676358`. Log Expo cũng in `ndk=27.1.12297006`, `buildTools=37.0.0`, compile SDK 37 và target SDK 36. SDK được chọn không có thư mục NDK và chỉ liệt kê Build Tools 36.0.0. Cần chốt NDK/Build Tools theo cấu hình hiệu lực rồi tái chạy trên máy sạch. Không có APK từ lần thử này. |
| Profile | `eas.json` chỉ định profile development client nội bộ dạng APK. Mẫu prebuild local ký cả biến thể release bằng debug config, chỉ phù hợp smoke build khi có APK. Chưa chứng minh standalone build có signing/profile được duyệt hoặc ABI cho máy thật. |
| README | Cần cập nhật Confirm G1 đã có ở Backend, chuyển clone steps sang đường dẫn tương đối và `npm ci`, ghi rõ env cho emulator/điện thoại, Mapbox dev build, setup SDK/NDK và cách build độc lập Metro. Bỏ diễn giải chung rằng logout xóa queue, vì cần nêu chính sách theo loại queue/owner. |

Bằng chứng trước đó trên bản sao Mobile vẫn là TypeScript, ESLint, 461/461 Jest và Android JS export PASS. Tài liệu cần mô tả riêng Expo Go, development build và standalone build. Khi đủ toolchain, nghiệm thu bằng package ID/ABI, JS bundle nhúng, merged permissions và cài/chạy đúng loại APK trên môi trường QA. [App config](../../mobile/app.json) · [EAS config](../../mobile/eas.json) · [README](../../mobile/README.md) · [Staging plan](git-release-staging-plan.md)

### 9.5 Checklist trước commit/push

| Cổng | Trạng thái xác minh | Owner cần làm |
| --- | --- | --- |
| SQL migration giữ nguyên dữ liệu mẫu | PASS | Backend/Prisma kiểm tra ledger và rehearsal đích do owner cho phép. |
| Phân loại e-POD legacy và writer cũ/mới | **BLOCKED** | Backend/Prisma + Driver/Storage duyệt corrective plan và deploy sequence. |
| Contract Confirm/PATCH liên nhánh | **BLOCKED** | Web + Backend + Planner ký contract/adapter và chạy test client + Package/snapshot. |
| Role/Branch, PRIMARY/RELIEF và version | PASS theo phạm vi code/test; **chờ signoff** | Backend + Web + Mobile + Planner xác nhận matrix và stale apply. |
| Expo prebuild và liên kết EAS | PASS kỹ thuật; **chờ signoff** | Mobile/EAS owner xác nhận namespace, profile/signing, README và permission. |
| APK từ clean source | **BLOCKED** | Mobile owner chốt toolchain, tái chạy build native và kiểm chứng artifact. |
| Staging A / commit / push | A theo allowlist ở bước staging riêng; **NO-GO** cho commit/push gói đầy đủ | Duyệt các cổng trên, kiểm staged diff/secrets, rerun regression trên tập file đã duyệt và đối chiếu ref remote đích. |

Không thay đổi phân loại 369 file, runtime, tests, schema/migration hay index. Các xác nhận trong mục 7 vẫn do owner điền.

## 10. Điều kiện giữ nguyên M3.5 khi bảng POD rỗng

**GO có điều kiện cho thiết kế M3.5** gồm `PHOTO` và `SIGNATURE`, `sizeBytes Int` bắt buộc và guard yêu cầu PHOTO `UPLOADED` còn hiệu lực. Nếu owner xác minh đúng database triển khai, không có POD legacy cần chuyển đổi và không còn writer cũ sẽ ghi vào đó, bỏ `UNKNOWN` khỏi phương án release của đích này. **NO-GO hiện tại cho migration/release** vì còn thiếu bằng chứng identity, count, ledger và inventory writer. Rehearsal mục 9 vẫn áp dụng nếu có môi trường chứa POD legacy.

### Ánh xạ và identity

- `PodFile` có `@@map("pod_files")`. Datasource PostgreSQL không khai báo schema riêng cho model. Cả `DATABASE_URL` lẫn `DIRECT_URL` trong cấu hình Backend local đều không có tham số `schema`, nên Prisma mặc định dùng `public`. Đích theo cấu hình là `public.pod_files`. Migration dùng tên bảng không kèm schema, do đó vẫn phải kiểm tra ngữ cảnh schema ở đích.
- Đọc cục bộ `backend/.env`, đã xác nhận file bị ignore. Runtime là Supabase pooler cổng 6543, migration dùng Supabase pooler cổng 5432 qua `DIRECT_URL`. Hai URL dùng cùng Supabase project/tenant ref, cùng DB tên `postgres`, khớp ref trong cấu hình Backend người dùng đã cung cấp trước đây. `PrismaService` không tự thay datasource. Không thấy override ba biến DB trong shell dùng để review. `TEST_DATABASE_URL` trỏ PostgreSQL loopback riêng, không phải đích release.
- Chủ dự án báo Dashboard project **logistics**, branch **main PRODUCTION** hiển thị *This table is empty* cho `public.pod_files`. Chưa có ref của nhánh Dashboard hoặc cấu hình môi trường deploy để so với ref của Backend. Tên database `postgres` có thể giống nhau giữa các project/branch. Owner cần so sánh ref từ mục **Connect** khi đang chọn đúng branch với ref của cả runtime và migration **trên môi trường triển khai**, rồi chỉ ghi nhận có khớp hay không. Giữ URL và credentials ngoài tài liệu.
- Git HEAD chưa chứa file migration e‑POD. Worktree có file `20261116090000_driver_epod` với SHA-256 `9f693458cf59b1def7e364f6fb5dd5dd9c6986b3843a66d74ce8da3a47d845fe`. Log M3.5 ghi migration đã deploy vào PostgreSQL test local. Rehearsal mục 9 dùng psql trên DB disposable. Hai bằng chứng này không xác định ledger hoặc số hàng ở Supabase.

[Prisma datasource và model](../../backend/prisma/schema.prisma) · [PrismaService](../../backend/src/prisma/prisma.service.ts) · [Log M3.5](../05-development/development-log.md)

### SELECT do owner/DBA thực hiện

Chạy trong SQL Editor của **đúng branch đã đối chiếu ref**, với role có thể đếm toàn bảng. `pod_rls_active = true` nghĩa là kết quả có thể bị giới hạn theo RLS, nên cần xác nhận lại bằng role được phép thấy mọi hàng. `current_database()` chỉ xác nhận tên DB, không thay việc đối chiếu ref. Không chạy câu đếm nếu `pod_table` là `NULL`, hoặc câu ledger nếu `prisma_ledger` là `NULL`.

```sql
SELECT current_database() AS database_name,
       current_schema() AS active_schema,
       to_regclass('public.pod_files') AS pod_table,
       to_regclass('public._prisma_migrations') AS prisma_ledger,
       row_security_active(to_regclass('public.pod_files')) AS pod_rls_active;

SELECT count(*) AS pod_row_count FROM public.pod_files;

SELECT migration_name, checksum, started_at, finished_at, rolled_back_at,
       applied_steps_count
FROM public._prisma_migrations
ORDER BY started_at, migration_name;

SELECT column_name, udt_schema, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pod_files'
  AND column_name IN ('evidenceType', 'sizeBytes')
ORDER BY column_name;

SELECT e.enumlabel
FROM pg_catalog.pg_enum e
JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typname = 'PodEvidenceType'
ORDER BY e.enumsortorder;
```

### Diễn giải và cổng release

| Bằng chứng trên đích | Quyết định đề xuất |
| --- | --- |
| `COUNT(*) = 0`, migration chưa áp dụng, chain trước đó khớp và chưa có hai cột/enum | Có thể giữ nguyên migration M3.5. Khi có phê duyệt triển khai, dừng writer và xác nhận lại count trên đúng đích sát thời điểm migration để tránh phát sinh bản ghi giữa hai bước. |
| `COUNT(*) = 0`, migration đã hoàn tất, không rolled back, checksum và schema khớp | Có thể giữ contract M3.5 hiện tại. Không áp dụng lại migration. Duyệt phiên bản Prisma Client/Backend và luồng rollout. |
| Có hàng nhưng đều có provenance M3.5 hợp lệ | Owner xác nhận bằng chứng theo từng nhóm dữ liệu. Sự hiện diện của hàng M3.5 hợp lệ không tự tạo nhu cầu thêm `UNKNOWN`. |
| Có POD legacy chưa phân loại, ledger lệch/thiếu, trạng thái migrate lỗi, schema khác ledger hoặc chưa đối chiếu được ref | **NO-GO** cho bước migration/release. Giữ mục 9 để xử lý nếu có dữ liệu legacy. |

**Writer.** Tìm thấy writer runtime hiện tại tại `DriverPodService`, ghi cả `evidenceType` và `sizeBytes`. Suite PostgreSQL có fixture tạo PodFile. Không tìm thấy writer runtime kiểu cũ trong HEAD hoặc các ref Web/master đã rà soát. Nhánh Web có fixture `backend/tests/monitor-test-app.cjs` dùng schema khác và không ghi loại bằng chứng. Repo không cho biết instance, worker, seed/import hay job ngoài repo nào đang chạy trên đích. Sau migration, hai cột bắt buộc không có default. INSERT kiểu cũ thất bại kể cả khi bảng ban đầu rỗng. Backend/Prisma owner cần xác nhận không còn writer cũ, hoặc dừng chúng trước migration và chỉ mở lại bằng bản M3.5 tương thích. [Writer](../../backend/src/trips/driver-pod.service.ts) · [Guard Complete Trip](../../backend/src/trips/driver-trip-execution.service.ts)

Mục ký duyệt ở trên giữ nguyên. Không kết nối production, chạy migration hoặc thay đổi schema, runtime hay Git index trong lượt review này.

## 11. Final pre-push integration audit — 24/11/2026

**Nghiệp vụ Driver mới đã chốt** · `ASSIGNED` xuyên suốt Start, Stop, e-POD và Complete. Trip quản lý tiến độ. Proposal Accept + Start đã **SUPERSEDED**. Mục này thay thế các kết luận rollout cũ ở mục 9–10 và vẫn giữ bằng chứng lịch sử. [Contract hiện hành](driver-assignment-availability-contract.md) · [Allowlist](git-release-staging-plan.md)

### Git và nhánh Planner

Đã đối chiếu Git HEAD, remote-tracking refs, worktree và refs server bằng `git ls-remote --heads origin`. Remote hiện chỉ công bố feature, Web Admin và master. **Không có ref Planner riêng được công bố**; đối chiếu Planner bằng code ở master và Web Admin, không suy đoán tên nhánh hoặc owner của nhánh riêng.

| Ref | Commit / phía sau–đi trước so với HEAD | Phạm vi trùng thay đổi với worktree |
| --- | --- | --- |
| HEAD và server `feat/phase-1-core-tms` | `2f42fc4`, 0–0 | Backend/Prisma, Mobile và docs là thay đổi worktree chưa stage. |
| `origin/feat/web-admin` và server | `7d1012f`, 0–22 | 20 path tracked cùng thay đổi, không path local mới trùng. |
| `origin/master` local | `400897f`, 0–24 | 20 path tracked cùng thay đổi, 16 path Mobile mới trùng tên, 7 khác nội dung sau chuẩn hóa CRLF. |
| master từ server | `4b819a725a57d98b041422bf42e8913c92aa5dc1`, 0–37 | 20 path tracked cùng thay đổi, 16 path Mobile mới trùng tên, 7 khác nội dung. Master có thêm 13 commit so với remote-tracking local gồm Driver Mobile, Planner/optimization và Web dispatch. |

Đọc object master mới theo SHA, giữ nguyên mọi ref local và Git index. Path trùng chỉ là phạm vi cùng chỉnh sửa. Chưa kiểm merge tự động hay chạy test trên cây merge. Bảy path local add trùng và khác nội dung là `mobile/.env.example`, `mobile/app.json`, `mobile/eslint.config.js`, `mobile/package-lock.json`, `mobile/package.json`, `mobile/src/app/_layout.tsx`, `mobile/tsconfig.json`.

### Ma trận phát hiện

Có **8 nhóm CONFIRMED CONFLICT** theo các dòng C1–C8. Một nhóm có thể gồm nhiều file hoặc lỗi SQL. Các rủi ro tiếp theo được ghi riêng.

| ID / Phân loại | Bằng chứng và tác động | Owner |
| --- | --- | --- |
| C1 · **CONFIRMED CONFLICT** · Prisma | `backend/prisma/migrations/20261116090000_driver_epod/migration.sql:3` thêm lại `sizeBytes`; Web `20261010140000_driver_delivery_pod/migration.sql:19` tạo sẵn kiểu nullable. Target theo bằng chứng DBA còn rỗng, chưa có `evidenceType` và chưa ghi ledger M3.5. Rehearsal `42701`. Chain HEAD/master/Web khác nhau. Chưa được ghi nhận migration đã áp dụng chỉ từ row count. | Backend/Prisma |
| C2 · **CONFIRMED CONFLICT** · Driver/Shared Backend | Feature `driver-trip-execution.service.ts:288,461,518` ghi attempt/event trước command; Web FK tham chiếu command ngay khi ghi, gồm `delivery_attempt_command_fk` và `execution_command_fk`. Rehearsal `23503`; cần reserve command, rollback nguyên tử cả khi trigger deferrable lỗi. | Driver/Backend |
| C3 · **CONFIRMED CONFLICT** · Prisma/Driver completion | Web migration `20261013090000_driver_trip_completion/migration.sql:4–8,17–51` yêu cầu ACCEPTED và evidence liên kết. Feature chưa projection cột assignment end/link, event `COMPLETE_TRIP` payload rỗng. Probe ASSIGNED có evidence đúng vẫn báo `23514`, command/event/Trip rollback. Đổi CHECK thành nhánh PRIMARY/ASSIGNED bổ sung, giữ legacy ACCEPTED và mọi điều kiện trigger. | Backend/Prisma + Driver/Web |
| C4 · **CONFIRMED CONFLICT** · Planner overlap | Web constraint `20261013090000_driver_trip_completion/migration.sql:13–15` giữ planned interval cho các assignment chưa có actual end. Probe chặn planned overlap nhưng nhận slot 12–14 khi Trip slot 08–12 còn IN_PROGRESS. Feature `trips.service.ts:352,1229,2861` lọc active Trip với planned interval; chưa đủ chống chạy song song khi overrun. Đối chứng legacy ACCEPTED nhả phần còn lại sau completion evidence. | Planner + Backend/Prisma |
| C5 · **CONFIRMED CONFLICT** · Driver Mobile/master | Server master `backend/src/driver-mobile/driver-mobile.controller.ts:54,65`, `service.ts:418,489` có accept/reject riêng với permission, version và lock. `mobile/src/DriverApp.tsx:20,212,231` dùng ACCEPTED ở luồng UI. Feature `driver-trip-workflow.ts:23,84` và Start giữ ASSIGNED theo contract mới. Tích hợp cùng app/API cần quyết định owner; giữ dữ liệu ACCEPTED lịch sử. | Web/master Driver + Mobile |
| C6 · **CONFIRMED CONFLICT** · Web Admin/auth/API | Feature `orders.controller.ts:27` dùng role + branch; G1 Confirm nhận body `expectedVersion` + UUID với receipt riêng. Web/master `backend/src/orders/orders.controller.ts:25–32` dùng `orders.write`, header idempotency, body `version` và client `parseOrder`; package manifest và phí trên master khác G1. Cần adapter contract và kiểm thử JWT/profile/Principal/permission/branch dùng chung. | Shared Backend + Web |
| C7 · **CONFIRMED CONFLICT** · Activity | Feature `backend/src/drivers/driver-activity.query.ts:27,64,72` lọc/đếm `COMPLETE_TRIP`; evidence Web yêu cầu `TRIP_COMPLETED`. Đổi writer trước reader sẽ bỏ KPI mới. Chọn một event chuẩn mỗi Trip trước lọc actor/kỳ. | Driver/Analytics |
| C8 · **CONFIRMED CONFLICT** · Git/Mobile | Master đã track 16 path Mobile feature đang untracked, 7 có nội dung khác. Cần plan hợp nhất Expo Router, entry point, config, lockfile và contract. Chưa merge hoặc test cây merge. | Mobile + maintainer master |
| P1 · **POTENTIAL CONFLICT** · Planner/Web metadata | Feature có giờ Branch/leave/vehicle downtime, Web có ca và readiness route. Chưa chứng minh dữ liệu ca/nghỉ/ready time/location đủ ở target. Feature planner có driver resource lock 4102, execution dùng trip 4201. Cần thống nhất lock order, kể cả roster, vehicle, reservation, overrun, cancellation/reassignment, snapshot version create/apply/publish. | Planner/Web/Backend |
| P2 · **POTENTIAL CONFLICT** · POD writer/history | Web fixture `backend/tests/monitor-test-app.cjs:94` ghi sizeBytes nhưng thiếu evidenceType, có scope/snapshot riêng. M3.5 `driver-pod.service.ts:374,430` ghi loại/kích thước và đi nhánh owner-null của trigger Web. Fixture/writer cũ cần cập nhật nếu còn dùng; chưa xác minh inventory triển khai. | Web/POD/DBA |
| P3 · **POTENTIAL CONFLICT** · Event/snapshot | Web `20261009090000_driver_trip_execution/migration.sql` yêu cầu snapshot cho `TRIP_STARTED`/`STOP_ARRIVED`; feature constants còn `START_TRIP`/`ARRIVE_STOP`. Không đổi tên Start/Arrive tùy tiện để tránh scope mở rộng. Owner chốt monitoring mapping, snapshot và history policy. | Driver/Web |
| K1 · **COMPATIBLE** · Driver/Mobile | Contract giữ ASSIGNED phù hợp lookup list/detail/history `driver-trips.service.ts:16,139,198`, `driver-trip-history.query.ts:56`, GPS/Incident/POD guard và các Mobile gate PRIMARY/RELIEF hiện có. Không chỉnh GPS runtime, retry/SQLite FIFO hoặc app restore. Đây là tương thích source/baseline, chưa nghiệm thu command/completion mới. | Driver/Mobile |
| K2 · **COMPATIBLE** · e-POD | Rehearsal Web có PHOTO/SIGNATURE upload, retry, double tap, replacement và history PASS khi đã có attempt hợp lệ. Complete thiếu PHOTO vẫn `POD_REQUIRED`. Giữ policy, storage và response. | Driver/POD |
| N1 · **NOT VERIFIED** · Release | Chưa chạy full ledger/schema prod clone, auth/Web/Planner với cây merge master mới, xác minh toàn bộ active writer, Android native build hoặc availability có ca/travel thật. Chưa có chữ ký owner. | Các owner |

[Orders](../../backend/src/orders/orders.controller.ts) · [Planner](../../backend/src/trips/trips.service.ts) · [Assignment schema](../../backend/prisma/schema.prisma) · [Activity query](../../backend/src/drivers/driver-activity.query.ts)

### Bằng chứng và cổng phát hành

Backend Jest **297/297**, PostgreSQL baseline disposable **76/76** (0 skipped), Nest build và ESLint **PASS**. Mobile Jest **461/461**, TypeScript và ESLint **PASS**. Probe PostgreSQL có DDL Web tái hiện CHECK `23514`, rollback và khoảng planned nối tiếp khi Trip trước chưa kết thúc. Đối chứng ACCEPTED cho thấy nhả phần lịch dự kiến khi evidence khớp. Đây là test trên schema tái tạo phần có liên quan, giữ FK/trigger; chưa áp dụng CHECK đề xuất. **Acceptance contract ASSIGNED, concurrent assignment/Start, availability ngày mai, Activity mới và merge integration NOT RUN.** Chi tiết raw probe nằm trong thư mục tạm của lượt audit. [Acceptance matrix](driver-assignment-availability-contract.md#6-acceptance-matrix)

- **Feature commit:** GO cho commit tài liệu bốn path được liệt kê ở staging plan khi người dùng cho phép. NO-GO cho commit gói Backend/Mobile tích hợp do migration/constraint và owner signoff.
- **Feature push:** NO-GO cho gói feature. Ref đích khớp HEAD; schema, contract dùng chung và acceptance còn mở.
- **Merge master:** NO-GO. Cần giải quyết branch contracts, 7 path Mobile khác nội dung, Planner/availability và migration chain rồi nghiệm thu cây hợp nhất.
- **Production migration/deploy:** NO-GO. Cần release runbook đã duyệt, ledger/checksum, inventory writer, đếm lại POD, rehearsal đầy đủ và xác nhận cutover release lịch.

Không sửa runtime, schema, migration hay index. Reviewer điền signoff ở mục 7. Các ref bên trên là snapshot audit ngày 24/11/2026.
