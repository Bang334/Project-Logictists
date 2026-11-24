# M4.1.2A — Khảo sát mở rộng sản phẩm Driver

20/11/2026 · Hoàn thành khảo sát source · **ĐỀ XUẤT**, chờ duyệt trước khi triển khai.

**Đề xuất ưu tiên:** Trang chủ công việc, danh sách chuyến gọn và tài khoản chỉ đọc có thể dùng API hiện tại. Lịch tuần có thể thử cho tập chuyến đã tải, nhưng cần lọc theo khoảng ở server để dùng làm lịch đầy đủ. Xe và chi nhánh có model thực nhưng cần contract Driver trước khi hiện dữ liệu ngoài phạm vi chuyến. Hiệu suất cần định nghĩa chỉ số. Thông báo cá nhân và thu nhập thuộc phạm vi tương lai.

Ảnh tham chiếu có bốn khu vực **Trang chủ · Chuyến · Lịch · Tài khoản** và bốn ô shortcut. Dùng bố cục ưu tiên chuyến đang thực hiện ở đầu màn. Ở lát cắt đầu, chỉ hiện shortcut có đích sử dụng thật. Lịch, xe, hiệu suất và chi nhánh mở theo mức sẵn sàng bên dưới. Không đặt nút tròn giữa thanh điều hướng khi chưa xác định hành động có giá trị.

Căn cứ: [AGENTS](../../AGENTS.md), [Mobile AGENTS](../../mobile/AGENTS.md), [kế hoạch TMS](../../KE_HOACH_TMS.md) §6.3–6.7, §9, §11–13, [Blueprint M4.1.0–M4.1.3](mobile-ui-ux-audit-redesign.md), [API contracts](api-contracts.md), [Driver → Customer E2E](../04-testing/driver-customer-e2e-qa.md). Kết quả dưới đây dựa vào schema, mã nguồn và fixture trong repo. Dữ liệu đang chạy và thao tác Android chưa được đo ở lượt khảo sát này.

## 1. Audit UI Driver theo mã nguồn

Driver hiện vào cùng `DriverTripListScreen` từ `/` và `/trips`. Root dùng Expo Router protected group, Driver layout dùng Stack. Trip layout lồng một Stack và khởi tạo workspace theo tài khoản + Trip. Các màn M4.1.2 đã tách khỏi Overview. Chiều dài dưới đây đánh giá theo cây render. Đo theo màn hình thật thuộc QA của lát cắt triển khai.

| Màn hình và component | Phân cấp, mật độ và thao tác | Trạng thái, tiếp cận và cải thiện |
|---|---|---|
| List · `DriverTripListScreen`, `DriverTripCard` | Filter ngang và FlatList có kéo tải lại, tải thêm. Card lặp mã, xe, hai mốc kế hoạch, giờ bắt đầu thực tế nếu có, số stop và role/status. Chuyến đang chạy có trọng lượng thị giác tương đương chuyến cũ. Đăng xuất đang là action trên header. | Có loading, tải thêm, lỗi và rỗng. Khi lỗi và tập rỗng, banner lỗi có thể đi cùng thông điệp chưa có chuyến. Có label cho card và selected cho chip. Đề xuất card hai dòng thông tin chính, ưu tiên trạng thái và thời gian, tách lỗi/rỗng theo filter, chuyển đăng xuất về tài khoản và giữ cảnh báo queue. |
| Overview · `DriverTripDetailScreen`, `driver-trip-workflow` | Có progress và hành động chính gần đầu. Banner, hộp thiết bị, shortcut full-width, mục mở rộng và panel điều hướng tạo nhiều cụm cùng độ nổi. Chuyến nhiều stop giao có thể thêm một shortcut POD mỗi stop. | Có lỗi, retry, offline, trạng thái GPS/queue và tiến độ server/local. Giữ selector quyết định hành động. Gom shortcut phụ thành hàng ngắn, ưu tiên stop tiếp theo và gắn lý do chặn ngay cạnh CTA. Các link xem e-POD vẫn mở được từ stop đã giao. |
| Stop · `DriverStopExecutionScreen`, `DriverStopExecutionPanel` | Địa chỉ/liên hệ lên đầu, timing thu gọn. Hàng hóa được liệt kê rồi form thực thi lại render dữ liệu theo task. Scroll tăng theo số kiện. CTA Đã đến có thanh dưới riêng, xác nhận hoàn thành nằm theo form. | Có loading, ID sai, offline và nháp Back. Đặt planned/actual trong cùng hàng nhập lúc thực thi. Giữ chi tiết kiện có thể mở và giữ CTA thao tác trong tầm tay khi bàn phím mở. Duy trì validation số thực tế, lý do, người nhận và thứ tự stop. |
| Sự cố · `DriverTripIncidentsScreen`, `DriverIncidentPanel/Form/Card` | Danh sách có disclosure từng sự cố. Form modal có nhiều chip loại/mức độ/đơn và phần mô tả. Làm mới, tải thêm và tạo có thể chia trọng lượng rõ hơn. | Có rỗng, lỗi, tải thêm, offline giữ mô tả và chỉ đọc theo quyền. Nâng mức độ, giờ và trạng thái lên đầu card. Đặt mô tả/đơn liên quan phía sau mở rộng. Giữ thứ tự focus khi mở modal và trả về nút tạo. |
| Sync · `DriverTripSyncScreen`, `OfflineDriverQueuePanel` | Có khối tổng hợp rồi từng card lệnh. Nhiều dòng đã gửi làm dài màn; lỗi cần xử lý nằm lẫn với lệnh thông thường. | Có queue rỗng, đang gửi, mất mạng, conflict và thử lại. Gom nhóm **Cần xử lý / Đang chờ / Đã gửi** theo trạng thái thật. Hiện chú thích theo stop và lý do xử lý phù hợp. Giữ khả năng chạm tới lệnh xung đột, không tự bỏ hoặc sửa version. |
| e-POD · `DriverStopPodScreen`, `DriverPodPanel` | Danh sách file, viewer, thay/chụp, nháp ảnh, chữ ký và retry có thể chồng nhiều nút. Trạng thái PHOTO bắt buộc là ưu tiên nghiệp vụ. | Có quyền camera, lỗi upload/metadata, offline chỉ đọc và preview. Phân hai phần **Ảnh bắt buộc** và **Chữ ký tùy chọn**, CTA đổi theo giai đoạn chụp → xác nhận → tải lại. Nhãn rõ ảnh local, đang gửi, server đã nhận và ảnh đã thay. Giữ ký một ngón và viewer theo quyền. |
| Map · `DriverTripMapScreen`, `DriverTripMap`, `DriverNavigationPanel` | Mapbox dùng vùng cử chỉ riêng; phần dưới điều hướng, chú giải và cảnh báo có thể cuộn. Sơ đồ điểm dừng và tìm đường ngoài là hai mục đích. | Giữ phương án điều hướng khi tile lỗi, không có GPS hoặc tọa độ. Tóm tắt điểm đích ngay cạnh nút điều hướng, chuyển chú giải dài xuống phần mở rộng. Kiểm tra lại pinch, tap marker, cuộn footer và TalkBack. |
| Auth, tài khoản · `LoginScreen`, `SessionErrorScreen`, `DriverPlaceholderScreen` | Login chung có form và lỗi xác thực. `DriverPlaceholderScreen` tồn tại trong source nhưng landing Driver thực tế là Trip List. Chưa có route tài khoản/cài đặt Driver; mở Settings thiết bị hiện gắn với GPS. | Tách tài khoản từ `AuthProfile`, dùng cùng flow refresh và đăng xuất. Giữ lỗi phiên và luồng bảo vệ route. Cài đặt vị trí chỉ mở trang ứng dụng trong Android Settings theo thao tác của tài xế. |

Nguyên nhân chính là nhiều card dùng cùng cỡ chữ đậm, độ nổi và khoảng cách, CTA phụ được trình bày như nhiệm vụ chính, thời gian và trạng thái được lặp lại ở nhiều cấp, còn icon/affordance rải rác theo component. Màu và spacing đã có token dùng chung, nhưng typography và vai trò của nút chưa được chuẩn hóa. Ưu tiên rút đường đi từ mở app đến việc cần làm, thay dữ liệu lặp bằng disclosure và dùng một hành động chính theo ngữ cảnh. Giữ thao tác đủ lớn khi dùng ngoài trời hoặc đeo găng, kiểm tra chữ lớn và trạng thái bằng chữ cạnh màu.

## 2. Prisma model và nguồn dữ liệu

Nguồn chính: [schema Prisma](../../backend/prisma/schema.prisma). Phạm vi QA được xác minh từ seed và tài liệu, gồm `seed-driver-demo.ts`, `seed-driver-incident-qa.ts`, `seed-driver-customer-e2e-qa.ts` và test liên quan. Sự tồn tại của bảng hoặc fixture không đồng nghĩa có dữ liệu vận hành đầy đủ.

| Model | Field và quan hệ thực tế | Phạm vi Driver và ý nghĩa |
|---|---|---|
| `User` → `Driver` | User `username, fullName, role, phone?, email?, active, branchId?, locationId?`. `Driver.userId?` unique. | JWT xác định tài khoản. `User.active` là trạng thái đăng nhập. `User.branchId` là thuộc tính account, không dùng thay `Driver.homeBranchId`. |
| `Driver`, `DriverLicense`, `Employee` | Driver `fullName, phone, status, homeBranchId, licenseNumber, licenseClass, licenseExpiry, employeeId?`. DriverLicense theo `driverId` có category, hiệu lực, xác minh. Employee có `employeeCode, userId?, employmentStatus, branchId`. | Có hồ sơ nghiệp vụ, chưa có `Driver.code` độc lập. Employee code chỉ dùng khi liên kết thật và được duyệt công bố. UUID và số giấy tờ không dùng làm mã UI. Trạng thái Driver là operational snapshot, tách trạng thái account và việc đang lái thực tế. |
| `DriverAssignment` → `Trip` | `driverId, tripId, startTime, endTime, role, status`, có liên kết điểm bắt đầu/kết thúc theo schema. Trip có planned/actual start/end, status, `version, vehicleId, managingBranchId?`. | Phân công theo chuyến, có thể biểu diễn lịch nhiều ngày. Quyền list/detail hiện lọc ASSIGNED. Giờ Trip, giờ assignment và ca làm việc mang ý nghĩa riêng. |
| `TripStop`, `DeliveryAttempt`, `ExecutionEvent` | Stop có sequence, loại, status và planned/actual. Attempt có `tripStopId, attemptNumber, result, occurredAt, commandId` unique. ExecutionEvent có `actorUserId, tripId, tripStopId?, eventType, occurredAt, receivedAt, commandId` unique. | Có thể ghép người thao tác qua command ID giữa attempt và event. `TripStop.status` là trạng thái điểm của chuyến. Nếu muốn thống kê cá nhân phải dùng actor hoặc phạm vi assignment đã chốt. Driver detail chỉ trả attempt mới nhất ở mỗi stop. |
| `Vehicle`, `MaintenanceRecord`, `VehicleUnavailability` | Xe có biển số, model, loại, `payloadCapacityKg, volumeCapacityM3`, kích thước lòng thùng, status, `homeBranchId, homeDepotLocationId?` và snapshot vị trí. MaintenanceRecord có ngày bảo dưỡng, km, nội dung, chi phí, khuyến nghị tiếp theo. Unavailability biểu diễn khoảng không khả dụng. | `DriverAssignment → Trip → Vehicle` xác định xe của chuyến. Xe hiện dùng chỉ được diễn giải từ chuyến cụ thể. Xe của nhiều chuyến không suy ra quyền xem toàn đội xe, hồ sơ sửa chữa hay chi phí. |
| `Branch`, `Location` | Branch có code, tên, địa chỉ, tọa độ, phone?, timezone, giờ hoạt động, active và trường vận hành/chi phí. `Driver.homeBranch`, `Trip.managingBranch`, `Vehicle.homeBranch`, depot và account location là quan hệ riêng. | Mỗi nhãn trên UI phải ghi rõ **Chi nhánh quản lý tài xế**, **Chi nhánh điều phối chuyến** hoặc **Điểm xuất phát**. Branch giờ hoạt động không xác lập ngày làm, giờ lái hay ca trực cá nhân. |
| `Incident`, `IncidentOrder` | `tripId, driverId?, vehicleId?, reporterId, type, severity, status, occurredAt` và đơn liên quan. | Incident list của chuyến đọc theo assignment, có thể gồm báo cáo từ người khác trên cùng chuyến. Chỉ số cá nhân dùng `reporterId = JWT user`, đếm theo ID, không coi incident là lỗi của tài xế. |
| `DriverActivityEvent`, `WorkPolicy`, `AttendanceEntry`, `EmployeeLeave` | Event theo Driver và Trip tùy chọn, có nguồn và correction. Policy có hiệu lực/giới hạn. Chấm công/nghỉ theo Employee và approval. | Có nền dữ liệu HR, chưa thấy model roster ca làm và API lịch HR cá nhân. Không suy ra ca chính thức từ assignment hay thời gian app/GPS. Ngày rỗng chỉ ghi **Chưa có chuyến trong phạm vi lịch**. |
| `Notification`, `OutboxEvent` | Notification có `userId, tripId?, kind, payload, readAt, createdAt`. Outbox lưu sự kiện xuất bản. | Có chỗ lưu inbox, chưa thấy luồng cá nhân tạo thông báo phân công và API inbox Driver. Gateway branch/location không cung cấp visibility theo assignment. |
| `PayrollPeriod`, `PayrollRun`, `PayrollItem` | Period theo chi nhánh, khoảng kỳ và `payDate?`. Run có `DRAFT/CALCULATED/APPROVED/PAID/CANCELLED`, duyệt và `paidAt?`. Item theo Run + Employee, Driver tùy chọn, có base/trip/allowance/overtime/deduction/net, currency, calculationSnapshot. Driver có `fixedSalaryMonthly, tripBasePay, perKmPay`. | Có cấu trúc lưu kỳ và cấu phần lương. `compensationPolicyId` trên item là field nullable, không tìm thấy model policy lương tương ứng trong schema. `PaymentTransaction` gắn Order. Không dùng thanh toán đơn/chi phí Trip để suy ra tiền đã trả cho Driver. |

## 3. API đang dùng và khoảng trống

API tóm tắt từ NestJS controllers, service selects và DTO. Không thấy cache ứng dụng khai báo trên các endpoint Driver khảo sát. List Mobile giữ dữ liệu trong state và fetch lại khi focus; đây chưa phải cache lịch offline lâu dài. Scoped routes dùng JWT + RolesGuard DRIVER trừ endpoint Profile chung và API vận hành trong bảng.

| Endpoint hiện có | Quyền, phạm vi | Contract, phân trang và tái sử dụng |
|---|---|---|
| `POST /auth/login`, `GET /auth/profile` | Login kiểm tra active. Profile xác thực JWT và đọc theo user ID của phiên. | Profile trả `id, username, fullName, role, phone, email, active, branchId, locationId, customer`. Không có projection Driver/employee/license/branch detail. Dùng thông tin account, refresh và logout hiện có. |
| `GET /driver/trips` | `Driver.userId = JWT.sub`, assignment ASSIGNED. Có thể đọc cả vai trò ngoài PRIMARY nếu còn được phân công. Thiếu profile trả conflict. | `status` tùy chọn trong DISPATCHED/IN_PROGRESS/COMPLETED/CANCELLED; `page` mặc định 1, `limit` 20, tối đa 100. `items/page/limit/total/totalPages`; sắp plannedStartTime rồi id tăng dần. Mỗi item có lịch, status/version, xe `id/plateNumber/model/vehicleType`, một assignment của Driver và stopCount. Không có date range, branch, tải trọng hay tiến độ đã xử lý trong list. |
| `GET /driver/trips/:id` | Cùng phạm vi list và UUID hợp lệ. Trip ngoài assignment/visibility không trả chi tiết. | Bổ sung stops theo sequence, liên hệ, tọa độ, thời gian, tasks/kiện và attempt mới nhất mỗi stop. Dùng cho Overview, chi tiết lịch và xe trong phạm vi Trip. Không dùng gọi lần lượt mọi Trip để tính thống kê. |
| `POST /driver/trips/:id/start`, `POST /driver/trips/:id/complete`, `POST /driver/trips/:tripId/stops/:stopId/{arrive,complete}` | PRIMARY/ASSIGNED, trạng thái, thứ tự stop, version và idempotency do service kiểm tra. | Command DTO/response chứa trạng thái/tiến độ Trip hoặc stop theo command và dữ liệu execution liên quan. Offline queue xử lý lệnh stop. Home chỉ đưa đến Overview, nơi thực hiện lệnh theo luồng hiện tại. |
| `POST /driver/trips/:tripId/gps` | Kiểm tra Driver/assignment và trạng thái tracking ở service. | Batch điểm, metadata session, số điểm chấp nhận theo response. Home/Overview dùng snapshot tracking của Mobile, tránh gọi latest GPS của API vận hành để dựng dashboard. |
| `GET/POST /driver/trips/:tripId/incidents`, `GET …/incidents/:incidentId` | Đọc theo assignment ASSIGNED và trạng thái cho phép. Tạo chỉ PRIMARY trên DISPATCHED/IN_PROGRESS. | List lọc type/status, page/limit, thứ tự occurredAt/id giảm. DTO tóm tắt loại, độ nghiêm trọng, trạng thái, mô tả, kết quả xử lý và đơn bị ảnh hưởng. Tạo có idempotency. List theo Trip, chưa phải thống kê báo cáo cá nhân. |
| `GET/POST /driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod`, `GET …/pod/:podFileId/view` | Khớp Driver PRIMARY/ASSIGNED → Trip → Delivery Stop → Attempt; thêm bằng chứng ở Trip đang thực hiện, xem theo policy ở Trip hoàn thành. | GET collection trả requirements và metadata file theo attempt. POST upload theo DTO và key; view theo ID file, dùng URL có thời hạn. Có thể dùng nguyên màn hiện có. Không lấy URL ảnh lên dashboard. |
| `GET /drivers/:id`, `GET /vehicles/:id`, `GET /branches/:id` và list tương ứng | ADMIN/DISPATCHER, service quản lý scope vận hành. Driver không có quyền. | Chỉ tham chiếu để hiểu model. DTO self-service phải là projection riêng và dùng JWT/assignment. |
| Socket.IO gateway | Có room user/branch/location, có phát `trip:updated` ở cấp branch. | Chưa xác minh event phân công cá nhân, replay inbox, trạng thái đã đọc hay push trên Mobile. Subscription cấp branch không dùng làm nguồn Driver Home. |

Code tham chiếu: [Driver trip select](../../backend/src/trips/driver-trips.service.ts), [Trip query DTO](../../backend/src/trips/dto/query-driver-trips.dto.ts), [Auth profile](../../backend/src/auth/auth.service.ts), [Incident service](../../backend/src/trips/driver-incidents.service.ts), [POD service](../../backend/src/trips/driver-pod.service.ts), [Events gateway](../../backend/src/events/events.gateway.ts).

## 4. Driver feature inventory, độ sẵn sàng và chi phí

**A** · Có thể làm lát cắt hữu ích bằng contract hiện có. **B** · Có một phần dữ liệu, bản đầy đủ cần sửa projection hoặc thêm API scoped. **C** · Có nền schema/event, cần thêm định nghĩa và contract. **D** · Chưa đủ điều kiện phát hành tính năng. Ưu tiên sản phẩm P0/P1/P2 độc lập với độ sẵn sàng.

| Module | Mức / ưu tiên | Dữ liệu thật, QA và điều kiện | Chi phí / lợi ích, migration |
|---|---|---|---|
| A. Home Dashboard | **A · P0** | Trip list filter IN_PROGRESS, detail một chuyến nếu chọn rõ, account và queue/GPS snapshot. QA có Trip thật ở các fixture Driver; có thể dùng Trip đã hoàn thành làm ca xem lại và một Trip QA riêng cho active. | Vừa / cao. Dùng API hiện có. Xử lý 0/1/nhiều chuyến; preview tiến độ chỉ khi có detail. Không cần migration. |
| B. Profile / Account | **A account, B nghiệp vụ · P0/P1** | Account từ /auth/profile. QA có account liên kết Driver, họ tên/số điện thoại/bằng/hồ sơ trong seed. UI nghiệp vụ thiếu self endpoint. | Thấp / cao cho tài khoản. Profile nghiệp vụ cần projection Driver và hợp nhất dữ liệu theo chủ sở hữu. Không cần migration cho các field hiện có. |
| C. Lịch tuần | **B · P1** | Khoảng giờ từ assignment, planned/actual Trip. Fixture có lịch phân công, chưa xác minh ca nghỉ, ca qua tuần và timezone khác nhau đủ phủ. API chưa lọc khoảng. | Vừa / cao. Có thể thử danh sách theo ngày trên dữ liệu đã tải với nhãn phạm vi; lịch đầy đủ cần server query. Không cần migration cho lịch chuyến. Roster/ca riêng cần khảo sát thêm. |
| D. Xe phân công | **A theo Trip, B hồ sơ xe · P1** | Biển số/model/loại từ Trip. Có tải trọng, status, bảo trì trong schema; các fixture demo/E2E có xe. Chưa xác minh fixture lịch sử bảo trì phục vụ Driver. | Thấp / vừa cho thẻ xe. Hồ sơ mở rộng cần scope theo Trip và allowlist, chưa có nhu cầu hiển thị toàn bộ lịch sử sửa chữa. Không cần migration cho phần đọc hiện hữu. |
| E. Chi nhánh | **B · P1** | Driver và Trip có quan hệ khác nhau. Seed có QA branch. Contract Driver thiếu thông tin địa chỉ/liên hệ và loại quan hệ. | Thấp–vừa / vừa. Cần read projection. Không cần migration cho chi nhánh quản lý và điều phối. |
| F. Hiệu suất | **C · P1 sau khi duyệt** | Có assignment, Trip, execution, attempt, incident. Fixture M4.0/M4.1.1 và incident có case đơn lẻ, chưa đủ ngày/actor/trạng thái để đối soát KPI. | Vừa–cao / có giá trị khi có kỳ so sánh đúng. Cần aggregate server theo actor/kỳ. Query hiện hữu có thể dùng trước, chỉ đánh giá index sau đo. |
| G. Thông báo | **C · P2** | Có Notification và gateway. Chưa thấy inbox/read API Driver, publisher phân công theo người nhận hoặc fixture inbox chuyên biệt trong phạm vi khảo sát. | Cao / vừa. Cần danh mục event, người nhận, chống trùng và bảo mật payload. Inbox có thể tận dụng model. Push delivery/token/receipt có thể cần schema sau duyệt. |
| H. Thu nhập | **D · P2, NOT READY** | Schema kỳ/chạy lương/phiếu + giá đầu vào Driver. Chưa xác minh payroll run API, policy tính, payslip self-read hay fixture payroll Driver đủ dữ liệu. | Cao / ngoài MVP. Cần HR chốt công thức, duyệt/công bố và quyền trước; migration chỉ sau thiết kế nếu thiếu policy, phiếu phát hành hoặc bằng chứng chi trả. |
| I. Lịch sử chuyến | **A cho phần còn ASSIGNED, B toàn bộ lịch sử · P0/P1** | Filter COMPLETED hiện trả các chuyến còn assignment `ASSIGNED` của tài xế. Hai chuyến M4.0 và fixture M4.1.1 đã hoàn thành dùng xem lại. | Thấp / cao cho lịch sử hiện thấy. Nếu muốn chuyến đã RELEASED/reassigned cần policy và API lịch sử riêng; giữ ranh giới đọc hiện hành. |
| J. Cài đặt / hỗ trợ | **A vị trí và phiên, C hỗ trợ vận hành · P0/P2** | Có trạng thái GPS và mở cài đặt thiết bị; auth lỗi có thử lại. Chưa thấy API contact/support Driver, preference thông báo hoặc fixture tương ứng. | Thấp / vừa cho Settings cơ bản. Kênh hỗ trợ và tùy chọn notification cần nguồn đã duyệt. Không giả lập hotline hoặc trạng thái push. |

## 5. Contract đề xuất và các quyết định nghiệp vụ

Tất cả endpoint trong bảng dưới là **đề xuất**. Mobile gửi yêu cầu qua API Backend, dựa vào JWT và quan hệ dữ liệu của tài xế đăng nhập.

| Nhu cầu | Contract tối thiểu | Giới hạn |
|---|---|---|
| Hồ sơ nghiệp vụ và chi nhánh quản lý | `GET /driver/me` hoặc DTO self-service tương đương. Trả operational status, chi nhánh nhà `code/name/address/phone/timezone` và thông tin bằng lái đã duyệt. | Source account cho email/username/active. Điện thoại nghiệp vụ ghi nhãn nếu hiển thị riêng. Ưu tiên hạng/hạn bằng, mask số nếu cần. Chưa có edit. Account offline chỉ hiển thị snapshot còn trong phiên. |
| Lịch tuần | Thêm `from/to` vào list theo semantics rõ hoặc route `GET /driver/schedule`. Trả items phân trang, múi giờ và giờ assignment. | Chọn theo giao khoảng `startTime < to AND endTime > from` trên cùng assignment của Driver. Dùng khoảng nửa mở, mốc tuần theo timezone nghiệp vụ do nhóm chốt. Chuyến qua đêm có thể xuất hiện ở hai ngày với cùng trip ID. Dùng ngày/giờ assignment để hiển thị lịch cá nhân. Ca chính thức, nghỉ/duyệt phép và giờ tuân thủ dùng contract HR riêng. |
| Xe và chi nhánh điều phối | Mở rộng Driver trip detail bằng projection đã giới hạn hoặc endpoint con theo Trip. | Đọc xe trong assignment còn quyền. Nhãn tải trọng thiết kế dùng kg. Vehicle.status là trạng thái xe toàn cục tại lúc đọc. Lịch sử xe cá nhân lấy từ Trip theo phạm vi lịch sử đã duyệt. Chỉ cung cấp thông tin bảo trì cần cho vận hành nếu có chính sách quyền. |
| Hiệu suất | `GET /driver/me/activity-summary?from=&to=` trả `range/timezone/asOf` và số đếm do server tính. | Phạm vi actor cho event/incident và assignment cho lịch. Không đếm dữ liệu pending local. Nếu chưa có dữ liệu, phân biệt số 0 đã đo và thiếu phạm vi thống kê. Không xếp hạng nhân sự trước khi có định nghĩa. |
| Lịch sử đầy đủ | API lịch sử riêng hoặc bộ lọc cùng quyền đã chốt. | Với assignment đã kết thúc/released, phải định nghĩa ai giữ quyền xem trip snapshot, POD và thông tin liên hệ. Tránh mở quyền trở lại cho các chi tiết ngoài nhu cầu. |
| Inbox | `GET /driver/notifications` phân trang theo cursor ổn định, thao tác đánh dấu đọc theo tài khoản và nguồn event phát hành. | Chỉ `Notification.userId = JWT.sub`. Loại đề xuất: phân công mới, thay thời gian, thu hồi phân công. Xác định dedup/event ID, tap mở Trip có kiểm tra lại quyền, payload tối thiểu. Push là lát cắt riêng. |
| Payroll | `GET /driver/me/payslips`, detail theo kỳ, chỉ sau policy phát hành. | Authorize qua chuỗi Driver/Employee của user, quy tắc khi quan hệ trống hoặc bất nhất, chỉ bản chính thức được duyệt công bố. Dùng tổng tiền của phiếu đã chốt, không nhân số chuyến với giá giả định. Quyết định riêng về thưởng, phạt, phụ cấp, làm thêm, cách làm tròn, kỳ và bằng chứng trả. |

**Phân loại thông tin Profile.** Hiển thị ngay họ tên, điện thoại và email của account nếu có. Cho phép xem lại tên đăng nhập, đăng xuất và cài đặt vị trí khi người dùng mở trang. Mã tài xế, trạng thái làm việc, hạng/hạn bằng và chi nhánh thuộc hồ sơ nghiệp vụ. Xe hiện dùng là xe của một chuyến cụ thể. Quyền thông báo chỉ có ý nghĩa khi có tính năng notification. Số giấy tờ, lương và cập nhật profile cần quyết định quyền riêng.

**Quy ước số đếm đề xuất.** Dùng `[from,to)` theo timezone nghiệp vụ, distinct ID tại DB trước khi trả số. Nêu rõ khoảng đo và mốc thời gian mỗi chỉ số. Event dùng `occurredAt` cho ngày thao tác thực và `receivedAt` cho chẩn đoán dữ liệu đến trễ. Rà lại khi đồng bộ offline bổ sung kết quả trong kỳ.

| Chỉ số | Nguồn, công thức và phạm vi |
|---|---|
| Chuyến được phân công trong kỳ | Distinct Trip ID từ assignment của Driver giao khoảng kỳ; trạng thái nào được tính và có gồm CANCELLED/RELEASED cần chốt. Nếu muốn chỉ số **phân công mới**, cần event/mốc phát hành riêng thay cho giờ chuyến. |
| Chuyến hoàn thành | Distinct Trip với `COMPLETE_TRIP` do JWT user thực hiện trong kỳ. Nếu muốn đếm chuyến tham gia đã hoàn thành, cần định nghĩa riêng theo trạng thái Trip và assignment của người tham gia. |
| Điểm đã xử lý | Distinct `tripStopId` từ event hoàn tất kho/pickup/delivery hoặc ghi nhận thất bại do actor. Dùng cả event thất bại nếu nhãn là **điểm đã xử lý**, ghi rõ kho có được tính. Loại `ARRIVE_STOP`, stop chỉ pending hoặc skipped khỏi số đã thao tác. |
| Giao thành công / một phần / thất bại | Đếm distinct DeliveryAttempt ID theo `result` lần lượt SUCCESS/PARTIAL/FAILED. Join `commandId` với ExecutionEvent của actor. Dùng từng lần giao nên retry idempotent không thêm lượt. Nếu cần chỉ số theo điểm/đơn, định nghĩa tổng hợp khác; phân loại PARTIAL riêng. |
| Sự cố đã báo | Distinct Incident ID với `reporterId` là user của tài xế, lọc `occurredAt`. Không lấy tổng tất cả sự cố trên Trip. |

**Thu nhập.** Schema có giá đầu vào theo chuyến/km và bảng kỳ/phiếu, nhưng khảo sát chưa thấy chính sách có hiệu lực về công thức, thưởng/phạt/phụ cấp, phát hành phiếu, chứng từ trả tiền và quyền Driver đọc. Trạng thái **NOT READY**. Không mở shortcut cho đến khi có contract và QA cho kỳ đã duyệt, kỳ chi trả và truy cập sai chủ.

## 6. Navigation Architecture

| Phương án | Ưu điểm | Chi phí và lúc phù hợp |
|---|---|---|
| Stack only theo luồng hiện tại | Back và deep link đơn giản, giữ không gian dọc, ít thay đổi workspace. | Danh sách tiếp tục gánh luôn nhiệm vụ của Landing và Tài khoản. Hợp nếu phạm vi vẫn chủ yếu là chuyến. |
| Bottom Tabs + nested Stack | Chuyển nhanh Trang chủ/Chuyến/Lịch/Tài khoản khi cả bốn là điểm đến thường dùng. | Thêm lịch sử Back theo tab, focus, request và khả năng giữ nhiều màn trong bộ nhớ. Dùng khi lịch đầy đủ và đủ nhu cầu; Stop, Map, e-POD và modal chặn nháp nên mở ngoài thanh tab qua Trip stack. |
| Dashboard + contextual shortcuts trong Stack | Đưa việc cần làm lên đầu, đưa tài khoản/xe/lịch vào đúng ngữ cảnh. Giữ các deep link hiện hữu. | Cần xử lý Home 0/1/nhiều chuyến, phân biệt loading/empty/lỗi. Với API hiện có, đây là bước ít chi phí nhất để kiểm chứng nhu cầu trước khi cân nhắc tabs. |

**Đề xuất MVP:** Driver dùng Dashboard + Stack. Nếu dữ liệu cho thấy đổi qua lại giữa bốn khu vực thường xuyên và lịch tuần có API đầy đủ, mới duyệt tab. Expo Router hỗ trợ lồng Stack/Tabs và guard client. Backend giữ quyền đọc/mutation thực tế. [Expo Router nesting](https://docs.expo.dev/router/advanced/nesting-navigators/) · [Expo Router protected routes](https://docs.expo.dev/router/advanced/protected/)

```text
(driver)/_layout                      Stack đã bảo vệ theo role
  index                               /                       Driver Home
  trips/index                         /trips                  List và filter lịch sử
  trips/[id]/_layout                  Trip workspace theo user + id
    index                             /trips/:id              Overview
    stops/[stopId]                    /trips/:id/stops/:sid
    stops/[stopId]/pod                /trips/:id/stops/:sid/pod
    map | incidents | sync           Các route Trip hiện có
    vehicle                           /trips/:id/vehicle     Khi cần màn xe riêng
    branch                            /trips/:id/branch      Sau contract điều phối
  account/index                       /account                Hồ sơ và cài đặt
  account/branch                      /account/branch         Sau contract home branch
  schedule                            /schedule               Sau query lịch
  performance                         /performance            Sau contract chỉ số
```

Mở từ Home tới Overview qua một instance đã scoped, Back về nguồn vào cả từ List và lịch. Nếu thử Tabs sau MVP, chỉ những trang gốc ở tab; route Trip làm sibling stack để Map/Stop giữ chiều cao và nháp. Giữ GPS/offline lifecycle ở root và auth guard ngoài mọi route Driver. Không remount workspace bằng key của tab.

## 7. Design system đề xuất

| Thành phần | Hướng thiết kế |
|---|---|
| Palette và ý nghĩa | Giữ primary `#1456D9`, text `#172033`, nền `#F4F7FB` và trắng. Thành công xanh, cảnh báo amber tối trên nền nhạt, lỗi đỏ, thông tin xanh, trạng thái chưa biết trung tính. Mỗi chip có chữ. Không dùng một màu cho cả thành công server và chờ đồng bộ. Kiểm tra tương phản ở theme và chữ lớn trên thiết bị. |
| Typography, spacing | Dùng font hệ thống. Bậc đề xuất 24/30 tiêu đề, 18/24 phần, 16/22 hành động/nội dung chính, 14/20 metadata. Giữ scale spacing của app ở cấp giao diện: 6/10/16/24/32, gom label/value, card chỉ tách khi chuyển chủ đề. |
| Cards và CTA | Ưu tiên chủ đề theo một trục nhìn: trạng thái → việc hiện tại → hành động. Card chuyến hiển thị mã, status và khung giờ/xe. Primary full-width cho hành động tiếp tục, đến điểm hay xác nhận trong ngữ cảnh; secondary gọn và mở rộng khi cần. Bottom action bar tính safe area và keyboard; lý do khóa đặt gần hành động. |
| Icons và navigation bar | Kiểm kê icon đã dùng trước. Một bộ nét đồng nhất nếu workspace đã có, giữ nhãn chữ cho các đích chính. Vùng chạm tối thiểu đề xuất 48×48 dp, icon có thể nhỏ hơn. Tab tương lai gồm icon + tên đích, trạng thái chọn dễ nhận biết, giữ an toàn Back trên Android. [Android accessibility](https://developer.android.com/guide/topics/ui/accessibility/apps) |
| Stepper, GPS và sync | Timeline theo sequence và nhãn rõ: chưa đến, đang xử lý, local chờ, server xác nhận, bỏ qua. Hiện số xác nhận và số chờ riêng. GPS chip gồm kết nối/quyền/độ mới, sync chip gồm số pending/lỗi, dẫn tới màn tương ứng. |
| Calendar, metrics, vehicle, profile | Lịch tuần dùng hàng ngày và agenda đọc từ trên xuống, có timezone và chuyến qua ngày. Metrics có kỳ, đơn vị và tooltip/cách tính. Thẻ xe gồm biển số, loại, Trip đang tham chiếu. Profile header ưu tiên tên, role và nhóm account/operational rõ. |
| Incident severity, tải và lỗi | Mức sự cố gắn chữ và màu, cùng status xử lý. Skeleton chỉ dùng tải lần đầu. Giữ nội dung đã tải khi refresh có lỗi và báo thời điểm dữ liệu nếu biết. Rỗng theo nguyên nhân hoặc filter. Offline được gắn riêng trạng thái local và phạm vi của dữ liệu đã tải. |

## 8. Wireframe theo vùng hiển thị

Thứ tự từ trái sang phải ở mỗi dòng dưới là thứ tự đọc từ trên xuống. Dữ liệu trong ảnh tham chiếu là bố cục minh họa.

| Màn và route đề xuất | Nội dung chính → phụ | Hành động và nguồn | Loading / rỗng / lỗi / offline | Sẵn sàng |
|---|---|---|---|---|
| **1. Driver Home** `/` | Tên tài xế + Tài khoản → chuyến đang thực hiện hoặc chuyến đã điều phối → status, xe và điểm tiếp theo nếu có detail → lối tắt Chuyến/Lịch khi sẵn sàng → chỉ báo queue. | **Tiếp tục chuyến** hoặc **Xem chuyến** → Overview. Nếu nhiều active, **Chọn chuyến**. Nguồn Trips list theo status, detail của một chuyến đủ rõ, profile account và state queue/GPS; không auto-start. | Skeleton cho card chính, rỗng dẫn tới list, lỗi có thử lại. Offline chỉ dùng snapshot còn khả dụng và nói rõ thời điểm; không chọn Trip từ dữ liệu thiếu. | A |
| **2. Trip List** `/trips` | Chuyến + filter → card mã/status/giờ/biển số, thêm ngữ cảnh vai trò khi ảnh hưởng quyền → tải thêm. Lịch sử dùng filter hoàn thành. | Mở card → Overview; kéo làm mới. Dùng `GET /driver/trips`. | Skeleton đầu, rỗng theo filter, phân biệt fetch lỗi. Nếu còn list trong phiên, giữ list và hiển thị offline. | A |
| **3. Overview** `/trips/:id` | Status và tiến độ xác nhận → stop cần làm + địa chỉ ngắn → CTA theo policy → GPS/Sync → Map, Sự cố, e-POD và chi tiết thu gọn. | CTA **Bắt đầu**, **Mở điểm**, **Xem đồng bộ**, **Bổ sung ảnh** hoặc **Hoàn thành** theo selector. Trip detail/readiness/queue làm nguồn. | Lỗi có thử lại. Mất mạng hiển thị việc local còn làm được và khóa Complete. Rỗng khi không còn stop hoặc thiếu dữ liệu, tách 404. | A |
| **4. Stop Execution** `/trips/:id/stops/:sid` | Loại + số thứ tự + địa chỉ/liên hệ → nhóm planned/actual hàng → kết quả/lý do/người nhận khi giao → e-POD khi có attempt. Timing và tọa độ thu gọn. | Thanh dưới **Đã đến** hoặc **Xác nhận** nếu hợp lệ. Stops/Tasks và offline queue hiện có. Nút phụ dẫn Map/Sync/POD đúng ngữ cảnh. | Loading, lỗi stop sai, chỉ đọc ngoài quyền. Offline hiện local pending. Back giữ/bỏ nháp theo flow hiện tại. | A |
| **5. Profile** `/account` | Họ tên → điện thoại/email → thông tin nghiệp vụ nếu có → quyền vị trí và mục phiên. | **Mở cài đặt vị trí**, **Làm mới**, **Đăng xuất** có xác nhận khi còn queue. Auth profile và GPS status; hồ sơ nghiệp vụ tùy `/driver/me`. | Placeholder trường thiếu, lỗi refresh giữ dữ liệu phiên. Offline hiện trạng quyền thiết bị và dữ liệu đã tải. | A account / B nghiệp vụ |
| **6. Lịch tuần** `/schedule` | Khoảng tuần + timezone → ngày đang chọn → agenda theo giờ assignment → xe/trạng thái → ghi chú qua đêm. | Trước/sau tuần, chọn ngày, mở Trip. Query overlap ở server. | Tải skeleton; ngày rỗng ghi chưa có chuyến, lỗi thử lại. Offline chỉ hiện tuần có snapshot, không suy ca trực/ngày nghỉ. | B, cần range |
| **7. Xe được phân công** `/trips/:id/vehicle` | Biển số lớn + loại/model → chuyến và thời gian assignment → tải trọng/trạng thái nếu DTO có. | **Xem chuyến**, **Báo sự cố** qua luồng Trip nếu đủ quyền. Từ Trip summary/detail. | Nếu mất quyền hoặc chưa thấy Trip, rỗng theo ngữ cảnh. Lỗi retry, offline dùng detail đã tải; trạng thái xe cũ có nhãn. | A thẻ / B detail |
| **8. Chi nhánh** `/account/branch` hoặc `/trips/:id/branch` | Nhãn quan hệ với Driver hoặc Trip → tên/code → địa chỉ, số điện thoại, giờ hoạt động nếu có. | **Gọi chi nhánh** nếu có số đã công bố. Nguồn Driver self projection hoặc Trip projection. | Loading, thiếu dữ liệu có lời giải thích, lỗi thử lại, offline hiện thông tin đã tải nếu còn quyền. Giờ hoạt động tách khỏi lịch cá nhân. | B |
| **9. Hiệu suất** `/performance` | Kỳ/timezone → số chuyến và stop → giao thành công/một phần/thất bại → incident đã báo → cách đếm. | Chọn kỳ và làm mới. Nguồn aggregate server theo actor/range. | Skeleton, kỳ chưa có event và lỗi phạm vi phân biệt với số 0. Offline hiện thời điểm chốt dữ liệu khi có snapshot. | C |
| **10. Thu nhập** · wireframe tương lai | Chọn kỳ → phiếu đã phát hành + ngày/trạng thái → cấu phần thu nhập, khấu trừ và thực nhận → thông tin kỳ. | **Xem phiếu** khi có dữ liệu đã công bố đúng owner. Mức tiền lấy từ PayrollItem; không đặt số trong wireframe. | Skeleton, chưa có phiếu chính thức, lỗi quyền và mạng. Tránh lưu dữ liệu tài chính offline trừ khi có policy. | D · NOT READY |
| **Sự cố** `/trips/:id/incidents` | Chuyến → mức độ + giờ + trạng thái mỗi báo cáo → chi tiết và đơn liên quan khi mở. | **Báo sự cố** theo quyền, xem thêm/thử lại theo list scoped. Back về Trip. | Loading/rỗng/lỗi mạng tách riêng. Offline giữ nội dung nhập trong form và khóa gửi. | A |
| **Đồng bộ** `/trips/:id/sync` | Pending/lỗi tổng hợp → cần xử lý → đang chờ → đã gửi có thể thu gọn. | **Thử đồng bộ** theo policy và xem lại Trip. Nguồn SQLite/coordinator theo owner và Trip. | Offline giữ lệnh, hiển thị lỗi version theo stop. Queue rỗng có xác nhận riêng. | A |
| **Bằng chứng** `/trips/:id/stops/:sid/pod` | Tình trạng PHOTO → file active/ảnh local → chữ ký tùy chọn → lịch sử thay nếu cần. | **Chụp / xác nhận / thử lại** theo giai đoạn, mở viewer hợp lệ. Nguồn API theo attempt và trạng thái upload. | Chờ dữ liệu, lỗi camera/upload, offline chỉ đọc. Ảnh đang gửi có nhãn riêng; không hiện hành động sửa với Trip hoàn thành. | A |
| **Bản đồ** `/trips/:id/map` | Map giữ vùng tương tác chính → đích hiện tại → điều hướng → chú giải/cảnh báo. | **Điều hướng** đến đúng stop theo policy và Back về Trip. Nguồn điểm dừng, GPS snapshot và Mapbox. | Loading bản đồ, thiếu tọa độ hoặc tile lỗi, GPS cũ. Giữ hướng dẫn hợp lệ khi map chưa tải. | A |

## 9. Rollout và phạm vi MVP

| Lát cắt | Giao phẩm | Phụ thuộc và gate |
|---|---|---|
| 1. Nền UI Driver | Token typography, status chips, empty/error, card và action hierarchy scoped Driver. | UI-only. Test chữ lớn, focus và vùng chạm. Tránh đổi shared UI theo cách gây thay đổi Customer. |
| 2. Home + Account | Landing Dashboard, lối tắt Chuyến, account thật và logout có queue guard. | UI-only. Baseline A. Active 0/1/n, assignment ngoài PRIMARY, load/error/offline và phiên đổi user. |
| 3. Polish Trip | Card list, filter lịch sử hiện có, Overview/Stop/Incident/Sync/e-POD compact theo ngữ cảnh. Giữ Mapbox path. | UI-only. Chạy regression Driver và QA nền, queue, POD guard, trạng thái và Back. |
| 4. Lịch tuần và thông tin vận hành | Date range / timezone; Profile nghiệp vụ, xe theo Trip và chi nhánh. | Backend work riêng cho B; thống nhất DTO, quyền và fixture trước triển khai. Thẻ xe hiện có triển khai được độc lập. |
| 5. Activity summary / Tab gate | Aggregate theo kỳ đã duyệt; lấy phản hồi về tần suất điều hướng trước quyết định Tabs. | Backend work riêng cho C. Đối soát same actor, nhiều role và cutoff. |
| 6. Android QA | Ma trận ở §10. Kèm ảnh chữ lớn và ghi hành vi role/offline/tracking. | Dùng dev APK có Mapbox và fixture local/test chuyên biệt. Giữ chuyến bằng chứng M4.0/M4.1.1. |

P0 gồm Home, Trip UX, Account cơ bản, lịch sử hiện có và lối tắt cài đặt vị trí. P1 gồm Calendar, hồ sơ nghiệp vụ, xe/chi nhánh và activity summary theo điều kiện. P2 gồm notification/inbox, payroll và hỗ trợ nâng cao. M4.1.3 Customer giữ kế hoạch riêng.

## 10. Regression risk matrix và Android QA

Các ca dự kiến dưới đây **NOT RUN**. Chạy trên development APK và Backend local/test ở giai đoạn nghiệm thu. Các chuyến M4.0 và M4.1.1 dùng đối chiếu ở chế độ xem, giữ fixture có ghi cho QA riêng.

| Ca / rủi ro | Thao tác Android và quy tắc PASS |
|---|---|
| D01 · Navigation và role | Login Driver, mở Home/List/Trip/screen con từ cả luồng nội bộ và deep link, Back hệ thống, thử sai ID và login Customer. PASS khi về đúng cha, không trùng workspace, dữ liệu ngoài quyền bị từ chối. |
| D02 · Home / phân công | Thử 0/1/nhiều Trip IN_PROGRESS, chuyến DISPATCHED, RELIEF, CANCELLED và lỗi/mất mạng. PASS khi CTA đúng quyền, không tự start và không dùng tiến độ từ snapshot thiếu. |
| D03 · Offline execution | Mất mạng khi ở Stop, gửi thao tác, chuyển route, bật mạng, đổi phiên và gặp conflict. PASS khi SQLite giữ đúng owner/Trip, FIFO, exact retry, expected version và progress local/server tách rõ. |
| D04 · Mandatory e-POD | Kiểm tra thiếu PHOTO, ảnh local/failed/đã thay, nhiều stop và retry upload rồi Back. PASS khi Complete chỉ mở với server-photo active, queue sạch và online; backend `POD_REQUIRED` còn bảo vệ. |
| D05 · GPS | Theo dõi khi chuyển route, tắt màn, thu hồi quyền hoặc logout; đối chiếu log/test DB của đúng chuyến. PASS khi chỉ có lifecycle cần thiết, queue đúng owner, UI báo stale/mất quyền đúng và tracking dừng theo policy. |
| D06 · Incident | PRIMARY báo, mất mạng lúc nhập, thử lại cùng dữ liệu, RELIEF/chuyến hoàn thành chỉ đọc. PASS khi retry không trùng và scope Trip được giữ. |
| D07 · Mapbox | Pinch, pan, tap marker, cuộn footer, external navigation và giả lập tile lỗi. PASS khi cử chỉ độc lập và điều hướng hợp lệ vẫn tới đúng điểm. |
| D08 · Android usability | Màn nhỏ, font hệ thống lớn, TalkBack, vùng chạm, Back khi nhập/đang ký, mở app ngoài trời. PASS khi status đọc được, CTA không bị keyboard che, nháp có bảo vệ và focus trở về hợp lý. |
| D09 · Customer E2E | Tài xế thực thi trên fixture mới, Customer đúng chủ xem polling/tiến độ, tài khoản khác thử truy cập. PASS theo hợp đồng M4.0 về quyền, địa điểm cuối của đúng Trip, e-POD và hoàn tất. |
| D10 · Lịch/profile/metrics | Khi có P1, thử ca qua đêm, ranh giới tuần, giờ Trip khác assignment, xe dùng nhiều chuyến, quản lý khác home branch, report khác actor và retry trùng. PASS theo contract từng module và không lộ giấy tờ, KPI hoặc dữ liệu khác owner. |

## 11. Điểm cần duyệt trước khi code

1. **MVP navigation:** Home + Stack trước, giữ Tabs bốn mục là phương án sau Calendar. Chốt Home ưu tiên chuyến đang thực hiện và Account chứa đăng xuất có cảnh báo queue.
2. **Lịch:** Dùng tên **Lịch chuyến đã phân công**, chọn timezone nghiệp vụ và quy tắc hiển thị chuyến qua ngày. Ca làm/ngày nghỉ chờ nghiệp vụ HR.
3. **Profile, xe, chi nhánh:** Chốt mã nghiệp vụ, hạng/hạn bằng và thông tin liên hệ được hiển thị. Xác nhận gắn xe theo Trip và dùng hai nhãn chi nhánh riêng.
4. **Thống kê và lịch sử:** Duyệt phạm vi cá nhân theo actor hay theo tham gia, khoảng kỳ, trạng thái assignment đã kết thúc và quyền xem snapshot cũ.
5. **Tương lai:** Notifications cần người nhận/event contract. Payroll cần chủ nghiệp vụ, công thức, công bố và quyền đọc trước khi lên UI.

Phạm vi bàn giao là tài liệu khảo sát. Backend, Prisma, runtime Mobile, dữ liệu, fixture M4.0/M4.1.1 và kế hoạch M4.1.3 Customer được giữ nguyên.

## 12. M4.1.2B — Driver Home Dashboard đã triển khai

- Route Driver `/` render Home trực tiếp trong Stack đã bảo vệ theo role. `/trips` và `/trips/:id` tiếp tục hoạt động. Stack Driver dùng `index` làm anchor để Back từ deep link. Lối tắt `/account` chỉ có tên tài khoản và đăng xuất có guard khi queue còn lệnh.
- Home dùng `GET /driver/trips?page=1&limit=2&status=IN_PROGRESS` và `GET /driver/trips?page=1&limit=3&status=DISPATCHED`. Khối chuyến đã điều phối lấy thứ tự giờ kế hoạch do server trả và mở danh sách đầy đủ theo filter. Lịch sử mở `/trips?status=COMPLETED`.
- Chỉ khi tổng và danh sách cùng xác nhận đúng một chuyến đang thực hiện mới tải `GET /driver/trips/:id`. Khi có nhiều chuyến, nút **Chọn chuyến** mở danh sách lọc IN_PROGRESS. Khi chi tiết thiếu hoặc đổi trạng thái trong thời gian tải, Home không hiện tiến độ suy đoán. Tài xế không phải PRIMARY thấy **Xem chuyến**.
- X/Y tính bằng số stop COMPLETED hoặc SKIPPED chia tổng stop của detail. Điểm bỏ qua có số riêng. Gợi ý điểm cần đến dùng selector hiện có với queue của đúng chuyến. Gợi ý dựa trên thao tác local có nhãn chưa đồng bộ.
- Kéo làm mới và focus dùng chung một request đang chạy. Phản hồi của màn đã unmount không cập nhật Home, và màn được khởi tạo riêng theo user. Khi ngoại tuyến hoặc lỗi tải có snapshot hợp lệ, dữ liệu trong phiên có nhãn có thể cũ. Không có lưu Home qua cold start. Các lỗi mất quyền xóa snapshot liên quan.
- Home chỉ đọc GPS snapshot và tổng queue của tài khoản. GPS chỉ hiện khi khớp Trip đang thực hiện và assignment PRIMARY. Home không khởi tạo watcher, gửi command hoặc tự đồng bộ queue.
- Các phần dành cho các lát cắt M4.1.2C/2D gồm polish Trip UX và mở rộng khu vực Account theo quyết định tiếp theo. Profile nghiệp vụ, lịch tuần đầy đủ, hiệu suất và thu nhập vẫn cần các điều kiện ở §§4–5. [Kiểm thử M4.1.2B](../04-testing/test-cases.md#m412b--driver-home-dashboard)
