# G3.1 — Đối chứng GPS trên Pixel 7 Android Emulator API 33

Ngày 22/11/2026 · **Build/cài G3.1A PASS. GPS Launcher online FAIL.** Bảng preflight bên dưới lưu trạng thái trước khi có APK tương thích. Kết quả Realme M5.8.3A/B.2 được giữ làm đối chứng. [Báo cáo Realme](driver-m5-final-android-e2e-report.md#m583b2--jobscheduler-instrumentation-và-thí-nghiệm-đối-chứng)

## Kiểm tra môi trường

| Kiểm tra | Kết quả |
| --- | --- |
| ADB và boot | **PASS.** `emulator-5554` ở trạng thái `device`, AVD `Pixel_7`, `sys.boot_completed=1`, Android 13 / API 33. |
| System image | **PASS.** AVD dùng `system-images/android-33/google_apis_playstore/x86_64/` và có Google Play services. Fingerprint `google/sdk_gphone64_x86_64/emu64x:13/TE1A.240213.009/12342917:user/release-keys`. Đây là Google Play image. |
| APK đối chứng | **BLOCKED.** Emulator báo `ro.product.cpu.abilist=x86_64`. ZIP và `aapt dump badging` của cả baseline code 15 và variant code 16 chỉ có `arm64-v8a`. Các APK GPS lân cận đã kiểm tra (M5.8.3 và B.1) cũng chỉ có ARM64. |
| Metadata APK | **PASS trên file.** Hai APK đối chứng có bundle nhúng, package `com.smarttms.mobile.qa4c1`, version name `1.0.0`, min SDK 24, target SDK 36. Manifest khai báo fine/coarse/background location, foreground service, foreground service location, internet và notification. Quyền thực tế trên emulator **NOT RUN** vì package chưa cài. |
| NestJS và đường mạng | **PASS preflight.** PID 18024 là Node chạy entrypoint NestJS, lắng nghe cổng 4000. Từ emulator, `HEAD /` qua `10.0.2.2:4000` trả `HTTP/1.1 404 Not Found`, xác nhận đến được HTTP server. Danh sách ADB reverse rỗng. Auth và GPS ingest qua APK **NOT RUN**. |
| PostgreSQL QA | **PASS preflight.** Docker publish `127.0.0.1:55433`. Truy vấn chỉ đọc trong container xác nhận database `tms_auth_test`, PostgreSQL 16.16. Cả hai socket TCP đang mở của PID Nest nối tới cổng loopback này. Driver/Trip cho lượt emulator và dữ liệu GPS **NOT RUN**. |

Hai hash khớp báo cáo Realme: baseline `baseline-source.apk` code 15 là `7ECA20FF7B5333BFA4A69E9ED33F86194869F5B284D1BA80E564E9234821E744`. Variant `variant.apk` code 16 là `74EFB9FA4279938EC0E297B13ECAC7264BBF6D1D596E2F8C488B3F785D18A64C`. File nằm trong `D:/Tn/SmartTms-M583B2-QA/`.

## Ma trận ca kiểm thử

| Ca | Pixel 7 API 33 | Baseline Realme |
| --- | --- | --- |
| Foreground | **NOT RUN.** Chưa có APK tương thích để xác nhận nguồn phát và ingest. | Ca chuẩn bị để xác minh pipeline. |
| Home → Launcher, online | **NOT RUN.** | **FAIL** với cả expedited và regular. |
| Màn hình khóa | **NOT RUN.** Chưa xác minh nguồn phát khi `interactive=false`, `keyguard=true`. | **FAIL** với cả expedited và regular. |
| Offline → reconnect, vẫn ở Launcher | **NOT RUN.** | **PASS** trong các cửa sổ B.2 đã đo. |

## Chuẩn bị lượt chạy tiếp theo

1. Dựng **APK QA standalone có trace**, từ cùng baseline expedited code 15 và cùng phiên bản dependency B.2, trong thư mục build QA riêng. Chạy Gradle task `:app:assembleRelease` với `-PreactNativeArchitectures=x86_64` trong bản build đó. Kiểm tra thêm mọi giới hạn ABI ở cấu hình QA sinh ra, và kiểm tra trực tiếp `aapt dump badging` cùng các thư viện native trong ZIP trước khi cài. Giữ nguyên behavior scheduler của baseline. [React Native về ABI Gradle](https://reactnative.dev/docs/build-speed)
2. Cấu hình `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000` cho **bản build QA** và xác minh đích trong bundle nhúng sau khi đóng gói. Địa chỉ LAN cũ trong hai APK Realme thuộc lượt đo trước. Kiểm tra cleartext policy của riêng QA APK nếu app không kết nối được. [Android Emulator networking](https://developer.android.com/studio/run/emulator-networking-address)
3. Cài qua ADB cho đúng `emulator-5554`. Đối chiếu version, hash của APK đã cài, package, quyền thực tế, foreground service và bucket. Dùng Driver QA được phân công vào Trip test riêng có baseline GPS trống. Ghi Trip ID và thời điểm bắt đầu trước khi phát điểm. Xác minh HTTP chỉ đi vào Backend QA đã đối chiếu PostgreSQL local.
4. Ghi marker và timestamp phát ở mỗi ca. Lấy foreground làm đối chứng dương, sau đó chạy Launcher, khóa và offline/reconnect. Trước và trong khi khóa, ghi `interactive=false` và `keyguard=true`, đồng thời đối chiếu marker do bộ phát Android ghi cùng mốc native nhận vị trí. Nếu không chứng minh được nguồn phát trong cửa sổ khóa thì ca đó **BLOCKED**, dữ liệu chưa đủ để đánh giá scheduler. Lặp cửa sổ khoảng 82 giây cho Launcher và khóa để so với Realme B.2, rồi ghi cutoff trước thời điểm mở lại app.
5. Đối chiếu theo marker, `measuredAt`, session/sequence và batch ID hoặc job ID. Theo dõi native nhận → `schedule()` → `onStartJob()` → JS TaskManager → SQLite enqueue → HTTP → `GpsEvent.receivedAt`. Ca reconnect cần marker thực sự đo khi offline và tới PostgreSQL sau khi mạng phục hồi, trước cutoff khi app vẫn ở nền. Marker chỉ lên sau khi mở app là **FAIL** nếu nguồn phát và cửa sổ đo đã được xác minh. Tránh tính chênh lệch thời lượng giữa hai nguồn đồng hồ nếu chưa đối chiếu offset.

Lượt preflight chỉ thay đổi báo cáo. AVD, fixture và các thay đổi G1/M2.3 được giữ nguyên.

## G3.1A — Build và cài APK standalone x86_64

Ngày 22/11/2026. Các mục trên ghi lại preflight G3.1 trước khi có APK tương thích.

| Hạng mục | Bằng chứng |
| --- | --- |
| Nguồn baseline | Log Gradle của M5.8.3B.2 chỉ tới snapshot QA ngoài Git `D:/q4`. Bundle còn lại ở đó khớp SHA-256 bundle nhúng của Realme code 15. Snapshot không có metadata Git, nên chưa xác minh được commit chính xác của lượt build đó. Commit HEAD `2f42fc49f93dcbc6d8dcbb68a5523b79f45d638f` chỉ mô tả repository tại lúc preflight G3.1A. |
| Cô lập build | Chép snapshot vào `D:/g31x`, giữ lockfile và instrumentation JS/native. Trong bản sao, phục hồi `TaskManagerUtils.baseline.java` từ evidence Realme và đặt versionCode 17 cho QA. Dùng `:app:assembleRelease -PreactNativeArchitectures=x86_64 --offline` với NDK `27.1.12297006` như build Realme. Gradle **PASS**, 7 phút 46 giây ở lượt thành công. |
| Native Scheduler | **PASS.** `classes.dex` trùng từng byte với Realme code 15, SHA-256 `54004890D67BDC96BF50061EFA6ADC758598A3986D4D9CA2049F8DCEDDF10EB9`. DEX có tham số hằng `true` cho `setExpedited`. Trace runtime ghi `schedule result=1 expedited=true`. |
| ABI | **PASS.** Chỉ `x86_64`, 27 file ELF x86-64. Đủ tên thư viện như baseline, gồm Hermes VM, React Native, Expo SQLite và Mapbox. |
| APK và bundle | **PASS.** SHA-256 APK `242BBCF933F6DDCF58AF599D41A698D1FFA23F2E38049103D1D21677D3476907`. Bundle Hermes nhúng 3.003.976 byte, SHA-256 `2C4F47BA5B009B18A6AA2EF6C2F20343B2A78E2265E14CCB9F99524774300D4C`. Bundle chứa `http://10.0.2.2:4000` và marker trace JS. Baseline nhúng địa chỉ LAN cũ và có cấu hình token bản đồ công khai, còn bản emulator để trống token bản đồ. Bundle và các file ELF khác hash. |
| Cài và chạy | **PASS.** `emulator-5554` cài package `com.smarttms.mobile.qa4c1` version `1.0.0` code 17. Chữ ký hợp lệ, base APK kéo từ emulator khớp hash file build. Android báo grant fine/coarse/background location, manifest có `LocationTaskService` với type location và `TaskJobService`. App mở màn đăng nhập, tài khoản PRIMARY đăng nhập được và Start Trip thành công trên Backend QA. |
| Fixture | `QA-G31-EMU-MAIN`, ID `f53f3275-22e4-4327-84c1-63a21fe39c11` trên `127.0.0.1:55433/tms_auth_test`. Baseline `DISPATCHED` v1, 0 GPS. Sau Start Trip, `IN_PROGRESS` v2. Dùng hai tài khoản QA đã có với vai trò PRIMARY và RELIEF. |

Đối chiếu dùng log `M581QA` của injector, trace native `M583N`, trace `M583GPS` và truy vấn PostgreSQL chỉ đọc theo Trip. Trace `enqueue-finish` ghi sequence sau khi thao tác SQLite hoàn tất. Evidence này ghi nhận enqueue từ ứng dụng, chưa đọc trực tiếp file SQLite của APK release. Các checkpoint dùng cả thời điểm thiết bị và host.


### GPS QA trên emulator

Tất cả thời điểm dưới đây là UTC. Cột Realme dùng **baseline expedited code 15** của M5.8.3B.2.

| Ca | Emulator API 33 | Realme Android 13 |
| --- | --- | --- |
| Foreground | **PASS.** Marker #420 và #422 vào PostgreSQL khi app active, cùng session PRIMARY, sequence 2 và 3. #420 đo `12:46:07.972`, được nhận `12:46:51.967`. Checkpoint đầu chỉ thấy enqueue. App gửi hai marker sau khi đạt điều kiện flush, vẫn ở foreground. | Đối chứng dương, có ingest. |
| Launcher online | **FAIL** trong cửa sổ khoảng 81 giây. Injector phát #440–448. Không có marker của ca trong PostgreSQL tại cutoff ở Launcher. #440, #442, #444, #446 và #448 chỉ tới PostgreSQL lúc `12:48:39.672`, sau resume lúc `12:48:39.292`. | **FAIL**. Batch đối chiếu chờ `onStartJob` tới sau resume. |
| Màn hình khóa | **PASS** theo tiêu chí có điểm của ca vào Backend trước khi đánh thức. Injector phát #460–468 với `interactive=false`, `keyguard=true`. #460, #462 và #464 tới PostgreSQL lúc `12:49:28.365`, trước cutoff khóa `12:50:09.544`. Hai marker #466 và #468 chỉ tới sau mở lại. | **FAIL**. Batch đối chiếu chỉ chạy và upload sau mở lại. |
| Offline → reconnect ở Launcher | **PASS**. Emulator mất default network và probe HTTP thất bại. #480 đo `12:50:32.500` lúc offline, SQLite ghi sequence 17 trong batch offline. Sau khi đường mạng trở lại, HTTP thành công khi app còn background và marker tới PostgreSQL lúc `12:51:23.351`, trước resume. Injector phát cả #481 nhưng marker đó chưa có bằng chứng đi hết pipeline. | **PASS** trong cửa sổ đo. |

**Chuỗi bằng chứng theo batch**

- **Launcher #440** — `measuredAt` `12:47:24.588`. Batch `18dbf357-aaed` schedule expedited `12:47:56.640` và `onStartJob` `12:47:56.642`. Callback JS ở background, SQLite ghi sequence 6–8 lúc `12:47:56.677`. Khi resume, batch thứ hai ghi sequence 9–10 và worker mới gửi cả năm row. PostgreSQL nhận lúc `12:48:39.672`. Khoảng chờ của batch đầu nằm sau enqueue. Trace hiện có phù hợp với điều kiện flush theo số điểm hoặc 45 giây được kiểm tra khi có callback, chưa chứng minh nguyên nhân duy nhất.
- **Khóa #460** — `measuredAt` `12:48:55.378`. Batch `89fb01db-c2fe` schedule `12:49:27.430`, `onStartJob` `12:49:27.434`, sau đó bridge/JS ở background và SQLite sequence 11–13 lúc `12:49:27.462`. HTTP thành công `12:49:28.014`. PostgreSQL nhận `12:49:28.365`.
- **Offline #480** — batch `5b45f68c-8e1d` schedule `12:50:52.209`, `onStartJob` `12:50:52.212`, JS ở background và SQLite sequence 16–18 lúc `12:50:52.247`. NetInfo báo online khi app vẫn ở background lúc `12:51:22.057`. HTTP thành công `12:51:22.542` và PostgreSQL nhận `12:51:23.351`.


### Session isolation ngắn

**PASS trong cửa sổ QA.** PRIMARY đăng xuất và Android báo `startRequested=false`. RELIEF đăng nhập, mở cùng Trip, GPS hiển thị chưa bắt đầu và trace ghi 0 đăng ký thu. Injector xác nhận đã phát #490–492 khi RELIEF đang xem Trip. PostgreSQL trước và sau vẫn có đúng 21 GPS event, tất cả thuộc một session PRIMARY, 0 trùng session/sequence, 0 row RELIEF và 0 marker #490–492.

### Kết luận và bước tiếp theo

- **G3.1A build/cài PASS. G3.1 GPS chưa đạt do Launcher online FAIL.** Kết quả khóa màn hình và reconnect chỉ áp dụng cho các cửa sổ đã đo. Trên emulator, batch Launcher đã qua JobScheduler và SQLite ở nền. Trên Realme, batch đối chiếu chờ trước `onStartJob`. Kết quả hiện có chưa đủ quy nguyên nhân cho OEM hoặc một thiết lập Android cụ thể.
- Bước chẩn đoán đề xuất là lặp ca Launcher với ngưỡng flush được kiểm soát. Đo riêng một lượt dưới 5 row và một lượt đủ 5 row khi app vẫn ở Launcher, ghi thời điểm callback kế tiếp sau mốc 45 giây. Dùng cùng trace trên hai môi trường nếu có thiết bị. Kết quả sẽ xác định khi nào cần tập trung vào hàng đợi upload và khi nào cần tập trung vào JobScheduler.
- APK và log build ở `D:/g31x/android/app/build/outputs/apk/release/app-release.apk` và `D:/g31x/gradle-qa-x86_64-sdk.log`. Evidence nằm trong `D:/g31x/evidence`, gồm `artifact.json`, `windows.ndjson`, trace, các snapshot trạng thái và dữ liệu PostgreSQL theo cutoff. Mobile TypeScript và ESLint **PASS**.
- Đã trả cài đặt khóa màn hình, Wi-Fi, dữ liệu di động, chế độ máy bay và mock location về trạng thái ban đầu. APK QA và fixture được giữ để đối chiếu. Workspace repository chỉ cập nhật báo cáo, cấu hình build riêng nằm ngoài repo.

## G3.2 — Chẩn đoán có kiểm soát điều kiện gửi GPS

Ngày 22/11/2026. APK standalone x86_64 code 17 giữ nguyên. SHA-256 của APK trên emulator vẫn là `242BBCF933F6DDCF58AF599D41A698D1FFA23F2E38049103D1D21677D3476907`. Hai chuyến mới trên PostgreSQL QA local là `QA-G32-A` (`a03dc769-6631-41b0-b683-d2b7ad345a44`) và `QA-G32-B` (`5213f54b-bc15-4ac0-bc25-656762202252`). Cả hai bắt đầu ở DISPATCHED với 0 GpsEvent. Injector QA riêng phát marker theo lịch, giữ mock provider hoạt động giữa các mẫu và ghi timestamp gốc. Hai ca dùng marker khác nhau. Điểm mồi được gửi xong khi app còn foreground để tạo mốc lần thử gửi gần nhất. Các lượt chuẩn bị A thiếu batch trong nền được tách riêng, đọc lại queue qua trace, gửi hết và chỉ tính marker của cửa sổ đo cuối. [Dữ liệu G3.1A](#g31a--build-và-cài-apk-standalone-x86_64)

### Đối chiếu source trước khi đo

- Expo Location yêu cầu khoảng lấy mẫu 15 giây, khoảng cách 20 m và deferred 45 giây. Khi host paused, `LocationTaskConsumer` đợi một vị trí đến để so timestamp mới nhất với vị trí native đã báo gần nhất, rồi mới chuyển batch sang JobScheduler. Mốc này thuộc tầng thu và giao điểm.
- `DriverGpsEngine.collect()` ghi SQLite, đọc số row đang chờ, rồi mới kiểm tra `pending >= 5 || now - lastAttemptAt >= 45_000`. `lastAttemptAt` được cập nhật ngay trước khi worker gửi batch, kể cả khi HTTP sau đó thất bại. Đây là mốc thời gian ở tầng upload. `schedule-flush` gọi trực tiếp `flush()`. Tên trace này không biểu thị một timer.
- Worker còn có các trigger restore khi app active, NetInfo chuyển offline → online, đồng bộ tay và hoàn thành chuyến hợp lệ. Luồng time predicate không có timer hay job độc lập đánh thức worker khi app đang ở Launcher. Timer trong service dùng để đóng tracking khi credential hết hạn. Retry SQLite và backoff HTTP có chức năng riêng. Nhà lập lịch hiện hữu giao callback vị trí sang JS.
- Probe ngoài repo chạy trực tiếp `collect()` từ source QA với storage và clock giả. 4 row ở 10 giây gọi flush 0 lần, 5 row ở 10 giây gọi 1 lần. 1 row ở 44.999 ms gọi 0 lần, ở 45.000 ms gọi 1 lần. Đây là bằng chứng riêng cho điều kiện trong JS. Probe không đi qua Android, SQLite thật hoặc HTTP.


### A — Dưới 5 row

**PASS chẩn đoán.** GPS không tự gửi tại hạn 45 giây. Callback kế tiếp mới kích hoạt upload và cả 4 row tới PostgreSQL trước resume.

Bắt đầu Launcher ở khoảng `14:18:38Z`, sau khi trace xác nhận HTTP đã nhận một điểm mồi riêng và PostgreSQL có sequence 11. Lần gửi mồi bắt đầu `14:18:36.441Z`. Mốc +45 giây là khoảng `14:19:21.441Z`, tính theo trace request trên thiết bị. `lastAttemptAt` được ghi ngay trước HTTP. Timestamp ghi chính xác trong SQLite **NOT VERIFIED** bằng cách đọc file trực tiếp.

| Marker | measuredAt UTC | Native receive đầu tiên UTC | Batch | Sequence | PostgreSQL receivedAt UTC |
| --- | --- | --- | --- | --- | --- |
| #630 | 14:18:39.066 | 14:18:39.080 | `025c529a-e85c` | 12 | 14:20:05.183 |
| #631 | 14:18:56.080 | 14:18:56.099 | `025c529a-e85c` | 13 | 14:20:05.183 |
| #632 | 14:19:13.067 | 14:19:13.077 | `025c529a-e85c` | 14 | 14:20:05.183 |
| #633 | 14:20:04.117 | 14:20:04.130 | `a9844817-eb49` | 15 | 14:20:05.183 |

| Batch | Schedule result | onStartJob | JS callback | SQLite enqueue-finish | Queue và trigger |
| --- | --- | --- | --- | --- | --- |
| `025c529a-e85c` | 14:19:13.091, `1`, expedited | 14:19:13.094 | 14:19:13.095, background | 14:19:13.147, seq 12–14 | 3 row lúc 14:19:13.151. Hai vế đều false. Không có request. |
| `a9844817-eb49` | 14:20:04.161, `1`, expedited | 14:20:04.167 | 14:20:04.168, background | 14:20:04.199, seq 15 | 4 row lúc 14:20:04.201. Count false, time true. `schedule-flush` cùng lúc, worker lúc 14:20:04.203. |

Checkpoint sau hạn ở `14:19:27.107Z` theo đồng hồ emulator vẫn ở Launcher online. PostgreSQL còn đúng 11 row của baseline, chưa có marker của ca. Không có callback JS mới, worker hay HTTP giữa batch đầu và batch #633. HTTP của batch thứ hai bắt đầu `14:20:04.251Z`, trả về lúc `14:20:04.775Z` với 4 row chấp nhận, 0 duplicate. Cutoff trước resume là `14:20:14.532Z` theo đồng hồ emulator, Launcher và default network vẫn hiện diện. Snapshot PostgreSQL có đủ 4 marker. Trace ghi response thành công và số row, mã status HTTP nguyên thủy **NOT VERIFIED**.

### B — Đủ 5 row

**PASS vận chuyển dữ liệu trong cửa sổ đo.** Queue lên đúng 5 row và worker gửi cả 5 trước cutoff. Hai vế count và time cùng đúng ở lần enqueue cuối, nên trigger **chỉ do count trên thiết bị là NOT VERIFIED**. Probe JS ở trên kiểm chứng riêng vế count ở 10 giây.

B dùng Trip và binding khác A. Mốc HTTP cho điểm mồi #641 là `14:21:28.101Z`, được xác nhận thành công trước khi bấm Home. Sau checkpoint sạch, batch đầu ghi đúng 3 row của B. Batch sau ghi đúng 2 row còn lại. Request chỉ chứa sequence 3–7 của B.

| Marker | measuredAt UTC | Native receive đầu tiên UTC | Batch | Sequence | PostgreSQL receivedAt UTC |
| --- | --- | --- | --- | --- | --- |
| #650 | 14:21:30.581 | 14:21:30.591 | `a8ab2618-0d22` | 3 | 14:22:57.716 |
| #651 | 14:21:47.597 | 14:21:47.607 | `a8ab2618-0d22` | 4 | 14:22:57.716 |
| #652 | 14:22:04.597 | 14:22:04.611 | `a8ab2618-0d22` | 5 | 14:22:57.716 |
| #653 | 14:22:21.597 | 14:22:21.612 | `adf02f26-f4b5` | 6 | 14:22:57.716 |
| #654 | 14:22:56.614 | 14:22:56.624 | `adf02f26-f4b5` | 7 | 14:22:57.716 |

| Batch | Schedule result | onStartJob | JS callback | SQLite enqueue-finish | Queue và trigger |
| --- | --- | --- | --- | --- | --- |
| `a8ab2618-0d22` | 14:22:04.620, `1`, expedited | 14:22:04.624 | 14:22:04.624, background | 14:22:04.660, seq 3–5 | 3 row lúc 14:22:04.665. Count và time đều false. |
| `adf02f26-f4b5` | 14:22:56.634, `1`, expedited | 14:22:56.638 | 14:22:56.638, background | 14:22:56.672, seq 6–7 | 5 row lúc 14:22:56.675, khoảng 88,6 giây từ request mồi. `schedule-flush` 14:22:56.676 và worker 14:22:56.697. |

Ở checkpoint `14:22:18.633Z`, sau mốc +45 giây `14:22:13.101Z`, app vẫn ở Launcher online và PostgreSQL chỉ có 2 row mồi. Khi marker thứ năm được enqueue, HTTP bắt đầu `14:22:56.754Z`, khoảng 140 ms sau `measuredAt` của #654 và 82 ms sau enqueue. Response ghi nhận 5 row chấp nhận, 0 duplicate lúc `14:22:57.305Z`. Mã status HTTP nguyên thủy **NOT VERIFIED**. Cutoff `14:23:06.053Z` xác nhận đủ 5 marker trong PostgreSQL và Launcher vẫn có default network. Không resume B.

### Kết luận

- **Tin cậy cao** rằng 45 giây là điều kiện xét tại callback, qua source và ca A. Trace A xác nhận queue nằm chờ qua hạn. B xác nhận khi predicate đúng vẫn có thể gọi worker và gửi trong nền. Hai cửa sổ này không quan sát worker bị hoãn sau khi predicate đã đúng.
- **GO cho kết luận chẩn đoán, NO-GO cho GPS realtime.** G3.2 chứng minh có upload trong nền khi callback đến. Độ trễ của marker vẫn có thể vượt 45 giây, chẳng hạn #630 mất khoảng 86 giây từ đo đến PostgreSQL. Realme còn có điểm chờ độc lập trước `onStartJob`, nên điều chỉnh predicate JS không giải quyết được ca Realme chưa nhận callback.
- Thay đổi nhỏ nhất đề xuất để đánh giá riêng tầng JS là thử một lần flush ngay sau khi callback đã enqueue thành công trong nền và đang online. Giữ một worker đang chạy tại một thời điểm, batching, backoff, binding và idempotency. Đo tác động số request và độ trễ trên cùng fixture trước khi quyết định production. Đề xuất này vẫn lệ thuộc native callback và không đưa ra cam kết thời gian thực.
- Evidence nằm ở `D:/g32qa/evidence`. Checkpoint window và trace cùng bảng PostgreSQL xác nhận queue sạch theo số row đã gửi và không lẫn marker cũ. File SQLite trực tiếp **NOT VERIFIED**. Đã dừng riêng APK QA và injector sau cutoff, trả mock location về mặc định. Fixture G3.1 giữ đúng 21 GPS event. Mobile TypeScript và ESLint **PASS**. Repository chỉ cập nhật báo cáo.
