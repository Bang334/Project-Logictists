# Web Admin TMS — chức năng, contract và kiểm chứng

**Nhật ký thao tác quản trị (05/11/2026):** đã nối `/audit-logs` → NestJS → PostgreSQL; chỉ ADMIN COMPANY theo quyết định người dùng. Có lọc, phân trang, chi tiết an toàn và liên kết đối tượng. Xem [nguồn dữ liệu, giới hạn lịch sử và thiết kế](#audit-log-survey), cùng mục 9 bên dưới. Migration index mới chưa áp lên database thật.

**Quản trị tài khoản và chi nhánh (03/11/2026):** xem [ma trận quyền, API, migration, kiểm thử và demo](#account-branch-admin). ADMIN cấp/khóa DRIVER và DISPATCHER; quản trị chi nhánh nằm trong tab Chi nhánh của Fleet. Chưa áp migration lên database thật.

**Rà soát bổ sung 03/11/2026:** tái sử dụng phần triển khai và chính sách đã ghi nhận trong workspace. Form đổi mật khẩu hiển thị lỗi server ngay tại `currentPassword`/`newPassword`, giữ nội dung khi thất bại; bộ chọn chi nhánh làm việc hỗ trợ tìm theo tên. Không thay API/schema hoặc cấp lại quyền. Test chọn chi nhánh dùng tìm kiếm trước khi chọn để không phụ thuộc vị trí trong danh sách ảo hóa; không xóa fixture cũ hoặc giảm assertion.

Kiểm chứng lượt bổ sung: 36 test tích hợp PostgreSQL, 11 Jest, 4 Vitest và 11 Playwright đạt; backend/frontend typecheck, lint, build đạt (frontend còn cảnh báo hiện hữu). Replay migration trên dữ liệu test và ca mã trùng đều đạt. Chi tiết lệnh, lỗi test ban đầu đã sửa và giới hạn trong [bàn giao quản trị](#account-branch-admin). Chưa chạy migration/seed hoặc ghi dữ liệu nghiệp vụ lên database thật; preflight chỉ đọc vẫn ghi nhận bốn migration pending và 11 checksum lịch sử lệch.

Gộp tài liệu ngày 21/10/2026; bổ sung gộp tài liệu tài khoản/chi nhánh và nhật ký ngày 05/11/2026, phạm vi Người 2 — Web & Backend. Đây là nơi tra cứu chung cho các chức năng web admin đã thực hiện, gồm quyết định nghiệp vụ, API, migration, kiểm thử và hướng dẫn demo.

**Cách đọc:** mỗi mục giữ ngày và kết quả của đợt triển khai gốc. Các kết quả kiểm thử bên dưới là bằng chứng lịch sử của từng đợt, không phải một lần chạy mới cho toàn hệ thống. Phân biệt đã triển khai local, đã kiểm chứng trên database test, đã áp migration database thật và đã deploy ứng dụng; không suy các trạng thái này tương đương nhau. Nội dung chưa tích hợp/chưa chốt vẫn giữ nguyên.

Kế hoạch và nguồn dùng chung: [Kế hoạch TMS](../KE_HOACH_TMS.md), [Thiết kế database](../THIET_KE_DATABASE.md), [Phân công ba người](../PHAN_CONG_3_NGUOI.md), [Contract Package/Order](package-order-contract.md). Tài liệu Optimization và lịch sử mobile tiếp tục nằm riêng theo phạm vi phụ trách.

## Mục lục

1. [Khách hàng vận tải](#khach-hang)
2. [Xe, tài xế và lịch khả dụng](#doi-xe)
3. [Nghiệm thu đơn vận tải và kiện](#don-kien)
4. [Tra cứu và giám sát chuyến](#giam-sat-chuyen)
5. [Dashboard vận hành](#dashboard)
6. [Biên bản đồng bộ database 16/10/2026](#database-20261016)
7. [Biên bản migration khách hàng 17/10/2026](#database-khach-hang)
8. [Hủy đơn vận tải trước phân công](#huy-don-van-tai)
9. [Nhật ký thao tác quản trị](#nhat-ky-thao-tac) — [khảo sát nguồn dữ liệu](#audit-log-survey)
10. [Quản trị tài khoản và chi nhánh](#account-branch-admin)

## Ánh xạ tài liệu đã gộp

Các file nguồn dưới đây được thay thế bằng mục tương ứng. Giữ tên cũ để đối chiếu lịch sử trao đổi; cập nhật tiếp vào mục tương ứng thay vì tạo thêm báo cáo tính năng rời.

| File cũ | Mục tra cứu |
| --- | --- |
| `TRANSPORT_CUSTOMERS.md` | [Khách hàng vận tải](#khach-hang) |
| `FLEET_MANAGEMENT_PROGRESS.md` | [Xe, tài xế và lịch khả dụng](#doi-xe) |
| `ORDER_PACKAGE_ACCEPTANCE_20261018.md` | [Nghiệm thu đơn vận tải và kiện](#don-kien) |
| `TRIP_MONITORING.md` | [Tra cứu và giám sát chuyến](#giam-sat-chuyen) |
| `TMS_DASHBOARD.md` | [Dashboard vận hành](#dashboard) |
| `DATABASE_SYNC_20261016.md` | [Biên bản đồng bộ database 16/10/2026](#database-20261016) |
| `DATABASE_CUSTOMERS_20261017.md` | [Biên bản migration khách hàng 17/10/2026](#database-khach-hang) |
| `AUDIT_LOG_SURVEY.md` | [Khảo sát nguồn nhật ký](#audit-log-survey) |
| `ACCOUNT_BRANCH_ADMIN.md` | [Quản trị tài khoản và chi nhánh](#account-branch-admin) |

---

<a id="khach-hang"></a>

## 1. Khách hàng vận tải

*Tài liệu gốc: Quản lý khách hàng vận tải — cập nhật 17/10/2026*

### Chính sách người dùng đã xác nhận

- Một Customer được nhiều chi nhánh phục vụ thông qua `customer_branches`. Quan hệ này là phạm vi phục vụ, không phải quyền sở hữu suy ra từ một đơn.
- ADMIN toàn công ty đọc/tạo/sửa và quản lý danh sách chi nhánh. DISPATCHER tạo khách trong các chi nhánh có quyền; được sửa hồ sơ khi **tất cả** chi nhánh của hồ sơ nằm trong phạm vi `customers.write` của mình. Hồ sơ chia sẻ ra ngoài phạm vi đó chỉ ADMIN sửa.
- Chỉ ADMIN thay đổi danh sách chi nhánh của hồ sơ đã tạo. Chi nhánh khác không được thấy/chọn khách nếu chưa được cấp.
- Khách mới không cần có đơn để được tìm/chọn. Quyền `customers.read` và `orders.read` độc lập; danh sách và số đếm đơn chỉ gồm đơn vận tải thuộc phạm vi người xem.
- Khách cũ được cấp phạm vi theo các chi nhánh đã có **đơn vận tải B2B**. Không dùng đơn bán lẻ để mở quyền vận tải. Khách không có đơn vận tải chỉ ADMIN thấy cho đến khi cấp chi nhánh.
- Điện thoại vận tải không duy nhất. Tên khách cũng không duy nhất. Mã khách được sinh bằng UUID, không dùng count + 1.

### Hành vi và file chính

- `backend/src/customers/`: DTO runtime, danh sách/tìm kiếm/phân trang, chi tiết, tạo/sửa trong transaction, idempotency, version và audit.
- `backend/src/auth/customer-access.ts`: chính sách hồ sơ dùng chung với `ResourceAccess.customer` của Orders. Tạo/sửa/xác nhận đơn kiểm tra đúng Customer–Branch; khóa SHARE hồ sơ giữ phạm vi ổn định đến commit. Sửa hồ sơ khóa UPDATE cùng hàng.
- `frontend/src/pages/CustomersPage.tsx`: màn hình `/customers`, form và chi tiết; xử lý lỗi, thử lại, xung đột, giữ bản nhập khi lưu thất bại. Màn hình được remount theo tài khoản/phạm vi trong App hiện có.
- `frontend/src/components/CustomerSelect.tsx`: tìm và phân trang từ server; tải riêng ID đang chọn để sửa đơn không mất nhãn khi khách không nằm trang đầu. Đổi chi nhánh đơn xóa lựa chọn cũ.
- `frontend/src/types/customers.ts`: kiểm tra runtime response ở API client.
- Hồ sơ chỉ sửa tên, điện thoại, email, địa chỉ, người liên hệ, mã số thuế và phạm vi được phép. ID, mã, version nội bộ, liên kết tài khoản không được client tự ghi. Không thêm xóa/khóa/gộp/import/export hoặc quản lý nhiều liên hệ.
- Sửa Customer không cập nhật địa chỉ/người liên hệ đã lưu trong OrderStop. Audit ghi actor, version, tên trường thay đổi và thay đổi phạm vi, không sao chép điện thoại/email vào log.

### API contract

Tất cả API yêu cầu bearer session. `X-Branch-Id` và `branchId` phải thuộc quyền backend đã kiểm tra.

| API | Contract |
|---|---|
| GET `/customers/page` | `branchId?`, `search?` (tối đa 200), `page` (mặc định 1), `pageSize` (mặc định 25, tối đa 100); trả `{items,total,page,pageSize}` |
| GET `/customers/lookup` | Cùng query; mỗi item chỉ có `id,code,name` |
| GET `/customers/:id` | Hồ sơ, `branches` trong quyền người xem, `canEdit`, `canManageScope`; giữ `orders` tối đa 10 đơn vận tải có quyền đọc để tương thích API cũ |
| GET `/customers/:id/orders` | Phân trang đơn vận tải độc lập; kiểm tra cả quyền hồ sơ và `orders.read`; không trả đơn/số đếm ngoài quyền |
| POST `/customers` | `name`, `phone`, `branchIds` bắt buộc; `email,address,contactPerson,taxCode` tùy chọn |
| PATCH `/customers/:id` | Hồ sơ đầy đủ như form, `version` bắt buộc; chỉ ADMIN được gửi `branchIds`; trường tùy chọn trống được lưu null |
| GET `/customers` | Giữ response mảng và `_count.orders` cho consumer cũ; tối đa 500 khách, vượt giới hạn trả `CUSTOMER_LOOKUP_REQUIRED`; frontend mới dùng lookup |

POST/PATCH yêu cầu `Idempotency-Key` dài 16–100 ký tự chữ/số/gạch dưới/gạch ngang. Khóa theo actor + loại lệnh + key, payload đã chuẩn hóa có hash; cùng payload không ghi thêm, khác payload trả 409. Retry được kiểm tra lại quyền và trả hồ sơ hiện tại, không phát lại dữ liệu cache ngoài phạm vi.

Lỗi có `code,message` và `fieldErrors` khi phù hợp. Các mã chính: `VALIDATION_ERROR` (400), `CUSTOMER_BRANCH_INVALID` (400), `PERMISSION_DENIED`/`CUSTOMER_SHARED_READ_ONLY` (403), `CUSTOMER_NOT_FOUND` (404), `CUSTOMER_VERSION_CONFLICT`/`IDEMPOTENCY_CONFLICT` (409). 401 dùng cơ chế hết phiên hiện có. UI không tự ghi đè version khi gặp 409; người dùng có thể chủ động tải bản mới vào form.

### Schema, migration và tương thích

Migration mới: `backend/prisma/migrations/20261016180000_transport_customers/migration.sql`.

- Thêm `Customer.version` mặc định 1 và CHECK > 0.
- Thêm `customer_branches` với khóa chính ghép, FK và index theo chi nhánh. Backfill chỉ từ đơn `B2B_TRANSPORT`; không gán chi nhánh mặc định cho khách chưa xác định được phạm vi.
- Thêm `Customer.retailPhoneKey` nullable/unique, giữ giá trị điện thoại cũ làm khóa nhận diện checkout trước khi bỏ unique trên `phone`. Khách tạo qua màn hình vận tải không được gán khóa này.
- Checkout và seed bán lẻ chuyển từ upsert phone sang khóa bán lẻ riêng. Checkout giữ liên kết tài khoản theo hành vi cũ nhưng không ghi đè tên của hồ sơ vận tải đã được cấp chi nhánh; cập nhật liên quan tăng version để không âm thầm ghi đè phiên chỉnh sửa. Không thêm nghiệp vụ bán lẻ mới.
- Cấp `customers.write` cho ADMIN/DISPATCHER và `customers.manage` cho ADMIN qua bảng quyền hiện có. Không đổi scope tài khoản hiện hữu.
- Không sửa migration đã áp dụng, không reset/truncate/db push, không thay checksum cũ.

**Đã áp dụng migration này lên database thật ngày 17/10/2026, sau khi người dùng xác nhận.** Có sao lưu mới và kiểm chứng phục hồi trước khi áp dụng. Database hiện có 89 bảng public, 16 migration đã áp dụng. Không chạy seed demo vào database thật. Xem [biên bản đồng bộ](#database-khach-hang).

Khi được phép triển khai: sao lưu dữ liệu/lịch sử migration, dừng các writer cũ, đối chiếu inventory khách chưa có phạm vi, áp migration đã review rồi triển khai backend/frontend và Prisma Client đồng bộ. Code checkout cũ dùng unique phone không tương thích sau thay đổi, nên không chạy hai phiên bản song song. Migration có transaction; lỗi trước COMMIT rollback. Sau khi có dữ liệu mới, không dùng down migration khôi phục unique phone vì đã có thể xuất hiện số trùng; cần sửa tiến hoặc phục hồi có đối soát trên bản sao.

### Kiểm chứng và cách chạy lại

Môi trường kiểm thử tính năng: PostgreSQL 17 cô lập, database `tms_customers_20261016`, phục hồi schema public có dữ liệu trước nâng cấp. Giai đoạn kiểm thử không ghi vào database thật. Sau xác nhận riêng ngày 17/10/2026, migration đã được áp dụng lên database thật; giữ nguyên các trường cũ của 12 Customer, khóa nhận diện bán lẻ và toàn bộ quan hệ backfill khớp lịch sử đơn vận tải.

Trước khi chạy test, đặt `CUSTOMER_TEST_DATABASE_URL` tới PostgreSQL **localhost/127.0.0.1**, tên database bắt đầu bằng `tms_customers_`, đã có schema hợp nhất và migration mới. Wrapper từ chối URL khác và không tự dùng DATABASE_URL trong `.env`. Lịch sử baseline của project có migration hợp nhất; xem `MERGE_RECOVERY.md` khi dựng database, không chạy toàn bộ lịch sử cũ lên database trống một cách tùy tiện.

Tại `backend`:

```powershell
npm run prisma:generate
npm run typecheck
npm run build
npm run lint
npm run test:customers
node node_modules/jest/bin/jest.js --runInBand
```

`test:customers`: Nest HTTP thật + PostgreSQL thật cho create/reload/first order, duplicate phone, retry đồng thời, payload conflict, ngoài phạm vi/giả mạo/validation, hai lần sửa cạnh tranh, giữ OrderStop, khách chia sẻ và số đếm, khách chưa có đơn, rollback lỗi quan hệ, search/pagination, quyền đọc đơn độc lập, checkout bán lẻ tương thích, audit.

Đối chiếu migration trên hai database riêng trước khi chỉnh dữ liệu test: đặt thêm `CUSTOMER_BASELINE_DATABASE_URL` tới bản sao trước migration, rồi chạy `node scripts/check-customer-migration.cjs`. Cả hai URL phải là database test local; script chỉ đọc và in số lượng, không in hồ sơ cá nhân.

Tại `frontend` (cùng biến môi trường database test):

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:customers
```

Playwright tự mở API thử ở `127.0.0.1:4016` và web ở `127.0.0.1:5176`. Các bước thành công dùng HTTP/database thật; các ca lỗi mạng/400/403/404/409 UI được chủ động giả lập response để kiểm tra giữ form và hiển thị lỗi. Test backend kiểm tra quyền/xung đột thật. Tọa độ đơn trong test là fixture do test nhập trực tiếp, không phải kết quả Mapbox.

### Kết quả và giới hạn

Kết quả kiểm tra mã nguồn: Prisma generate, backend/frontend typecheck và build đạt; backend lint đạt, frontend lint không lỗi và còn 9 cảnh báo có trước. Backend Jest: 38 suite đạt, 162 test đạt, 3 suite/4 test bỏ qua theo cấu hình sẵn có. Frontend Vitest: 14 file, 44 test đạt. Suite HTTP/PostgreSQL riêng: 11 kịch bản con và một test cha, tổng 12 test đạt, không bỏ qua; bao gồm transaction, retry đồng thời, version và rollback thực.

Playwright: 4/4 kịch bản đạt (lượt cuối 39 giây): tạo/reload/sửa/đơn đầu tiên/khách ngoài trang đầu; lỗi mạng và validation/xung đột/bàn phím/màn hình nhỏ; logout và đổi tài khoản; lỗi 403/404 và đổi chi nhánh xóa khách đã chọn. Console phát cảnh báo Ant Design “There may be circular references” khi thao tác form đơn; chưa xác định nguyên nhân cảnh báo, không có ca chức năng thất bại ở lượt cuối. Các lượt trước có lỗi locator của test với Select; đã sửa cách thao tác bàn phím, giữ nguyên assertion hành vi.

Giới hạn: database thật đã cập nhật và kiểm chứng bằng truy vấn đọc; chưa deploy ứng dụng hoặc chạy luồng ghi end-to-end trên production. Kiểm tra màn hình nhỏ là trình duyệt 390×844, không phải app mobile/thiết bị native. Build frontend còn cảnh báo kích thước bundle. Không thay đổi điều phối/optimizer/mobile execution.

### Demo trên database test

1. Chạy `node scripts/with-customer-test-env.cjs tests/customer-test-app.cjs` tại backend.
2. Chạy Vite tại frontend với `VITE_API_URL=http://127.0.0.1:4016`, host `127.0.0.1`, port `5176`.
3. Đăng nhập `demo_auth_a` bằng mật khẩu test được khai báo trong `scripts/with-customer-test-env.cjs`; mở **Khách hàng vận tải**.
4. Tạo khách cho chi nhánh A → tìm theo tên/mã → reload → xem hồ sơ.
5. Mở **Quản lý Đơn hàng**, tạo nháp, tìm khách vừa tạo từ server, nhập điểm/kiện → lưu → reload.
6. Sửa hồ sơ khách, reload; ID khách và thông tin liên hệ đã chốt trên đơn vẫn được giữ.
7. Dùng `demo_auth_admin` cấp thêm chi nhánh B; `demo_auth_b` thấy khách nhưng chỉ thấy đơn thuộc B và không sửa hồ sơ chia sẻ với A.

Các tài khoản này chỉ là fixture của môi trường test, không phải thông tin đăng nhập production.

---

<a id="doi-xe"></a>

## 2. Xe, tài xế và lịch khả dụng

*Tài liệu gốc: Quản lý xe, tài xế và lịch khả dụng*

Cập nhật ngày 18/10/2026. Phạm vi Người 2: hồ sơ, ca và dữ liệu không khả dụng trên web/backend. Không triển khai lại solver, validator xếp/dỡ, GPS/mobile hoặc tính lương. Chưa áp dụng migration lên database thật, chưa commit/push/deploy.

### Quyết định đã được người dùng xác nhận

- ADMIN tạo/sửa; DISPATCHER chỉ đọc trong phạm vi chi nhánh. Không chuyển chi nhánh hoặc đổi trạng thái thủ công khi còn reservation HELD/ACTIVE hay chuyến PLANNED/DISPATCHED/IN_PROGRESS.
- Tài xế mới chọn Employee có sẵn. Không tạo tài khoản; nếu Employee có User thì kiểm tra tài khoản hoạt động và quyền DRIVER tại chi nhánh. Hồ sơ cũ được liên kết Employee thủ công, giữ nguyên Driver ID và lịch sử; không đoán theo tên/điện thoại.
- Ca ngày–giờ riêng, có thể qua đêm, không lịch lặp. Quyết định này thay thế ca cố định theo chi nhánh trong tài liệu cũ.
- ADMIN ghi nhận ca/nghỉ phép/nghỉ khác/bảo dưỡng/hỏng xe, hiệu lực ngay. Khoảng `[bắt đầu, kết thúc)`: cho phép tiếp giáp, từ chối chồng cùng loại. Ca và nghỉ khác loại có thể giao nhau; nghỉ chặn nhận việc.
- Lịch thông thường xung đột chuyến/reservation bị từ chối. Hỏng xe thực tế vẫn lưu, audit xung đột và hiển thị chuyến liên quan theo quyền; không tự sửa/hủy chuyến.
- Biển số so trùng sau viết hoa và bỏ khoảng trắng, dấu chấm, gạch ngang. Giấy phép có hiệu lực hết ngày hết hạn tại Asia/Ho_Chi_Minh. Chưa đặt quy tắc hạng bằng, giới hạn giờ làm/lái hoặc thời gian nghỉ.

### Hành vi và file chính

- `backend/src/fleet/`: API danh sách phân trang/lọc, chi tiết, tạo xe/tài xế, liên kết Employee, CRUD hiệu lực lịch và tra cứu khoảng thời gian. Dùng bảng EmployeeLeave/VehicleUnavailability hiện hữu và DriverShift mới.
- `backend/src/vehicles/resource-profile.ts`, services vehicles/drivers: khóa cùng namespace 4101/4102 với Trip; kiểm tra `expectedUpdatedAt`, cập nhật timestamp tăng ít nhất 1 ms; bảo vệ trạng thái/chi nhánh và ghi audit. Driver sửa thông tin nhân sự đồng thời với Employee; nguồn đã lệch trả 409 để đối chiếu.
- `backend/src/fleet/fleet-command.ts`: tạo/liên kết/lịch yêu cầu Idempotency-Key, phạm vi actor + command, hash payload chuẩn hóa, transaction ghi kết quả; retry cùng payload không tạo bản ghi thứ hai, khác payload trả 409. Đọc lại kết quả vẫn kiểm tra quyền hiện tại.
- `frontend/src/pages/FleetPage.tsx`: danh sách server, tạo/sửa/chi tiết, Employee link, lịch, tra cứu theo giờ; giữ tab chi nhánh hiện có. Các form có loading, validation, lỗi và giữ nội dung khi lưu thất bại. Schedule hủy hiệu lực, không xóa lịch sử.
- `CreateFleetModal`, `FleetSchedulePanel`, `ResourceAvailabilityNotice`: giao diện tạo, lịch và cảnh báo cho điều phối thủ công. Điều phối tự động ghi rõ danh sách ứng viên chưa bảo đảm nhận chuyến.
- Không trả citizenId/licenseNumber trong danh sách, availability hay snapshot lịch; chi tiết giấy tờ chỉ cho quyền manage. DriverLicense chưa được tạo song song: số/hạng/hạn giấy phép đang dùng trường Driver hiện hữu, không bịa validFrom để backfill.
- Tải/thùng lấy từ VehicleType hiện hữu. Hồ sơ dùng cm/kg, contract hình học chuyển tường minh sang mm/g. Cửa sau theo quyết định có sẵn; khẩu độ cửa/vật cản là null, `dataComplete=false` và lý do chưa kiểm chứng, không bịa số đo.

### Contract dành cho Người 1

Tất cả route cần xác thực và kiểm tra chi nhánh phía server. `kind` là `vehicles` hoặc `drivers`.

| Route | Nội dung |
| --- | --- |
| GET `/fleet/:kind` | `items,total,page,pageSize`; lọc `branchId,status,search`, pageSize tối đa 100 |
| GET `/fleet/:kind/:id` | Chi tiết + `updatedAt`; dữ liệu nhân sự lấy từ Employee khi liên kết |
| POST `/fleet/vehicles`, `/fleet/drivers` | Tạo thật trong transaction; bắt buộc Idempotency-Key |
| GET `/fleet/employees` | Nhân viên hoạt động chưa liên kết Driver, phân trang/tìm kiếm |
| POST `/fleet/drivers/:id/employee` | `employeeId,employeeVersion,expectedUpdatedAt` + Idempotency-Key |
| PATCH `/vehicles/:id`, `/drivers/:id` | Hợp đồng cũ bổ sung bắt buộc `expectedUpdatedAt` |
| GET `/fleet/:kind/availability` | Phân trang hồ sơ kèm kết quả cho `startsAt,endsAt` |
| GET `/fleet/:kind/:id/availability` | Kết quả một tài nguyên trong khoảng giờ |
| GET `/fleet/:kind/:id/schedules` | Lịch giao với khoảng; ca/nghỉ phân trang riêng, có shiftTotal/leaveTotal |
| POST `/fleet/:kind/:id/schedules` | `kind,startsAt,endsAt,reason`, Idempotency-Key |
| PATCH `/fleet/:kind/:id/schedules/:source/:scheduleId` | Như tạo + version; không đổi loại/chủ sở hữu lịch |
| POST `/fleet/:kind/:id/schedules/:source/:scheduleId/cancel` | `version,reason`, Idempotency-Key; giữ bản ghi và audit |

`source` là SHIFT/LEAVE/OTHER/MAINTENANCE/BREAKDOWN; lịch LEGACY chỉ đọc để tránh phân loại dữ liệu cũ bằng phỏng đoán. Ngày giờ API phải ISO 8601 có Z hoặc offset; lưu UTC, UI hiển thị giờ Việt Nam. licenseExpiry là YYYY-MM-DD.

Availability `fleet.v1` gồm resourceId, kind, version (updatedAt), profile, profileActive, dataComplete, scheduleCovered, reasons, affectedTrips, conflictsTruncated, startsAt/endsAt, timezone, units, vehicleGeometry, snapshotOnly và unchecked. `scheduleCovered=null` với xe vì không có mô hình ca xe. Không có cờ `available=true`.

Lý do: PROFILE_NOT_ACTIVE, VEHICLE_PROFILE_INCOMPLETE, DOOR_AND_OBSTACLE_DATA_UNVERIFIED, EMPLOYEE_LINK_MISSING, EMPLOYEE_BRANCH_MISMATCH, LICENSE_EXPIRES_BEFORE_WORK_END, SHIFT_NOT_COVERING_INTERVAL, EMPLOYEE_LEAVE, VEHICLE_UNAVAILABILITY, RESERVED_OR_ASSIGNED. Chuyến hiển thị tối đa 100, bị lọc theo quyền; có cờ giới hạn dữ liệu. `unchecked`: vị trí thực tế, thời gian đến nhận việc, giờ lái/nghỉ, tương thích hạng bằng/xe, validator không gian.

`/vehicles/available`, `/drivers/available` giữ response dạng mảng để không phá bộ chọn cũ; chỉ là ứng viên theo hồ sơ, không thay API khoảng giờ. Giấy phép xét theo kết thúc công việc ở API mới; phần Trip liên quan đã dùng cùng biên ngày địa phương.

`calendar-snapshot.ts` đọc nhất quán RepeatableRead các ca, nghỉ, block xe, reservation và version. `TripsService` lưu `resourceCalendar` (`fleet.calendar.v1`) trong requestSnapshot của OptimizationJob và phát hiện version hồ sơ thay đổi khi tạo snapshot. Mỗi thay đổi lịch qua API tăng version tài nguyên.

Phân công/publish vẫn thuộc Người 1. Migration bảo vệ biên reservation HELD/ACTIVE trong transaction bằng khóa chung và kiểm tra dữ liệu lịch mới nhất. Đã kiểm thử INSERT và HELD → ACTIVE trên PostgreSQL, không coi đó là E2E solver/publish. Solver hiện hữu vẫn đề xuất theo service-day của chi nhánh; việc dùng ca tùy ý để tìm nghiệm nằm ở consumer Người 1, chưa được triển khai lại trong nhiệm vụ này. Thiếu ca có thể làm apply/publish bị từ chối, không tự sinh ca để vượt kiểm tra.

Lỗi chuẩn: 400 validation/IDEMPOTENCY_KEY_REQUIRED/INVALID_INTERVAL, 403 thiếu quyền, 404 tài nguyên ngoài phạm vi, 409 RESOURCE_VERSION_CONFLICT/RESOURCE_IN_USE/EMPLOYEE_PROFILE_CONFLICT/IDEMPOTENCY_CONFLICT/FLEET_DATA_CONFLICT. Validation HTTP có fieldErrors; UI hiển thị lỗi chung cho xung đột liên trường. Không trả stack trace.

### Migration và dữ liệu cũ

`backend/prisma/migrations/20261017120000_fleet_schedules/migration.sql` thêm DriverShift, actor/version cho lịch hiện hữu, kind LEGACY cho block xe cũ, unique biển số chuẩn hóa, CHECK khoảng giờ, exclusion chồng lịch và trigger khóa/kiểm tra reservation. Không sửa migration đã áp dụng, không xóa dữ liệu, không backfill Employee/User/ca/giấy phép/cửa.

Migration chạy trong transaction; cần extension btree_gist và PostgreSQL hỗ trợ range_agg. Unique/exclusion có thể thất bại nếu dữ liệu cũ trùng biển số hoặc chồng lịch; phải đối chiếu, xử lý có truy vết rồi chạy lại, không tự gộp. CHECK trên khoảng cũ dùng NOT VALID để giữ lịch chưa đủ dữ liệu, nhưng exclusion vẫn kiểm tra các dòng tham gia. Tạo index/exclusion có thể khóa bảng; cần cửa sổ triển khai và bản sao lưu trước khi áp dụng thật. Nếu migration lỗi transaction rollback; nếu đã áp dụng và phát sinh dữ liệu mới, dùng migration sửa tiến hoặc phục hồi bản sao theo kế hoạch vận hành, không drop bảng lịch để rollback mù.

Đã thử bản SQL cuối trên database riêng `tms_fleet_migration_final`, phục hồi từ before.dump có dữ liệu cũ. Script `backend/scripts/check-fleet-migration.cjs` so count + hash toàn bộ cột cũ từng bảng: giữ nguyên 88 bảng/1.195 dòng, không sinh ca hoặc actor giả. Không phải xác nhận mọi bộ dữ liệu triển khai đều hợp lệ; database thật chưa bị ghi.

### Kiểm chứng và cách chạy

- Backend build, typecheck, lint đạt. Jest trực tiếp `node node_modules/jest/bin/jest.js --runInBand`: 38 suite/162 test đạt; 3 suite/4 test skip theo cấu hình hiện có.
- HTTP + PostgreSQL 17 thật: 16 kịch bản đạt (Node báo 17 khi tính test cha). Gồm tạo/retry/concurrent unique, cập nhật cạnh tranh/version, quyền/ID giả, Employee link/sync, ca qua đêm/chồng/tiếp giáp, expiry tới mili giây, snapshot không giấy tờ, reservation chặn lịch/trạng thái, breakdown giữ nguyên Trip, bảo dưỡng cạnh tranh reservation.
- Frontend build/typecheck đạt, lint 0 lỗi/9 cảnh báo hiện có; build cảnh báo bundle lớn.
- Playwright: 3 kịch bản đạt với HTTP/PostgreSQL thật: tạo xe/lịch qua đêm/tra cứu/reload, tạo tài xế/sửa/reload/giữ form khi 409, DISPATCHER chỉ đọc và đổi tài khoản không giữ dữ liệu cũ. Kiểm tra viewport 390×844 không tràn ngang, thao tác bàn phím trên bộ chọn ngày. Riêng HTTP409 được giả lập có chủ đích để kiểm tra UI lỗi.
- Component Vitest: 2 test đạt (giữ lương 0/gửi version, giữ form khi 409), chạy `node node_modules/vitest/vitest.mjs run src/test/EditDriverModal.test.tsx --pool=forks --maxWorkers=1 --reporter=verbose --testTimeout=10000 --hookTimeout=10000`. Lần threads treo đã dừng; không tính là đạt. Ant Design còn cảnh báo deprecation/useForm và jsdom thiếu getComputedStyle pseudo-element; các assertion và luồng trình duyệt nêu trên đều đạt.
- `git diff --check` đạt; giữ nguyên các thay đổi customer ngoài phạm vi có từ đầu phiên.

Lệnh từ backend (URL chỉ được phép trỏ localhost database test):

```powershell
$env:FLEET_TEST_DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:<port>/tms_fleet_test'
npm run build
node scripts/with-fleet-test-env.cjs --test tests/fleet-profiles.integration.cjs
node node_modules/jest/bin/jest.js --runInBand
```

Từ frontend, cùng biến môi trường: `npm run test:fleet`. Playwright tự chạy API 4017 và Vite 5177; không dùng database mặc định từ .env. Migration test: đặt FLEET_MIGRATION_TEST_URL vào localhost database có tên bắt đầu tms_fleet_migration_, đã restore trước migration, rồi chạy `node scripts/check-fleet-migration.cjs`; không chạy lặp trên bản đã migrate.

### Demo

1. Trên database đã migrate, đăng nhập ADMIN → Đội xe → tạo xe với biển số riêng, loại xe và chi nhánh hợp lệ; tạo tài xế bằng Employee có sẵn.
2. Mở Chi tiết/lịch tài xế, tạo ca 22:00 hôm nay → 02:00 hôm sau. Ca tiếp theo từ 02:00 được chấp nhận; ca chồng cùng loại bị từ chối. Thêm nghỉ trong khoảng và tra cứu thấy EMPLOYEE_LEAVE.
3. Tra cứu đúng khoảng giờ; thấy lý do, version và điều kiện chưa kiểm tra. Reload vẫn còn hồ sơ/lịch.
4. Với fixture chuyến/reservation có hiệu lực: bảo dưỡng/nghỉ xung đột bị từ chối; hỏng xe thực tế lưu thành công, hiện chuyến liên quan, Trip giữ nguyên. Không tạo/chỉnh chuyến thật chỉ để demo.
5. Mở hai form cùng version: lần lưu thứ hai nhận 409 và giữ nội dung để đối chiếu. Đăng nhập DISPATCHER thấy dữ liệu thuộc phạm vi, không có thao tác ghi.

Giới hạn: chưa triển khai lên database thật; chưa kiểm chứng E2E optimizer/publish hoặc mobile. Contract cung cấp dữ liệu và kiểm tra thời gian, không chứng nhận khả thi nhận chuyến, nghỉ đủ, đến kịp hoặc xếp/dỡ được.

---

<a id="don-kien"></a>

## 3. Nghiệm thu đơn vận tải và kiện

*Tài liệu gốc: Nghiệm thu Order vận tải – từng Package, 18/10/2026*

**Kết luận: đạt nghiệm thu luồng tạo nháp → sửa → xác nhận → tải lại → dữ liệu bàn giao điều phối trong phạm vi kiểm tra dưới đây.** 20 kịch bản HTTP/PostgreSQL và 5 kịch bản trình duyệt đạt; 162 test Jest đạt. Không phải kết luận toàn bộ điều phối/TMS hoàn thành.

Không xây lại điều phối, solver, bán lẻ hay mobile. Giữ nguyên thay đổi customer/fleet có trước nhiệm vụ. Không ghi database thật, commit, push hoặc deploy. Không cần migration ứng dụng cho hai bản sửa.

### Hiện trạng và căn cứ

Đã đọc hướng dẫn project, kế hoạch, thiết kế database, phân công, contract Package, schema/SQL ràng buộc, Orders DTO/service/controller, ResourceAccess, CustomerSelect, OrdersPage/OrderDetailDrawer và consumer packagesToCargoUnits/buildOptimizerOrders/chia đơn. Quyết định 03/10 và contract hiện hành: một pickup–một delivery; mỗi Package có UUID và số đo riêng; quantity/tổng chỉ là projection; nháp được thiếu cả cặp khung giờ, nhưng dòng/kiện/số đo/điểm phải đầy đủ theo DTO hiện tại. SERVICE_START là cửa sổ bắt đầu phục vụ; cho phép qua ngày/chồng nhau có thứ tự lấy trước giao. Chia đơn đã được duyệt theo tập kiện, không chia một kiện.

Script orders cũ trỏ tms_merge_test_20261011 nhưng test kiểm tra tms_merge_test_20261005, và có fixture xe theo schema trước VehicleType. Không chạy script này trên database khác để vượt kiểm tra đích. Bộ nghiệm thu mới tách phần Người 2, tái sử dụng API/adapter thật và có guard database riêng. Tệp ORDERS_PACKAGES.md được liên kết trong tài liệu cũ hiện không tồn tại; dùng docs/package-order-contract.md và quyết định ghi trong kế hoạch/thiết kế làm căn cứ, không suy thêm policy.

### Lỗi tìm thấy và bản sửa

| Mã | Tái hiện trước sửa | Nguyên nhân và tác động | Sửa / regression |
| --- | --- | --- | --- |
| F01 | Tạo đơn API với cửa sổ `.123Z`–`.987Z`, mở web sửa chỉ ghi chú; PATCH trả cả hai mốc thành `.000Z` | OrdersPage định dạng ngày giờ tới giây khi vào/ra form. Đổi thời gian dù người dùng không sửa giờ, có thể làm thay đổi việc làm tròn cửa sổ ở consumer | Giữ `SSS` ở cả hai chiều; test trình duyệt đối chiếu chính xác thời điểm trước/sau, reload/đăng nhập lại và API handoff |
| F02 | Tạo StopTask tham chiếu Package, không có orderId/orderStopId/allocationId; PATCH đơn trả 200 thay vì 409 | lockedOrder chỉ dò task qua Order/OrderStop, bỏ sót liên kết Package. Đơn có tác vụ cũng còn lọt danh sách điều phối mới | Dùng predicate lịch sử Package gồm task, allocation, pickup/delivery, event, load plan/placement, transfer; khóa sửa và loại khỏi danh sách chờ. Test PostgreSQL chứng minh trước sửa 200, sau sửa ORDER_REFERENCED và không được chọn lại |

File ứng dụng sửa: `backend/src/orders/orders.service.ts`, `backend/src/orders/order-contract.ts`, `backend/src/trips/trips.service.ts`, `frontend/src/pages/OrdersPage.tsx`. Consumer điều phối đọc thẳng DB nên bộ lọc `newDispatchOrderWhere` được dùng chung tại API danh sách chờ, nhận đơn tạo chuyến mới, tối ưu mới và kiểm tra lại khi tạo/apply. Không thay truy vấn sửa kế hoạch của chuyến đã phân công. Backend không xóa/chuyển tác vụ hoặc sửa Trip để xử lý lỗi; chỉ bảo vệ dữ liệu đã được tham chiếu. Không đổi cấu trúc response. Dữ liệu cũ cần đối soát giữ LEGACY_REVIEW và null; không tạo kiện đoán.

### Ma trận API/PostgreSQL

Bằng chứng: `backend/tests/order-acceptance.integration.cjs`, chạy với PostgreSQL 17 riêng. 20 kịch bản con đạt; Node báo 21 test khi tính test cha.

| # | Kịch bản | Kết quả / assertion chính |
| --- | --- | --- |
| 1 | Nháp 2 dòng/4 kiện khác tải và kích thước, đọc lại API | Đạt: 4 ID/mã riêng, liên kết đúng stop/dòng; 100010 g, 102000000 mm³; UTC đúng |
| 2 | Số đo 0/âm/lẻ, quá giới hạn gram, kiện rỗng, cửa sổ đảo/thiếu offset, tổng giả | Đạt: 400 có fieldErrors |
| 3 | Giả branch/customer/order/package; đọc/sửa/xác nhận ngoài chi nhánh | Đạt: 403/404/400 theo biên, không lộ đơn; unauthenticated 401 |
| 4 | Thiếu gram/kích thước/tọa độ, ID lặp; loại đơn ngoài B2B | Đạt: từ chối dữ liệu sai; đơn retail fixture không đọc qua API vận tải |
| 5 | Hai sửa cùng version | Đạt: chỉ một 200, còn lại 409; giữ ID dòng/stop/kiện |
| 6 | Hai create cùng key; khác payload; nhiều create khác key | Đạt: cùng kết quả khi retry, 409 khác payload; mã đơn/kiện duy nhất |
| 7 | Trigger test làm lỗi ở kiện cuối transaction | Đạt: count Order/Stop/Item/Package/ProcessedCommand không đổi; trigger test gỡ trong finally |
| 8 | Nháp thiếu khung giờ; xác nhận đủ; adapter thật | Đạt: thiếu giờ 400; đủ chuyển CONFIRMED; đủ ID kiện, stop, tải, giây UTC, 600/1200 giây phục vụ |
| 9 | Thêm/bớt kiện, xóa dòng chưa có lịch sử, sửa liên hệ | Đạt: giữ ID/mã kiện còn lại; tổng độc lập 18 g/24060006 mm³; itemId/stopId ngoài đơn bị chặn |
| 10 | Hai confirm cùng key và retry trạng thái khác | Đạt: một CONFIRMED event, Package READY; non-draft/stale/key khác payload 409 |
| 11 | Retry sửa; session hết hạn | Đạt: chỉ một UPDATED event; payload khác 409; token của session hết hạn 401 |
| 12 | Sửa cạnh tranh xác nhận | Đạt: một thành công, một 409, version tăng đúng một lần |
| 13 | Gram/thể tích vượt Number.MAX_SAFE_INTEGER | Đạt: chuỗi JSON/DB chính xác 9007199254740993 g và 1000003000003000001 mm³; adapter từ chối gram không biểu diễn an toàn thay vì làm tròn |
| 14 | Cửa sổ bắt đầu phục vụ ngắn hơn thời lượng, mili giây | Đạt: xác nhận hợp lệ; adapter ceil đầu/floor cuối, không mở rộng cửa sổ; giữ 600 giây phục vụ |
| 15 | Null số đo dữ liệu cũ, nháp và LEGACY_REVIEW | Đạt: null không thành 0; không xuất hiện trong danh sách chờ |
| 16 | Allocation hoặc PackageEvent tồn tại | Đạt: 409 ORDER_REFERENCED, giữ ID/liên kết; đơn có allocation không được chọn mới |
| 17 | Quyền chỉ đọc và phiên đã thu hồi | Đạt: đọc 200, create/update/confirm 403; sau logout 401 |
| 18 | StopTask chỉ tham chiếu Package (F02) | Đạt sau sửa: không sửa được đơn và không lọt danh sách chờ; chạy truy vấn chọn Order thật của executeAutomaticOptimization trên PostgreSQL để kiểm tra cùng ranh giới |
| 19 | Khách vừa tạo/cấp chi nhánh, chưa có đơn | Đạt: tạo đơn đầu tiên được, không cần suy phạm vi từ đơn cũ |
| 20 | Sửa cạnh tranh transaction ghi Allocation | Đạt: giữ khóa Order, quan sát pg_blocking_pids xác nhận request đang chờ, commit Allocation rồi PATCH nhận 409; version không đổi |

Ca 20 kiểm tra giao điểm transaction dùng cùng khóa Order với TripsService (create/apply). Đây là fixture ghi Allocation ở biên database, không phải chạy toàn bộ API Trip/solver/publish. Ca hai request cùng version dùng Promise.all và kiểm tra bất biến kết quả; không giả định thứ tự thắng. Không dùng sleep tùy ý để ép race.

### Trình duyệt

Bằng chứng: `frontend/tests/order-acceptance.spec.ts`, cấu hình `playwright.order-acceptance.config.ts`; API 4018 + Vite 5178, database thật riêng. Các ca:

1. Tạo nháp nhiều kiện có tải khác nhau, xem chi tiết, reload, sửa, giữ UUID, xác nhận.
2. Lỗi mạng, lỗi field, 403; form giữ dữ liệu và retry giữ key. Các lỗi này được mô phỏng bằng Playwright, không tính là bằng chứng dịch vụ ngoài.
3. Viewport 390×844, bàn phím nhập/Tab, nút lưu cuộn vào màn hình; ảnh `frontend/test-results/order-acceptance-mobile.png`.
4. F01: chỉ sửa ghi chú phải giữ mili giây; xác nhận, logout/login và lấy lại đúng Package từ API chờ điều phối.
5. Request đang chờ: form khóa, chỉ một POST; 409 giữ nội dung; đổi sang tài khoản chi nhánh khác không giữ đơn cũ và tìm kiếm trả empty.

**Kết quả cuối: cả 5 ca đạt trong một lần chạy (1,2 phút).** Đã xem ảnh viewport 390×844: form cuộn được, nút lưu trong vùng nhìn thấy. Không tính những lần chạy lỗi harness là đạt. Lỗi harness đã sửa: selector khách cũ khớp cả div/input, thao tác khi modal đang chuyển hiệu ứng hoặc login chưa hoàn tất, và rate-limit tài khoản demo tích lũy từ nhiều lần chạy. Bộ test chọn combobox đúng vai trò và chờ trạng thái UI; khi khởi tạo API riêng chỉ hết hạn counter của ba tài khoản demo và IP test, không nới/tắt rate-limit ứng dụng.

### Phạm vi tích hợp và kiểm tra

- PostgreSQL: API/auth thật, schema hiện hành, 6 CHECK/FK nghiệp vụ Package/khung giờ cùng partial indexes từ SQL migration gốc. Không mock repository. Đây là schema kiểm thử mới, không phải nghiệm thu nâng cấp migration dữ liệu thật.
- Contract điều phối: gọi chính `TripsService.buildOptimizerOrders` và packagesToCargoUnits trên Order đọc từ DB; không nhân quantity lần hai. Test executeAutomaticOptimization chạy truy vấn chọn tài nguyên/đơn thật rồi chủ động dừng bằng sentinel tại biên đã thu được danh sách, trước khi gọi dịch vụ ngoài; không coi là chạy optimizer thành công. Jest có các ca chia tập kiện, cấm mất/trùng kiện, giữ source_order/source_location, version và planned manifests. Không viết lại solver.
- Mapbox: không gọi trong lần nghiệm thu này; UI nhập tọa độ rõ ràng, hiện thiếu cấu hình bản đồ. Không dùng route giả hoặc nhận đã kiểm chứng Mapbox.
- FastAPI/OR-Tools/Redis worker/mobile: không chạy trong lần này. Test adapter không chứng minh solver/feasibility/publish hoàn chỉnh.
- Backend `npm run build`, `npm run typecheck`, `npm run lint`, Jest `node node_modules/jest/bin/jest.js --runInBand`: đạt 38 suite/162 test; 3 suite/4 test skip theo cấu hình có sẵn. Sau thay đổi bộ lọc consumer đã chạy lại Jest; lần gọi có thêm `--testPathPatterns=trips` không giới hạn suite ở phiên bản Jest hiện tại, thực tế vẫn chạy đủ 38 suite và đạt.
- Frontend `npm run typecheck`, `npm run lint`, `npm run build`: đạt; lint 0 lỗi/9 cảnh báo có trước, build cảnh báo bundle lớn. Không tắt rule để qua kiểm tra.
- Đã tự rà diff các file sửa; `git diff --check` đạt. Không sửa schema/migration ứng dụng hoặc các thay đổi customer/fleet có trước để làm test qua.

### Chạy lại và demo an toàn

Chỉ định URL localhost tới **tms_order_acceptance_20261018** bằng biến `ORDER_ACCEPTANCE_DATABASE_URL`; không dùng URL database thật. Wrapper không đọc .env, không in URL/mật khẩu. PostgreSQL phải đang chạy và user test được tạo database. Không chạy integration và browser cùng lúc vì có ca thay quyền fixture rồi phục hồi.

```powershell
# Từ backend; điền tài khoản test riêng, không đưa secret vào tài liệu/git.
$env:ORDER_ACCEPTANCE_DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:<port>/tms_order_acceptance_20261018'
npm run test:order-acceptance:prepare
npm run build
npm run test:order-acceptance
node node_modules/jest/bin/jest.js --runInBand

# Từ frontend, cùng biến môi trường
npm run test:order-acceptance
```

Prepare tạo schema chỉ khi database mới rỗng; nếu đã có bảng thì chỉ kiểm tra, không reset/truncate/db push. Dùng migrate diff tạo schema test và nguyên văn ràng buộc từ migration Package; không sửa migration cũ. Dữ liệu phát sinh có nhãn [TEST]/[ACCEPTANCE]/[PLAYWRIGHT] và UUID. Các ca phá dữ liệu có chủ đích chỉ chạm fixture; không có thông tin cá nhân thật.

Demo thủ công: từ backend chạy `node scripts/with-order-acceptance-env.cjs tests/order-acceptance-app.cjs`; từ frontend đặt VITE_API_URL=http://127.0.0.1:4018 và chạy Vite port 5178. Tài khoản test demo_auth_a, mật khẩu test nằm trong wrapper (không phải tài khoản thật). Vào /orders → chọn khách chi nhánh A → nhập hai dòng, kiện khác số đo/tải → lưu nháp → mở sửa một kiện/ghi chú → xác nhận → reload/logout/login → đối chiếu chi tiết và GET /orders/available-for-dispatch. Dùng test tự động để demo xung đột/rollback, không tạo lỗi trên dữ liệu vận hành.

### Policy và giới hạn còn mở

Tại mốc nghiệm thu đơn–kiện 18/10, hủy Order vận tải chưa được chốt. Quyết định mới ngày 03/11 cho hủy trước phân công được ghi tại [Hủy đơn vận tải](#huy-don-van-tai). Hủy sau phân công/pickup/giao một phần vẫn ngoài phạm vi.

Chưa chạy bộ orders integration cũ có solver/Mapbox và fixture schema cũ; không nhận kết quả cũ làm bằng chứng hiện tại. Chưa deploy hoặc áp dụng lên database thật. Kết luận chỉ dành cho luồng Order–Package và hợp đồng bàn giao, không phải toàn bộ TMS.

---

<a id="giam-sat-chuyen"></a>

## 4. Tra cứu và giám sát chuyến

*Tài liệu gốc: Tra cứu chuyến — contract đọc web*

Ngày 18/10/2026. Phạm vi chỉ đọc, quyền `trips.read`; không thay đổi điều phối hoặc thực thi.

### Khảo sát và nguồn dữ liệu

Mobile và API `/driver/...` đã bị gỡ theo ghi chú 16/10 trong tài liệu và mã nguồn hiện tại. **Người dùng xác nhận trong phiên 18/10: Người 3 chưa đẩy code, hiện chưa có phần đó để tích hợp.** Schema lịch sử còn tồn tại; StorageService private và outbox `trip:updated` còn hoạt động. Không có producer GPS hoặc API tổng kết completion hiện hành. Tích hợp xuyên suốt Người 3 đang chặn bởi thiếu mã nguồn hiện hành; không khôi phục nghiệp vụ mobile trong nhiệm vụ này.

| Hiển thị | Nguồn | Ý nghĩa / loại | Thiếu hoặc mâu thuẫn |
|---|---|---|---|
| Mã, chi nhánh, xe, trạng thái, version | Trip, Branch, Vehicle | Trạng thái Trip không đại diện kết quả mọi kiện | Không suy hoàn tất Order |
| Phân công, nhận/từ chối | DriverAssignment | planned start/end; respondedAt và actualEndTime là actual | ASSIGNED không phải ACCEPTED |
| Tuyến, stop/task, khung giờ | TripStop, StopTask, OrderStop | Kế hoạch hiện tại; actual tách riêng | null hiển thị chưa ghi nhận |
| Bố trí | LoadPlan mới nhất và steps/placements | Kế hoạch đã lưu, đơn vị mm | Không sinh bố trí hoặc suy custody |
| Snapshot thực thi | TripExecutionSnapshot.id/sourceTripVersion | Version nguồn của event, không phải TripPlan | Không tạo snapshot thay thế |
| Mốc thực thi | ExecutionEvent | occurredAt khác receivedAt; lịch sử phân trang | Không trả payload nội bộ |
| Pickup | PickupResult + event | LOADED / NOT_COLLECTED | Thiếu kết quả là chưa ghi nhận, không tự coi thất bại |
| Custody | DriverDeliveryState + pickup/event | ON_VEHICLE / UNLOADED / DELIVERED / FAILED | Giữ nguyên trạng thái nguồn, không dùng Package.status thay thế |
| Lần giao | DeliveryResult + DeliveryAttempt | Kết quả từng lần, recipient/reason/time | Đếm DISTINCT package đã có DELIVERED; không cộng số lần giao |
| POD | PodFile thuộc đúng attempt/stop/snapshot/assignment | UPLOADED là server đã xác minh; bytes vẫn phải đối chiếu khi mở | Pending/uploading/failed/discarded tách riêng; lỗi storage không trả thành công |
| Tổng kết kết thúc / GPS | Chưa có API/producer hiện hành | Chưa tích hợp | Hiển thị rõ giới hạn, không mô phỏng |

API riêng `/trip-monitoring`: danh sách phân trang server, lọc mã chuyến/biển số/tên tài xế, trạng thái, chi nhánh, xe/tài xế; khoảng thời gian `[from,to)` lọc **plannedStartTime**, không lọc ngày tạo. Thứ tự plannedStartTime giảm dần, id giảm dần. Snapshot đọc trong transaction RepeatableRead. Không thêm schema/migration hoặc quyền mới.

POD không trả storageKey/URL ký ra client. Mỗi lượt tải kiểm tra quyền hiện hành và quan hệ lồng nhau, đọc storage private, đối chiếu checksum/MIME/size. Response private,no-store,nosniff. Phần storage dùng lại cơ chế ký nội bộ hiện có; URL không làm ID lâu dài.

Web `/trips?trip=<uuid>` dùng URL để reload/back; socket chỉ invalidation, luôn tải API. Poll dự phòng có timeout/backoff; đổi scope unmount và xóa object URL POD. Không ghi trạng thái suy diễn vào DB.

### Kiểm chứng

Đã triển khai phần đọc độc lập trên web/backend. **Chưa hoàn tất toàn bộ yêu cầu tích hợp mobile**, không dùng fixture để nhận nghiệm thu producer thực thi.

| Kiểm tra đã chạy | Kết quả / giới hạn |
|---|---|
| Backend `npm run typecheck`, `npm run lint`, `npm run build` | Đạt |
| Frontend `npm run typecheck`, `npm run lint`, `npm run build` | Đạt; 9 warning hook hiện hữu, cảnh báo bundle lớn |
| Backend `npm run test:monitoring` | 6/6: PostgreSQL + Nest HTTP + private filesystem thật; gồm pagination/filter/scoped totals, viewer không quyền plan, cross-branch/nested links, trạng thái và planned/actual, retry delivery không đếm trùng, POD pending/hỏng/thiếu/khác scope, thu hồi quyền |
| Backend Jest toàn bộ | 38 suites / 162 tests đạt trước sửa gateway; 3 suites / 4 test PostgreSQL tự skip, không tính là đã chạy |
| Gateway + outbox sau sửa | `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath test/events/events.gateway.spec.ts test/common/services/outbox-event.publisher.spec.ts`: 2 suites / 20 tests đạt, có regression mới |
| Frontend `npm run test:monitoring` | 4/4 Playwright Chromium nối backend/DB thật: viewer, danh sách/chi tiết/reload/POD, lỗi HTTP/thử lại, Socket.IO/sự kiện lặp/cũ/reconnect, response đến muộn sau đổi chuyến, thu hồi quyền xóa POD đang mở. Lỗi mạng và trì hoãn response được tiêm tại trình duyệt; dữ liệu thành công lấy backend thật |
| Frontend `npm test` | 14 file đạt; tổng 45 test đạt, 1 test EditDriverModal timeout 5 giây. Chạy riêng `npx vitest run src/test/EditDriverModal.test.tsx --maxWorkers=1` vẫn timeout (2/2); có cảnh báo JSDOM getComputedStyle và Ant Design. File/component này đã có thay đổi trước nhiệm vụ và không được sửa trong nhiệm vụ này; test chỉ import EditDriverModal và mock api/client, không import module giám sát. Không tăng timeout/bỏ assertion để báo pass |
| `git diff --check` | Đạt; Git báo quy ước LF/CRLF ở các file hiện hữu |

Schema thử được tạo trên database trống **tms_monitor_test** trong container **tms-monitor-test-20261018**, chỉ bind `127.0.0.1:55440`. Không reset database có sẵn; không áp migration lên database vận hành. Schema test từ Prisma phù hợp kiểm chứng truy vấn đọc, **không chạy lại trigger thực thi/migration mobile**, không chứng minh các lệnh pickup/handover/complete hoặc validator.

Fixture ghi trực tiếp lịch sử để kiểm tra consumer; ảnh PNG thử được ghi qua StorageService và tải qua HTTP có quyền. Không phải người nhận/POD thật, không qua camera hoặc upload mobile. Playwright dùng tài khoản thử riêng mỗi lần để giữ nguyên cơ chế giới hạn đăng nhập, không nới quyền sản phẩm. Các endpoint `/__test/*` chỉ có trong `backend/tests/monitor-test-app.cjs`, không import vào app sản phẩm.

### API và file chính

- `GET /trip-monitoring`: query `search,status,branchId,vehicleId,driverId,from,to,page,pageSize`; pageSize tối đa 50. Response items/total/page/pageSize/fetchedAt. Progress = số stop COMPLETED / tất cả stop, số Package riêng biệt có DeliveryResult DELIVERED / Package có định danh trong manifest. Không cộng số lần giao.
- `GET /trip-monitoring/resources?search=...`: tối đa 30 xe/tài xế có chuyến trong scope, dùng cho chọn bộ lọc; không cần quyền hồ sơ tài nguyên.
- `GET /trip-monitoring/:id`: dữ liệu chọn lọc, không trả hồ sơ riêng tài xế, storageKey hay payload nội bộ. Quan hệ mâu thuẫn trả 409, không chọn nguồn tùy tiện.
- `GET /trip-monitoring/:id/events?page=...&pageSize=...`: phân trang lịch sử, có version để tránh ghép hai snapshot khác nhau.
- `GET /trip-monitoring/:id/pod/:podId`: bytes có xác thực, kiểm tra quan hệ và checksum/size/MIME; audit đọc. Chỉ JPEG/PNG/WebP. Thời hạn reservation chưa gắn không được áp lên chứng cứ đã gắn để làm mất lịch sử.
- Backend: `src/trip-monitoring/*`; frontend: `src/api/monitoring.ts`, `src/pages/TripMonitoringPage.tsx`; App/Sidebar/navigationAccess thêm `/trips` cho `trips.read`.
- Không thêm dependency, quyền hoặc schema/migration. Không đổi API mobile/planning. Gateway sửa nhánh từ chối `emitTripUpdate`: báo `scope:revoked` sau khi rời phòng để client xóa POD ngay khi server phát hiện mất quyền. Trước sửa, revalidate chạy sau leave không còn phòng để phát thông báo.
- Load Plan hiện tại hiển thị revision/bước/task/vị trí/hướng/kích thước mm; snapshot thực thi hiển thị ID/version nguồn riêng. Bản đồ dùng MapboxMap hiện có với simulation tắt; hình học LineString được đọc từ Trip, định dạng khác báo chưa hỗ trợ. Chưa kiểm chứng live Mapbox trong bài test không có token.

### Cách xem và chạy lại

Trong ứng dụng đang chạy, mở **Tra cứu chuyến** hoặc `/trips`. Người có `trips.read` không cần `trips.plan`. Chọn chi nhánh ở thanh trên, tìm/lọc chuyến, mở mã chuyến, mở điểm giao rồi chọn **Mở POD đã xác minh**. Reload giữ ID chuyến và bộ lọc; quay lại danh sách giữ query. Dữ liệu thật thiếu lịch sử/POD hiển thị thiếu, không tự seed vào database vận hành.

Để chạy kiểm chứng tách biệt, đặt `MONITOR_TEST_DATABASE_URL` trỏ database local tên chính xác `tms_monitor_test` (không dùng DATABASE_URL vận hành):

```powershell
# backend; PostgreSQL thử đã được khởi động và database trống tồn tại
npm run test:monitoring:prepare
npm run build
npm run test:monitoring
# frontend; cùng biến MONITOR_TEST_DATABASE_URL
npm run test:monitoring
```

Playwright tự mở backend 4019/frontend 5179 và đóng sau test; không deploy. Bằng chứng ảnh trong `frontend/test-results/monitor-detail.png` và `monitor-mobile-width.png`; đã kiểm tra layout desktop 1440 px và màn hình 390 px. Fixture thuộc nhóm `MONITOR-FIXTURE-BROWSER-*` gồm 5 kiện với delivered, not-collected, unloaded, reloaded/on-vehicle và failed.

### Bàn giao cho Người 3 khi có code

Đối chiếu schema/snapshot/custody/POD hiện hành trước merge. Chỉ khi producer đã có mới chạy luồng thật: nhận → start → arrive → pickup → unload/handover/POD → server/outbox → web reload/reconnect/mở POD. Đối chiếu event hoàn tất với publisher hiện tại; chưa tự đặt tên event/contract completion mới. GPS cần producer có measuredAt/receivedAt/nguồn/chất lượng và policy đã chốt. Không có lời khẳng định mobile/GPS/hoàn tất chuyến đã hoạt động từ kết quả của nhiệm vụ này.

---

<a id="dashboard"></a>

## 5. Dashboard vận hành

*Tài liệu gốc: Dashboard vận hành TMS*

Khởi đầu 20/10/2026, cập nhật 21/10/2026. Người dùng cho phép triển khai web/backend; xác nhận dùng tập ứng viên với nhãn “Đơn chờ kiểm tra điều phối”. Không chứng nhận khả thi từ số đếm này.

### Định nghĩa trước triển khai

Múi giờ hiển thị Asia/Ho_Chi_Minh. Kỳ lọc `[from,to)` gồm đầu, không gồm cuối; tối đa 366 ngày (giới hạn truy vấn kỹ thuật). Snapshot hiện tại không lọc ngày tạo. Mỗi bảng đếm theo ID thực thể, dùng quan hệ EXISTS/none thay vì cộng dòng join. Mọi truy vấn áp dụng quyền chức năng và phạm vi chi nhánh hiện hành.

| Nhãn | Nguồn / điều kiện | Thời gian / chi nhánh | Đối chiếu |
|---|---|---|---|
| Đơn chờ kiểm tra điều phối | `newDispatchOrderWhere`: B2B, CONFIRMED, COMPLETE, không allocation/task/lịch sử kiện theo contract dùng chung | Hiện tại; Order.branchId | Danh sách phân trang ngay tại Dashboard → chi tiết đơn |
| Chuyến đã lập kế hoạch | Trip.status=PLANNED | Hiện tại; scope giám sát chuyến | Bảng chuyến với cùng status, không lọc ngày |
| Chuyến đã phát hành | Trip.status=DISPATCHED | Như trên | Như trên |
| Chuyến đang thực hiện | Trip.status=IN_PROGRESS | Như trên | Như trên |
| Chuyến có mốc khởi hành thực tế trong kỳ | Trip.actualStartTime khác null, nằm trong kỳ; mọi status | Kỳ actualStartTime; scope giám sát | Bảng chuyến lọc actualStartTime |
| Chuyến hoàn tất có mốc kết thúc trong kỳ | Trip.status=COMPLETED, actualEndTime nằm trong kỳ | Kỳ actualEndTime; scope giám sát | Bảng chuyến lọc COMPLETED + actualEndTime |
| Xe có trạng thái AVAILABLE | Vehicle.status=AVAILABLE, không suy đủ lịch/đến kịp/xếp vừa | Hiện tại; homeBranchId | Danh sách Dashboard → hồ sơ xe |
| Tài xế có trạng thái AVAILABLE | Driver.status=AVAILABLE, không suy đủ bằng/ca/nghỉ/đến kịp | Hiện tại; homeBranchId | Danh sách Dashboard → hồ sơ tài xế |

### Vấn đề có căn cứ

| Nhãn | Điều kiện / bằng chứng | Giới hạn |
|---|---|---|
| Đơn xác nhận cần đối soát kiện | B2B CONFIRMED, packageDataStatus khác COMPLETE; hiển thị trạng thái nguồn và updatedAt | Schema thực tế dùng LEGACY_REVIEW (không phải tên NEEDS_REVIEW trong trao đổi); không suy dữ liệu null bằng 0 |
| Bằng lái đã hết hạn | Driver.licenseExpiry trước ngày địa phương của snapshot; dùng minimumLicenseDate chung với fleet | Bằng còn hiệu lực hết ngày, không tự kiểm tra tương thích hạng bằng |
| Xe có lịch không khả dụng hiện tại | Có VehicleUnavailability ACTIVE, startsAt ≤ snapshot < endsAt hoặc endsAt null | Một xe đếm một lần dù nhiều lịch; không kết luận mọi chuyến tương lai bị ảnh hưởng |

Các vấn đề là thông tin cần xem xét, không tự đổi trạng thái hay sinh workflow đóng cảnh báo. Cảnh báo xung đột chuyến, kết quả giao chưa xử lý, GPS cũ và nguy cơ trễ chỉ được bổ sung khi có nguồn/contract/policy phù hợp. Mobile/API thực thi đã bị gỡ; lịch sử còn trong DB không chứng minh producer đang hoạt động.

### Phạm vi triển khai

Tái sử dụng Nest/Prisma, AuthContext, API client, newDispatchOrderWhere, quy tắc ngày hết hạn của fleet, scope giám sát chuyến, Socket.IO/outbox. Dashboard chỉ đọc. Không thêm dependency, migration, cache hoặc index khi chưa có bằng chứng cần thiết.

API tổng hợp và danh sách dùng RepeatableRead từng response; hai lần tải khác nhau có thể khác khi dữ liệu đã thay đổi, luôn hiển thị thời điểm lấy dữ liệu. Danh sách đối chiếu trả total trong cùng snapshot với items. Không lưu snapshot dài hạn hay hứa số liệu giữa hai request luôn bất biến.

### API và file chính

- `GET /dashboard/summary?from=...&to=...&branchId=...`: bắt buộc hai mốc ISO có timezone; trả metrics, issues, fetchedAt, timezone, scope và số chuyến COMPLETED thiếu actualEndTime. Chỉ số không có quyền trả null; không có bất kỳ quyền đọc TMS nào trong phạm vi trả 403. Không trả GPS, giấy tờ tài xế hoặc POD.
- `GET /dashboard/items?metric=...&page=1&pageSize=20&branchId=...`: metric thuộc candidateOrders/reviewOrders/availableVehicles/availableDrivers/expiredDrivers/blockedVehicles. pageSize tối đa 50; total và items đọc cùng snapshot. Backend kiểm tra quyền tương ứng, không tin ID chi nhánh.
- `/trip-monitoring` thêm `timeBasis=plannedStartTime|actualStartTime|actualEndTime`; mặc định giữ plannedStartTime để không đổi consumer cũ. Có from/to thì áp dụng `[from,to)` lên mốc được chọn. Dashboard dùng danh sách này, mở `/trips?trip=<id>` bằng quyền trips.read, không cần trips.plan.
- Backend: `src/dashboard/*`, `src/trip-monitoring/monitoring-scope.ts`, DTO/service giám sát và đăng ký trong AppModule.
- Web: `src/pages/DashboardPage.tsx`, `src/api/dashboard.ts`; App hiểu đường dẫn có query, OrdersPage mở `?order=<id>`, FleetPage mở `?kind=vehicles|drivers&resource=<id>`. Navbar giới hạn chiều rộng tên chi nhánh dài. AuthContext nhớ lựa chọn chi nhánh theo ID tài khoản trong sessionStorage, kiểm tra lại bằng profile hiện hành; đây chỉ là lựa chọn giao diện, quyền vẫn lấy server.
- Không thêm thư viện, lockfile, migration/index, schema hoặc quyền mới. Các migration/customer/fleet đang có trong workspace thuộc công việc trước phiên này; không áp dụng lên dữ liệu vận hành.

### Độ mới và lỗi

Socket.IO chỉ nhận invalidation `trip:updated`, gom trong 300 ms và đọc lại API; không lấy payload socket để sửa số đếm. Reconnect tải lại. Khi chọn một chi nhánh có quyền trips.read, dùng room hiện hành; chế độ tất cả chi nhánh dựa vào polling vì gateway hiện tại chỉ giữ một room chi nhánh. Đơn/hồ sơ chưa có invalidation chung, dùng polling 30–60 giây và nút Làm mới.

Polling không gửi khi trang ẩn, tải lại khi hiện; sau ba vòng lỗi liên tiếp dừng tự thử. Timeout HTTP 12 giây. Mỗi khu vực có lỗi riêng; dữ liệu cùng bộ lọc được giữ với nhãn “Dữ liệu cũ” và thời điểm gốc. Đổi bộ lọc/phạm vi loại response cũ; 401/403 hoặc scope:revoked xóa snapshot được bảo vệ. Việc thu hồi được phát hiện qua API, gateway hoặc refresh profile, không phải cơ chế push tức thời cho mọi loại dữ liệu.

Không có producer mobile/GPS hiện hành; không dựng bản đồ xe hoặc hiệu suất giả. Chuyến thiếu actualEndTime không được gán vào một kỳ bằng createdAt/plannedEndTime. Không có stop/manifest hiển thị chưa có dữ liệu, không dùng 0/0 như tiến độ thật. Chưa bổ sung ngưỡng sắp trễ, GPS cũ, hạng bằng tương thích hay quy trình xử lý kết quả giao; không tự chốt các policy này.

### Kiểm chứng

- Frontend `npm run typecheck`, `npm run lint`, `npm run build`: đạt; lint còn 9 warning hook hiện hữu, build cảnh báo bundle lớn.
- Frontend `npm run test:dashboard` (lượt cuối chạy CLI Playwright trực tiếp cùng config): **5/5 đạt**, Chromium nối backend/PostgreSQL thật. Gồm số thẻ/danh sách, mở đơn/chuyến/hồ sơ bằng tài khoản chỉ đọc, Back/reload, bàn phím và viewport 390 px không tràn ngang; lỗi mạng từng khu vực/dữ liệu cũ/thử lại; response đến muộn khi đổi kỳ/chi nhánh; Socket.IO thật với invalidation lặp/cũ/reconnect; đổi tài khoản, hai chi nhánh được cấp, lựa chọn ALL và thu hồi quyền. Chỉ lỗi mạng/trì hoãn response được tiêm tại trình duyệt, không mock dữ liệu thành công.
- Kiểm tra trực quan phát hiện tên chi nhánh dài gây tràn Navbar trên 390 px; đã sửa chiều rộng và chạy đạt lại. Ca chọn chi nhánh trong test dùng ArrowDown để thao tác bộ chọn Ant Design bằng bàn phím, không force-click qua lớp hiển thị. Ảnh: `frontend/test-results/dashboard-desktop.png`, `frontend/test-results/dashboard-mobile.png`.
- Backend `npm run typecheck`, `npm run lint`, `npm run build`: đạt.
- `npm run test:dashboard` backend: 5 nhóm con đạt (Node báo 6 test gồm test cha), HTTP Nest + PostgreSQL 17 thật. Fixture hai chi nhánh riêng mỗi lần chạy, đơn tạo trước kỳ, nhiều trạng thái, hai phân công cùng chuyến, một đơn chia hai chuyến, package-only task history; kiểm tra biên đầu/cuối tới mili giây, pageSize, scope giả mạo, quyền thu hồi, bằng hết hạn/tới hết ngày và một xe nhiều lịch không đếm trùng.
- `npm run test:monitoring` backend: 5 nhóm con đạt (6 test gồm cha), hồi quy danh sách/chi tiết/phạm vi, nhiều lần giao cùng kiện, actual/planned và POD.
- Backend Jest: 38 suites / 163 test đạt; 3 suites / 4 test PostgreSQL skip theo cấu hình có sẵn, không nhận là đã chạy.
- Frontend Vitest `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --pool=forks`: 14 file / 44 test đạt; 2 test `EditDriverModal.test.tsx` timeout 5000 ms. File/component đó đã thay đổi từ trước nhiệm vụ, không được sửa trong nhiệm vụ Dashboard, không import Dashboard/AuthContext/Navbar; hiện tượng timeout đã được ghi trong [mục giám sát chuyến](#giam-sat-chuyen). Không nới timeout hoặc giảm assertion để nhận pass. Lần chạy mặc định trước đó bị treo đã dừng, không tính là đạt.
- `git diff --check`: đạt (cảnh báo LF/CRLF từ quy ước Git).

Database thử mới `tms_dashboard_test` ở container `tms-dashboard-test-20261020`, bind `127.0.0.1:55441`. Chuẩn bị schema chỉ khi database thử trống, không reset dữ liệu có sẵn. Schema lấy từ Prisma để kiểm chứng truy vấn đọc, không chứng minh trigger/migration/lệnh thực thi mobile. Regression giám sát dùng database thử `tms_monitor_test` riêng. Không ghi database vận hành, commit, push hay deploy.

### Chạy và demo đối chiếu

Đặt `DASHBOARD_TEST_DATABASE_URL` tới localhost database tên chính xác `tms_dashboard_test`; không dùng DATABASE_URL vận hành. Từ backend chạy `npm run test:dashboard:prepare`, `npm run build`, `npm run test:dashboard`. Sau đó từ frontend chạy `npm run test:dashboard` với cùng biến môi trường. Không chạy hai suite Dashboard đồng thời vì fixture kiểm tra thu hồi quyền. Playwright tự mở API 4020, Vite 5180 và đóng sau test; endpoint `/__test/*` chỉ có trong test app.

Trong ứng dụng: mở **Tổng quan Vận hành** (`/` hoặc `/dashboard`), chọn chi nhánh và kỳ. Nhấn **Đối chiếu** trên thẻ để xem total của danh sách cùng điều kiện, rồi mở mã đơn/chuyến/hồ sơ; Back và reload giữ bộ lọc. Đơn ứng viên vẫn hiện khi đổi sang kỳ không chứa ngày tạo của nó. Thẻ chuyến hiện tại không lọc kỳ; thẻ khởi hành/kết thúc lọc đúng actual. Đổi sang chi nhánh không có dữ liệu hiển thị rỗng hợp lệ; lỗi API phải hiện lỗi, không biến thành zero. Dữ liệu vận hành không được tự seed để demo.

Fixture trình duyệt có hai ứng viên ở A và một ở B; A có một PLANNED, một DISPATCHED, một IN_PROGRESS. Kỳ 02/01/2031 00:00 → 03/01/2031 00:00 giờ Việt Nam có hai mốc khởi hành thực tế và một COMPLETED có mốc kết thúc; mốc đúng cuối kỳ nằm ở kỳ kế tiếp. Một COMPLETED thiếu mốc kết thúc được báo thiếu dữ liệu riêng.

---

<a id="database-20261016"></a>

## 6. Biên bản đồng bộ database 16/10/2026

*Tài liệu gốc: Biên bản đồng bộ database ngày 16/10/2026*

### Phạm vi được người dùng xác nhận

- Nhánh làm việc: `feat/web-admin`, commit `bee8ff6`.
- Người dùng xác nhận tác giả Git là `chinh` và chọn đồng bộ cả năm migration mobile còn thiếu, dù chức năng mobile đã được gỡ.
- Không sửa code ứng dụng, schema Prisma, nội dung migration cũ hoặc checksum lịch sử.

### Đã áp dụng

1. `20261009090000_driver_trip_execution`
2. `20261010090000_driver_pickup_results`
3. `20261010140000_driver_delivery_pod`
4. `20261012090000_driver_pod_history_guard`
5. `20261013090000_driver_trip_completion`

Đã kiểm tra danh sách pending khớp chính xác năm mục này trước khi chạy Prisma migrate deploy trên bản sao và database đang cấu hình. Không áp dụng migration khác.

### Sao lưu và kiểm chứng

- Sao lưu toàn bộ schema `public`, dữ liệu và `_prisma_migrations` bằng PostgreSQL 17 pg_dump dạng custom. Đây không phải bản sao lưu toàn bộ các schema hạ tầng Supabase.
- Bản sao lưu trên máy thực hiện: `C:/Users/ASUS/.codex/backups/tms-chinh-20261016/before.dump` (19.702.890 byte), không đưa vào Git.
- Đã phục hồi vào PostgreSQL 17 cô lập, cài `btree_gist` để phục hồi ràng buộc lịch, rồi thử thành công cả năm migration trước khi cập nhật database đang dùng.
- Trên cả bản sao và database đang dùng: đối chiếu số dòng và hash nội dung các cột cũ của 82 bảng không thuộc nhóm quyền/lịch sử migration; không phát hiện thay đổi.
- So sánh riêng với bản sao lưu: giữ nguyên 18 permission và 27 role-permission cũ; chỉ thêm một permission `driver.trips.execute` và một liên kết quyền tương ứng như migration quy định.
- Giữ nguyên toàn bộ bản ghi của 10 migration đã áp dụng trước đó; thêm năm bản ghi thành công.
- Truy vấn Prisma `findFirst` thành công với DriverAssignment, DeliveryResult, TripExecutionSnapshot, PickupResult, DriverDeliveryState, PodFile, DeliveryAttempt và ExecutionEvent. Lỗi thiếu cột P2022 đã tái hiện trước đó không còn ở các truy vấn này.
- `prisma migrate status`: 15 migration, không còn migration pending.
- `public` tăng từ 85 lên **88 bảng**: 86 bảng tương ứng model, một bảng liên kết `_LoadPlanStepTasks`, một bảng `_prisma_migrations`.

### Giới hạn và khác biệt còn lại

- Chỉ kiểm chứng nâng cấp database, bảo toàn dữ liệu và truy vấn Prisma; chưa nghiệm thu lại luồng UI/mobile hoặc mọi nghiệp vụ ghi dữ liệu.
- `prisma migrate diff` vẫn có khác biệt khóa ngoại: các FK bổ sung bằng SQL (`allocation_package_item_fk`, `execution_stop_trip_fk`), tên FK và hành vi ON UPDATE NO ACTION trong migration so với CASCADE mặc định trong Prisma. Không thực thi SQL diff để tránh xóa ràng buộc hoặc tự thay đổi hành vi ngoài năm migration đã duyệt.
- Chênh lệch checksum lịch sử vẫn được giữ nguyên: bảy file khác cách xuống dòng; baseline và migration hợp nhất còn khác nội dung. Không sửa lịch sử để làm kết quả trông khớp.
- Các constraint NOT VALID vẫn giữ trạng thái do migration quy định; không tuyên bố mọi dữ liệu lịch sử đã được validate.
- Các migration có transaction riêng. Nếu cần phục hồi sau khi có dữ liệu mới, cần đối soát và thử trên bản sao; không tự reset hoặc ghi đè database bằng backup.

---

<a id="database-khach-hang"></a>

## 7. Biên bản migration khách hàng 17/10/2026

*Tài liệu gốc: Áp dụng migration khách hàng — 17/10/2026*

Người dùng xác nhận cho phép sao lưu và áp dụng migration quản lý khách hàng lên database thật đang cấu hình trong backend. Nhánh: `feat/web-admin`.

### Phạm vi và kết quả

- Kiểm tra chỉ còn đúng `20261016180000_transport_customers` chưa áp dụng; chỉ chạy migration này bằng Prisma migrate deploy. Không seed, reset, db push hoặc sửa lịch sử migration cũ.
- Tạo bản sao lưu mới bằng PostgreSQL 17 pg_dump custom, gồm schema public, dữ liệu và lịch sử migration. Không bao gồm toàn bộ schema hạ tầng Supabase.
- Backup: `C:/Users/ASUS/.codex/backups/tms-customers-20261017/before.dump`, 19.739.949 byte, ngoài Git.
- Phục hồi thành công backup vào PostgreSQL 17 riêng `tms_customers_livecheck_20261017`, có btree_gist; chạy migration và kiểm chứng trước khi áp dụng lên database thật. Lần phục hồi đầu dừng vì schema public mặc định đã tồn tại; xử lý schema rỗng trên database thử riêng rồi phục hồi lại thành công, không tác động database thật.
- Database thật: **89 bảng public**, gồm 87 bảng model, một bảng liên kết ngầm và bảng lịch sử migration; **16 migration thành công**, không còn pending theo đối chiếu lịch sử với thư mục migration.
- Giữ nguyên số dòng/hash nội dung các cột cũ của **85 bảng** ngoài nhóm quyền và lịch sử migration, gồm toàn bộ **12 Customer**. Kiểm tra riêng giữ nguyên các permission, role-permission và toàn bộ bản ghi migration cũ.
- Thêm hai permission `customers.write`, `customers.manage` và ba role-permission theo migration đã review.
- Tất cả khách cũ có version 1 và retailPhoneKey bằng số điện thoại trước nâng cấp; thêm **13 quan hệ khách–chi nhánh**, khớp chính xác DISTINCT từ đơn B2B_TRANSPORT.
- **5 khách chưa có phạm vi**: không tự cấp chi nhánh; ADMIN cần cấp theo nghiệp vụ trước khi dispatcher sử dụng.
- Truy vấn Prisma Customer kèm branches và CustomerBranch thành công trên database thật. Không ghi dữ liệu demo để kiểm tra.

### Vận hành và giới hạn

Code mới cần dùng cùng Prisma Client/schema đã cập nhật; không chạy checkout bản cũ còn upsert bằng unique phone. Chưa commit, push hoặc deploy ứng dụng. Kiểm thử luồng ghi UI/API được thực hiện trên database riêng, không tuyên bố đã chạy end-to-end trên production.

Không sửa các drift/checksum lịch sử được ghi trong biên bản ngày 16/10. Nếu cần phục hồi sau khi phát sinh dữ liệu mới, phục hồi backup trên database riêng để đối soát; không tự ghi đè database thật hoặc khôi phục unique phone vì số điện thoại vận tải đã được phép trùng.

Kết quả kiểm chứng dạng JSON nằm cùng thư mục backup (`restored-verified.json`, `live-verified.json`); không chứa hồ sơ liên hệ hoặc chuỗi kết nối.

---

<a id="huy-don-van-tai"></a>

## 8. Hủy đơn vận tải trước phân công — 03/11/2026

### Chính sách đã xác nhận

Người dùng xác nhận toàn bộ đề xuất trong phiên triển khai: ADMIN/DISPATCHER có `orders.write` theo phạm vi được cấp được hủy đơn B2B DRAFT/CONFIRMED chưa có phân công hay lịch sử vận chuyển. Bắt buộc lý do. Order và mọi Package của các dòng hàng sang CANCELLED, tăng version, giữ nguyên ID, stop, dòng hàng và lịch sử. Không sửa/xác nhận lại/phục hồi đơn đã hủy. Không gỡ phân công, sửa chuyến, trả hàng hay hủy sau pickup. Đây là phần POL02/BR14 trước phân công, không chốt phí hủy hoặc các luồng sau phân công.

### API và dữ liệu

- `POST /orders/:id/cancel`, quyền `orders.write`; body `{ "version": 1, "reason": "Khách yêu cầu hủy" }`, header `Idempotency-Key` theo quy ước 16–100 ký tự chữ/số/`_`/`-`. Version nguyên 1–2147483647; lý do chuỗi có ký tự khác khoảng trắng, tối đa 1000 ký tự. Không nhận actor, trạng thái đích, chi nhánh hoặc thời điểm từ client.
- Trả 201 cùng response Order. Trong một transaction: đổi trạng thái/tăng version Order và Package, ghi OrderEvent `CANCELLED` với from/to, actor, thời điểm DB, payload lý do đã trim, và hoàn tất ProcessedCommand. Không thêm schema/migration hoặc permission; không backfill thông tin giả cho đơn cũ.
- Response Order có `cancellation: {reason, actorUserId, actorName, occurredAt} | null`. Null nghĩa là chưa có sự kiện truy vết, kể cả đơn CANCELLED cũ. Chỉ trả trong scope `orders.read` hoặc response lệnh `orders.write` đã được kiểm tra.
- GET chi tiết và kết quả lệnh mới có `cancellationAllowed`: backend dùng cùng kiểm tra quan hệ với lệnh hủy để quyết định hiển thị nút. Giá trị này là gợi ý tại lúc đọc; transaction vẫn kiểm tra lại. Response retry là kết quả cũ; GET chi tiết trả hiện trạng.
- Cùng actor/type/key và cùng payload trả kết quả cũ, không thêm sự kiện. Khác payload trả `IDEMPOTENCY_CONFLICT`. Retry đi qua xác thực/quyền hiện hành và kiểm tra lại scope của Order trước khi trả dữ liệu. Lệnh mới cho đơn đã CANCELLED trả `ORDER_ALREADY_CANCELLED` (409).

Lỗi quan trọng: 401 phiên không hợp lệ, 403 `PERMISSION_DENIED`, 404 đơn không tồn tại/ngoài scope; 409 `ORDER_VERSION_CONFLICT`, `ORDER_CANCEL_STATE`, `ORDER_ASSIGNMENT_EXISTS`, `ORDER_EXECUTION_EXISTS`, `ORDER_RECONCILIATION_REQUIRED`. Không trả mã chuyến hoặc dữ liệu chi nhánh khác trong lỗi hủy. API hủy bán lẻ từ chối B2B với 404, kể cả ADMIN, để không đi vòng qua version/quyền/khóa của lệnh hủy vận tải.

### Ranh giới lịch sử và khóa

Hủy lấy `FOR UPDATE` trên Order trong transaction ReadCommitted, cùng khóa row mà create thủ công và apply tự động đang sử dụng. Điều phối lấy khóa advisory tài nguyên trước row Order; hủy chỉ lấy row Order, không lấy khóa xe/tài xế sau đó nên không tạo chiều khóa ngược. Khóa idempotency `4201` có trước khóa Order theo quy ước OrdersService.

Sau khóa, kiểm tra Allocation ở cả đường OrderItem và Package; StopTask qua Order/OrderStop/Package/Allocation; pickup/delivery, actual task, execution event, PackageEvent, load plan/placement, transfer, các mốc giữ/giao hàng; OrderEvent có lịch sử ngoài tạo/sửa/đối soát/xác nhận; inventory reservation, nguồn/điểm bán lẻ; PackageItem và mapping cũ/mâu thuẫn. Trạng thái kiện phải DRAFT với đơn DRAFT hoặc READY với đơn CONFIRMED; manifest phải COMPLETE và số kiện khớp dòng. Quan hệ cũ RELEASED hoặc task chỉ trỏ Package cũng chặn; không tự xóa liên kết để cho hủy.

ResourceReservation chỉ gắn Trip/xe/tài xế trong schema hiện tại, không gắn trực tiếp Order. Bất kỳ Allocation/StopTask của Order tới Trip đã đủ chặn hủy, bất kể reservation của Trip còn hiệu lực hay đã giải phóng. InventoryReservation có OrderId được kiểm tra trực tiếp.

Hủy commit trước: điều phối đọc lại sau khóa, loại CANCELLED và/hoặc phát hiện version thay đổi. Phân công commit trước: hủy đọc trạng thái/quan hệ mới và từ chối. Job đang tính không khóa nghiệp vụ hủy và không bị hủy theo; proposal/candidate đã lưu bị từ chối tại apply. Claim APPLYING rollback nếu kiểm tra lại thất bại. Không sửa solver/validator hay nội dung snapshot cũ.

### Web và độ mới

Mở Quản lý đơn → Chi tiết → Hủy đơn. Dialog hiển thị mã đơn, tác động, lý do; có loading và khóa submit bằng ref. API lỗi giữ lý do/key cho payload không đổi. 409 yêu cầu tải lại để đối chiếu, khóa gửi tiếp; không tự thay version và retry. Chỉ thông báo thành công sau response backend; chi tiết hiện lý do, người và giờ UTC+7, reload vẫn giữ dữ liệu. Bộ lọc CANCELLED dùng API danh sách hiện có.

Danh sách chờ điều phối thủ công/tự động và Dashboard dùng `newDispatchOrderWhere` chỉ lấy CONFIRMED, nên lần tải kế tiếp không còn đơn hủy. Giữ cơ chế hiện có: Dashboard polling 30–60 giây/nút Làm mới; màn hình điều phối tải lại khi mở/làm mới. Không thêm sự kiện socket mới hoặc outbox không có consumer. OrderEvent là audit nghiệp vụ, ghi cùng transaction; không phát thông báo trước commit. AuthContext/App hiện có hủy request và remount nội dung khi tài khoản/scope đổi; modal hủy bỏ qua response sau unmount.

File chính: `backend/src/orders/{orders.service,orders.controller,order-contract}.ts`, `dto/cancel-order.dto.ts`; `frontend/src/components/CancelOrderModal.tsx`, `OrderDetailDrawer.tsx`, `pages/OrdersPage.tsx`, API client và types Order. Giữ nguyên thay đổi quản trị tài khoản/chi nhánh có trước nhiệm vụ.

### Kiểm chứng và cách chạy

PostgreSQL 17 riêng: container `tms-order-cancel-test-20261103`, bind `127.0.0.1:55443`, database `tms_order_acceptance_20261018`. Dùng guard của `with-order-acceptance-env.cjs`; không đọc `.env` vận hành. Schema thử được tạo khi trống bằng script acceptance hiện có, gồm sáu constraint nghiệp vụ của migration đơn–kiện. Không reset/truncate, không migration dữ liệu thật.

Đặt `ORDER_ACCEPTANCE_DATABASE_URL` tới database thử trên. Trong backend:

```powershell
npm run test:order-acceptance:prepare
npm run build
node scripts/with-order-acceptance-env.cjs --test --test-concurrency=1 tests/order-cancellation.integration.cjs tests/order-acceptance.integration.cjs
```

Các option Node phải đứng trước tên file. Hai suite dùng chung fixture quyền nên chạy tuần tự; chạy song song gây nhiễu ca thu hồi quyền và đếm rollback. Lượt chạy tuần tự đạt **36/36** (34 nhóm con + 2 test cha): 14 nhóm hủy/cạnh tranh và 20 nhóm hồi quy đơn–kiện. Bao gồm hai trạng thái hợp lệ, validation/quyền/scope, lịch sử/mapping cũ/reservation, hủy–hủy/xác nhận/sửa, rollback tại ghi event, idempotency/quyền retry, giữ ID, loại ứng viên/Dashboard, job đang tính/candidate cũ và chặn hủy B2B qua service bán lẻ trên dữ liệu PostgreSQL thật.

`order-cancellation-races.cjs` chạy transaction create/apply thật trên PostgreSQL. Test chặn sau khóa row thật, quan sát `pg_blocking_pids` để chứng minh lệnh kia thực sự phải chờ; cả bốn tổ hợp thủ công/tự động × hủy/phân công commit trước đạt. Chỉ Mapbox/spatial response và proposal là fixture kiểm thử; không lấy các ca này làm bằng chứng tích hợp Mapbox/OR-Tools thật. Không đổi hoặc nới validator sản phẩm.

Trong frontend, cùng biến môi trường:

```powershell
node node_modules/@playwright/test/cli.js test --config playwright.order-cancellation.config.ts
```

Chromium nối Nest/PostgreSQL thật: **6/6 đạt**. Kiểm tra xác nhận/lý do bắt buộc, chống submit lặp, reload truy vết, ứng viên điều phối, lỗi mạng giữ key/lý do, 403, version cũ bằng lệnh xác nhận thật, bàn phím/390 px, 401 và đổi tài khoản/chi nhánh. Ca cuối mở màn hình điều phối tự động và Dashboard thật, đối chiếu đơn biến mất và số ứng viên giảm đúng một sau hủy. Thành công không mock; mạng/401/403 được tiêm lỗi tại trình duyệt. Đã xem ảnh `frontend/test-results/order-cancellation-desktop.png` và `order-cancellation-mobile.png` do suite tạo (lượt Playwright sau có thể dọn thư mục kết quả).

Backend/frontend typecheck, lint và build đạt; frontend còn 9 cảnh báo hook hiện hữu và cảnh báo kích thước bundle. Jest chạy trực tiếp `node node_modules/jest/bin/jest.js --runInBand`: 38 suite/163 test đạt, 3 suite/4 test bỏ qua theo cấu hình. Sau khi bổ sung chặn API bán lẻ, chạy lại riêng `test/sales-orders/sales-orders.service.spec.ts`: 2/2 đạt; suite PostgreSQL phía trên cũng chạy lại sau thay đổi này. Frontend `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --pool=forks`: 15 file/45 test đạt, 2 test trong `EditDriverModal.test.tsx` timeout 5000 ms. Đây là lỗi đã ghi nhận ở mục Dashboard; component và test đó không được sửa trong nhiệm vụ hủy đơn. Không nới timeout/giảm assertion, không báo toàn bộ Vitest đạt.

Hồi quy trình duyệt đơn–kiện: `node node_modules/@playwright/test/cli.js test --config playwright.order-acceptance.config.ts` đạt **5/5**, gồm tạo/sửa/xác nhận, lưu–reload giữ ID kiện và thời gian, lỗi API giữ form/key, pending/version, màn hình nhỏ/bàn phím và đổi tài khoản.

Kiểm tra tiếp ngày 04/11/2026: đã tái hiện hai timeout `EditDriverModal` khi chạy toàn bộ Vitest. Đo tạm từng bước cho thấy render khoảng 1,3 giây, riêng `getByRole` quét toàn form để tìm nút Lưu mất khoảng 5,4 giây trong jsdom. Đổi test sang tìm nhãn trước, lấy button chứa nhãn rồi kiểm tra role, accessible name, enabled và chờ visible trước khi click. Giữ nguyên timeout 5000 ms, các assertion lương 0/version/giữ form khi xung đột và component thật; không thay logic ứng dụng. Đã gỡ instrumentation. Lượt cuối `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --pool=forks` đạt **16 file/47 test**, không bỏ qua, trong 64,01 giây. Typecheck và lint đạt (lint toàn frontend còn 9 cảnh báo hiện hữu). Cảnh báo jsdom scrollbar và Ant Design deprecated vẫn xuất hiện; hai timeout ghi ở biên bản 03/11 phía trên đã được xử lý bằng thay đổi test này.

Demo: tạo đơn nháp có kiện → xác nhận → mở chi tiết → Hủy đơn, nhập lý do → xác nhận hủy → reload → lọc CANCELLED và xem truy vết → tải lại danh sách chờ điều phối/Dashboard để đối chiếu không còn ứng viên đó. Không có migration mới cần áp dụng. Chưa commit, push, deploy hoặc ghi database vận hành.

---

<a id="nhat-ky-thao-tac"></a>

## 9. Nhật ký thao tác quản trị — 05/11/2026

**Quyền đã chốt:** chỉ ADMIN với grant COMPANY hiện hành, branchId null; gồm sự kiện tài khoản/quyền/đổi mật khẩu. DISPATCHER không được đọc. Không thêm role/permission, không cấp quyền bằng username. Quyền đọc audit độc lập với quyền đọc đối tượng đích; API đích vẫn kiểm tra scope/tồn tại. Nhóm hỗ trợ: đơn vận tải, khách vận tải, xe/tài xế, liên kết Employee, lịch khả dụng/nghỉ, tài khoản và chi nhánh. [Bảng nguồn và giới hạn dữ liệu cũ](#audit-log-survey).

### Màn hình và API

- Menu **Nhật ký thao tác**, URL `/audit-logs`. Bộ lọc theo khoảng ngày giờ, ID actor, loại đối tượng/thao tác, ID đối tượng và ID chi nhánh đã ghi nhận. Không tìm tùy ý trong payload hoặc tải toàn bộ nhật ký. Khoảng mặc định là bảy ngày lịch tính đến hết hôm nay theo giờ Việt Nam.
- `GET /audit-logs?from=<ISO có timezone>&to=<ISO có timezone>&page=1&pageSize=20`. Khoảng `[from,to)`, tối đa 93 ngày; page 1–10000, pageSize 1–100. Optional: `actorUserId`, `entityType`, `action`, `entityId`, `branchId`. ID lọc chính xác, tối đa 100 ký tự chữ/số/`_`/`-`; action chữ in hoa/`_` tối đa 60. Không nhận trường thừa.
- `GET /audit-logs/:source/:id`, source `AUDIT_LOG` hoặc `ORDER_EVENT`. ID không tồn tại/ngoài nhóm nguồn quản trị trả 404. Không có endpoint sửa/xóa/khôi phục.
- Danh sách và tổng số dùng cùng predicate, cùng snapshot RepeatableRead. Thứ tự `timestamp DESC, id DESC, source DESC` (nguồn là khóa phân biệt cuối). Offset pagination giữ thứ tự xác định cho cùng dữ liệu; bản ghi mới có thể dịch vị trí trang giữa hai lần tải, không tuyên bố đây là snapshot xuyên suốt phiên xem.
- API trả `Cache-Control: private, no-store`; không lưu nội dung audit vào localStorage/sessionStorage. URL giữ bộ lọc/trang/chi tiết cho Back/reload. Request cũ bị bỏ khi đổi bộ lọc hoặc phiên/scope; 403 xóa dữ liệu và vô hiệu hóa response còn chờ.
- Thời điểm hiển thị Asia/Ho_Chi_Minh. Tên actor được chú thích là **tên hiện tại**; không dựng username/nhãn lịch sử. Không có actor thì nói rõ chưa ghi nhận, không tự coi là hệ thống. Không có giá trị cũ thì hiển thị chưa ghi nhận.
- Chi nhánh làm việc ở thanh trên không giới hạn audit của ADMIN COMPANY. Bộ lọc riêng chỉ dùng metadata lịch sử hợp lệ; bỏ lọc để xem cả các dòng chưa xác định scope. Không suy chi nhánh từ actor/tài nguyên hiện tại.
- Bộ chuyển backend có allowlist theo entity/action, không trả raw `details`/`changeSummary`, mật khẩu/hash/token, signed URL, giấy tờ tài xế, POD hoặc snapshot Order cũ đầy đủ. Lý do được render như văn bản. Nhãn hành động không nhận diện chỉ có thông tin cơ bản.

Liên kết mở đơn/khách/xe/tài xế/tài khoản/chi nhánh cụ thể. Lịch mở tài nguyên liên quan khi nguồn có resourceId. Nếu đối tượng không còn truy cập được, màn hình đích hiển thị lỗi; lịch sử vẫn giữ nguyên. Màn hình chi nhánh đọc mới `/branch-detail?branch=...` dùng API `branches.read`, không trao quyền sửa.

### Điểm ghi và migration

Giữ nguyên các transaction nghiệp vụ; bổ sung `auditBranchIds` cho các lần ghi mới của Order, sửa Customer, tạo/sửa Vehicle/Driver, liên kết Employee và lịch fleet. Không thêm AuditLog trùng OrderEvent. Dữ liệu tài khoản, chi nhánh và các sự kiện khác tiếp tục dùng nguồn đã có. Không backfill actor/scope/giá trị trước-sau hoặc sửa/xóa audit cũ.

Schema chỉ bổ sung khai báo hai index tương ứng migration `20261105100000_audit_lookup_indexes`: AuditLog `(timestamp,id)`, OrderEvent `(occurredAt,id)`, phục vụ lọc toàn công ty theo thời gian. Đã chạy SQL index trên PostgreSQL test có dữ liệu và đối chiếu count/hash toàn bộ hai bảng trước/sau. Không thay dữ liệu hoặc permission. CREATE INDEX thông thường có khóa ghi: trước triển khai bảng lớn cần backup, thử trên bản phục hồi và bố trí thời gian bảo trì; rollback riêng hai index nếu cần. **Chưa áp migration này hoặc migration pending có trước lên database thật.**

File chính: `backend/src/audit-logs/*`, `backend/prisma/schema.prisma`, migration index; metadata tại OrdersService/CustomersService/FleetService/VehiclesService/DriversService; `frontend/src/pages/AuditLogsPage.tsx`, `BranchDetailPage.tsx`, `types/audit.ts`, App/menu/quyền điều hướng và deep-link trên trang khách/tài khoản.

### Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| Backend/frontend `npm run typecheck`, `npm run lint`, `npm run build` | Đạt; frontend còn 9 cảnh báo hook hiện hữu và cảnh báo bundle lớn |
| Backend `node node_modules/jest/bin/jest.js --runInBand src/audit-logs/audit-projection.spec.ts` | 7/7 |
| Frontend `node node_modules/vitest/vitest.mjs run src/test/audit.test.ts src/test/client.test.ts --maxWorkers=1 --pool=forks` | 6/6, 2 file |
| Backend `node scripts/with-audit-test-env.cjs --test tests/audit.integration.cjs` | 10/10 (9 nhóm con + test cha), PostgreSQL/HTTP thật |
| Backend `node scripts/with-audit-test-env.cjs --test --test-concurrency=1 tests/order-cancellation.integration.cjs tests/order-acceptance.integration.cjs` | 36/36 hồi quy đơn; đã chạy chung với suite audit ở lượt trước khi thêm ca quyền đối tượng |
| `with-fleet-test-env.cjs --test tests/fleet-profiles.integration.cjs` | 17/17 trên `tms_fleet_test` |
| `with-customer-test-env.cjs --test tests/customers.integration.cjs` | 12/12 trên `tms_customers_admin_20261101` |
| Frontend `node node_modules/@playwright/test/cli.js test --config playwright.audit.config.ts` | 6/6 Chromium nối Nest/PostgreSQL thật |
| `git diff --check` | Đạt |

Suite audit kiểm tra phân trang trùng timestamp, biên `[from,to)`/UTC+7, list/detail và thu hồi grant, branch đa/khác/không rõ, actor bị khóa/đổi tên/chuyển nhánh, payload lạ và credential, query sai, quyền audit không trao quyền đối tượng, retry và rollback do trigger audit thất bại. Lỗi trigger được ApiErrorFilter hiện hữu trả 503 `SERVICE_UNAVAILABLE`; không biến thành thành công. Migration giữ fingerprint lịch sử. Các ca rollback chạy trên PostgreSQL test, không mock repository.

Browser kiểm tra tạo khách thật → tra cứu → chi tiết → mở khách → Back/reload; tạo/hủy đơn thật và lý do chứa script hiển thị text; mở tài khoản/chi nhánh/xe; empty, lỗi mạng/404/403/401; đổi scope/tài khoản; response thật bị giữ lại rồi trả muộn; viewport 390 px và focus bàn phím. Chỉ lỗi HTTP/mạng được tiêm bằng Playwright route; dữ liệu thành công đến từ backend thật. Đã xem ảnh `frontend/test-results/audit-desktop.png` và `audit-mobile.png`; thư mục kết quả có thể bị Playwright ghi đè ở lần chạy sau.

Trong quá trình kiểm chứng đã sửa selector test khớp nhãn thật (“Tên hiển thị”, “Lý do: …”), chờ route hoàn tất trước khi bỏ interception, và dùng Enter để chọn option Ant Design ảo hóa. Không tăng timeout, bỏ test hoặc giảm assertion. Khi tiếp tục phiên, container test đã dừng; khởi động lại đúng container localhost rồi chạy lại, không nới guard kết nối.

### Chạy thử và giới hạn

Container riêng đã dùng: `tms-order-cancel-test-20261103`, PostgreSQL 17 bind `127.0.0.1:55443`, database `tms_order_acceptance_20261018`. `with-audit-test-env.cjs` chỉ đọc cấu hình container này hoặc biến `ORDER_ACCEPTANCE_DATABASE_URL` trỏ database test localhost đúng tên; không đọc `.env` vận hành. Bộ khởi động API test seed fixture trong database test. Không chạy nó với database thật. Chạy suite HTTP và browser lần lượt vì có chung fixture quyền. Backend cần build trước khi khởi động API test.

Demo: đăng nhập ADMIN COMPANY → tạo/sửa khách hoặc hủy đơn chưa phân công → mở **Nhật ký thao tác** → nhập ID đối tượng và khoảng thời gian phù hợp → Tra cứu → Xem nhật ký → Mở đối tượng → Back → reload. Thử DISPATCHER để thấy chặn quyền; không cấp thêm quyền chỉ để demo.

Phần chức năng đã kiểm chứng trên môi trường test; chưa deploy hoặc áp index lên database vận hành, chưa đo hiệu năng với khối lượng audit production. Dữ liệu cũ thiếu scope/giá trị trước-sau vẫn thiếu và hiển thị đúng giới hạn. Không kiểm toán toàn bộ nội dung audit vận hành, không tuyên bố lịch sử vận hành không có dữ liệu nhạy cảm; API mới không trả raw payload. Không thêm dependency, không commit/push hoặc ghi database thật.

<a id="audit-log-survey"></a>

### Nhật ký thao tác quản trị — khảo sát 05/11/2026

Người dùng đã cho phép triển khai và xác nhận **chỉ ADMIN COMPANY được xem nhật ký**, gồm tài khoản/quyền/đổi mật khẩu, không có giá trị mật khẩu. Trạng thái kiểm chứng cuối cùng được ghi tại mục Nhật ký thao tác trong `WEB_ADMIN.md`.

#### Nguồn và dữ liệu

Bảng dưới đây ghi nhận hiện trạng lúc khảo sát ban đầu. Metadata được bổ sung cho lần ghi mới được mô tả ở phần “Triển khai và dữ liệu mới”; không áp các mô tả thiếu dữ liệu cũ cho mọi bản ghi mới.

| Nhóm thao tác | Nguồn hiện có | Dữ liệu ghi nhận | Thiếu/giới hạn lịch sử |
|---|---|---|---|
| Tạo/sửa/đối soát/xác nhận/hủy đơn | `OrderEvent` trong `OrdersService` | Actor, Order ID, loại sự kiện, occurredAt, commandId, trạng thái trước/sau; hủy có lý do | Không có snapshot chi nhánh cho mọi sự kiện. Sửa có snapshot Order cũ, nhưng không có snapshot sau tương ứng; không đưa toàn bộ snapshot lên UI |
| Tạo/sửa khách, đổi phạm vi phục vụ | `AuditLog` trong `CustomersService` | Actor, Customer ID, timestamp, commandId, version, tên trường; tạo/đổi phạm vi có branchIds và khi đổi có previousBranchIds | Sửa hồ sơ không đổi phạm vi chưa lưu chi nhánh. Không có giá trị trước/sau cho các trường hồ sơ |
| Tạo xe/tài xế, liên kết Employee | `AuditLog` trong `FleetService` | Actor, ID, action, version hoặc Employee ID | Chưa lưu phạm vi lịch sử và nhãn tài nguyên |
| Sửa xe/tài xế | `AuditLog` trong `VehiclesService`/`DriversService` | Tên trường, version trước/sau | Không có giá trị trường trước/sau hoặc snapshot phạm vi; chuyển scope tài xế có sự kiện riêng trên User với chi nhánh cũ/mới |
| Tạo/sửa/hủy lịch, ghi nhận xung đột | `AuditLog` trong `FleetService` | ID lịch/tài nguyên, loại lịch, lý do, thời gian; sửa có metadata lịch trước | Chưa lưu chi nhánh lịch sử; tripIds nội bộ không được trả nguyên khối |
| Tạo/sửa/khóa/mở tài khoản | `AuditLog` trong `UsersService` | Actor, User ID, thao tác; tạo có roleCode/branchIds; sửa có tên trường | Sửa scope chưa ghi tập chi nhánh cũ/mới; không có nhãn lịch sử |
| Đổi mật khẩu cá nhân | `AuditLog` trong `AuthService` | Actor, User ID, timestamp, sessionsRevoked | Chỉ hiển thị sự kiện đã đổi. Không có reset mật khẩu quản trị trong scope hiện hành |
| Tạo/sửa/ngừng/kích hoạt chi nhánh | `AuditLog` trong `BranchesService` | Actor, Branch ID; tạo có code, sửa có tên trường, đổi trạng thái có active | Không có giá trị trước/sau đầy đủ. Branch ID của đối tượng xác định chi nhánh liên quan, không cần suy từ actor |

Các điểm ghi trên gọi `tx.auditLog.create` hoặc `tx.orderEvent.create` trong transaction nghiệp vụ. Retry của các command có khóa idempotency không chạy lại callback ghi. Khóa tài khoản đã khóa và đổi trạng thái chi nhánh không thay đổi có nhánh không ghi thêm audit. Đây là nhận xét từ code, **chưa phải kết quả kiểm thử tích hợp của nhiệm vụ này**.

`AuditLogService.log` dùng Prisma ngoài transaction và catch lỗi; hiện `InventoryService` chỉ inject, tìm kiếm không thấy lời gọi `.log` từ module này. Các luồng TMS ưu tiên ở bảng trên không gọi helper đó. Không thay helper hoặc nghiệp vụ inventory ngoài phạm vi chỉ để chuẩn hóa.

Các nguồn khác có trách nhiệm riêng:

- `ProcessedCommand`: chống lặp, hash yêu cầu và kết quả lệnh; không phải dòng lịch sử thao tác để đưa lên UI.
- `ExecutionEvent`: bằng chứng thực thi chuyến, có occurredAt/receivedAt; ngoài phạm vi tra cứu quản trị này.
- `OutboxEvent`: giao sự kiện sau commit, trạng thái retry/lỗi; không phải nhật ký quản trị. Sự kiện retry outbox, FeedbackCase và xem PodFile không thuộc nhóm ưu tiên.
- `AuditLog.timestamp` và `OrderEvent.occurredAt` không có cặp thời gian xảy ra/nhận tương ứng. Không dựng thêm thời điểm còn thiếu.

#### Quyền và thiết kế đã chốt

Backend kiểm tra grant ADMIN, scope COMPANY, branchId null được AuthService tải từ PostgreSQL cho mỗi request. Không dựa vào username hoặc cột User.role. DISPATCHER bị chặn ở cả danh sách, tổng số, chi tiết. Không thêm role/permission hoặc chạy seed trên dữ liệu vận hành.

ADMIN được xem sự kiện khác chi nhánh, nhiều chi nhánh và không xác định phạm vi. Bộ lọc chi nhánh chỉ tra metadata lịch sử hợp lệ; không dùng nhánh hiện tại của actor/tài nguyên. Selector chi nhánh làm việc không thu hẹp quyền đọc audit toàn công ty, và UI nói rõ điều này. Actor không có ID được ghi là không ghi nhận, không tự gán tác nhân hệ thống.

Nguồn đọc: AuditLog của chín loại đối tượng trong bộ chuyển; OrderEvent chỉ CREATED/UPDATED/PACKAGES_RECONCILED/CONFIRMED/CANCELLED của đơn B2B. Mỗi dòng có nguồn riêng; không tạo AuditLog trùng OrderEvent. Không trả ProcessedCommand, ExecutionEvent hoặc OutboxEvent. Bộ lọc actor/đối tượng dùng ID chính xác; không tìm trong payload, không cấp API liệt kê toàn bộ actor. Tên actor được ghi rõ là tên hiện tại; nhãn lịch sử không được suy dựng.

Liên kết đơn/Fleet dùng URL hiện có (`order`, `kind`/`resource`). Bổ sung `customer` trên trang khách, `account` trên trang tài khoản và trang đọc `/branch-detail?branch=...`. Backend chỉ trả link khi có quyền đọc loại đối tượng; API đích vẫn kiểm tra quyền/scope/tồn tại. Back và reload giữ URL bộ lọc/trang/chi tiết. AuthContext hủy request/remount theo phiên/scope; trang nhật ký bỏ response cũ theo vòng đời request và generation khi nhận 403.

#### Triển khai và dữ liệu mới

`backend/src/audit-logs`: DTO, controller, service truy vấn và bộ chuyển dữ liệu. Chỉ trả tên trường được phép theo entity/action; bỏ payload không nhận diện, giá trị hồ sơ và credential; giữ source, ID, thời gian và scope có bằng chứng metadata. Trả trạng thái đơn, trạng thái hoạt động chi nhánh, thời gian lịch trước/sau, phạm vi phục vụ trước/sau khi nguồn có lưu. Không dựng giá trị cũ từ hồ sơ hiện tại. React render lý do dưới dạng văn bản.

`auditBranchIds` được bổ sung cho các lần ghi mới trong transaction hiện có: sự kiện tạo/sửa/xác nhận/hủy Order; sửa Customer (hợp phạm vi trước/sau); tạo/sửa xe và tài xế; liên kết Employee; lịch tài nguyên và ghi nhận xung đột. Không thêm dòng sự kiện trùng hoặc backfill lịch sử. Customer CREATE/đổi phạm vi và Driver scope transfer cũ đã có metadata có thể dùng; sự kiện Branch có ID đối tượng là chi nhánh liên quan. Tài khoản/mật khẩu cũ không có snapshot phạm vi tiếp tục hiển thị chưa xác định, vẫn chỉ ADMIN được đọc.

Không có cột mới; metadata JSON tương thích dữ liệu cũ. Migration `20261105100000_audit_lookup_indexes` thêm index `(timestamp,id)` và `(occurredAt,id)` vì truy vấn toàn công ty có khoảng thời gian và thứ tự này; index entity/actor hiện có không có timestamp ở đầu. Migration không sửa/xóa dòng hoặc cấp quyền. CREATE INDEX thông thường khóa ghi trong lúc tạo: cần thử trên bản backup và chọn thời gian bảo trì khi triển khai bảng lớn. Khôi phục riêng thay đổi này bằng DROP hai index nếu cần; không reset/truncate hoặc sửa migration cũ. **Chưa áp lên database thật.**

Kiểm thử tích hợp và browser ở `backend/tests/audit.integration.cjs`, `frontend/tests/audit.spec.ts`; fixture và runner chỉ dùng PostgreSQL localhost `tms_order_acceptance_20261018`. Bằng chứng unit không thay thế kết quả tích hợp. Không kiểm tra hoặc sửa hàng loạt nội dung audit vận hành, không khẳng định dữ liệu vận hành chưa từng chứa thông tin nhạy cảm. API mới không trả raw details/summary. Chưa commit/push/deploy và không ghi database vận hành.

---

<a id="account-branch-admin"></a>

## 10. Quản trị tài khoản và chi nhánh — cập nhật 03/11/2026

### Chính sách người dùng đã xác nhận

- Chỉ giữ một tài khoản ADMIN; ADMIN là quyền cao nhất, cấp/khóa DRIVER và DISPATCHER. Không mở chức năng tạo/cấp/sửa/khóa ADMIN qua API quản trị tài khoản. Truy vấn chỉ đọc tại thời điểm khảo sát cho thấy database đang cấu hình chỉ có `admin` là ADMIN COMPANY hoạt động; không cần thu hồi hoặc chuyển tài khoản nào.
- DRIVER đăng nhập ứng dụng tài xế; DISPATCHER đăng nhập web để lập kế hoạch chuyến. ADMIN quản lý lịch tài xế bằng module Fleet hiện có.
- Quyền quản trị dựa trên scope ADMIN COMPANY đang hoạt động và permission tương ứng; không còn kiểm tra username demo. Không chạy seed để cấp quyền trên database thật.
- DRIVER/DISPATCHER đổi mật khẩu của mình bằng mật khẩu hiện tại. Đổi xong thu hồi mọi phiên và đăng nhập lại. Không triển khai reset mật khẩu bởi quản trị, mật khẩu tạm hoặc email/SMS.
- Có tạo/ngừng/kích hoạt lại chi nhánh. Không tự chuyển dữ liệu. Mọi Driver còn gắn đều chặn ngừng, kể cả nghỉ; xe DECOMMISSIONED không chặn. Khách hiện không có trạng thái ngừng riêng: quan hệ CustomerBranch còn tồn tại là phạm vi đang sử dụng.
- Chi nhánh còn scope tài khoản hoạt động, khách, xe hoạt động, Driver, đơn/chuyến chưa kết thúc hoặc reservation HELD/ACTIVE bị chặn ngừng. Giữ cách loại scope chi nhánh ngừng khỏi quyền hiện hành. Kích hoạt lại không thay active của scope.

Reservation được đối chiếu cả chi nhánh quản lý chuyến và chi nhánh của xe/tài xế. Xe DECOMMISSIONED tự nó không chặn; reservation HELD/ACTIVE còn tồn tại trên xe đó vẫn phải được xử lý trước khi ngừng chi nhánh.

### API và quyền

| API | Quyền / hành vi |
|---|---|
| GET `/users`, `/users/:id` | ADMIN COMPANY + users.read; không trả password/hash/session |
| GET `/users/available-drivers` | ADMIN COMPANY + users.create; tìm kiếm/phân trang hồ sơ chưa có User |
| POST `/users` | users.create; chỉ DRIVER/DISPATCHER; bắt buộc Idempotency-Key |
| PATCH `/users/:id` | users.create; tên hiển thị, scope DISPATCHER; expectedUpdatedAt; thu hồi phiên |
| PATCH `/users/:id/lock`, `/unlock` | users.lock; expectedUpdatedAt; không được tác động ADMIN/tự khóa |
| POST `/auth/change-password` | Phiên đăng nhập hiện hành; currentPassword + newPassword; thu hồi mọi phiên |
| GET `/branches/admin-list` | branches.manage; page/pageSize/search/status |
| POST `/branches` | branches.manage; mã chuẩn hóa trim/uppercase, tọa độ thực tế; Idempotency-Key |
| GET `/branches/:id/impacts` | branches.manage; số lượng dữ liệu chặn |
| PATCH `/branches/:id` | branches.manage; expectedUpdatedAt; audit cùng transaction |
| PATCH `/branches/:id/status` | branches.manage; active + expectedUpdatedAt; Idempotency-Key |

Giữ GET `/branches` hiện có để consumer vẫn nhận danh sách chi nhánh hoạt động. Web quản trị chi nhánh nằm tại **Đội Xe & Tài Xế → Chi nhánh**, dùng lại modal sửa hiện có. Không tạo màn hình quản trị thứ hai.

Tài khoản DRIVER phải chọn Driver có sẵn, không tự tạo hồ sơ. Scope phải khớp homeBranchId; nếu đã liên kết Employee thì kiểm tra nhân viên hoạt động/cùng chi nhánh/chưa có User và liên kết cùng transaction. Không đổi quan hệ Employee/Driver/Customer khi sửa User; không chuyển một User DRIVER thành DISPATCHER hoặc ngược lại bằng sửa role trực tiếp.

Khi ADMIN chủ động chuyển hồ sơ Driver ở Fleet, scope DRIVER đang được cấp chuyển theo homeBranchId trong cùng transaction, lưu scope cũ ở trạng thái thu hồi và thu hồi phiên. Nếu scope nguồn đã bị thu hồi thì không cấp lại. Các điều kiện chặn chuyển khi còn chuyến/reservation vẫn giữ nguyên. Trường User.role được dùng để bảo vệ loại tài khoản/liên kết cũ, không thay thế UserRoleScope khi tính quyền truy cập.

Chi tiết tài khoản hiển thị cả `scopeHistory`: scope đã thu hồi, vai trò đã ngừng, chi nhánh đã ngừng. Chỉ permission của grant hiện hành quyết định quyền. Khi chi nhánh đã chọn mất quyền, web xóa dữ liệu và phiên cục bộ, yêu cầu đăng nhập lại; không tự mở rộng sang mọi chi nhánh. Giá trị chi nhánh cũ được xóa để lần đăng nhập sau không mắc vòng lặp.

Audit chỉ ghi loại thay đổi, actor và metadata cần thiết. Idempotency tạo tài khoản dùng HMAC để tránh lưu mật khẩu hoặc digest không khóa trong log lệnh. Sửa scope giữ bản ghi scope đã thu hồi, không xóa lịch sử. Mở khóa không phục hồi phiên cũ.

### Migration và vận hành

Ba migration mới, theo thứ tự:

1. `20261021100000_branch_lifecycle_guard`: unique mã chuẩn hóa, trigger vòng đời và liên kết.
2. `20261101100000_branch_link_lock_order`: tuần tự hóa cấp scope với mở khóa tài khoản, giữ chi nhánh quản lý chuyến ổn định khi tạo reservation.
3. `20261101103000_branch_reservation_resources`: kiểm tra reservation theo cả xe/tài xế, kể cả dữ liệu xe đã DECOMMISSIONED nhưng còn giữ lịch.

- Thêm unique index mã chi nhánh sau trim/uppercase. Nếu dữ liệu cũ xung đột, migration dừng; không tự đổi mã.
- Thêm trigger/khóa hàng chi nhánh để phối hợp ngừng với các liên kết mới và chuyển trạng thái. Kiểm tra lại số lượng chặn trong transaction trước ngừng.
- Không thêm cột/version số: dùng `updatedAt` làm token kiểm soát sửa đồng thời. Client phải đọc lại sau lưu hoặc xung đột.
- Không thay scope, role, password hoặc dữ liệu lịch sử; không suy ra quyền từ cột User.role cũ để cấp mới.
- **Chưa áp dụng các migration trên database thật.** Bản code mới cần đủ ba migration để bảo vệ cạnh tranh ngừng chi nhánh. Không chạy `migrate deploy` bừa khi còn migration khác pending. Không sửa migration đã áp dụng.

Preflight chỉ đọc, chạy tại backend: `node scripts/administration-preflight.cjs`. Đối soát ADMIN duy nhất, mã trùng, migration pending và checksum lịch sử; không sửa checksum cũ. Trước áp dụng thật cần backup mới và thử trên bản phục hồi có dữ liệu đại diện. Nếu cần phục hồi, dùng backup riêng để đối soát; không reset/truncate hoặc tự ghi đè dữ liệu thật. Lỗi cấu hình quyền phải sửa có kiểm soát bằng ID tài khoản đã xác minh và ghi audit, không chạy seed demo hoặc tạo mật khẩu bí mật.

Lần preflight 03/11 xác nhận chỉ một tài khoản có vai trò/scope ADMIN (`admin`), đang hoạt động và đủ cả bốn permission `users.read`, `users.create`, `users.lock`, `branches.manage`. Cả ba định nghĩa role ADMIN/DISPATCHER/DRIVER hiện hoạt động. Không có mã chi nhánh trùng sau chuẩn hóa. Có 11 migration lịch sử lệch checksum; migration Fleet `20261017120000_fleet_schedules` cùng ba migration quản trị còn pending. Không thay checksum hoặc áp cả chuỗi migration lên database này. Migration mới không cấp ADMIN; tài khoản `admin` hiện đủ quyền sử dụng, không cần seed demo.

### Kiểm thử và demo

Các suite mới/được cập nhật:

- `npm run test:accounts` (backend): PostgreSQL, HTTP và Socket.IO; quyền/target, tạo DRIVER, retry/unique/rollback, scope, version, khóa/mở khóa, login cạnh tranh khóa.
- `node scripts/with-auth-test-env.cjs --test tests/change-password.integration.cjs`: đổi mật khẩu cạnh tranh, phiên cũ, mật khẩu cũ, audit không chứa secret.
- `node scripts/with-auth-test-env.cjs --test tests/branches-admin.integration.cjs`: tạo/retry/trùng mã, trạng thái/version, tọa độ 0, cạnh tranh cấp scope/tạo Driver/chuyến/reservation với ngừng chi nhánh, giữ lịch sử và scope đã thu hồi.
- `node scripts/test-branch-admin-migration.cjs`: chạy đúng SQL trên schema test sao chép dữ liệu hiện hữu; so fingerprint các bảng user/scope/session/chi nhánh/nghiệp vụ trước và sau; mã cũ xung đột phải rollback.
- `node node_modules/@playwright/test/cli.js test accounts.spec.ts admin-lifecycle.spec.ts auth.spec.ts` (frontend; tương đương script `test:auth`): backend thật cho luồng thành công. Các route mock chỉ dành cho lỗi mạng/HTTP hoặc đáp ứng chậm.
- `npm test -- src/test/ChangePasswordButton.test.tsx`: component với API mock, giữ form khi lỗi và xóa dữ liệu sau thành công; không thay thế nghiệm thu tích hợp.

Database kiểm thử phải là PostgreSQL localhost `tms_auth_test`, không phải database vận hành. Không chạy suite HTTP và browser đồng thời vì fixture quyền dùng chung. Migration mới phải được áp dụng trên database test trước suite chi nhánh. Các lần test tạo dữ liệu riêng có nhãn TEST; không dùng mật khẩu thật.

Demo: ADMIN → Quản lý tài khoản → tạo DISPATCHER với một/nhiều chi nhánh hoặc DRIVER từ hồ sơ có sẵn → reload → đăng nhập tài khoản mới → đổi mật khẩu → đăng nhập lại → ADMIN khóa/mở khóa, kiểm tra token cũ vẫn bị từ chối. Tại tab Chi nhánh, tạo chi nhánh rỗng, reload, ngừng/kích hoạt lại; thử ngừng chi nhánh đang có Driver để xem lý do và số lượng chặn.

### Bằng chứng kiểm chứng

- Backend/frontend: build và typecheck đạt; lint không lỗi. Frontend còn 9 cảnh báo hook có trước, build còn cảnh báo bundle lớn. Không nâng dependency hoặc tắt kiểm tra để xử lý cảnh báo.
- Jest `users.dto.spec.ts`, `events.gateway.spec.ts`, `auth.config.spec.ts`: 3 suite / 11 test đạt. Vitest ChangePasswordButton: 1 test đạt; jsdom có cảnh báo không mô phỏng pseudo-element, không dùng test này để kết luận layout trình duyệt.
- PostgreSQL/HTTP auth: 21 test đạt; accounts: 23 test đạt; đổi mật khẩu: 4 test đạt; chi nhánh: 9 test đạt. Ba suite accounts/mật khẩu/chi nhánh được chạy lại cùng phiên 03/11, 36/36 test đạt, không bỏ qua. Có kiểm tra phiên/socket thật, đăng nhập cạnh tranh mật khẩu/khóa, rollback và audit.
- Playwright tài khoản/auth: 9 test đạt; vòng đời chi nhánh/đổi mật khẩu: 2 test đạt. Bao gồm lưu/reload, sửa phạm vi, xem scope thu hồi, khóa/mở khóa, tài khoản khác không giữ dữ liệu cũ, lỗi API, viewport 390 px, tọa độ bằng 0.
- Hồi quy PostgreSQL/HTTP: khách hàng 12, Fleet 17, giám sát/POD 6, dashboard 6 test đạt. Playwright tương ứng: 4 + 3 + 4 + 5 test đạt. Bao gồm POD bị từ chối sau thu hồi quyền, lịch/Employee, đổi chi nhánh và xóa dữ liệu cũ.
- Fleet 17/17 được chạy lại ngày 03/11 sau khi áp migration reservation thứ ba trên database Fleet test, gồm kiểm tra đồng thời giữ lịch/bảo dưỡng. Replay migration trên dữ liệu test hiện hữu và ca mã cũ xung đột đều đạt; không thay đổi fingerprint các hàng cũ.
- Test auth cũ được cập nhật theo contract `expectedUpdatedAt`, endpoint sửa User nay trả 403 cho DISPATCHER và bộ lọc đơn hiện tại. Test giám sát nay xác nhận tự xóa phiên khi mất chi nhánh đã chọn, không chờ người dùng bấm đăng xuất. Không bỏ assertion về quyền/dữ liệu.

Các database dùng trong lần kiểm chứng: `tms_auth_test`, `tms_fleet_test`, `tms_customers_admin_20261101`, `tms_monitor_test`, `tms_dashboard_test`, đều ở container PostgreSQL chỉ bind localhost. Database khách hàng được sao chép từ database Fleet test; chỉ mật khẩu fixture `demo_auth_*` trong bản sao được cấu hình theo wrapper test. Không sao chép hoặc ghi dữ liệu vận hành. Các suite chuyên biệt chạy qua scripts `with-*-test-env.cjs` và cấu hình `playwright.*.config.ts` hiện có, với biến URL chỉ tới database test.

### Giới hạn nghiệm thu

#### Lượt rà soát bổ sung ngày 03/11/2026

Phần quản trị đã tồn tại trong workspace trước lượt này. Giữ nguyên chính sách đã ghi nhận và các thay đổi đang có; bổ sung hiển thị lỗi server tại ô mật khẩu tương ứng và tìm kiếm theo tên trong bộ chọn chi nhánh làm việc. Không thêm migration, sửa schema hoặc thay quyền tài khoản hiện hữu trong lượt rà soát.

Kết quả chạy lại trên trạng thái cuối:

- Backend `npm run build`, `npm run typecheck`, `npm run lint`: đạt.
- `node scripts/with-auth-test-env.cjs --test --test-concurrency=1 tests/accounts.integration.cjs tests/change-password.integration.cjs tests/branches-admin.integration.cjs`: 36/36 test đạt, không skip, PostgreSQL localhost `tms_auth_test` và Socket.IO thật.
- Jest `src/users/users.dto.spec.ts`, `test/events/events.gateway.spec.ts`, `src/auth/auth.config.spec.ts`: 11/11 test đạt. Lệnh đầu nhập sai đường dẫn file gateway; đã chạy lại đúng đường dẫn, không bỏ suite.
- Frontend `npm run typecheck`, `npm run lint`, `npm run build`: đạt; vẫn có 9 cảnh báo hook và cảnh báo bundle lớn.
- `npm test -- src/test/ChangePasswordButton.test.tsx src/test/client.test.ts`: 4/4 test đạt; jsdom vẫn báo giới hạn pseudo-element.
- Playwright `accounts.spec.ts`, `admin-lifecycle.spec.ts`, `auth.spec.ts` với `CI=true`: 11/11 đạt, 1,7 phút. Backend/server mới do Playwright khởi động, không dùng lại server vận hành. Bao gồm nhập sai mật khẩu hiện tại → lỗi tại trường → giữ mật khẩu mới → sửa và gửi lại → đăng nhập/reload bằng mật khẩu mới. Luồng thành công dùng backend thật; các ca lỗi mạng/HTTP giả lập được đánh dấu trong test.
- Lượt browser đầu timeout khi test tìm một option chưa được render trong danh sách ảo hóa dài. Đã sửa thao tác test để nhập từ khóa trước khi chọn; không tăng timeout, xóa dữ liệu hoặc giảm assertion. Đã xem ảnh `frontend/test-results/accounts-mobile.png` ở chiều rộng 390 px.
- `node scripts/test-branch-admin-migration.cjs`: cả hai ca dữ liệu có sẵn và mã cũ xung đột đạt; fingerprint dữ liệu giữ nguyên, ca xung đột rollback. Chỉ tạo schema thử trên database test.
- Preflight chỉ đọc chạy lại: một ADMIN `admin` đủ bốn permission, không có mã chi nhánh trùng chuẩn hóa; vẫn 11 checksum lịch sử lệch và bốn migration pending (Fleet + ba migration quản trị). Không sửa dữ liệu/lịch sử migration.

Các suite hồi quy khách hàng, Fleet, giám sát và dashboard ở mục trước là bằng chứng lịch sử; không chạy lại toàn bộ trong lượt bổ sung UI này. Kết quả trên không chứng nhận triển khai database thật, Mapbox hoặc ứng dụng mobile.

#### Giới hạn triển khai

- Checkout hiện không có file nguồn mobile được Git quản lý; chưa nối UI đổi mật khẩu và chưa chạy app tài xế trên thiết bị. API dùng chung không chứng minh UI mobile hoạt động.
- Không có quyền triển khai lên database thật/deploy; hiện trạng database thật chỉ được truy vấn đọc.
- Kiểm thử migration trên dữ liệu test có sẵn không thay thế thử trên bản backup vận hành trước triển khai. Chưa nghiệm thu dịch vụ Mapbox bằng địa chỉ thực trong nhiệm vụ này; kiểm thử form sửa dùng tọa độ nhập rõ ràng, không coi geocode mock là tích hợp thật.
