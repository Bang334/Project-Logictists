# Mobile tài xế — QR, pickup từng kiện và kết thúc điểm

Mốc 3, ngày 10/10/2026. Kế thừa mốc nhận chuyến và start/arrive. Quyết định người dùng đã chốt: mỗi kiện có QR riêng; mã lô dùng để gom kiện; quét và xác nhận đã xếp lên xe; được lấy thiếu nhưng phải khai báo chính xác từng kiện chưa lấy và lý do.

## Hành vi đã triển khai

- Camera Expo chỉ đọc QR, không có ô nhập mã thay thế. Quét gọi backend kiểm tra trước, chưa tạo LOAD. Tài xế xem kiện/vị trí kế hoạch rồi bấm xác nhận đã xếp lên xe; backend kiểm tra lại toàn bộ điều kiện trong transaction.
- QR nội bộ: `TMS:PACKAGE:1:<Package.id>`. Có thể dùng chính `Package.packageCode` duy nhất đã đăng ký làm nội dung QR của bên vận chuyển. Không tự đăng ký mã lạ hoặc dùng mã Order chung để ghi nhận nhiều kiện. Tiền tố `TMS:PACKAGE:` dành riêng cho định dạng nội bộ.
- Mã lô hiện hiển thị bằng Order.orderNumber; không thêm Shipment entity hay sửa Order. Một Order có nhiều kiện riêng, kể cả phân công trên nhiều Trip.
- LOAD ghi actualQuantity=1, Package.status=LOADED và tăng Package.version. Mỗi LOAD là một kiện vật lý, không mở kiện hoặc nhập số lượng tùy ý. Không sửa plannedQuantity, Allocation hay nội dung kế hoạch.
- Kết thúc điểm xác nhận `FULL`, `PARTIAL` hoặc `NONE`. Backend tự đối chiếu với kết quả đã lưu; mọi kiện còn thiếu phải có taskId và lý do 1–1000 ký tự. Unknown dùng lý do “chưa xác định”, không tự suy thành mất hàng.
- Điểm chuyển ARRIVED → COMPLETED, ghi actualDepartureTime; Trip vẫn IN_PROGRESS. Hoàn tất điểm lấy thiếu không đồng nghĩa Order hoàn thành. Package chưa lấy giữ nguyên trạng thái, Allocation chưa được release; điều phối xử lý tiếp, không tự phân công lại/optimizer.
- Mỗi LOAD/kết thúc điểm tăng Trip.version một lần. Lệnh hoàn tất có thể phát nhiều ExecutionEvent nhưng chỉ một lần tăng version.
- Điểm PICKUP thuần LOAD được hỗ trợ. Điểm có UNLOAD/mixed task cần mốc delivery tiếp theo. Không tự giao các kiện chưa lấy, không tự kết thúc Trip.

## Contract API

Tiền tố `/driver/assignments/:id/stops/:stopId`. Cả ba endpoint POST dùng session hiện hành và permission `driver.trips.execute`; quan hệ User → Driver → DriverAssignment quyết định quyền tài nguyên. Không tin driverId/userId/branchId từ client. ADMIN/DISPATCHER không tự nhận danh tính tài xế.

| Endpoint | Body ngoài expectedVersion và expectedTripVersion | Kết quả |
|---|---|---|
| `/scan-pickup` | `qrCode` | Kiểm tra chỉ đọc; trả taskId, packageId, packageCode, tripVersion, loadPlanRevision và placement mm |
| `/pickup` | `qrCode`, `loadedOnVehicle: true` | Ghi nhận kiện đã xếp lên xe |
| `/complete-pickup` | `declaredOutcome: FULL/PARTIAL/NONE`, `missing: [{taskId,reason}]` | Ghi nhận từng kiện chưa lấy và kết thúc điểm |

Hai lệnh ghi bắt buộc header Idempotency-Key 8–128 ký tự chữ/số/`_`/`-`. expectedVersion là Assignment.version, expectedTripVersion là Trip.version trước thao tác. Ví dụ kết thúc thiếu:

```json
{
  "expectedVersion": 2,
  "expectedTripVersion": 5,
  "declaredOutcome": "PARTIAL",
  "missing": [{"taskId": "<UUID task chưa lấy>", "reason": "Người gửi chưa đóng gói"}]
}
```

HTTP 200 của lệnh ghi: `{assignmentId,tripId,stopId,tripVersion,eventId,packageId,outcome,occurredAt}`. packageId=null khi kết thúc điểm; outcome=LOADED cho nhận kiện. Quét trả 200 chỉ có nghĩa kiểm tra kiện hợp lệ, chưa nhận bàn giao.

GET detail bổ sung task.actualQuantity, task.pickup `{outcome:LOADED/NOT_COLLECTED,reason,occurredAt}|null`, stop.pickupSummary `{plannedCount,loadedCount,outcome}|null`. Không trả QR hash, snapshot nội bộ hoặc dữ liệu optimizer. Mobile hiển thị kết quả đủ/thiếu sau reload.

400: DTO sai, thiếu lý do, khai báo không khớp kiện còn thiếu hoặc hiện trạng. 401 xóa phiên; 403 giữ phiên và báo thiếu quyền. 404 không tìm thấy phân công/điểm/QR trong phạm vi được phép. 409 gồm VERSION_CONFLICT, IDEMPOTENCY_MISMATCH, INVALID_TRANSITION, PLAN_CHANGED, PICKUP_SNAPSHOT_REQUIRED, PACKAGE_ALREADY_RECORDED, PACKAGE_UNAVAILABLE, LOAD_PLAN_REQUIRED, INVALID_LOAD_PLAN, LOADING_PATH_BLOCKED, ONBOARD_PLAN_CONFLICT, CAPACITY_EXCEEDED, UNSUPPORTED_PICKUP_STOP/LOADING_PATH. Lỗi DB dùng filter hiện hữu trả 503.

## Snapshot, xếp hàng và giới hạn contract Người 1

Start mới lưu snapshot schemaVersion=2 gồm route cũ và pickupPlan: Allocation/Package, kích thước xe và LoadPlan mới nhất cùng steps/placements. Hash canonical loại bỏ khác biệt thứ tự key JSON; không đưa actual/status/version Package biến động vào hash. Mọi lệnh pickup kiểm tra lại kế hoạch hiện tại với snapshot; thay kích thước, ánh xạ kiện, LoadPlan hoặc kế hoạch sau start sẽ bị chặn.

Snapshot v1 vẫn dùng được cho arrive; không bị sửa/backfill. Pickup trên snapshot v1 trả PICKUP_SNAPSHOT_REQUIRED. Không được tạo lại lịch sử hoặc sửa ngược Trip để lách điều kiện này.

LoadPlan hiện lưu trạng thái sau mỗi stop, chưa có thứ tự/đường thao tác LOAD từng kiện đầy đủ. Guard thực thi chỉ chứng minh đường **tịnh tiến thẳng qua cửa sau**, không chồng, nằm trong thùng, đúng kích thước và vị trí đã duyệt; kiểm tra cản bởi các kiện thực sự đang trên xe, tải thực và không đổi vị trí kiện cũ. Không sinh bố trí mới, không suy thứ tự từ ID, không dịch chuyển kiện còn lại.

**Chưa hoàn tất hỗ trợ mọi phương án xếp hàng của optimizer**: đường cần rẽ/xoay hoặc loại cửa khác bị chặn, kể cả có thể tồn tại phương án hợp lệ. Cần Người 1 bổ sung contract thao tác theo kiện, đường đi đã kiểm chứng và chiều cửa để consumer thực thi dùng chung validator. Đây là giới hạn đang chặn các phương án đó, không phải tính năng đã hoàn thành hay lựa chọn nghiệp vụ của người dùng.

## Transaction và dữ liệu dùng chung — Người 2 review

- Khóa advisory tài nguyên xe 4101 → tài xế 4102, tái kiểm tra session/scope; namespace 71009 cho actor/key. Khóa Assignment, Trip, Allocation, StopTask và Package theo thứ tự ổn định. Tranh chấp cùng package giữa các Trip được serialize bằng khóa Package và unique index.
- ProcessedCommand namespace DRIVER_PICKUP: cùng key/nội dung trả kết quả cũ; đổi nội dung/đích/action trả 409. Danh sách missing được canonical theo taskId. Mobile giữ nguyên key/payload khi kết quả mạng chưa rõ, chống nhấn lặp; không có offline queue bền vững.
- Migration mới `20261010090000_driver_pickup_results` tạo PickupResult, FK tới task/event/allocation/package, CHECK outcome/reason, unique task và package LOADED, trigger đối chiếu các quan hệ và cấm sửa/xóa lịch sử. Không backfill kết quả cho dữ liệu cũ, không sửa migration đã áp dụng.
- Custody của kiện đã lấy được truy qua PickupResult → ExecutionEvent → snapshot Trip/vehicle, không suy từ Allocation tương lai. Unique LOADED hiện áp dụng suốt vòng đời kiện vì mốc này chưa có unload/reload/chuyển tải; phải nâng thành custody theo chặng có review trước khi mở nghiệp vụ đó.
- Cập nhật Package/Task/Trip/Stop, command, kết quả, audit và outbox trong cùng transaction. Lỗi bất kỳ bước nào rollback tất cả.
- ExecutionEvent: PACKAGE_LOADED, PACKAGE_NOT_COLLECTED, PICKUP_STOP_COMPLETED; có sourceSnapshotId, commandId và eventSequence. Reason nằm trong PickupResult, không broadcast.
- Outbox: `driver.package.loaded`, `driver.pickup.completed`; aggregate Trip/version. Payload chỉ ID, version, outcome để tải lại snapshot. Publisher dùng gateway Trip hiện hữu có scope. Không đổi quyền role khác.
- Migration đã chạy trên PostgreSQL thử có dữ liệu, giữ nguyên số task và không suy kết quả cũ. Script test dùng prisma db execute theo môi trường thử hiện hữu chưa có migration ledger; không tự baseline/deploy DB dùng chung. Trước áp dụng môi trường khác cần review lịch sử, backup và lock bảng. Khôi phục bằng backup/migration tiến tiếp, không xóa chứng cứ pickup.

## Chạy thử và QR demo

Trong backend, dùng database thử local đã cấu hình AUTH_TEST_DATABASE_URL và mật khẩu AUTH_DEMO_PASSWORD trong `.env`:

```powershell
npm run prisma:generate
npm run driver:demo:prepare
npm run driver:pickup:seed
npm run driver:pickup:labels
npm run build
npm run start:driver-demo
```

Seed tạo chuyến DEMO-MOBILE-PICKUP-A/B, mỗi chuyến hai kiện cho demo_driver_a/b; không reset tài khoản/scope/kết quả cũ. Đây là fixture hai khối đã kiểm tra đường thẳng/tải, không phải chứng minh publish/optimizer sản xuất hoạt động. Nhãn in được tại `backend/logs/driver-pickup-labels.html`, tạo cục bộ bằng qrcode, không gửi thông tin sang dịch vụ ngoài. Mở trên máy khác màn hình hoặc in để điện thoại quét. Muốn lấy đủ, lấy kiện không có hậu tố K02 trước rồi K02; muốn lấy thiếu, xác nhận một kiện và khai báo kiện còn lại.

Trong mobile: đặt EXPO_PUBLIC_API_URL trong `.env.local`, chạy `npm start`. Android emulator: `http://10.0.2.2:4013`; điện thoại thật dùng IP LAN máy backend. Thiếu URL báo lỗi cấu hình. Expo Camera chỉ xin quyền camera, tắt microphone. Đăng nhập → nhận chuyến demo mới → bắt đầu → đến điểm → quét → xem kiện/vị trí → xác nhận đã xếp → kết thúc đủ/thiếu → tải lại.

## Kiểm chứng

Các lệnh thực thi: Prisma validate/generate; migration PostgreSQL qua driver:demo:prepare; backend typecheck/build/lint/Jest; test:driver:pickup, test:driver:execution, test:driver, test:driver:client; mobile typecheck/test/lint; Expo Android export; git diff --check.

Kết quả: pickup PostgreSQL 11/11 (10 ca và test cha); hồi quy start/arrive 13/13, assignment 18/18, client/Socket.IO 1/1; backend Jest 37 suites/161 test đạt, 3 suites/4 test PostgreSQL cũ tự skip do chưa cấu hình riêng và không được tính là đã chạy. Mobile 5 suites/39 test, typecheck/lint đạt. Prisma validate/generate, migration trên PostgreSQL thử, backend typecheck/build/lint đạt. Android Hermes export đạt; đây không phải build APK/native đã chạy.

Test pickup PostgreSQL dùng Nest HTTP và database thật: quyền/QR/DTO, kiểm tra QR không tạo LOAD, kết quả bền vững, replay, thiếu lý do/kiện/outcome sai, đủ/thiếu/không lấy được, tranh chấp LOAD–complete, đường bị cản, kế hoạch thay đổi, rollback LOAD và complete, snapshot v1, mobile Api/DriverStore thực rồi reopen. Fixture hình học trong test có đánh dấu demo, không thay thế kiểm thử optimizer.

Mobile test camera callback/permission được mock: quét một lần, kiểm tra server trước confirmation, khai báo thiếu, mất mạng/retry, 401/403/409, response phiên cũ không ghi vào tài khoản mới. **Chưa kiểm chứng trên điện thoại/emulator**: không có adb/Android SDK/thiết bị trong môi trường. Export Hermes không phải APK đã chạy; camera thật, chất lượng đọc nhãn và bố cục/keyboard trên máy thật vẫn cần nghiệm thu. Backend chỉ kiểm chứng mã và quyền, không thể dùng payload client để chứng minh camera thực sự nhìn thấy kiện vật lý.

Tài liệu SDK đã đối chiếu: [Expo Camera SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/camera/). Dependency mới: expo-camera phù hợp SDK; qrcode devDependency phục vụ nhãn demo. Không nâng major dependency hiện có, không thay optimizer, không commit/push/deploy.
