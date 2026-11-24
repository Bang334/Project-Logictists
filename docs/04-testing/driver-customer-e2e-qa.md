# M4.0 — Driver → Customer Integration QA

Fixture này dành cho PostgreSQL test local tại `127.0.0.1:55433/tms_auth_test`. Dùng một chuyến và một đơn xuyên suốt bài QA. GPS của bài manual đến từ Android thật.

| Dữ liệu | Giá trị |
|---|---|
| Driver | `driver.demo`, PRIMARY / ASSIGNED |
| Customer chủ đơn | `customer.tracking.demo` |
| Customer đối chứng | `customer.tracking.other` |
| Trip | `QA-M40-DRIVER-CUSTOMER` · `5ef963fd-be66-4ab5-9ff2-093d55233935` |
| Order | `QA-M40-ORDER` · `b1c7f310-8857-4b69-8092-7b155bebc446` |
| Xe và kiện | `QA-M40.01`, 1 kiện 20 kg · `ALLOCATED` lúc đầu |
| Baseline | Trip `DISPATCHED` v1, Order `ASSIGNED` v1, 4 stop PENDING, GPS/event/attempt = 0 |

Dùng mật khẩu demo của các fixture hiện có. Chuyến có Depot Start → Pickup (LOAD 1) → Delivery (UNLOAD 1) → Depot End. Hai task liên kết cùng Order và cùng Package. Giờ phân công được đặt sau lịch hiện hữu của Driver để tránh trùng. Không thay đổi trạng thái hoặc tài khoản của các fixture cũ.

## Chuẩn bị Backend và thiết bị

1. Nếu cần khởi chạy lại Backend, dừng phiên đang giữ cổng 4000 rồi mở PowerShell tại `backend`. Override hai URL chỉ trong terminal chạy Backend.

   ```powershell
   $qaUrl = (Get-Content -LiteralPath .env |
     Where-Object { $_ -match '^\s*TEST_DATABASE_URL\s*=' } |
     Select-Object -First 1) -replace '^[^=]*=', ''
   $qaUrl = $qaUrl.Trim().Trim('"').Trim("'")
   $qaUri = [Uri]$qaUrl
   if ($qaUri.Scheme -notin @('postgresql', 'postgres') -or
       $qaUri.Host -ne '127.0.0.1' -or $qaUri.Port -ne 55433 -or
       $qaUri.AbsolutePath -ne '/tms_auth_test' -or
       $qaUri.Query -notin @('', '?schema=public')) {
     throw 'Sai database đích M4.0'
   }
   $env:DATABASE_URL = $qaUrl
   $env:DIRECT_URL = $qaUrl
   $env:ALLOW_REMOTE_TEST_DATABASE = 'false'
   npm run start:dev
   ```

2. Mở Smart TMS development APK, dùng Metro và cấu hình API LAN hiện có. Bật quyền vị trí Driver, kiểm tra camera và kết nối đến dịch vụ lưu trữ e-POD của môi trường QA. Dùng ảnh vật mẫu, tránh dữ liệu cá nhân.
3. Tốt nhất dùng một thiết bị Driver và một thiết bị Customer. Với một điện thoại, giữ tài khoản Driver để đồng bộ GPS trước, chạy `probe` trên máy tính để kiểm tra API ngay, rồi dùng Customer để kiểm tra polling và trạng thái trên UI. Đăng xuất Driver dừng tracking. Khi đăng nhập lại đúng tài khoản, tiếp tục tracking trên đúng chuyến M4.0.

## Checklist Android

| Bước | Thao tác | PASS nếu | Manual |
|---|---|---|---|
| 1 | Customer mở `QA-M40-ORDER` trước khi Driver start | Theo dõi hiển thị đúng trip đã điều phối và chưa có vị trí | NOT RUN |
| 2 | Driver bắt đầu `QA-M40-DRIVER-CUSTOMER`, cho phép vị trí và chờ GPS hoặc dùng **Thử đồng bộ** | Trip `IN_PROGRESS` v2; PostgreSQL có GpsEvent của đúng Trip và Driver | NOT RUN |
| 3 | Giữ màn hình Customer Detail ở foreground; kiểm tra tối đa qua vài nhịp polling 30 giây kể từ khi có điểm GPS | Tracking có đúng Trip và latest GPS; khi quá 120 giây theo `measuredAt` là stale, ở 120 giây hoặc ít hơn là fresh. Dùng `probe` giữa hai mốc để phân biệt độ trễ poll | NOT RUN |
| 4 | Driver hoàn thành kho đầu, đến Pickup, nhập thực tế 1 và xác nhận lấy hàng | Kiện `LOADED`, Order `IN_TRANSIT`; có một OrderEvent `ASSIGNED → IN_TRANSIT`. Mở lại Customer Detail nếu badge đầu trang chưa tải lại | NOT RUN |
| 5 | Đến Delivery, nhập thực tế 1, chọn giao thành công, nhập người nhận, rồi thực hiện kho cuối | Một DeliveryAttempt `SUCCESS`; kiện `DELIVERED`; Order `COMPLETED` vì toàn bộ kiện active đã giao. Trip lúc này vẫn `IN_PROGRESS` | NOT RUN |
| 6 | Trước khi có ảnh, quan sát nút Hoàn thành chuyến; chụp và tải PHOTO từ app, rồi hoàn thành Trip khi online | Trước ảnh: UI chặn Complete Trip; sau ảnh PHOTO active `UPLOADED`: Trip `COMPLETED` v11. Chữ ký không thay thế ảnh bắt buộc | NOT RUN |
| 7 | Mở lại Customer Detail và chạy `inspect` / `probe` sau khi hàng đợi GPS hợp lệ đã drain | Customer nhận đúng GPS cuối của Trip này. Trip có 1 START, 4 ARRIVE, 4 COMPLETE_STOP, 1 COMPLETE_TRIP; 10 ExecutionEvent và 10 ProcessedCommand COMPLETED tương ứng theo `commandId`, 1 DeliveryAttempt | NOT RUN |
| 8 | Đối chiếu latest GPS của Trip hoàn thành với vị trí xe khi xe có GPS mới ở chuyến khác | Tracking của Order vẫn dùng tọa độ và timestamp GPS cuối của Trip M4.0. Bằng chứng automated dùng fixture cách ly với Vehicle snapshot khác; ca manual có GPS chuyến sau chỉ chạy khi có chuyến QA phù hợp | NOT RUN |

Để kiểm tra stale, tạm ngừng phát mẫu mới sau khi điểm fresh đã lên Backend. Có thể tắt mạng trên máy Driver trong khi máy Customer vẫn online, đợi quá 120 giây từ `measuredAt` phía Backend, rồi nối mạng lại để kiểm tra phục hồi. Với một máy, dùng `probe` trong lúc Driver mất mạng để đối chiếu API. Ghi FAIL nếu ID, số lượng, quyền truy cập hoặc trạng thái khác tiêu chí. Ghi NOT RUN cho ca chưa thao tác trên thiết bị.

Order chỉ chuyển `COMPLETED` khi đang `IN_TRANSIT` và toàn bộ Package active đã `DELIVERED`. Với kết quả thiếu/thất bại, có thể hoàn thành Trip theo policy nếu các điều kiện riêng đạt nhưng Order vẫn chưa giao xong.

## Đối chiếu PostgreSQL và API

Chạy từ `backend`. Ba chế độ cùng kiểm tra chính xác host/port/database; `inspect` và `probe` chỉ đọc. `seed` trả lại fixture đã có và giữ nguyên tiến độ thực thi hiện tại.

```powershell
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts seed
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts inspect
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts probe
```

- **Trước** khi test, lưu kết quả baseline `inspect`: đúng Trip/Order, GPS 0, event 0, attempt 0. `probe` phải trả detail/tracking 200 cho chủ đơn, 404 truy cập chéo hai chiều, đúng Trip và `hasLocation=false`.
- **Sau** Start, Pickup, Delivery và Complete Trip, chạy lại hai lệnh đọc. Đối chiếu GPS mới nhất theo measuredAt/receivedAt, trạng thái kiện/đơn, OrderEvent, DeliveryAttempt, PHOTO active và cặp ExecutionEvent/ProcessedCommand. Hai API dùng JWT trong ứng dụng Nest chạy riêng và cùng trỏ DB local.
- Với version hoặc event lệch, giữ nguyên dữ liệu và ghi lại bước lỗi. Nếu kiểm thử replay API trên môi trường local, gửi lại chính command và idempotency key đã dùng, rồi so sánh số event/attempt. Không tạo thao tác mới trên Trip đã hoàn thành chỉ để thử trùng.

## Kết quả chuẩn bị ngày 2026-11-20

- Fixture baseline, xác thực DB qua TCP, chạy seed lần hai giữ nguyên ID, ownership HTTP và tracking trước khi có GPS: **PASS**.
- Kiểm tra bcrypt cục bộ xác nhận mật khẩu demo hiện hữu khớp cho cả ba tài khoản. Cấu hình lưu trữ e-POD hiện có đủ biến bắt buộc. Kết quả upload ảnh thật vẫn chờ Android QA.
- **42/42 PASS** trong ba suite PostgreSQL hiện có cho Driver GPS, Driver Trip Execution và Customer Order Tracking. Đây là test với fixture cách ly, chạy ngoài luồng Android M4.0.
- Các case GPS/Execution/e-POD/Customer polling trên thiết bị: **NOT RUN** trong M4.0.

## Chuyến QA thứ hai cùng xe

- Chuyến `QA-M40-DRIVER-CUSTOMER-02` · `d9a7cb92-f80c-404e-90c1-b0a57fb12a33`, dùng cùng xe `QA-M40.01` với chuyến gốc. Driver và Customer giữ nguyên.
- Đơn `QA-M40-ORDER-02` · `1dbc12ee-ef93-40ad-8135-b6cb2b1dc20b`. Baseline Trip `DISPATCHED` v1, Order `ASSIGNED` và GPS = 0.
- GPS cuối chuyến gốc trước bài kiểm tra: `2026-11-20T08:49:02.382Z` theo `measuredAt`. Dùng timestamp này để đối chiếu khi GPS thật của chuyến thứ hai đã lên Backend.

```powershell
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts inspect follow-up
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts probe follow-up
npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts probe original
```

1. Start đúng chuyến có đuôi `-02` và đồng bộ GPS Android thật. Kiểm tra đơn mới có vị trí. Đơn gốc phải giữ GPS cuối của chính nó dù xe đã gửi vị trí trên chuyến mới.
2. Giữ màn hình tracking đơn `-02` mở khi còn mẫu fresh. Dừng đồng bộ từ máy Driver, giữ Customer online và chờ mẫu quá hai phút cộng tối đa một nhịp polling 30 giây. Nếu chỉ có một thiết bị, chuyển sang Customer ngay sau khi Driver gửi mẫu, rồi giữ màn hình mở. Xác nhận cảnh báo xuất hiện mà không tải lại thủ công.
3. Trên chuyến `-02`, hoàn thành bốn điểm dừng nhưng chưa tải PHOTO. Xác nhận UI chặn hoàn thành, rồi tải ảnh mẫu và hoàn thành chuyến. Dùng `inspect follow-up` trước và sau để đối chiếu trạng thái và thời điểm PHOTO.

### Kết quả chuyến thứ hai ngày 2026-11-20

- **GPS liên chuyến PASS qua PostgreSQL/API với GPS Android thật.** Trip `-02` lên `IN_PROGRESS` v2, có 3 điểm đúng Driver. Xe `QA-M40.01` nhận vị trí lúc 16:08:16 (UTC+7) từ Trip `-02`. Tracking đơn `-02` trả vị trí mới và `isStale: false`; tracking đơn gốc vẫn trả GPS cuối 15:49:02 (UTC+7) của Trip gốc.
- **Polling fresh → stale trên UI — PASS theo xác nhận Android của người dùng.** Màn hình tracking đơn `-02` hiển thị cảnh báo **Vị trí có thể đã cũ** theo ca polling.
- **UI chặn hoàn thành trước PHOTO — PASS.** Người dùng xác nhận trên Android. PostgreSQL cùng mốc ghi nhận 4/4 điểm dừng hoàn thành, Order `COMPLETED`, một DeliveryAttempt `SUCCESS`, 0 ảnh PHOTO active `UPLOADED`, 0 sự kiện `COMPLETE_TRIP`. Trip vẫn `IN_PROGRESS` v10.
- Lần đối chiếu tiếp theo thấy Trip `-02` có 8 GPS, mẫu mới nhất lúc 16:09:44 (UTC+7) đúng bằng thời điểm cập nhật vị trí xe. API đơn mới vẫn báo fresh và GPS cuối đơn gốc vẫn là 15:49:02 (UTC+7).
- **Hoàn thành sau PHOTO — PASS.** Sau thao tác Android, PostgreSQL xác nhận ảnh active `UPLOADED` lúc 16:24:56 (UTC+7), trước khi Trip chuyển `COMPLETED` v11 lúc 16:25:11. Có 4/4 điểm dừng, 1 DeliveryAttempt `SUCCESS`, 10 ExecutionEvent và 10 ProcessedCommand tương ứng. Chỉ có 1 event và 1 command `COMPLETE_TRIP`.
- **Tracking sau hoàn thành — PASS qua API.** Đơn `-02` nhận GPS cuối lúc 16:24:55 của đúng chuyến, tổng 47 mẫu trong PostgreSQL. Đơn gốc giữ GPS cuối 15:49:02. API vẫn trả 200 cho chủ đơn và 404 khi truy cập chéo.
- **Kết luận:** luồng chính và ba ca bổ sung Driver → Customer E2E đạt phạm vi QA đã chốt.
