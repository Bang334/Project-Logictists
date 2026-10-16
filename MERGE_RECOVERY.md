# Bàn giao xử lý merge ngày 05/10/2026

Giữ Package vật lý, khung giờ SERVICE_START, DRAFT → CONFIRMED, session và quyền theo grant; tích hợp job tối ưu qua queue, nhiều phương án, planning snapshot, load plan và các module bán lẻ của nhánh pull.

## Trạng thái áp dụng ngày 11/10/2026

Đã được người dùng cho phép và đã áp dụng lên Supabase qua `DIRECT_URL` sau khi tạo backup PostgreSQL 17 dạng custom ở thư mục tạm ngoài repository và phục hồi thử schema `public` vào PostgreSQL 17 cô lập. Ba migration `20261005140000`, `20261007090000`, `20261007100000` chạy thành công; hai migration lịch sử được đánh dấu applied sau khi xác nhận toàn bộ hậu điều kiện đã do migration hợp nhất tạo ra.

Hậu kiểm: 84 bảng nghiệp vụ; 3 users, 53 orders và 12 vehicles được giữ nguyên; 12/12 xe có `vehicleTypeId`; có 12 `vehicle_types`; không còn `driver_shifts`, `driver_leave`, `vehicle_doors` hoặc các cột cấu hình kỹ thuật cũ trên `vehicles`. `prisma migrate status` báo schema đã cập nhật và truy vấn Prisma qua connection pooler đọc được VehicleType, scope, invoice và payment.

## Database dùng chung đang theo baseline của nhánh pull

Người dùng xác nhận database đã áp dụng baseline mới. Migration bổ sung nằm tại `backend/prisma/migrations/20261005140000_merge_packages_windows_auth/migration.sql`. Đây là nâng cấp **từ baseline 66 bảng và bốn migration tiếp theo đến `20261003210000_vehicle_home_depot`**, không dùng cho database theo lịch sử schema cũ.

- Giữ các bảng/module mới; thêm lại bảng quyền, phiên đăng nhập, Allocation và quan hệ lịch sử. Theo quyết định 11/10/2026, migration không tạo `driver_shifts`, `driver_leave`, `vehicle_doors`; schema hợp nhất có 83 model và database có 84 bảng nghiệp vụ do quan hệ ngầm `_LoadPlanStepTasks`.
- `vehicle_types` là nguồn chuẩn của tải trọng, thể tích, kích thước thùng, định mức nhiên liệu và chi phí cố định. Migration gom các xe có cấu hình cũ giống nhau vào cùng một loại, gán `vehicleTypeId` bắt buộc rồi xóa các cột kỹ thuật trùng ở `vehicles`. Optimizer dùng đúng một cửa sau (`REAR`), không lưu bảng cửa xe.
- Khôi phục cột thời gian ở `order_stops` dạng timestamp có timezone và cho phép null với dữ liệu cũ. Giá trị đã bị migration của nhánh pull xóa **không thể tự khôi phục**: phải lấy từ backup hoặc nhập lại sau đối soát.
- Giữ `PackageItem` của nhánh bán lẻ. Package cũ chưa có `orderItemId` vẫn giữ ID, số đo, quan hệ và lịch sử. Không chia khối lượng tổng hoặc suy diễn ánh xạ dòng hàng.
- Giữ lịch sử tại bảng `order_status_events`; không tạo một nguồn lịch sử đơn khác.
- Giữ scope địa điểm bán lẻ tại `user_location_scopes`; scope TMS dùng `user_role_scopes` với role/permission. Chuyển quyền ADMIN/DISPATCHER đang có thành grant tương ứng, không thay mật khẩu hay kích hoạt lại user. JWT cũ thiếu session ID phải đăng nhập lại.
- Thêm quan hệ nhiều task cho mỗi LoadPlanStep: snapshot của một điểm phục vụ bao phủ mọi kiện tại điểm đó. Giữ FK `stopTaskId` cũ để đọc lịch sử.
- CHECK số đo và FK Package–Allocation dùng NOT VALID với dữ liệu cũ; vẫn kiểm tra bản ghi mới. Cần đối soát trước khi VALIDATE CONSTRAINT. Không xóa dữ liệu để ép constraint đạt.

### Không chạy ngay `prisma migrate deploy`

Trong repo còn hai migration của lịch sử cũ: `20260926090000_auth_sessions_scope_constraints` và `20261002140000_order_packages_windows`. Chúng không tương thích khi chạy trực tiếp trên baseline mới. Không sửa checksum hoặc nội dung migration đã áp dụng, không reset/db push.

Quy trình vận hành đã dùng ngày 11/10/2026 và cần lặp lại trên bản sao khi phục hồi môi trường khác:

1. Dừng ghi, backup đầy đủ gồm `_prisma_migrations`, phục hồi thử vào database riêng. Kiểm tra đúng năm migration của nhánh pull đã thành công; nếu lịch sử khác thì dừng để đối chiếu.
2. Trên bản sao, chạy SQL của migration bổ sung bằng URL migration được chỉ rõ, ví dụ `npx prisma db execute --url "$env:DIRECT_URL" --file prisma/migrations/20261005140000_merge_packages_windows_auth/migration.sql`. Không dùng `--schema` cho bước này vì `.env` có thể làm lệnh trỏ sang database khác dự kiến. SQL có transaction. Không chạy lại file nếu đã áp dụng.
3. Đối chiếu schema, CHECK/FK/index và các dòng dữ liệu đại diện. Xác nhận các hiệu lực của hai migration cũ đã được migration hợp nhất thay thế; sau đó dùng `prisma migrate resolve --applied <tên>` cho **hai migration cũ và migration hợp nhất**. Đây là reconciliation lịch sử, không phải giả vờ các SQL cũ đã chạy. Lưu biên bản kèm backup và kết quả so sánh.
4. Chạy `prisma migrate status`, kiểm tra schema diff và truy vấn nghiệm thu. Composite FK `allocation_package_item_fk` được khai báo bằng SQL ngoài khả năng biểu diễn quan hệ của Prisma; không xóa FK chỉ vì Prisma diff đề xuất xóa.
5. Chỉ áp dụng lại quy trình đã kiểm chứng lên database dùng chung khi được người dùng cho phép. Nếu upgrade thất bại trước COMMIT, rollback transaction; nếu đã phát sinh ghi mới sau upgrade thì không dùng down migration xóa bảng, phải khôi phục có đối soát hoặc sửa tiến.

Database mới hoàn toàn cũng phải đi theo baseline mới, bỏ qua hai migration cũ bằng reconciliation được review. Không dùng lịch sử cũ để dựng schema hợp nhất.

## Dữ liệu cũ và phạm vi giao diện

Đơn B2B cũ mặc định `LEGACY_REVIEW`, không đưa vào điều phối/optimizer. Đơn chưa có Package và chưa bị tham chiếu có thể đối soát bằng màn hình sửa: nhập số đo từng kiện và khung giờ, lưu rồi xác nhận; số liệu cũ được lưu audit. Đơn có Package bán lẻ/mapping chưa rõ hoặc Allocation/task/lịch sử phải xử lý riêng, API chặn sửa thay thế (`LEGACY_PACKAGE_MAPPING_REQUIRED` / `ORDER_REFERENCED`). Không tự backfill.

Màn hình `/orders` dùng quyền `orders.read`/`orders.write`. Chọn khách, chi nhánh, thông tin liên hệ và hai điểm Mapbox; nhập ngày–giờ UTC+7, số đo mm/g cho từng kiện hoặc thêm nhanh N kiện; lưu nháp rồi xác nhận. Chi tiết hiển thị mã kiện, stop liên quan và tổng do server tính. Tải lại `/orders`, tìm mã đơn và mở chi tiết để kiểm tra dữ liệu bền vững. Lỗi API giữ form; version và idempotency vẫn bắt buộc.

## Chạy kiểm chứng riêng

`backend/.env` cần AUTH_TEST_DATABASE_URL trỏ localhost/127.0.0.1 với database `tms_auth_test`, AUTH_DEMO_PASSWORD và cấu hình ứng dụng hợp lệ. Script chỉ dùng URL test này để dựng `tms_merge_test_20261011`, không dùng DATABASE_URL thật. Redis test tại localhost:56389. Không chạy hai app/worker trên cùng database test trong lúc suite đơn hàng chạy.

```powershell
cd backend
npm ci
npm run prisma:generate
npm run orders:demo:prepare
npm run orders:demo:seed
npm run build
npm run test:orders
npm run test:orders:auth
node scripts/with-merge-test-env.cjs node_modules/jest/bin/jest.js --runInBand --testPathPattern=.postgres.spec.ts
npm test -- --runInBand
npm run lint
```

`orders:demo:prepare` dựng baseline, chèn dữ liệu cũ đại diện rồi áp dụng migration mới và kiểm tra bảo toàn. Nếu database test đã được xác minh, script báo dùng lại; không reset. `test:orders` khởi động FastAPI/OR-Tools thật từ `optimizer/.venv/Scripts/python.exe`; chỉ thời gian/quãng đường dịch vụ đường bộ là fixture, PostgreSQL/HTTP/queue/solver dùng thật. Các test auth cấu hình không chạy cùng wrapper nạp `.env` vì ConfigService ưu tiên environment hơn fixture cấu hình.

Frontend: `npm ci`, `npm run build`, `npm run lint`, `npm test`, `npm run test:orders`. Playwright tự mở backend test và web localhost:5174; test chọn bản đồ cần Mapbox public token và mạng truy cập styles/geocoding. Chạy thủ công bằng `npm run start:orders-demo` ở backend và `npm run dev:orders-demo` ở frontend. Không dùng các script test schema cũ để nâng cấp database chung.

Xem hợp đồng kiện và job tại [docs/package-order-contract.md](docs/package-order-contract.md). Bộ kiểm chứng merge không thay thế nghiệm thu toàn bộ thuật toán/hình học của Người 1 hoặc toàn bộ nghiệp vụ bán lẻ.

## Bằng chứng kiểm chứng trong phiên xử lý merge

- Prisma validate, backend/frontend typecheck và build đạt. Backend lint không lỗi; frontend lint không lỗi, còn 9 cảnh báo React Hook được ghi nhận, chưa tuyên bố lint sạch cảnh báo.
- Backend Jest: 126 test đạt. Hai suite PostgreSQL được chạy riêng trên database test: 3 test đạt, không dùng kết quả skip làm bằng chứng.
- HTTP/PostgreSQL đơn hàng: 14 kịch bản con đạt (Node báo 15 test kể cả test cha), gồm tạo/sửa, rollback, retry/cạnh tranh, mapping kiện, phân công thủ công, load plan bao phủ mọi task, publish và job tối ưu thật.
- HTTP/socket phân quyền: 20 kịch bản con đạt; quản lý tài khoản: 19 kịch bản con đạt, gồm tài khoản mới và scope nhiều chi nhánh.
- Frontend Vitest: 34 test đạt; Playwright: 5 test đạt, gồm Mapbox, lưu/reload, giữ ID kiện, xác nhận, lỗi mạng/quyền/validation và màn hình 390px. Lần đầu Mapbox timeout; lần chạy lại cả 5 ca đạt. Không giả lập Mapbox để biến lần lỗi thành pass.
- Python: 56 test đạt, gồm test hồi quy độ chính xác gram trong snapshot xếp hàng. Có 3 cảnh báo deprecation từ SWIG.
- Migration đã thử từ baseline có đơn cũ, PackageItem, kiện vật lý và order status event; dữ liệu được bảo toàn. Prisma diff với database riêng chỉ còn bảng marker test và composite FK bổ sung bằng SQL; không thực thi SQL diff đề xuất xóa chúng.
- Đã áp dụng và hậu kiểm schema trên database dùng chung ngày 11/10/2026. Khôi phục khung giờ đã bị xóa và đối soát kiện cũ vẫn cần dữ liệu nguồn thật; không tự bịa giá trị để hoàn tất backfill.
