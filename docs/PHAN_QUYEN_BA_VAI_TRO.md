# Phân quyền ba vai trò chi nhánh — Người 2

Quyết định trực tiếp của người dùng ngày 22/11/2026 thay mô hình bốn vai trò ngày 14/11. Người dùng xác nhận **chỉ sửa phần Người 2, bàn giao phần Người 1** khi được hỏi về API lịch hẹn. Quyền triển khai nền web/backend đã được ghi nhận trong kế hoạch và WEB_ADMIN; nhiệm vụ này tiếp tục phạm vi đó. Không cấp quyền chạy migration trên database vận hành.

## Làm rõ nhóm chức năng của Trưởng chi nhánh

Người dùng làm rõ ngày 22/11/2026: phần lập kế hoạch, điều phối thủ công/tự động và tối ưu do Người 1 xây dựng trên web admin được xem là **một nhóm chức năng của vai trò Trưởng chi nhánh**. Người 1 là người phụ trách phát triển, không phải một vai trò sử dụng hay một ứng dụng quản trị tách biệt.

Nhóm này gồm chọn dữ liệu đầu vào trong chi nhánh, tạo/chỉnh phương án, chạy tối ưu, xem tuyến/bố trí hàng và duyệt phiên bản kế hoạch. Web hiện đã mở DispatchPage và AutomaticDispatchPage cho BRANCH_DISPATCH_LEAD qua trips.plan/trips.approve, đồng thời dùng màn hình lập và duyệt làm trang đầu. Quyền phát hành bản đã duyệt vẫn thuộc Điều phối viên vận tải như quyết định trước.

Vì vậy, phần ghi “chưa hoàn tất” ở mục 4 là các điều kiện nghiệp vụ/tích hợp chưa kiểm chứng đủ, không có nghĩa nhóm chức năng Người 1 chưa được gắn vào vai trò Trưởng chi nhánh. Xử lý yêu cầu lịch hẹn của nhân viên vận tải và thao tác tạo/tối ưu phương án là các thao tác khác nhau; việc làm rõ nhóm chức năng này không tự cấp trips.plan cho Điều phối viên. Phân công phát triển và giới hạn chỉ sửa phần Người 2 vẫn giữ theo xác nhận trước.

## 1. Ma trận quyền cuối cùng

Mọi quyền chi nhánh dưới đây cần đồng thời có trong grant đang hoạt động từ PostgreSQL và trong giới hạn vai trò tại `backend/src/auth/access.ts`. Không tự cấp quyền từ tên đăng nhập hoặc cột `User.role`. Chỉ gán một vai trò và một chi nhánh trên trang Tài khoản. Những scope lịch sử nhiều chi nhánh được đối soát trước khi chuyển, không đoán chi nhánh.

| Nghiệp vụ | Trưởng chi nhánh | Quản lý tài nguyên | Điều phối viên vận tải | ADMIN |
|---|---|---|---|---|
| Chi nhánh đang hoạt động | Đọc chi nhánh mình | Đọc chi nhánh mình | Đọc chi nhánh mình | Quản trị theo grant COMPANY |
| Đơn, kiện | Đọc | Không | Đọc, tạo/sửa/xác nhận/hủy bằng API hiện hữu | Theo grant hiện hành |
| Khách hàng/lookup cho form | Đọc | Không | Đọc | Quản trị theo grant |
| Xe, tài xế, lịch khả dụng | Đọc | Đọc/ghi hồ sơ, ca, nghỉ, bảo dưỡng/hỏng | Đọc phục vụ kiểm tra chuyến | Quản trị theo grant |
| Chuyến và bằng chứng hiện có | Đọc chi nhánh mình | Đọc để đối chiếu ảnh hưởng tài nguyên | Đọc/theo dõi chi nhánh mình | Theo grant |
| Lập/chỉnh kế hoạch | `trips.plan` | Không | Không | Giữ quyền lập hiện hữu |
| Duyệt phiên bản | `trips.approve` | Không | Không | Không tự duyệt thay vai trò chi nhánh |
| Phát hành | Không | Không | `trips.publish` | Không tự phát hành thay vai trò chi nhánh |
| Cấu hình tối ưu/phạt | Chỉ đọc phục vụ lập kế hoạch | Không | Không | Quản trị theo grant |
| Tài khoản, nhật ký quản trị | Không | Không | Không | Grant ADMIN COMPANY tương ứng |
| Lịch hẹn giao cho nhân viên | API hiện tại theo `trips.plan` | Không | **Chưa được nối — cần Người 1** | Theo API hiện hành |

`BRANCH_DISPATCH_LEAD`: branches.read, vehicles.read, drivers.read, customers.read, orders.read, trips.read, trips.plan, trips.approve, settings.read.

`RESOURCE_MANAGER`: branches.read, vehicles.read, vehicles.manage, drivers.read, drivers.manage, trips.read.

`TRANSPORT_DISPATCHER`: branches.read, vehicles.read, drivers.read, customers.read, orders.read, orders.write, trips.read, trips.publish.

ADMIN vẫn cần các permission thật trên grant COMPANY. DRIVER chỉ dùng nhóm `driver.*` đã có; CUSTOMER giữ inbox lịch hẹn và API phản hồi hiện hành. Grant nhầm như orders.write trên Quản lý tài nguyên hoặc users.create trên vai trò chi nhánh bị chặn cả ở tính quyền server lẫn profile trả về frontend.

## 2. API và màn hình Người 2

| API hiện có được rà soát/bảo vệ bằng policy mới | Quyền và phạm vi |
|---|---|
| `/auth/login`, `/auth/profile`, phiên HTTP/socket/worker | Tải grant từ DB, loại quyền vượt vai trò; ORDER_SCHEDULER không còn là grant web hợp lệ |
| GET `/branches`, `/branches/:id` | branches.read + chi nhánh; endpoint admin vẫn branches.manage |
| GET `/orders`, `/:id`, `/available-for-dispatch` | orders.read + branchFilter; không trao orders.read cho Quản lý tài nguyên |
| POST `/orders`, `/:id/confirm`, `/:id/cancel`; PATCH `/:id` | orders.write + quyền trên đơn/khách/chi nhánh; giữ version, command key, trạng thái và lịch sử |
| GET `/customers/page`, `/lookup`, `/:id`, `/:id/orders` | customers.read; lọc quan hệ CustomerBranch; quyền quản trị khách không thêm cho nhân viên vận tải |
| GET `/fleet/:kind`, `/:id`, `/availability`, `/:id/availability`, `/:id/schedules`; `/vehicles`, `/drivers`, các lookup available/types/employees | Quyền đọc tương ứng hoặc drivers.manage đối với Employee lookup; scope bản ghi và header chi nhánh được kiểm tra ở service |
| Ghi hồ sơ/lịch tài nguyên | vehicles.manage/drivers.manage; giữ khóa, version, idempotency, exclusion và trigger lịch hiện có |
| GET `/locations` | Chuyển sang branches.read + branchFilter từ Principal, thay nhánh fallback theo User.role/STAFF; tài khoản STAFF cũ đã chuyển vai trò dùng đúng scope mới |
| GET `/monitoring/*`, `/dashboard/*` | Giữ bộ lọc Trip và toàn bộ tham chiếu đơn/kiện/xe/tài xế; Quản lý tài nguyên xem được chuyến bị ảnh hưởng |
| `/users` đọc/tạo/sửa/khóa/mở | Vẫn chỉ ADMIN COMPANY, không cấp ADMIN qua form; không nhận ORDER_SCHEDULER cho gán mới; sửa vai trò thu hồi phiên và ngắt socket |

Không đổi DTO nghiệp vụ chuyến, optimizer, payload Python hoặc điều kiện feasibility của Người 1. Đầu vào từ `X-Branch-Id` chỉ là lựa chọn phạm vi, không là bằng chứng có quyền. Guard cũng nhận lựa chọn này cho endpoint đánh dấu `authenticated` như Fleet; service kiểm tra quyền thực tế theo kind.

Trang đầu: Trưởng chi nhánh → Lập và duyệt kế hoạch; Quản lý tài nguyên → Đội xe; Điều phối viên → Đơn hàng; ADMIN theo trang hợp lệ hiện có; CUSTOMER → Lịch hẹn. Sidebar và URL trực tiếp dùng cùng bộ kiểm tra vai trò/trang/permission. Navbar hiện tên vai trò tiếng Việt và chi nhánh. Trang Đơn của Trưởng chi nhánh ẩn tạo/sửa/xác nhận; Điều phối viên có thao tác theo API/trạng thái. Trang Đội xe ẩn ghi khi chỉ đọc. Bộ chọn vai trò tài khoản có ba vai trò vận hành và DRIVER, hỗ trợ điều hướng bàn phím không dùng danh sách ảo cho bốn lựa chọn.

Quản lý tài nguyên được quản lý **ca ngày–giờ hiện có** và xem khoảng bảy ngày. Không có API lịch tuần theo nhóm thường/hỏa tốc hoặc cặp tài xế–xe cố định. Lịch thường xung đột reservation/chuyến bị từ chối; hỏng xe thực tế vẫn ghi nhận, hiển thị chuyến bị ảnh hưởng, giữ nguyên chuyến.

## 3. Migration và tài khoản cũ

Migration mới: `backend/prisma/migrations/20261122100000_three_branch_roles/migration.sql`. Không sửa các migration cũ. Không đổi schema hay ORM.

- Đối soát role-permission đúng ba vai trò; ADMIN/DRIVER/CUSTOMER và quyền của chúng không bị thay đổi.
- Chuyển scope ORDER_SCHEDULER đang hoạt động sang TRANSPORT_DISPATCHER cùng chi nhánh. Nếu đã có scope đích cùng chi nhánh, upsert thành một scope; giữ scope nguồn dưới trạng thái thu hồi và ghi audit có ID scope cũ.
- Dừng toàn transaction nếu scope không phải BRANCH, thiếu/ngừng chi nhánh, có location scope, loại tài khoản không phù hợp hoặc có vai trò/chi nhánh khác đang hoạt động. Vai trò nguồn/đích bị ngừng hoặc scope đích còn location khác cũng phải đối soát riêng; không tự hồi sinh quyền đã bị ngừng.
- Không tự mở khóa User; không suy vai trò mới cho DISPATCHER chung cũ. Loại tài khoản STAFF cũ được giữ, nhưng quyền lấy từ grant mới; ADMIN vẫn có thể khóa tài khoản vận hành đã chuyển này.
- Thu hồi phiên của người có một trong bốn scope liên quan, tăng updatedAt để form tài khoản cũ nhận version conflict; ngừng định nghĩa ORDER_SCHEDULER. API đọc quyền hiện hành mỗi request; socket revalidate và session revocation loại quyền cũ.
- Khóa bảng RBAC/users/sessions trong transaction. Dừng API/worker cũ, sao lưu và thử phục hồi, review lịch sử migration rồi chạy trên bản sao trước khi đề nghị áp dụng thật. Khi lỗi transaction rollback. Sau commit và phát sinh dữ liệu mới, dùng migration sửa tiến hoặc phục hồi/đối soát bản sao; không tự bật lại scope/phiên cũ.

Preflight chỉ đọc: đặt `ROLE_MIGRATION_DATABASE_URL` rồi chạy `node scripts/three-roles-preflight.cjs` trong backend. Script dùng transaction READ ONLY, báo số scope/session và các scope cần đối soát, không trả tên đăng nhập/mật khẩu/token. Kết quả đọc database đang cấu hình ngày 22/11: chưa có ba role mới hoặc ORDER_SCHEDULER; 0 scope scheduler hoạt động, 0 tài khoản DISPATCHER hoạt động, migration mới chưa áp dụng. Không thay dữ liệu hoặc migration history trên database này. Tệp kết quả cục bộ: `.git/three-roles-current-db-preflight.log`.

## 4. Phần cần phối hợp/kiểm chứng trong nhóm chức năng Trưởng chi nhánh

| File / API thuộc Người 1 | Việc cần phối hợp | Hệ quả hiện tại |
|---|---|---|
| `backend/src/trips/delivery-planning.controller.ts`, `.service.ts`; GET `/delivery-planning/batches`, `/:id` | Tách quyền đọc/xử lý lịch hẹn khỏi trips.plan; kiểm tra branch của batch và mọi đơn/khách liên quan | Điều phối viên chưa đọc/xử lý được batch; không cấp trips.plan chỉ để vượt guard |
| `frontend/src/components/DeliveryAppointments.tsx`, `pages/AutomaticDispatchPage.tsx` | Tách giao diện lịch hẹn dành cho nhân viên khỏi chạy optimizer/propose/replan; xác định thao tác nhân viên theo contract | Không thêm nút báo thành công hay UI giả trong trang Đơn |
| `backend/src/trips/trips.controller.ts`, `.service.ts`, `optimization-jobs.service.ts`; `frontend/src/pages/DispatchPage.tsx`, `AutomaticDispatchPage.tsx` | Kiểm tra consumer dùng grant mới, quyền lập/duyệt/phát hành và tất cả thao tác hàng loạt; regression test bằng ba vai trò | Chỉ rà soát và dùng màn hình hiện hữu trong browser test; không sửa các file này |
| `TripsService.executeAutomaticOptimization/create/updatePlan/approvePlan/publish` | Áp dụng mốc đặt trước 17:00/hẹn lấy ngày mai và chỉ lập sau 17:00; duyệt lại sau sửa; kiểm tra ca/tài nguyên mới nhất trước phát hành | Chưa tuyên bố đã thực thi toàn bộ policy ngày 19/11 hoặc đạt E2E lập–duyệt–phát hành |
| Cập nhật chuyến IN_PROGRESS và API thực thi | Giữ phần đã làm, bàn giao hàng, version và duyệt thay đổi | Chưa có luồng đầy đủ để kiểm chứng thay đổi chuyến đang chạy, giao thất bại/sự cố/trả hàng |

Các mốc 07:30/16:00/17:00 trong kế hoạch vẫn là yêu cầu đã chốt. Chưa có API thì ghi thiếu, không biến thành điều kiện UI có thể bỏ qua. Quyền chấp thuận hủy sau lấy, hoàn tiền, biểu phí và quyết định xe thay thế vẫn cần chốt riêng. Hủy trước phân công chỉ trong phạm vi API đã duyệt; không tự mở hủy đơn đã vận chuyển.

## 5. Kiểm chứng và chạy lại

Các kiểm chứng mới dùng PostgreSQL 16 thật trên `127.0.0.1:55432/tms_roles_test` và Redis test ở port 56379; không dùng database vận hành. Full schema hiện tại được tạo trên DB test trống bằng Prisma db push; test cài các function/trigger lịch thật từ migration cũ. Đây là fixture test, không là xác nhận toàn bộ lịch sử migration có thể deploy từ đầu.

Backend và frontend đã đạt typecheck, build và lint; frontend còn 9 cảnh báo hooks có từ trước và cảnh báo bundle lớn. Jest đạt 7 suite/35 test; Vitest đạt 3 file/8 test. HTTP/PostgreSQL đạt 7 nhóm kịch bản (Node báo 8 test tính cả test cha), gồm rollback khi role nguồn đã ngừng hoặc nhiều chi nhánh, gộp scope đích, thu hồi phiên, quyền đọc/ghi/lookup đúng vai trò và khác chi nhánh, grant cấu hình nhầm, idempotency lịch, bảo dưỡng bị chặn và hỏng xe được lưu khi ảnh hưởng chuyến. Browser kiểm tra menu/trang đầu/URL trực tiếp, dữ liệu sau reload/đổi tài khoản và thu hồi phiên khi đổi vai trò. Số lượt browser cuối ghi ở mục kết quả cuối bên dưới. Không chạy lại toàn bộ suite ngoài phạm vi, không nhận các test có sẵn từng lỗi từ lượt merge là đã được sửa. Log lưu trong `.git/three-roles-*.log`; ảnh Playwright trong `frontend/test-results/three-roles/`.

```powershell
# Từ thư mục gốc: profile test trong cùng compose.yaml, dùng volume test đã giữ:
docker compose --env-file backend/.env --profile roles-test up -d roles-postgres roles-redis

# backend: khi cần tạo schema trên DB test mới, đặt DATABASE_URL và DIRECT_URL
# tới localhost:55432/tms_roles_test, rồi dùng Prisma db push chỉ trên DB test trống.
# Harness mặc định dùng URL test riêng; không đọc .env để chọn đích DB.
npm run typecheck
npm run build
npm run lint
node --test tests/three-roles.integration.cjs
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/auth/branch-role-policy.spec.ts src/auth/auth.config.spec.ts src/users/users.dto.spec.ts src/orders/orders.delivery-hold.spec.ts test/auth/branch-scope.spec.ts test/events/events.gateway.spec.ts test/locations/locations.service.spec.ts

# frontend; chạy sau HTTP test, vì hai bộ dùng chung fixture DB test.
npm run typecheck
npm run build
npm run lint
node node_modules/vitest/vitest.mjs run src/test/branch-navigation.test.ts src/test/AuthContext.test.tsx src/test/OrdersPage.delivery-policy.test.tsx --maxWorkers=1
node node_modules/@playwright/test/cli.js test --config playwright.roles.config.ts
```

Harness từ chối URL khác localhost, port khác 55432 hoặc tên DB khác tms_roles_test; dùng credential cố định chỉ dành cho container test. Các fixture có tiền tố ROLE-/roles_test_ được chuẩn bị lại trên DB test, không chạy script này lên DB thật. Không chạy HTTP test đồng thời Playwright vì reset fixture sẽ thu hồi phiên của lượt chạy còn lại.

Workspace lúc bắt đầu đang ở merge chưa commit, đã stage các thay đổi pull. Bản tree/index trước nhiệm vụ lưu ở `.git/three-roles-baseline/`. Phần phân quyền mới để unstaged, không commit/push/deploy và không thay kết quả stage của lần giải quyết xung đột. Không sửa code Người 1; phần import module thật trong test chỉ để kiểm tra màn hình/API hiện hữu.


### Kết quả cuối ngày 22/11/2026

- Backend: typecheck, build, lint đạt; Jest 7 suite/35 test đạt.
- Frontend: typecheck, build, lint đạt (0 lỗi/9 cảnh báo hooks hiện hữu); Vitest 3 file/8 test đạt. Build còn cảnh báo chunk lớn; màn hình cũ còn cảnh báo Ant Design deprecation/Spin tip.
- HTTP/PostgreSQL: 7 nhóm/8 test tính cả test cha đạt, trên bản build cuối, gồm STAFF chuyển vai trò dùng lookup chi nhánh mới và khóa tài khoản vẫn thu hồi phiên.
- Playwright: **4/4 đạt**, lần cuối 27,3 giây. Dùng HTTP/PostgreSQL/Redis thật, không mock API. Ngoài menu/URL/reload/đổi tài khoản, Quản lý tài nguyên đã nhập ca và điểm sẵn sàng trên form, lưu HTTP 201, mở lại sau tải trang và thấy ca đã lưu. ADMIN thấy đúng ba lựa chọn vận hành + DRIVER; đổi vai trò khiến cửa sổ nhân viên phải đăng nhập lại và nhận menu mới.
- Đã xem ảnh desktop của lịch tài xế và ảnh 390×844 của Điều phối viên. Bảng có cuộn ngang trong vùng bảng; menu hẹp dùng nút mở, không coi ảnh này là chứng minh mọi màn hình responsive.
- `git diff --check`, `git diff --cached --check`, kiểm tra conflict marker đạt. Index vẫn có cùng tree với trước nhiệm vụ; các thay đổi pull đã stage được bảo toàn. Không có diff mới trong `backend/src/trips/`, DispatchPage, AutomaticDispatchPage, DeliveryAppointments hoặc optimizer.
- Database vận hành chỉ được đọc bằng preflight; chưa áp migration mới, chưa commit/push/deploy.

**Hoàn tất phạm vi Người 2 đã được phép. Chưa hoàn tất toàn luồng nghiệp vụ ba vai trò:** lịch hẹn nhân viên và các kịch bản mốc 17:00/lập–duyệt–phát hành/điều chỉnh chuyến đang chạy còn cần Người 1 theo mục 4. Ca tuần theo nhóm, cặp xe cố định, trả hàng và policy tiền còn thiếu API hoặc cần chốt riêng; không được coi là đã xây xong trong nhiệm vụ phân quyền này.

### Làm rõ màn hình phát hành chuyến (22/11/2026)

Theo yêu cầu riêng của người dùng, DispatchPage bổ sung hướng dẫn khi chưa có kế hoạch đã duyệt, ba bước lập/duyệt → kiểm tra → phát hành và nút tải lại. Khi chưa chọn chuyến, bản đồ dùng tọa độ thật từ API chi nhánh đang chọn, có chú thích đây là khu vực chi nhánh; không suy chi nhánh là điểm xuất phát/kho. Không tải được vị trí thì hiển thị lỗi và nút thử lại. Lỗi API danh sách chuyến được hiển thị riêng, không báo nhầm là danh sách trống.

Đã chạy frontend typecheck, Docker build (bao gồm tsc và Vite), lint (0 lỗi, cảnh báo hooks cũ), diff check. Playwright kiểm tra hướng dẫn trống, tải lại, vị trí chi nhánh HCM thật, lỗi vị trí/thử lại và phân biệt lỗi danh sách với danh sách trống; có ảnh desktop và 390 px. Danh sách trống dùng response mô phỏng `[]` tại trình duyệt, không tạo kế hoạch hoặc thay dữ liệu vận hành để kiểm tra giao diện.

Giới hạn bản chính phát hiện trong lượt kiểm tra: GET /trips trả 503; truy vấn Prisma chỉ đọc xác nhận P2022 do thiếu cột `trips.approvedPlanVersion` trong database hiện hành. Chưa áp migration hoặc sửa database trong nhiệm vụ giao diện này; chưa kiểm chứng chọn/phát hành kế hoạch thật trên bản chính.

### Sửa database cho danh sách phát hành chuyến (22/11/2026)

Theo yêu cầu tiếp theo của người dùng sửa lỗi trên bản chính, đã áp đúng `20261114153000_trip_plan_approval` và `20261122100000_three_branch_roles` qua `backend/scripts/apply-trip-approval-migrations.cjs --confirm-development`. API/workers được dừng khi cập nhật rồi khởi động lại. Không chạy toàn bộ migration pending, seed hoặc reset dữ liệu; không sửa nội dung migration đã có. Ba cột duyệt đều nullable, không tự đánh dấu kế hoạch đã duyệt. Preflight không có scope lịch hẹn cũ cần đối soát; database có 0 chuyến trước và sau cập nhật. Hai tài khoản HCM vẫn có đúng một scope tại BRANCH-SGN.

Script lưu bản đối chiếu cột/quyền/scope/lịch sử migration trong `.git/trip-approval-before-*.json` (không có mật khẩu/URL/token), thực hiện cả hai migration và ghi checksum trong cùng transaction, có giới hạn chờ khóa. Nếu lỗi trước commit thì PostgreSQL rollback cả thay đổi. Sau commit không tự xóa cột hoặc khôi phục phiên đã thu hồi; giữ cột/dữ liệu khi quay lại mã nguồn và đối soát quyền bằng snapshot nếu cần xử lý sự cố. Các phiên của vai trò chi nhánh bị thu hồi theo migration để buộc tải lại quyền.

Kiểm chứng: cú pháp script đạt; lần chạy thứ hai xác nhận checksum khớp và không áp lại; Prisma đọc Trip thành công. Playwright đăng nhập tài khoản Điều phối vận tải HCM vào bản chính, GET /trips trả 200, hiện hướng dẫn danh sách trống, không còn khung lỗi; tải lại danh sách và reload đều đạt, không mock API, không có lỗi runtime trình duyệt. Ảnh `.git/publish-ui-database-fixed.png`. Bốn dịch vụ Docker đều healthy, diff check đạt. Không có chuyến trong database nên chưa kiểm chứng thao tác duyệt/phát hành một chuyến thật trong nhiệm vụ sửa lỗi này.
