# Driver Assignment và Availability — contract hiện hành

**Nghiệp vụ Driver đã chốt ngày 24/11/2026.** Assignment giữ `ASSIGNED` trong luồng thực hiện chuyến. Phần DDL, Web, Planner, khả năng cung cấp dữ liệu và rollout vẫn chờ owner duyệt. [Proposal cũ đã thay thế](driver-start-trip-accept-contract.md) · [Release review](shared-backend-release-review.md)

**Snapshot feature hiện tại.** Start đã chặn hai chuyến chạy đồng thời cho cùng tài xế bằng khóa transaction theo actor và kiểm tra Trip `IN_PROGRESS`, kể cả khi hai khung dự kiến không chồng nhau. PostgreSQL regression đã tái hiện lỗi trên code cũ và PASS sau sửa. Availability đầy đủ, điều phối chuyến bổ sung, phối hợp lock với phân công và completion evidence vẫn là proposal. [Regression và quyết định lưu code](git-release-staging-plan.md)

## 1. Trip lifecycle

| Thao tác | Assignment của PRIMARY | Trip |
| --- | --- | --- |
| Điều phối phân công và phát hành | ASSIGNED | DISPATCHED khi đủ điều kiện |
| Start | ASSIGNED | IN_PROGRESS |
| Arrive Stop / Complete Stop | ASSIGNED | IN_PROGRESS |
| Upload e-POD | ASSIGNED | IN_PROGRESS trong happy path |
| Complete Trip | ASSIGNED | COMPLETED |

Giữ API và nút Start. RELIEF chỉ dùng phạm vi đọc hiện hành. Assignment lịch sử `ACCEPTED` và các trạng thái hợp lệ ngoài happy path được giữ theo nghiệp vụ của chúng. Contract này không thay đổi các đường đọc/xem POD lịch sử hoặc upload bổ sung đã được phê duyệt. Mọi thay đổi quyền terminal và các luồng ngoài happy path cần review riêng.

## 2. Availability theo thời gian

- Dùng khoảng nửa mở `[start,end)`, lưu mốc timezone-aware và xác định ngày làm việc bằng timezone của ca/chi nhánh đã được owner chọn. Một Trip chính/ngày là mặc định điều phối. Một Trip có thể phục vụ nhiều stop. Không thêm unique theo driver/day.
- Trip bổ sung cần xác nhận rõ từ điều phối viên đúng branch và dữ liệu đủ về giờ ca còn lại, nghỉ, hành trình tới điểm khởi hành, xe và lịch chưa hủy. Tính lại dưới lock ở lúc xác nhận, apply và publish; ghi actor, căn cứ và version. Khi thiếu đầu vào, có thể báo **không thấy chồng lịch**, nhưng giữ **chưa đủ dữ liệu để xác nhận khả dụng**.
- Trạng thái hiển thị đề xuất. `ON_TRIP` khi có vận hành thực tế đang mở; `SCHEDULED` khi giữ lịch trong khoảng hỏi; `OFF_DUTY` khi dữ liệu lịch xác nhận ngoài ca; `UNAVAILABLE` khi nghỉ hoặc có blocker đã biết; `AVAILABLE` chỉ khi đủ dữ liệu và qua toàn bộ điều kiện. Khi thiếu dữ liệu, trả coverage/reason riêng và không suy ra `AVAILABLE`. Availability ngày mai tính trên cửa sổ ngày mai. Một chuyến đang quá giờ có thể tạo rủi ro chưa rõ cho lịch tương lai; Start vẫn phải kiểm tra có chuyến mở theo thời gian thực. Giữ `Driver.status` cho điều kiện hồ sơ hiện có, không thêm `BUSY` làm nguồn chân lý phân lịch.

### Dữ liệu thực tế

| Dữ liệu | Bằng chứng và giới hạn |
| --- | --- |
| Ca làm | Feature có giờ hoạt động và timezone của Branch, có AttendanceEntry. Chưa có model `DriverShift` trong feature. Web Admin có `DriverShift` và `planning-calendar.ts` kiểm phủ ca; chưa xác minh dữ liệu đích đầy đủ cho mọi Driver. |
| Nghỉ phép | Feature có `EmployeeLeave` và liên kết `Driver.employeeId` nullable. Web calendar lọc nghỉ `APPROVED`. Thiếu liên kết/hồ sơ phải được phản ánh trong coverage. |
| Kế hoạch và actual | Trip có planned/actual. DriverAssignment feature có khoảng đặt lịch `startTime/endTime`, thiếu projection completion. Web DDL có `actualEndTime` và `completionEventId`. |
| Vị trí và hành trình | Feature có `GpsEvent` theo driver/trip, timestamp đo/nhận và freshness. Vị trí hiện trên Vehicle có thể thuộc Trip khác. Web có ready time/location theo ca và route-to-start qua Mapbox. Chưa chứng minh mọi chuyến bổ sung có điểm xuất phát, thời gian di chuyển và quy tắc nghỉ đủ tin cậy. |
| Xe và khoảng giữ lịch | Feature có Vehicle status, `VehicleUnavailability`, `ResourceReservation` và overlap theo planned Trip. Web calendar kiểm cả block xe và reservation. Cần kiểm tra các đường create/apply/publish và thời điểm nhả từng reservation. |

[Prisma schema](../../backend/prisma/schema.prisma) · [Planner/Trips](../../backend/src/trips/trips.service.ts) · [GPS](../../backend/src/trips/driver-gps.service.ts)

## 3. Bảo vệ lịch và concurrency

Đề xuất hai phép kiểm tra, dùng chung trên các đường ghi đã duyệt:

1. **Khoảng giữ lịch dự kiến.** Trip đã đặt lịch hợp lệ giữ khoảng dự kiến, kể cả trước Start. Tiếp tục dùng exclusion/ràng buộc tương đương cho assignment chưa giải phóng, với predicate dựa trên dấu mốc giải phóng hợp lệ ngoài trạng thái. Web hiện có `status IN (ASSIGNED, ACCEPTED, ACTIVE) AND actualEndTime IS NULL`. Giữ lịch sử planned/actual riêng. Cần quy tắc release reservation tương ứng để tránh trường hợp hoàn thành sớm mà reservation vẫn giữ phần dư.
2. **Vận hành đang mở.** Kiểm riêng assignment/Trip đang chạy theo Driver, gồm chuyến có `actualStartTime` và chưa kết thúc, kể cả đã qua plannedEndTime. Start và điều phối trực tiếp cho khoảng chồng vận hành phải fail closed. Một lịch tương lai đã đặt có thể vẫn hiện `SCHEDULED`, nhưng nếu chuyến trước chưa kết thúc, lịch kế tiếp không được Start và phải báo điều phối để dời/đổi người. Đánh giá bảo vệ DB bổ sung cho tối đa một vận hành mở theo driver nếu có writer khác; CHECK/index trên một bảng không tự đọc trạng thái Trip từ bảng khác.
3. **Giải phóng.** Complete sớm giải phóng phần dự kiến còn lại sau khi evidence cùng transaction đã commit. Chuyến mới chỉ được xét từ `actualEndTime` cộng nghỉ/di chuyển. Complete muộn giữ chặn chạy đồng thời cho tới lúc commit, sau đó đánh giá lại lịch sau theo actual. Hủy chuyến hoặc thu hồi/thay người giải phóng theo mutation được phép và cập nhật mọi reservation/occupancy liên quan. Không dùng thời gian completion giả cho hủy, không xóa assignment lịch sử.
4. **Serialize mọi writer.** Create/apply/publish/reassign/cancel/Start/Complete dùng giao thức lock cùng Driver, Trip row/version và assignment row/CAS. Planner đang dùng namespace driver `4102`, execution dùng trip `4201`; chọn thứ tự chung giữa các resource, kể cả nhiều driver/vehicle, và khóa trước khi re-read. Không dựa vào một lần validate snapshot ngoài transaction. Recheck đúng branch, resource, slot và `IN_PROGRESS` ngay trước ghi. Chuẩn hóa `409` khi race/exclusion, và giữ bản ghi command atomic. API accept/reject master nếu được giữ ở hệ dùng chung phải tuân cùng quy tắc.

## 4. Complete Trip và migration proposal

1. Giữ advisory lock và CAS hiện có, tạo `ProcessedCommand(PROCESSING)` trước các bản ghi tham chiếu. Sau mutation cập nhật cùng row thành `COMPLETED` với receipt. Retry cùng key/hash trả receipt đã commit. Lỗi trong mutation hoặc deferred trigger rollback toàn bộ.
2. Complete yêu cầu đúng `PRIMARY/ASSIGNED`, `IN_PROGRESS` và version. Kiểm stop/task/attempt và PHOTO `UPLOADED` còn hiệu lực trước khi đổi Trip. Dùng một timestamp. Ghi Trip `COMPLETED` và actual end, tiếp theo event `TRIP_COMPLETED` có `payload.assignmentId`, sau đó gắn `completionEventId` và `actualEndTime` vào cùng assignment. Giữ assignment `ASSIGNED`. Thứ tự này phù hợp với trigger assignment kiểm ngay và trigger Trip kiểm cuối transaction.
3. Tạo migration mới thay CHECK `driver_assignment_completion_pair` bằng predicate tương đương về cặp trường, chấp nhận thêm nhánh `role='PRIMARY' AND status='ASSIGNED'` cho completion mới. Giữ nhánh `ACCEPTED` hợp lệ của DDL cũ để bảo toàn lịch sử. Ví dụ logic: cả hai trường null, hoặc cả hai khác null và `(status='ACCEPTED' OR (role='PRIMARY' AND status='ASSIGNED'))`. Giữ FK unique completion link, mọi kiểm tra Trip/actor/assignment/timestamp, event uniqueness, history/POD triggers. Rà dữ liệu trước khi cài CHECK thay thế nguyên tử, triển khai sau phê duyệt. Explicitly giữ legacy `ACCEPTED` khỏi mọi backfill vô căn cứ.
4. Hòa hợp POD. Clean DB phải đến cùng schema và constraints thông qua chain chuẩn được duyệt. Đích Web đã có `sizeBytes integer NULL`, cần giữ cột đó, kiểm kiểu/enum và chốt ledger migration pending trước rollout. Trên đích đã kiểm đúng schema và bảng còn rỗng, thêm `evidenceType` với `PHOTO`/`SIGNATURE` và siết hai cột NOT NULL mà không giữ default tạm. Nếu có dữ liệu xuất hiện, dừng để đối soát writer/provenance. Không sửa migration đã áp dụng, tự ghi ledger, hoặc nối correction phía sau một pending migration chắc chắn lỗi trước.
5. Installer Prisma/schema phải đọc các cột completion có sẵn trên đích và tạo chúng có kiểm chứng trên baseline thiếu cột. Sinh client từ schema chuẩn rồi rollout Backend tương thích cùng writer. DDL/test phải chạy cả clean và bản sao đầy đủ của đích. Giữ storage mappings, retry, replacement và PHOTO policy.

[Execution service](../../backend/src/trips/driver-trip-execution.service.ts) · [POD service](../../backend/src/trips/driver-pod.service.ts) · [Bằng chứng FK/DDL](shared-backend-release-review.md)

## 5. API, file và consumer cần review

| Consumer | Tác động và file |
| --- | --- |
| Driver Backend | `backend/src/trips/driver-trip-execution.service.ts` và constants cần reserve command, liên kết completion, phối hợp lock. DTO Start/Complete và receipt hiện hành giữ shape. List/detail/history, GPS, Incident, POD và Mobile offline không cần `ACCEPTED` cho happy path. Điểm giao quyền terminal/historical cần regression. |
| Trip Activity | `backend/src/drivers/driver-activity.query.ts` hiện lọc `COMPLETE_TRIP`. Đọc thêm `TRIP_COMPLETED`, chọn một event hoàn thành có thẩm quyền trên mỗi Trip trước khi lọc actor/kỳ, để hai tên event hoặc khác kỳ không đếm hai lần. Cần owner xác nhận thứ tự ưu tiên ở dữ liệu trùng. |
| Planner/Web Admin | `backend/src/trips/trips.service.ts` và Web calendar/fleet/monitoring cần thống nhất overlap, reservation, điều kiện chuyến bổ sung, trạng thái hiển thị và start/complete evidence. `master` dùng flow accept/reject và version assignment riêng. Giữ UX nhánh này, quyết định tích hợp đồng thời thuộc owner. |
| Prisma | `backend/prisma/schema.prisma` và migration mới sau signoff, giữ cột/tables đã chạy và pooler/DB đúng đích. |
| Mobile | Start giữ UX hiện tại. Regression list/detail/history, RELIEF, POD readiness, GPS restore, offline SQLite FIFO và retry. Không thêm HR/shift module. |

## 6. Acceptance matrix

| Ca nghiệm thu trên bản sao có constraint đích | Tiêu chí | Trạng thái |
| --- | --- | --- |
| Start / retry / owner | ASSIGNED giữ nguyên, Trip IN_PROGRESS, một event/version. RELIEF và sai owner bị từ chối. | NOT RUN với contract mới |
| Arrive/Complete Stop / command | FK DeliveryAttempt hợp lệ, retry một attempt, stop/task/version đúng. | Hiện hành FAIL theo rehearsal `23503`; bản sửa NOT RUN |
| Complete đủ PHOTO / evidence | ASSIGNED giữ nguyên, đúng actor/assignment/event/time, đích giữ trigger. | Hiện hành FAIL; probe `23514` ở CHECK sau khi đã reserve command; bản sửa NOT RUN |
| Complete thiếu PHOTO | `POD_REQUIRED`, không đổi dữ liệu. | PASS trên bản tái tạo Web trước sửa; cần rerun sau sửa |
| Rollback và concurrent command | Lỗi FK/CHECK/deferred không ghi nửa chừng; cùng key replay, khác payload 409, race chỉ một mutation. | Probe rollback PASS trên constraint hiện hành; nghiệm thu race mới NOT RUN |
| Phân công concurrent / DISPATCHED | Hai điều phối viên tranh cùng slot chỉ một thành công; DISPATCHED giữ lịch. | Probe overlap đã chặn slot chồng; concurrent NOT RUN |
| IN_PROGRESS và hoàn thành muộn | Khung dự kiến nối tiếp có thể đặt nhưng Start sau bị chặn khi Trip cũ còn mở. | Probe thấy exclusion hiện hành nhận slot nối tiếp; guard mới NOT RUN |
| Hoàn thành sớm / giữ ASSIGNED | Nhả phần dư có evidence, bảo toàn lịch sử, kiểm ca/nghỉ/di chuyển và xác nhận điều phối. | Đối chứng SQL `ACCEPTED` nhả slot PASS; `ASSIGNED` sau sửa NOT RUN |
| Ngày mai / hủy hoặc thay người | Query đúng cửa sổ timezone, phân biệt thiếu dữ liệu; nhả đúng reservation, giữ lịch sử. | NOT RUN |
| Activity / Mobile ASSIGNED | KPI không đếm trùng, workflow, replay/restore, POD và GPS vẫn chạy. | Baseline PASS; nghiệm thu contract mới NOT RUN |

Baseline ngày 24/11/2026: Backend Jest **297/297**, PostgreSQL disposable **76/76**, Nest build và Backend ESLint PASS. Mobile Jest **461/461**, TypeScript và ESLint PASS. Probe PostgreSQL có constraint Web chạy trên phần DDL liên quan, không đại diện toàn bộ Supabase. Không chạy Android native build hoặc merge integration trong lượt này. [Chi tiết audit](shared-backend-release-review.md#11-final-pre-push-integration-audit--24112026)

## 7. Owner signoff

- **Backend/Prisma** · Duyệt CHECK chuyển tiếp, chain/ledger POD, FK/trigger, data inventory, writers và runbook auth/rollback.
- **Web Admin** · Duyệt monitoring, contract auth/branch, tương thích workflow assignment/POD, confirm chuyến bổ sung và Confirm/PATCH.
- **Planner** · Duyệt cơ chế giữ/nhả lịch và locks, ca/leave/readiness input, rest/travel rule, một Trip chính, xe, đồng thời create/apply/publish.
- **Mobile/Driver** · Duyệt smoke flow ASSIGNED, execution, GPS, offline restore và activity. Các ký duyệt ở trên vẫn **PENDING**.

GO cho contract Driver và tài liệu. NO-GO cho gói feature tích hợp, merge master và production rollout trước các phê duyệt/acceptance trên.
