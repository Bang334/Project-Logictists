# G1 — Contract xác nhận đơn vận chuyển của Customer

Ngày đối chiếu 22/11/2026 · **Contract đã duyệt cho Backend.**

Backend M2.3 đã triển khai Confirm và bảo vệ ghi cạnh tranh cho PATCH. [API hiện hành và bàn giao Web](api-contracts.md#m23--xác-nhận-đơn-customer-từ-web-admin) · [Bằng chứng kiểm thử](../04-testing/test-cases.md#g1--m23--backend-customer-order-confirmation)

G1 bổ sung bước điều phối xác nhận một đơn Customer đã tạo ở `DRAFT` và chứng minh đơn đủ điều kiện vào planner sau khi xác nhận. Phần Web Admin và G4 tiếp tục theo phân công nhóm. Quyết định nghiệp vụ Customer tạo `DRAFT` và ADMIN/DISPATCHER xác nhận qua thao tác riêng đã được ghi trong luồng Customer. Mục 1–2 ghi lại hiện trạng trước triển khai. Bảng ownership giữ các vai trò cần nhóm xác nhận. [Audit G0](graduation-requirements-coverage-audit.md) · [Luồng Customer](../02-business/customer-order-flow.md) · [API hiện hành](api-contracts.md)

## 1. Hiện trạng đã kiểm chứng

| Luồng | Endpoint, guard và service | UI và bằng chứng test |
| --- | --- | --- |
| Customer tạo và xem đơn | `GET /customer/branches`, `POST /customer/orders`, `GET /customer/orders`, `GET /customer/orders/:id` và `GET /customer/orders/:id/tracking` dùng JWT và `RolesGuard` với role `CUSTOMER`. Service lấy Customer theo `User.id` đã xác thực, lọc đọc theo ownership, kiểm tra Branch được chọn đang active và lưu `DRAFT` với items, pickup, delivery, totals, `ORDER_CREATED` có `source: CUSTOMER_APP` và command idempotency. | Mobile gọi API Customer và có badge `DRAFT` / `CONFIRMED`. Test PostgreSQL đã có cho tạo DRAFT, branch, idempotency, rollback và ownership đọc. [Controller](../../backend/src/orders/customer-orders.controller.ts) · [Branches](../../backend/src/orders/customer-branches.controller.ts) · [Service](../../backend/src/orders/customer-orders.service.ts) · [Mobile service](../../mobile/src/features/orders/services/orders.service.ts) · [Badge](../../mobile/src/features/orders/components/OrderStatusBadge.tsx) · [Test tạo](../../backend/test/orders/customer-create-order.postgres.spec.ts) · [Test đọc](../../backend/test/orders/customer-orders.postgres.spec.ts) |
| Web Admin tạo đơn mới | `POST /orders` dùng JWT, `RolesGuard` và role `ADMIN` / `DISPATCHER`. Service tạo thẳng `CONFIRMED`. ADMIN có thể dùng Branch từ request hoặc tài khoản theo contract hiện tại, DISPATCHER dùng Branch tài khoản. | Trang Orders dùng `ordersApi.create`. Đây là luồng **tạo đơn mới**, chưa kiểm chứng được bước duyệt một đơn Customer đã tồn tại. [Controller](../../backend/src/orders/orders.controller.ts) · [Service](../../backend/src/orders/orders.service.ts) · [OrdersPage](../../frontend/src/pages/OrdersPage.tsx) |
| Web Admin đọc và sửa | `GET /orders` hỗ trợ lọc trạng thái và branch scope. `GET /orders/:id` kiểm tra quyền đọc tài nguyên theo Branch. `PATCH /orders/:id` cho phép sửa hợp lệ ở `DRAFT` / `CONFIRMED`. Global validation từ chối field `status` ngoài DTO. JWT strategy kiểm tra tài khoản active và đọc role/branch hiện hành. | OrdersPage có lọc DRAFT và chỉnh sửa, kiểu Order đã có `version`. Test PostgreSQL xác minh ADMIN/DISPATCHER đọc theo quyền, DISPATCHER thiếu Branch bị chặn, PATCH hợp lệ và field `status` bị từ chối. [Auth](../../backend/src/auth/jwt.strategy.ts) · [Branch scope](../../backend/src/auth/branch-scope.ts) · [Web API client](../../frontend/src/api/client.ts) · [Web types](../../frontend/src/types/index.ts) · [Test authorization](../../backend/test/auth/transport-authorization.postgres.spec.ts) |
| Planner chọn đơn | `GET /orders/available-for-dispatch` liệt kê CONFIRMED theo phạm vi. Planner tự query `branchId` và `status: CONFIRMED`, sau đó lọc Package và dựng input. | Test Customer create chứng minh DRAFT vắng ở API available-for-dispatch. Test split planning và optimization jobs kiểm tra các phần riêng của planner, chưa chứng minh thao tác M2.3 đưa cùng Order vào snapshot mới. [TripsService](../../backend/src/trips/trips.service.ts) · [Test planner](../../backend/test/trips/trips.split-order-planning.spec.ts) · [Test jobs](../../backend/test/trips/optimization-jobs.postgres.spec.ts) |

## 2. Phần còn thiếu của M2.3

- Backend chưa có endpoint/service xác nhận DRAFT của Customer riêng. Web chưa có thao tác xác nhận trên đơn đó. Chưa có test nối Create DRAFT, xác nhận và eligibility của **cùng Order ID**.
- `PATCH /orders/:id` đọc trạng thái trước transaction, sau đó có thể thay Items/Stops và cập nhật Order theo ID mà chưa tăng version. Khi PATCH và xác nhận chạy song song, kiểm tra `expectedVersion` riêng ở endpoint xác nhận có thể duyệt một bản dữ liệu khác bản người điều phối đã xem. G1 cần nhóm duyệt cách phối hợp khóa và version ở cả hai đường ghi. [OrdersService.update](../../backend/src/orders/orders.service.ts)

## 3. API đã duyệt

**`POST /orders/:id/confirm`** với JWT, `RolesGuard`, `ADMIN` hoặc `DISPATCHER`. `:id` là UUID. Body chỉ nhận `expectedVersion` là JSON integer dương và `idempotencyKey` là UUID, theo validation whitelist hiện hành.

```json
{
  "expectedVersion": 1,
  "idempotencyKey": "d76baade-ecb1-42c3-ac69-f1284b1b13b1"
}
```

HTTP **200** trả thông tin lần xác nhận đã ghi nhận. Ví dụ sau lấy version tăng từ 1 lên 2.

```json
{
  "orderId": "e87916e7-0b20-462e-bcd4-ffa9f6f79b19",
  "orderNumber": "TMS-EXAMPLE-001",
  "status": "CONFIRMED",
  "version": 2,
  "confirmedAt": "2026-11-22T08:30:00.000Z"
}
```

| HTTP | Trường hợp |
| --- | --- |
| 400 | Path/body sai kiểu, version ngoài miền số nguyên biểu diễn được của trường hoặc có field thừa. |
| 401 | JWT thiếu, sai, hết hạn hoặc User inactive. |
| 403 | Role sai, DISPATCHER thiếu Branch hoặc Order nằm ở Branch khác. |
| 404 | Order ID hợp lệ nhưng Order không tồn tại. |
| 409 | `ORDER_VERSION_CONFLICT`, `ORDER_STATE_CONFLICT`, `ORDER_CONFIRM_IDEMPOTENCY_CONFLICT` hoặc `ORDER_NOT_CONFIRMABLE` nếu thiếu bằng chứng nguồn Customer hay đã tồn tại Package vật lý ngoài luồng đề xuất. |
| 422 | `ORDER_VALIDATION_FAILED` khi dữ liệu vận chuyển lưu sẵn không đạt, hoặc `ORDER_BRANCH_INACTIVE` nếu Branch đã ngừng hoạt động. |

Giữ envelope của exception filter gồm `statusCode`, `errorCode`, `message`, `timestamp`, `path`, `correlationId`. Các mã nghiệp vụ ở bảng là đề xuất. Nhánh từ chối dùng thông báo phù hợp cho điều phối, tránh đưa PII hoặc lỗi DB vào response. [HTTP exception filter](../../backend/src/common/filters/http-exception.filter.ts)

## 4. Authorization matrix

| Actor | Xác nhận | Phạm vi |
| --- | --- | --- |
| ADMIN active | Có | Branch của Order, theo quyền toàn hệ thống hiện tại. Branch của Order vẫn phải active. |
| DISPATCHER active, có Branch | Có trong Branch của mình | So Branch của tài khoản với Branch lưu trên Order. Branch khác trả 403. |
| DISPATCHER thiếu Branch | 403 | Fail closed. |
| CUSTOMER, DRIVER, STAFF và các role khác | 403 | Áp dụng cả khi Customer là chủ Order. |
| Không có phiên hợp lệ hoặc tài khoản inactive | 401 | JWT strategy hiện hành. |

Server lấy actor từ JWT đã xác thực và lấy Branch từ Order. Áp dụng lại quyền tài nguyên khi xử lý retry, kể cả khi đã lưu kết quả xác nhận. Đọc Customer list/detail/tracking vẫn theo Customer relation của JWT.

## 5. Chuyển trạng thái, dữ liệu và ghi nhận

1. **Điều kiện xác nhận.** Order đang ở `DRAFT`, loại `B2B_TRANSPORT`, có `OrderEvent` gốc `ORDER_CREATED` sang DRAFT với `source: CUSTOMER_APP`, có Customer liên kết và Branch active. Legacy DRAFT thiếu bằng chứng nguồn trả `ORDER_NOT_CONFIRMABLE` theo đề xuất. Kiểm tra version client khớp phiên bản đã lưu.
2. **Kiểm tra dữ liệu đã lưu.** Áp dụng quy tắc M2.2 cho đúng một pickup sequence 1 và một delivery sequence 2. Kiểm tra địa chỉ, tọa độ hữu hạn đúng miền, thông tin liên hệ theo DTO đã lưu và 1–20 loại kiện. Mỗi dòng có quantity nguyên 1–500, khối lượng mỗi kiện tính bằng `OrderItem.weightKg / quantity` trong miền (0, 1000] kg, kích thước dương với giới hạn 1000 × 300 × 300 cm. Tính lại totals để so với dữ liệu đã lưu theo đơn vị schema, dùng sai số phù hợp cho số thực và từ chối tổng hoặc giá trị chuyển sang đơn vị planner không hợp lệ. Trường giá chưa báo vẫn giữ giá trị hiện hành. [Customer DTOs](../../backend/src/orders/dto/) · [Prisma schema](../../backend/prisma/schema.prisma) · [Chuẩn hóa input planner](../../backend/src/trips/optimizer-payload.ts)
3. **Package policy đề xuất.** Customer DRAFT chuẩn chưa có `Package` vật lý. Nếu phát hiện bất kỳ Package đã tồn tại, kể cả bản ghi đã hủy, trả 409 để kiểm tra dữ liệu. Khi xác nhận hợp lệ, planner vẫn có thể dựng input từ OrderItem. Giữ việc materialize Package tại luồng apply hiện có.
4. **Từ chối duyệt.** Validation hoặc review không đạt thì giữ DRAFT và báo nguyên nhân có thể sửa. Điều phối kiểm tra thủ công khả năng phục vụ khi pickup khác khu vực vì chưa có service-area mapping. Luồng từ chối nghiệp vụ có trạng thái riêng, chuyển Branch, hủy đơn và chính sách giá thuộc quyết định riêng. Xác nhận có nghĩa đơn đủ điều kiện dữ liệu để xét lập kế hoạch, khả năng xếp xe được kiểm tra ở planner.
5. **Transaction và race.** Trong một transaction, khóa idempotency theo actor + command type + key theo pattern hiện hữu, khóa dòng Order trước khi đọc/kiểm tra dữ liệu, kiểm tra Branch active theo cùng phạm vi nhất quán với thao tác duyệt và thực hiện CAS theo ID + `DRAFT` + `expectedVersion`. Cập nhật thành `CONFIRMED` và tăng version một lần. Tạo `ProcessedCommand` loại đề xuất `CONFIRM_CUSTOMER_ORDER` và một `OrderEvent` loại `ORDER_CONFIRMED` liên kết command. Event lưu actor, trạng thái trước/sau, thời gian server/DB, Branch và version trước/sau. Dùng thời gian event làm `confirmedAt`. Nếu bất kỳ bước ghi nào lỗi, rollback cả ba phần.
6. **Retry.** Hash request chuẩn hóa gồm Order ID và expectedVersion. Cùng actor/key/hash và vẫn có quyền thì trả đúng receipt ban đầu, kể cả khi Order đã chuyển sang ASSIGNED. Web đọc lại Order để lấy trạng thái hiện hành. Cùng actor/key nhưng hash khác trả 409. Hai request cùng key/payload chỉ ghi một lần. Hai người dùng duyệt đồng thời, hoặc cùng người dùng đổi key, chỉ một request chuyển được DRAFT, request còn lại nhận `ORDER_STATE_CONFLICT`.
7. **Đồng bộ với PATCH.** Điều kiện triển khai đề xuất là PATCH khóa cùng dòng Order **trước khi** sửa Items/Stops, kiểm tra lại Branch, trạng thái và version đọc ở bước chuẩn bị, tăng version khi có thay đổi hiệu lực. Nếu bản ghi đổi trong lúc chuẩn bị, trả 409 và rollback. Một PATCH tuần tự đọc phiên bản mới của CONFIRMED vẫn theo quyền sửa hiện hành. Nhóm cần duyệt đồng thời trách nhiệm xử lý 409 trên Web và kiểm chứng version của planner.
8. **Migration.** Dự kiến tái sử dụng `Order.version`, unique key của `ProcessedCommand` và `OrderEvent.commandId` cùng actor, timestamp và payload sẵn có. Các loại command và event là chuỗi. Policy một lần chuyển DRAFT → CONFIRMED cùng CAS giải quyết cạnh tranh trong phạm vi này. Nhu cầu cột `confirmedAt` riêng hoặc vòng đời mở lại đơn cần thiết kế riêng. [Schema](../../backend/prisma/schema.prisma)

## 6. Planner integration

- Trước commit, query planner chỉ chọn CONFIRMED trong đúng Branch nên DRAFT bị loại. Sau commit, lần thu thập dữ liệu tiếp theo có thể lấy Order vừa duyệt. Planner hiện nhận đơn chưa có Package qua OrderItems. Với đơn đã có Package, logic hiện hành chỉ chấp nhận khi tập Package chưa hủy có ít nhất một phần tử và tất cả đều READY. G1 giữ nguyên logic đó.
- Snapshot mới phải chứa đúng `{id, version}` sau duyệt nếu Order hợp lệ và các điều kiện planner còn lại đã được chuẩn bị. Snapshot cũ giữ nguyên danh sách đã chụp. Apply đã có kiểm tra đối chiếu version. Nếu nội dung Order bị sửa sau khi chụp, version mới phải khiến apply từ chối snapshot cũ theo đường kiểm tra hiện hành.
- G1 chứng minh query/input hoặc snapshot builder nhận đúng đơn và đúng version. Xác nhận đơn không kích hoạt job tự động. Test riêng cần phân biệt danh sách available-for-dispatch với nguồn input planner thật. [TripsService](../../backend/src/trips/trips.service.ts) · [Optimizer payload](../../backend/src/trips/optimizer-payload.ts)

**Acceptance G4 đề xuất**

Customer tạo DRAFT → Admin thấy đúng Branch → xác nhận CONFIRMED → Planner nhận đơn hợp lệ → Generate candidate → Apply plan → Publish Trip → Driver nhận Trip → Pickup/Delivery → PHOTO e-POD → Complete Trip → Customer History/Tracking → Dashboard cập nhật. Theo dõi cùng Order ID qua tất cả các bước và liên kết Trip qua StopTask. Phạm vi nghiệm thu G1 kết thúc ở xác nhận và chứng minh eligibility cho planner.

## 7. Tests và fixtures đề xuất

Dùng fixture mới trên PostgreSQL local `127.0.0.1:55433/tms_auth_test`, gồm Branch A/B, Branch có thể chuyển inactive sau bước tạo, Customer owner và non-owner, hai ADMIN, DISPATCHER A/B và DISPATCHER chưa gán Branch. Tạo DRAFT chính qua `POST /customer/orders`. Chuẩn bị đủ depot, xe và tài xế hợp lệ cùng Branch trong test planner. Thay thế Matrix/solver ngoài ở tầng test nếu cần, vẫn chạy query và bước dựng input/snapshot thật.

| Tầng | Ca nghiệm thu |
| --- | --- |
| Unit | DTO chặn field lạ, version sai và key sai. Validator kiểm tra pickup/delivery, biên kiện, totals, quy đổi, Branch inactive, nguồn legacy và Package bất thường. Kiểm tra mapping receipt và audit actor/time. |
| PostgreSQL | DRAFT vắng trước duyệt, xuất hiện trong input/snapshot mới sau duyệt với version tăng đúng một, vắng ở Branch khác, snapshot cũ giữ nguyên. 401 và 403 đúng role/scope, 404 Order thiếu. Invalid DRAFT trả lỗi và giữ nguyên dữ liệu. |
| PostgreSQL concurrency | Hai ADMIN cùng duyệt, duplicate retry, replay sau đổi trạng thái, key với payload khác, stale version, race với PATCH theo cả hai thứ tự. Kiểm chứng chỉ một event và command ghi thành công. Fault khi ghi audit/command phải rollback toàn bộ. |
| Regression Web và Mobile | Web `POST /orders` vẫn tạo CONFIRMED. PATCH hợp lệ giữ request/response chính, field `status` vẫn bị chặn. Web vô hiệu hóa thao tác đang gửi, giữ key khi kết quả mạng chưa rõ và tải lại khi conflict. Mobile đọc CONFIRMED sau refresh, tài khoản khác vẫn nhận 404 ở Customer detail/tracking. |
| G4 E2E | Chạy chuỗi thật với solver, điều phối publish, Driver, e-POD, Customer và Dashboard. Ghi bằng chứng theo từng điểm giao giữa nhóm. |

Các ca G1/G4 trên là tiêu chí đề xuất. Lượt signoff này đối chiếu source và test hiện có, chưa chạy test cho operation mới.

## 8. Ownership cần xác nhận

| Khu vực | Chủ trì đề xuất | Xác nhận |
| --- | --- | --- |
| Customer Mobile và Customer API | Thành viên phụ trách Mobile Customer/Driver và API tương ứng, theo xác nhận M2.4. | Vai trò đã rõ. **OWNER TO CONFIRM** số thành viên vì hồ sơ gốc và member scope dùng cách đánh số khác nhau. |
| Web Admin | Thành viên phụ trách Web Admin, được người dùng nêu là thành viên 3 ở M2.4. | **OWNER TO CONFIRM** vì bảng phân công gốc gán Web cho thành viên 2. |
| Shared Backend Orders | Người được nhóm giao `POST /orders/:id/confirm`, phối hợp owner Orders cho khóa/version của PATCH. | **OWNER TO CONFIRM**. Việc sở hữu UI Web chưa tự xác định người sửa Backend dùng chung. |
| Planner integration | Thành viên phụ trách Planner/Dispatch theo kế hoạch người 1. | Đề nghị người phụ trách ký xác nhận input/snapshot, fixture và bằng chứng eligibility. |
| E2E QA | Một người tổng hợp bằng chứng G4, từng owner chạy phần mình và đối chiếu Order ID. | **OWNER TO CONFIRM** người tổng hợp và ký nghiệm thu. |

[Phân công gốc](../../PHAN_CONG_3_NGUOI.md) · [Phạm vi Mobile](../01-project-overview/member-2-scope.md) · [Kế hoạch Planner người 1](../../KE_HOACH_HOAN_THANH_NGUOI_1.md) · [Kế hoạch dự án](../../KE_HOACH_TMS.md)

## 9. Scope khi được duyệt triển khai

| Khu vực | Phạm vi đề xuất |
| --- | --- |
| Backend | OrdersModule, DTO, operation xác nhận, phối hợp bảo vệ race ở PATCH và tests local. Giữ nguyên contract tạo đơn Admin và Customer. |
| Web | Action xác nhận tại DRAFT, dùng `Order.version` có sẵn, xử lý submit, retry và conflict, tải lại list/detail. Phân quyền do server quyết định. |
| Mobile | Kiểm chứng list/detail/tracking hiện có sau refresh. Contract này giữ nguyên luồng tạo và đọc của Customer. |
| Planner | Thêm bằng chứng test về eligibility và tương thích snapshot thông qua luồng hiện tại. Các thay đổi thuật toán hoặc đổi API planner cần phê duyệt riêng. |

## 10. Điều kiện duyệt coding G1

- Chốt người chịu trách nhiệm cho Web, Backend dùng chung, bàn giao planner và QA G4.
- Duyệt API/HTTP semantics, đặc biệt retry receipt, 403 sai Branch, phạm vi giới hạn đến Customer DRAFT có audit nguồn và cách xử lý Package tồn tại.
- Duyệt cách chia sẻ khóa và version với PATCH, cách xử lý 409 trên Web, kế hoạch rollout và test cạnh tranh. Backend đã dùng khóa chung và hỗ trợ `expectedVersion` tùy chọn để Web chuyển đổi tương thích.
- Duyệt chính sách review Branch thủ công, kiểm tra dữ liệu lưu sẵn, dùng audit hiện có và tiêu chí bằng chứng planner trước/sau. Ghi nhận acceptance G4 riêng sau khi các bên có thể chạy toàn chuỗi.
