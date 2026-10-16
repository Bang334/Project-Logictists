# Mobile tài xế — QR, dỡ hàng, POD và hoàn tất điểm giao

> **Cập nhật 16/10/2026:** Theo yêu cầu người dùng, mã nguồn app mobile và API thực thi riêng của Người 3 đã được gỡ, gồm phần chưa commit. Nội dung mobile bên dưới là tài liệu lịch sử/yêu cầu, không mô tả chức năng hiện có. Schema và migration được giữ để bảo toàn lịch sử dữ liệu.

Cập nhật 12/10/2026, nhánh `feat/mobile-driver`. Quyền triển khai và các quyết định dưới đây đến từ yêu cầu/trao đổi trực tiếp của người dùng. Code nối Expo → NestJS → PostgreSQL → private filesystem và validator Python thật. Chưa nghiệm thu camera, upload native và bố cục trên điện thoại/emulator; xem giới hạn cuối tài liệu.

## Quy tắc đã chốt — D14 / phần POD của POL08

- QR riêng mỗi Package vật lý; quét chỉ kiểm tra, không ghi dỡ hoặc giao. Không mở kiện để giao một phần bên trong.
- Tách **dỡ khỏi xe** và **bàn giao người nhận**. Kiện đã dỡ vẫn do tài xế giữ tại điểm, chưa tính giao thành công.
- Bàn giao cần tên người nhận và ít nhất một ảnh hàng/biên nhận được backend kiểm chứng. Không chữ ký/OTP. Dùng chung POD trong cùng lần bàn giao tại một điểm; mỗi kiện có DeliveryResult riêng.
- Cho hoàn tất điểm giao đủ/thiếu/không giao được sau khi khai báo đúng từng kiện đã pickup nhưng chưa giao và lý do, không cần điều phối duyệt. Hàng chưa giao giữ trên xe chờ điều phối; không tự giao lại/trả hàng/chuyển tải.
- NOT_COLLECTED hiển thị riêng **chưa pickup**, không tính giao thất bại hoặc hàng trên xe.
- Không hoàn tất điểm khi còn kiện đã dỡ chưa bàn giao. Phải bàn giao hoặc quét, kiểm chứng đường và xác nhận **xếp lại đúng vị trí ban đầu trên cùng xe**. Không tạo PickupResult mới cho thao tác xếp lại.
- Không đổi Assignment.status, planned quantity, route, LoadPlan hoặc tự hoàn tất Trip/Order. Task.actualQuantity chỉ thành 1 khi bàn giao; kết quả không giao/chưa pickup là 0.

## State machine và nguồn custody

| Trạng thái | Bằng chứng / nơi giữ | Thao tác kế tiếp |
|---|---|---|
| ON_VEHICLE | PickupResult LOADED + event đúng snapshot/xe; hoặc PACKAGE_RELOADED | Dỡ; hoặc khai báo chưa giao khi kết thúc điểm |
| UNLOADED | DriverDeliveryState + PACKAGE_UNLOADED; tài xế giữ tại điểm | Bàn giao cùng POD hoặc xếp lại có kiểm chứng |
| DELIVERED | DeliveryResult + PACKAGE_DELIVERED + DeliveryAttempt có POD | Kết quả cuối, không giao lại |
| FAILED | Đã lấy nhưng chưa giao, vẫn trên xe chờ điều phối | Kết quả cuối tại điểm, không tự xử lý chuyến khác |
| NOT_COLLECTED | PickupResult NOT_COLLECTED, giữ lý do pickup | Lưu DeliveryResult NOT_COLLECTED khi hoàn tất điểm |
| UNKNOWN | Thiếu chứng cứ pickup | Chặn thực thi, không suy từ Allocation |

`Package.status=LOADED` là trạng thái tổng hợp cũ, giữ trong bước UNLOADED; **không đại diện vị trí vật lý hiện tại**. Consumer tải/vật cản phải đọc PickupResult và DriverDeliveryState: loại UNLOADED/DELIVERED khỏi xe; giữ ON_VEHICLE/FAILED. Consumer pickup đã được cập nhật. Chứng cứ pickup, snapshot, event và Package.status được kiểm tra phối hợp, không dùng riêng status để chứng minh custody.

## API và DTO

Prefix `/driver/assignments/:id/stops/:stopId`. JWT + permission `driver.trips.execute`; tái kiểm tra session/user/role/scope, User–Driver và assignment thuộc chính tài xế trong transaction. Không mở quyền upload chung cho DRIVER.

Mọi POST có `expectedVersion` (Assignment), `expectedTripVersion` (Trip). Mọi lệnh ghi có header `Idempotency-Key` 8–128 ký tự chữ/số/`_`/`-`; scan chỉ đọc, không ghi command.

| Method / đường dẫn | Dữ liệu ngoài version | Hành vi |
|---|---|---|
| POST `scan-delivery` | `qrCode` | Kiểm tra kiện UNLOAD/custody, trả task/package/path/custody/contextHash; không tạo event |
| POST `unload` | `qrCode`, `unloadedFromVehicle:true` | Kiểm chứng lại hàng thực tế, ghi UNLOADED |
| POST `scan-reload` | `qrCode` | Chỉ kiện UNLOADED, kiểm chứng đường vào vị trí ban đầu |
| POST `reload` | `qrCode`, `reloadedOnVehicle:true` | Ghi ON_VEHICLE, không tạo pickup/vị trí mới |
| POST `pod` | `mediaType`, `sizeBytes` | Server tạo podId/storageKey/owner/scope/expiry; không nhận URL từ client |
| POST `pod/:podId/upload` | multipart `file`, hai trường version | Một file, ghi bytes/checksum, trạng thái UPLOADING |
| POST `pod/:podId/confirm` | Chỉ version | Đọc lại bytes/metadata/checksum, trạng thái UPLOADED |
| POST `handover` | `taskIds[]`, `podFileIds[]`, `recipientName`, `handedToRecipient:true` | 1–1000 task duy nhất đã UNLOADED; 1–10 POD đã xác minh, chưa gắn, cùng owner/assignment/stop/snapshot và còn hạn |
| POST `complete-delivery` | `declaredOutcome` FULL/PARTIAL/NONE, `failed:[{taskId,reason}]` | Danh sách chính xác các kiện LOADED chưa giao; reason 1–1000 ký tự sau trim; không đưa NOT_COLLECTED vào failed |
| GET `pod/:podId` | Không body | Tải theo quyền hiện hành; đối chiếu checksum metadata và DB; audit đọc; `private,no-store`, `nosniff` |

Response ghi: `assignmentId`, `stopId`, `tripVersion`, `occurredAt`, `outcome` và ID tương ứng. Snapshot trả `tasks[].delivery:{state,reason}`, `stops[].driverPodFiles` chỉ có metadata hiển thị, không chứa storageKey/URL/token/bytes.

Lỗi: 400 DTO/manifest/outcome; 401 hết phiên; 403 quyền; 404 ngoài tài nguyên; 409 version/plan/custody/path bị chắn/POD chưa sẵn sàng; 413 quá giới hạn multipart; 415 MIME/magic bytes; 503 validator không kiểm chứng được hoặc lỗi lưu. Lịch sử giao cũ không có ExecutionEvent trả LEGACY_DELIVERY_HISTORY khi ghi, cần đối soát; không backfill giả.

## UNLOAD dùng chung — Người 1 review

LoadPlan cũ giữ bố trí **sau stop**, thiếu đường của kiện đã rời xe. Endpoint nội bộ Python `POST /validate-execution-path` mới gọi **chính SpatialValidator._build_package_access_paths hiện có**. Không tạo thuật toán hình học khác, không chạy routing solver, tìm bố trí hoặc replan.

- Contract version `1`, validator_version `spatial-validator-v1`, context_hash gắn snapshot/Trip.version/stop/hướng/input.
- Backend lấy vị trí cố định từ LoadPlanStep và placementHash trong event pickup. Chỉ đưa tập kiện thực tế trên xe; reload thêm kiện đích tại vị trí ban đầu. Package.id là item_id, Order.id là order_id; mm/g đổi sang cm/kg.
- Validator kiểm tra kích thước hữu hạn/dương, giới hạn thùng/tải, ID/đích, va chạm, không z/xếp chồng; đường do validator dùng chung tính. Không dịch chuyển/xoay hàng khác, không suy thứ tự từ ID.
- Yêu cầu bước DELIVERY đúng task, LoadPlan VALID, hình học/cửa sau khớp snapshot. Python timeout 5 giây; kiểm tra contract/path hữu hạn. Transaction khóa lại, so contextHash/version sau khi Python trả về rồi mới ghi.
- Giới hạn kỹ thuật: 64 kiện trên xe, cửa sau, hướng cố định đang hỗ trợ ở execution. Vượt giới hạn trả lỗi rõ, không bỏ vật cản để tạo đường giả. Path là góc kiện theo cm tới cửa, x tăng về cửa sau; reload đảo chiều path.
- Hàng FAILED vẫn tính tải/vật cản cho pickup sau. Nếu LoadPlan tương lai không mô tả được vị trí hàng còn lại, chặn để điều phối xử lý; không tự sửa plan.

Người 1 cần review adapter, contract lâu dài và giới hạn trên. Phương án ngoài giới hạn **chưa hỗ trợ**. Giới hạn LOAD tịnh tiến thẳng từ mốc pickup vẫn giữ; không nhận đã nghiệm thu mọi phương án optimizer.

## Transaction, migration, realtime — Người 2 review

- Khóa xe 4101 → tài xế 4102 → user/driver/assignment/trip/allocation/task/package theo thứ tự chung. Khóa pod row khi gắn/confirm/cleanup. Actor/key namespace 71010, command type DRIVER_DELIVERY.
- Replay cùng key/payload trả kết quả đã commit trước kiểm tra expected version, vẫn xác thực quyền. Đổi payload/action/đích/bytes/MIME trả 409. Key mới không vượt trạng thái cuối/unique result.
- Mỗi lệnh ghi tăng Trip.version đúng một lần, giữ Assignment.version/status. Kết quả/state/actual/event/audit/outbox/ProcessedCommand atomic trong SQL. Python và upload vật lý không phải thành phần atomic của SQL.
- Events: PACKAGE_UNLOADED, PACKAGE_RELOADED, PACKAGE_DELIVERED, PACKAGE_DELIVERY_FAILED, DELIVERY_NOT_COLLECTED, DELIVERY_STOP_COMPLETED, POD_UPLOAD_RESERVED, POD_BYTES_STORED, POD_VERIFIED.
- Outbox `driver.delivery.updated`: tripId/assignmentId/stopId/tripVersion; gateway dùng room/quyền hiện có. Không broadcast ảnh/tên người nhận/lý do. Mobile tải snapshot HTTP sau thành công/reopen.
- Migration `20261010140000_driver_delivery_pod`: DriverDeliveryState, FK snapshot/event/command, POD tạm nullable attempt với owner/scope/expiry; unique task result/kiện delivered/stop completion; trigger transition/linkage/lịch sử.
- Migration tiến tiếp `20261012090000_driver_pod_history_guard`: cấm bỏ owner để vượt trigger, cấm xóa POD đã gắn, bắt size cho owned POD mới. Không sửa migration đã chạy.
- Link mới nullable để giữ dữ liệu cũ, không suy custody. FK DeliveryAttempt.commandId NOT VALID cho lịch sử chưa đối soát nhưng kiểm tra ghi mới. Partial unique bao phủ result có event mới; service còn kiểm tra delivered lịch sử theo Package.
- Đã áp DB thử **có dữ liệu**, xác nhận giữ task/pickup/result/POD, không tạo custody giả. DB thử dùng prisma db execute, chưa có migration ledger đầy đủ. Không tự baseline/deploy DB chung. Trước áp dụng chung cần review legacy command/result, backup, thời gian khóa/index, consumer PodFile.deliveryAttemptId nullable. Khôi phục bằng backup/migration tiến tiếp, không drop chứng cứ.

## POD/storage và mobile

Private filesystem StorageService hiện có, không qua Cloudinary/generic upload. STORAGE_ROOT là root bền vững. STORAGE_MAX_FILE_BYTES mặc định 10 MiB; delivery áp trần 10 MiB và không vượt cấu hình thấp hơn. JPEG/PNG/WebP: kiểm tra kích thước/MIME/magic bytes/SHA-256; không phải nhận diện nội dung ảnh hay antivirus.

Key bất biến `pod/<uuid>-proof.<ext>` được reserve trong DB trước ghi bytes. File/sidecar ghi mới; retry cùng bytes dùng lại key. Confirm đọc tệp thật. SQL upload lỗi sau ghi bytes vẫn giữ reservation để retry; nghiệp vụ rollback không gắn POD. Crash tạo tệp dở không khớp checksum: bỏ draft/chọn lại, file cũ được cleanup.

POD chưa gắn hết hạn sau 24 giờ (giới hạn tạm kỹ thuật, **không phải retention lịch sử**). Job mỗi 60 giây, tối đa 20 row, FOR UPDATE SKIP LOCKED; xóa bytes/sidecar rồi đánh dấu discarded/FAILED. Không xóa file đã gắn. Nhiều replica cần cùng persistent STORAGE_ROOT; chưa kiểm chứng vận hành nhiều replica.

Expo 57 dùng expo-camera hiện có; thêm expo-image-picker ~57.0.20, expo-file-system ~57.0.7 qua expo install, không nâng major. Multipart native foreground, progress bytes **chưa phải xác minh**, timeout 60 giây, abort khi logout. Tắt microphone.

UI: ảnh trên máy → đang gửi → chờ xác minh → server xác minh → gắn bàn giao; retry/bỏ draft lỗi, chọn kiện/ảnh/tên người nhận và confirmation bàn giao riêng. Tổng kết điểm và lý do từng kiện còn trên xe, mở lại lấy dữ liệu DB.

Draft/key chỉ trong bộ nhớ, chưa có offline queue bền vững. 401 xóa phiên, 403 giữ phiên, 409 tải snapshot/lý do. Epoch chặn response phiên cũ, draft gắn assignment. AppState khi dùng picker không xóa điểm đang chọn. Ảnh tạm app sở hữu được dọn sau confirm/bỏ draft/logout/unmount và lúc mở lại; không xóa ảnh gốc thư viện. App bị đóng phải tải lại trạng thái server, chọn lại nếu ảnh chưa upload; không báo đồng bộ giả.

Docs đối chiếu: [ImagePicker SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/), [FileSystem SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/), [Camera SDK 57](https://docs.expo.dev/versions/v57.0.0/sdk/camera/).

## Demo và cách kiểm chứng

DB thử local từ AUTH_TEST_DATABASE_URL, tên đích `tms_driver_test_20261007`, Redis thử 56389. Mật khẩu chỉ lấy AUTH_DEMO_PASSWORD từ môi trường, không đưa secret vào repo. Trong backend:

```powershell
npm run prisma:generate
npm run driver:demo:prepare
npm run build
npm run driver:delivery:seed
npm run driver:delivery:labels
npm run start:driver-demo
```

Seed chỉ chạy DB thử local, tạo DEMO-MOBILE-DELIVERY-A/B cho demo_driver_a/b qua API login/accept/start/arrive/pickup/complete-pickup/arrive thật. Mỗi chuyến có một kiện LOADED và một NOT_COLLECTED (K02). Rerun giữ kết quả/account/scope, không kích hoạt quyền thu hồi/reset chuyến. Nếu tài xế/xe đang chạy demo khác, báo xung đột và giữ nguyên; không sửa status để lách.

Nhãn: `backend/logs/driver-delivery-labels.html`, QR `TMS:PACKAGE:1:<Package.id>`. Fixture hai khối đánh dấu DEMO, không phải output optimizer sản xuất. K02 bị từ chối do chưa pickup; kiện B trong tài khoản A bị từ chối do ngoài tài nguyên.

Trong optimizer:

```powershell
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Backend OPTIMIZER_URL trỏ Python (mặc định localhost:8000). Mobile EXPO_PUBLIC_API_URL: emulator Android `http://10.0.2.2:4013`, điện thoại dùng IP LAN backend. `npm start` trong mobile; kiểm tra native bằng development build có modules/plugin mới.

Tài xế A → DELIVERY-A → quét kiện không K02 → xem đường → xác nhận dỡ → chọn/chụp ảnh → upload/xác minh → chọn ảnh/kiện, nhập người nhận → xác nhận bàn giao → hoàn tất PARTIAL → mở lại. Thử từ chối: dỡ → quét/xác nhận xếp lại → hoàn tất NONE kèm lý do kiện LOADED. Trip vẫn IN_PROGRESS.

## Kiểm chứng và giới hạn

| Kiểm tra | Kết quả thực chạy |
|---|---|
| Backend typecheck/lint/build; Prisma validate/generate | Đạt |
| Migration PostgreSQL thử có dữ liệu | Đạt, không reset/backfill kết quả |
| test:driver:delivery | 16 ca + test cha = 17/17; Nest HTTP/PostgreSQL/storage tạm/Python thật; outage tiêm URL không kết nối được, ca race chỉ điều khiển lịch chạy để tái hiện |
| Backend Jest | 37 suite / 165 test đạt; 3 suite / 4 test PostgreSQL cũ tự skip, không tính đã chạy |
| Outbox publisher sau bổ sung event delivery | Chạy riêng 15/15 đạt, bao gồm driver.delivery.updated qua gateway đúng phạm vi |
| Python pytest test_execution_validation.py, test_t21_t27.py, test_spatial_layout_search.py | 27 đạt; warnings deprecation thư viện |
| Mobile typecheck/lint/Jest | 6 suite / 50 test đạt; native camera/picker/HTTP mock trong Jest |
| Expo Android export | Đạt; Hermes `mobile/dist/delivery-check`, không phải APK đã chạy |

Integration bao phủ QR không ghi thực tế; quyền/custody/NOT_COLLECTED; fake upload/MIME/kích thước/POD owner; đủ/thiếu/không giao; path chặn/xếp lại; version/plan; replay/mismatch/cạnh tranh handover–complete; rollback audit/outbox/bytes; cleanup/private download; mobile Api/DriverStore thật gửi multipart và reopen.

Hồi quy PostgreSQL thực đã đạt: `test:driver:pickup` 11/11, `test:driver:execution` 13/13, `test:driver` 18/18, `test:driver:client` 1/1 (gồm Socket.IO theo quyền). Seed delivery chạy hai lần thành công; lần sau không tạo lại lịch sử thực thi. Đã tạo nhãn QR A/B. `git diff --check` đạt. Các số liệu có tính test cha theo Node test runner.

**Chưa hoàn tất nghiệm thu thiết bị thực tế:** môi trường không có adb/thiết bị sẵn để kiểm tra đọc QR, chụp/chọn ảnh, progress native, keyboard và layout điện thoại. Jest/export không thay thế phần này. Ngoài phạm vi: offline queue, tracking nền, kết thúc Trip, tự xử lý hàng còn lại. Giới hạn execution cửa sau/hướng cố định/64 kiện và pickup đường thẳng vẫn áp dụng. Người 1/2 cần review phần dùng chung trước tích hợp chung; chưa commit/push/deploy hoặc áp migration lên dữ liệu thật.
