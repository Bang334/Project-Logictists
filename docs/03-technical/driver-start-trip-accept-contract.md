# Driver Start Trip = Accept + Start — SUPERSEDED

**SUPERSEDED · 24/11/2026.** Đề xuất chuyển sang `ACCEPTED` ở Start và yêu cầu `ACCEPTED` ở Complete đã bị hủy. Assignment giữ `ASSIGNED` trong luồng hiện hành. Toàn bộ nội dung bên dưới được giữ làm lịch sử, gồm tiêu chí và kết luận cũ. Dùng [Driver Assignment và Availability](driver-assignment-availability-contract.md) cho quyết định hiện hành.

## Contract Driver tại thời điểm đề xuất cũ

| Bước | Điều kiện | Hiệu ứng |
| --- | --- | --- |
| Start | Trip `DISPATCHED`, đúng version, đúng một assignment hiện hành của actor ở `PRIMARY/ASSIGNED` | Assignment sang `ACCEPTED`, Trip sang `IN_PROGRESS`, một start event và một receipt. Dùng nút và API Start hiện có. |
| Arrive/Complete Stop | Trip `IN_PROGRESS`, actor là PRIMARY đã nhận chuyến | Giữ thứ tự stop, version, payload offline và idempotency hiện hành. |
| Complete | Trip `IN_PROGRESS`, đúng version, `PRIMARY/ACCEPTED`, các stop/task/attempt và PHOTO đạt policy | Một `TRIP_COMPLETED` liên kết assignment và Trip trong cùng transaction. |
| RELIEF | Có assignment phù hợp phạm vi đọc | Đọc theo quyền hiện tại. Lệnh PRIMARY vẫn bị chặn. |

Giữ request `{ idempotencyKey, expectedTripVersion }` và response Start/Complete hiện có. Không thêm nút Accept. Status `ACCEPTED` trong response list/detail là thay đổi mà caller phải hỗ trợ khi rollout. Giữ `OrderStatus.ASSIGNED` hiện có của Order.

## Schema và ràng buộc đã kiểm tra

- `TripStatus` là enum gồm `DRAFT`, `PLANNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.
- `DriverAssignment.status` là `String` mặc định `ASSIGNED`. Local chưa có `actualEndTime`, `completionEventId` hoặc các trường phản hồi/version assignment của contract master. Baseline exclusion constraint giữ lịch cho `ASSIGNED` và `ACTIVE`. Bật `ACCEPTED` trên baseline này trước DDL tương thích sẽ làm assignment vừa nhận rời phạm vi chống trùng lịch ở cấp DB.
- DDL Web giữ lịch cho `ASSIGNED`, `ACCEPTED`, `ACTIVE` khi `actualEndTime IS NULL`. Cặp `actualEndTime` và `completionEventId` chỉ được set cùng nhau trên assignment `ACCEPTED`. Link completion phải trỏ event cùng Trip, cùng actor, đúng `payload.assignmentId` và cùng timestamp. Trigger assignment chạy ngay, trigger Trip completion kiểm ở cuối transaction. FK command cho attempt/event kiểm ngay khi ghi. DDL Web còn có check snapshot riêng khi dùng event tên `TRIP_STARTED` hoặc `STOP_ARRIVED`.
- Planner đang kiểm overlap theo driver, khung giờ và Trip status hoạt động trong các đường tạo/apply/publish đã rà soát. Cần kiểm chứng đồng nhất với constraint sau accept, và thời điểm trả lại khả dụng sau completion. Web Admin có nhãn ASSIGNED/ACCEPTED trong Trip Monitoring, cần duyệt timeline và feedback khi chưa nhận chuyến. Ref master còn có API accept/reject riêng với permission, `respondedAt`, CAS theo assignment version và Trip version. Cần chọn cách phối hợp endpoint, version và lock nếu hai luồng cùng tồn tại.
- Bắt buộc rà soát lịch sử `IN_PROGRESS + PRIMARY/ASSIGNED` ở đích trước khi bật guard mới. Ưu tiên để chuyến cũ hoàn thành bằng phiên bản tương thích trước cutover. Nếu không thể, dùng quy trình xử lý từng chuyến có bằng chứng Start và owner duyệt. Không chuyển hàng loạt hoặc tự nhận tại Complete.

[Prisma schema](../../backend/prisma/schema.prisma) · [Baseline migration](../../backend/prisma/migrations/20261001000000_demo_66_table_baseline/migration.sql) · [Planner/Trips](../../backend/src/trips/trips.service.ts)

## Thay đổi đề xuất theo transaction

1. **Command wrapper.** Giữ lock idempotency, hash và thứ tự kiểm replay. Sau khi khóa Trip theo protocol thống nhất với consumer, tạo `ProcessedCommand(PROCESSING)` trước mutation, rồi cập nhật chính hàng đó thành `COMPLETED` với receipt. Lỗi trong mutation hoặc khi deferred trigger chạy ở commit phải rollback mọi bản ghi. Retry cùng key/payload trả receipt đã commit và không lặp accept. Cùng key khác payload vẫn trả 409; hai key chạy song song chỉ một command thay đổi version.
2. **Start.** Xác định actor từ JWT, tìm assignment của đúng driver và Trip, kiểm role/status và CAS assignment theo ID + driver + Trip + `PRIMARY/ASSIGNED`. Nếu có nhiều PRIMARY đủ điều kiện hoặc CAS không cập nhật đúng một hàng, fail closed, trả conflict nghiệp vụ. Giữ 404 cho assignment ngoài phạm vi và `DRIVER_NOT_PRIMARY` cho RELIEF. Khóa và kiểm version Trip, cập nhật Trip khi còn `DISPATCHED`, ghi đúng một start event với `assignmentId`. Mọi bước trong một transaction. Chốt thứ tự lock với master/Planner vì master hiện khóa assignment trước khi share-lock Trip. Nếu giữ tên event Start hiện tại, phải chốt tương thích timeline/snapshot với Web; nếu đổi sang `TRIP_STARTED`, cần có snapshot đúng contract để qua check Web.
3. **Complete.** Xác nhận assignment `PRIMARY/ACCEPTED` và validate các guard hiện tại trước khi ghi. Sau khi reserve command, CAS Trip sang `COMPLETED` với `now` duy nhất, tạo một event `TRIP_COMPLETED` cùng actor/Trip/command và `payload.assignmentId`, cập nhật assignment với `completionEventId` và cùng `actualEndTime`. Thứ tự Trip → event → assignment đáp ứng trigger assignment kiểm ngay và trigger Trip kiểm cuối transaction. Không dùng completion để tự nhận chuyến.
4. **Activity.** Đọc lịch sử `COMPLETE_TRIP` và tên mới `TRIP_COMPLETED`. Chọn một event hoàn thành chuẩn trên mỗi Trip, ưu tiên bản ghi mới nếu có bằng chứng trùng, rồi mới áp dụng actor/khoảng thời gian. Kiểm tra riêng trường hợp các bản ghi cùng Trip nằm khác kỳ hoặc khác actor. Giữ KPI điểm dừng, giao hàng và coverage hiện có.

[Execution service](../../backend/src/trips/driver-trip-execution.service.ts) · [Command DTO](../../backend/src/trips/dto/driver-trip-command.dto.ts) · [Activity query](../../backend/src/drivers/driver-activity.query.ts)

## File dự kiến và dependency rollout

| Hạng mục | File/nhóm dự kiến | Owner cần duyệt |
| --- | --- | --- |
| Transaction và lifecycle | `backend/src/trips/driver-trip-execution.service.ts`, `driver-trip-execution.constants.ts`, execution unit và PostgreSQL suites | Backend Driver + Backend dùng chung |
| Schema và migration | `backend/prisma/schema.prisma`, migration mới/đường hòa hợp ledger nếu được duyệt | Backend/Prisma + Planner/Web |
| Read/authorization sau Start | `driver-trips.service.ts`, `driver-trip-history.query.ts`, `driver-pod.service.ts`, `driver-incidents.service.ts`, `driver-gps.service.ts`; các suite liên quan | Backend Driver + consumer |
| Activity | `backend/src/drivers/driver-activity.query.ts` và Driver PostgreSQL suite | Backend Driver/Activity |
| Mobile | `driver-trip-workflow.ts` và các gate screen/list/contact/Map/Incident/e-POD/Sync; account, GPS lifecycle/restore, offline replay/snapshot | Mobile owner |

Các reader Backend và Mobile hiện lọc chính xác `ASSIGNED`. Phải hỗ trợ `ACCEPTED` cho quyền phù hợp sau Start, đồng thời giữ ranh giới PRIMARY/RELIEF, trạng thái Trip, owner-scoped snapshot và backlog GPS sau completion. Thay đổi gate theo lifecycle đã duyệt; giữ engine GPS, SQLite FIFO, retry, payload/version và PHOTO/SIGNATURE. Sau Start cần refresh từ server để nhận trạng thái assignment. Trước khi bật chuyển trạng thái, ship consumer tương thích hoặc dùng rollout phối hợp đã duyệt để app cũ không tự khóa tài xế ở giữa chuyến.

DB owner cần chốt ledger thực tế và đường tới cùng schema trên clean DB lẫn đích đã có migration Web. Bổ sung Prisma projection/relations cho các trường completion trên đích đã có cột, giữ constraint history, FK và overlap. Dùng DDL thích hợp cho baseline thiếu cột/constraint, tránh add trùng ở đích đã có. Hòa hợp POD bằng việc tái sử dụng `sizeBytes`, thêm `evidenceType` nếu thiếu, siết `NOT NULL` sau khi đếm lại bảng rỗng và chặn writer. Không sửa migration đã chạy và không thêm `UNKNOWN` cho đích rỗng. Chưa có phê duyệt đường ledger/DDL. [Rehearsal M3.5](shared-backend-release-review.md#9-release-blocker-verification--23112026)

## Kiểm thử và cổng duyệt

| Acceptance mới trên DB disposable có đủ constraint đích | Kết quả |
| --- | --- |
| PRIMARY/ASSIGNED Start → ACCEPTED/IN_PROGRESS; replay cùng key một event/version; khác payload hoặc race trả 409 | NOT RUN · chưa triển khai proposal |
| Lỗi sau CAS, event/FK hoặc khi commit → rollback assignment, Trip và command; RELIEF/sai owner không mutation | NOT RUN · chưa triển khai proposal |
| COMPLETE_STOP tạo attempt dùng FK hợp lệ; retry một attempt | NOT RUN · chưa triển khai proposal |
| Complete đủ PHOTO tạo event/link/time đồng nhất; thiếu PHOTO giữ `POD_REQUIRED`; ASSIGNED bị chặn | NOT RUN · chưa triển khai proposal |
| Activity đọc cả hai tên event, không đếm trùng qua actor/kỳ; Planner không cho chồng lịch sau accept | NOT RUN · chưa triển khai proposal |
| Mobile không thêm nút; detail/list, e-POD, lịch sử, GPS, offline sync vẫn hoạt động với ACCEPTED | NOT RUN · chưa triển khai proposal |

**Baseline đã chạy lại** trên bản sao tách biệt. Backend Jest **297/297**, PostgreSQL disposable theo schema baseline **76/76**, Nest build và Backend ESLint **PASS**. Mobile Jest **461/461**, TypeScript và ESLint **PASS**. Rehearsal trước trên schema gắn ràng buộc Web có **20 POD test và 4 probe Execution đạt assertion**, gồm các lỗi FK và trigger đã tái hiện. Baseline và probe trước không nghiệm thu Start = Accept + Start.

**Kết luận lịch sử đã hết hiệu lực.** Proposal Accept + Start không còn được dùng cho triển khai hoặc release. Các điểm liên quan schema, ledger, event và phân lịch được chuyển sang [contract hiện hành](driver-assignment-availability-contract.md).
