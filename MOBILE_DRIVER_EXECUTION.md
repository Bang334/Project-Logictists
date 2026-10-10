# Mobile tài xế — bắt đầu chuyến và đến điểm

Mốc 2, ngày 09/10/2026. Kế thừa đăng nhập, nhận/từ chối và đọc phân công của mốc 1. Không triển khai pickup/delivery, hoàn tất stop/chuyến, GPS, POD hoặc offline queue.

Phạm vi và kết quả dưới đây ghi lại mốc 2. Mốc 3 bổ sung QR/pickup/kết thúc điểm và snapshot v2 trong [MOBILE_DRIVER_PICKUP.md](MOBILE_DRIVER_PICKUP.md); các giới hạn “chưa có pickup” dưới đây không còn mô tả toàn bộ code hiện tại.

## Quy tắc đã được người dùng chốt trong phiên

- Cho bắt đầu sớm hơn plannedStartTime. Assignment phải ACCEPTED; Trip đang DISPATCHED; xe và tài xế không được có chuyến khác IN_PROGRESS.
- Xác nhận đến điểm bằng thao tác thủ công, không phải bằng chứng GPS. Điểm trước phải COMPLETED. Mốc này dừng ở ARRIVED điểm đầu vì chưa có nghiệp vụ hoàn tất điểm.
- Bắt đầu chuyển Trip sang IN_PROGRESS. Mỗi start/arrive thành công tăng Trip.version một lần; không đổi Assignment.version/status hay nội dung kế hoạch.
- Tạo snapshot thực thi bất biến tại lúc bắt đầu. Execution event tham chiếu snapshot vì schema hiện chưa có TripPlan. Đây là contract tạm cho thực thi đã được chấp thuận, không tuyên bố đã triển khai TripPlan/active_plan_id theo toàn bộ DB10.

Thời gian actual dùng thời điểm máy chủ xử lý lệnh online (UTC), không nhận thời gian thiết bị. Thời gian planned giữ nguyên. Mất mạng không được báo đã thực hiện; retry giữ cùng key/payload trong bộ nhớ. Sau khi mở lại app, tải snapshot hiện tại trước thao tác tiếp.

## API

Permission mới: `driver.trips.execute`, cấp cho role DRIVER qua role_permissions. Scope BRANCH phải khớp Driver.homeBranchId như mốc 1; ADMIN/DISPATCHER không tự có quyền này. Danh tính luôn lấy từ session và Driver.userId.

| Endpoint | Hành vi |
|---|---|
| POST `/driver/assignments/:id/start` | Bắt đầu chuyến đã nhận |
| POST `/driver/assignments/:id/stops/:stopId/arrive` | Ghi nhận đến điểm thuộc chính chuyến |

Cả hai gửi `Authorization: Bearer …`, `Idempotency-Key` dài 8–128 ký tự chữ/số/`_`/`-`, body:

```json
{"expectedVersion":2,"expectedTripVersion":2}
```

HTTP 200 trả `{assignmentId,tripId,tripVersion,stopId,eventId,snapshotId,sourceTripVersion,occurredAt,status}`. `stopId=null/status=IN_PROGRESS` cho start; `status=ARRIVED` cho arrive. Version trong request là version trước thao tác; response là version sau thao tác. Cùng key/body trả lại chính kết quả đã lưu, kể cả version hiện tại đã tăng. Đổi thứ tự thuộc tính JSON không đổi ý nghĩa request. Cùng key khác nội dung/action/đích trả 409.

GET list/detail bổ sung `trip.actualStartTime`, `actualEndTime`, `executionSnapshot:{id,sourceTripVersion}|null`. Detail bổ sung `stop.status`, `actualArrivalTime`, `actualDepartureTime`. Không trả nội dung snapshot nội bộ. Mobile hiển thị riêng version Trip và version kế hoạch nguồn.

Lỗi: 400 DTO/UUID/key; 401 session; 403 permission/scope; 404 assignment/stop không thuộc tài xế/chuyến; 409 với mã `VERSION_CONFLICT`, `ASSIGNMENT_NOT_ACCEPTED`, `INVALID_TRANSITION`, `INVALID_EXECUTION_STATE`, `RESOURCE_BUSY`, `RESOURCE_UNAVAILABLE`, `PREVIOUS_STOP_INCOMPLETE`, `PLAN_CHANGED`, `IDEMPOTENCY_MISMATCH`. Lỗi lưu DB được filter hiện hữu trả 503. Mobile tải lại sau 409 và giữ lý do nghiệp vụ; chỉ thông báo version thay đổi khi đúng VERSION_CONFLICT.

## Transaction và kế hoạch nguồn

Khóa tài nguyên cùng namespace/thứ tự của planning/publish: xe 4101, tài xế 4102. Khóa hàng tài xế, assignment, Trip và xe khi start; tái kiểm tra danh tính sau khi chờ khóa. Advisory lock riêng serialize actor/idempotency key. Hai chuyến chung xe hoặc tài xế không được start đồng thời dù lịch planned khác nhau.

Start kiểm tra status AVAILABLE của xe/tài xế, hạn bằng còn qua thời điểm hiện tại và plannedEndTime, khoảng xe không khả dụng ACTIVE và nghỉ tài xế APPROVED. Các stop phải PENDING, chưa có actual. Mốc này không tự đổi status tài nguyên hoặc reservation; Trip IN_PROGRESS là nguồn kiểm tra đang chạy. Không tính lại feasibility/optimizer và không tự publish.

Snapshot lưu ID xe, thời gian planned, thứ tự/địa chỉ/tọa độ/thời gian stop, ID/action/số lượng task, allocation/orderStop ID và phân công tài xế/phạm vi stop. Snapshot gắn `sourceTripVersion` trước start, hash SHA-256 và ID riêng. Arrive so sánh lại hash các trường kế hoạch này; khác thì PLAN_CHANGED, không tự điều chỉnh lịch sử. Không bao gồm chi phí, token, giấy tờ tài xế hoặc kết quả optimizer.

Trip/Stop update, snapshot, ProcessedCommand, ExecutionEvent, AuditLog và OutboxEvent nằm trong cùng transaction. Event `TRIP_STARTED`/`STOP_ARRIVED` có `commandId` FK thật, `eventSequence=0`, sourceSnapshotId, occurredAt/receivedAt và phương thức DRIVER_MANUAL. Unique index chặn ghi start/arrival lần hai với key khác. DB kiểm tra snapshot/stop thuộc cùng Trip. Snapshot và event mới có trigger cấm update/delete.

Outbox: `driver.trip.started`, `driver.stop.arrived`, aggregate Trip, payload chỉ gồm tripId, assignmentId, stopId, tripVersion, executionEventId. Publisher tái sử dụng gateway có phân quyền để phát `trip:updated {id,version}`; mobile tải snapshot bằng HTTP.

## Migration và vận hành thử

Migration mới `20261009090000_driver_trip_execution` tạo trip_execution_snapshots, thêm FK/sequence/source vào execution_events, unique index và trigger bất biến, cấp permission mới. Không sửa migration cũ hoặc suy lịch sử start/arrival cho chuyến cũ. Chuyến IN_PROGRESS cũ không có snapshot sẽ bị từ chối arrive; cần phương án chuyển đổi có review, không tạo snapshot giả.

Migration có transaction; nếu dữ liệu cũ có commandId mồ côi, stop khác Trip hoặc duplicate start/arrival thì fail/rollback để kiểm kê. Kiểm tra dữ liệu, backup và thời gian khóa bảng trước khi áp dụng ngoài database thử. Khôi phục bằng backup hoặc migration tiến tiếp có review; không xóa snapshot/lịch sử để rollback tính năng.

Đã áp dụng SQL trên `tms_driver_test_20261007` local có dữ liệu từ mốc 1, không reset/truncate/db push. Database thử nguồn chưa có Prisma migration ledger (theo cách chuẩn bị SQL trước đây); script test tiếp tục dùng prisma db execute và không tự baseline database dùng chung. Người 2 cần đối chiếu lịch sử trước khi migrate deploy ở môi trường khác.

```powershell
cd backend
npx prisma generate
npm run driver:demo:prepare
npm run driver:demo:seed
npm run build
npm run start:driver-demo
```

Backend demo port 4013. PostgreSQL test local port 55439, Redis 56389; AUTH_TEST_DATABASE_URL và AUTH_DEMO_PASSWORD lấy từ backend/.env. Không chạy script test/demo trên dữ liệu vận hành.

```powershell
cd mobile
# Nếu chưa có .env.local: copy từ .env.example rồi cấu hình EXPO_PUBLIC_API_URL.
npm start
```

Android emulator dùng `http://10.0.2.2:4013`; thiết bị thật dùng IP LAN của máy backend. Đăng nhập demo_driver_a/b với AUTH_DEMO_PASSWORD, chọn phân công ASSIGNED → nhận → bắt đầu → đến điểm đầu. Chuyến demo ngày tương lai vẫn start được vì đã cho phép sớm. Seed không reset assignment/chuyến đã thực hiện; hết chuyến phù hợp thì cần fixture mới, không xóa lịch sử hoặc sửa ngược status bằng tay. Dữ liệu demo là fixture DISPATCHED phục vụ thực thi, không phải bằng chứng đã qua publish/validator.

## Kiểm chứng và review

Lệnh: Prisma validate/generate, backend typecheck/build/lint/Jest, `test:driver:execution`, `test:driver`, `test:driver:client`; mobile typecheck/lint/test và Expo Android export; git diff --check.

Kết quả đã chạy: migration SQL trên PostgreSQL, Prisma validate/generate và backend typecheck/build/lint đạt; integration execution 13/13 (12 ca + test cha), assignment 18/18 và client/Socket.IO 1/1 đạt; mobile typecheck/lint và 30/30 test đạt; bundle Android Hermes xuất thành công. git diff --check đạt cho cả file cũ và file mới. Không dùng kết quả mock thay cho các bài integration PostgreSQL này.

Backend Jest cuối: 36 suites / 151 tests đạt; 3 suites / 4 test PostgreSQL cũ tự skip khi không có TEST_DATABASE_URL, không tính là đã chạy. Test PostgreSQL mới nêu trên dùng script cấu hình database riêng và đã thực thi thật.

Test PostgreSQL mới bao gồm quyền/ownership/validation/version, start sớm, hai chuyến tranh tài nguyên, replay, arrival theo thứ tự, snapshot bất biến/FK, kế hoạch đổi sau start, rollback do outbox lỗi và code Api/DriverStore thực gọi Nest HTTP rồi reopen đọc lại trạng thái. Token storage trong test client là adapter chỉ dùng cho test.

Mobile có test confirmation start/arrive, chặn bấm lặp, retry giữ key, lỗi mạng/401/403/409, lý do RESOURCE_BUSY và dừng tại ARRIVED. Những test này không thay thế kiểm thử native. Chưa có Android SDK/emulator/thiết bị để xác minh SecureStore, keyboard và thao tác thực tế; Android export chỉ là bundle Hermes, không phải APK đã chạy.

Người 1 review version Trip tăng khi thực thi, snapshot/hash và việc khóa sửa kế hoạch sau start; vẫn sở hữu publish/feasibility/replan. Người 2 review schema/FK/trigger/permission, lock order dùng chung, command/outbox và lịch sử migration. Test schema contract được cập nhật từ 86 lên 87 model, có assertion TripExecutionSnapshot, không bỏ kiểm tra model cũ.

Trước mốc pickup/delivery cần chốt task completion, số lượng/kiện, custody, arrival ngoài thứ tự có ngoại lệ hay không, kế hoạch mới khi đang chạy và ánh xạ snapshot hiện tại sang TripPlan tương lai. Mốc này không mở endpoint bypass để đi qua stop chưa hoàn tất.

Tham chiếu SDK: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/). Không thêm dependency mobile cho mốc này.
