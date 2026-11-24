# M4.1.0 · Mobile UI/UX Audit & Redesign Blueprint

Ngày 20/11/2026 · Audit từ source trước redesign · **M4.1.1** đã PASS luồng chính và guard e-POD trên Android. **M4.1.2** đã triển khai và nhận phản hồi ổn từ người dùng. Kết quả theo từng ca Android nằm trong checklist. **M4.1.3** đã chuẩn bị kế hoạch triển khai.

M4.0 Driver → Customer E2E đã chốt. M4.1.0 là khảo sát và thiết kế tài liệu. Căn cứ là `AGENTS.md`, `mobile/AGENTS.md`, `KE_HOACH_TMS.md` §10–12, route thực tế trong `mobile/src/app`, các screen, panel, hook và [checklist E2E đã chạy](../04-testing/driver-customer-e2e-qa.md). Các nhận định bố cục dựa trên cây render và điều kiện hiển thị; cần đo thao tác và kích thước trên Android khi triển khai. Rule tham chiếu BR03, BR13, BR15–17, BR20, BR22 và ca T08, T11–12, T16, T19–20.

## 1. UI Audit Matrix

Đường dẫn component tính từ `mobile/src/features/`. **S** là số cụm nội dung, không tính header và banner lỗi. **A** là số điều khiển chạm, gồm Back, CTA và lựa chọn, không tính ô nhập, gesture, cuộn hoặc kéo làm mới. Nút biến thiên được ghi riêng theo điều kiện; các nhánh loại trừ nhau không cộng thành một tổng đồng thời. Hộp thoại Android dùng để xác nhận được nêu riêng.

### Driver

| Route và component | Chức năng, S/A | Giữ lại và phần có thể tách | Scroll và trạng thái | Rủi ro khi đổi |
|---|---|---|---|---|
| `/` và `/trips` · `driver-trips/screens/DriverTripListScreen.tsx` | Danh sách chuyến phân công, lọc trạng thái, kéo refresh, tải thêm. **S2** bộ lọc + danh sách. **A6 + N**: 5 chip, đăng xuất, 1/chuyến. Hộp thoại pending khi logout có 2 lựa chọn. | Giữ `FlatList`, phân trang, bộ lọc và thẻ chuyến. Chuyển logout sang Hồ sơ, giữ cảnh báo queue. | Tiêu đề dài cạnh nút logout, chip cuộn ngang. Có spinner đầu/cuối, empty, banner; lỗi và empty có thể hiện cùng lúc. Empty chưa phân biệt bộ lọc rỗng với chưa có phân công. | Mất cảnh báo pending, tải trùng khi đổi filter, Back về một bản danh sách thứ hai. |
| `/trips/[id]` · `driver-trips/screens/DriverTripDetailScreen.tsx` | Thực thi chuyến và tất cả nghiệp vụ phụ. **S8**: thông tin chuyến, GPS, queue, phân công, sự cố, điều hướng ngoài, mở bản đồ, danh sách stop; Start/Complete là hành động cấp chuyến. **A2** nền: Back + Bản đồ. Thêm tối đa 1 điều hướng ngoài, tối đa 1 Start/Complete, mỗi điểm có hành động theo điều kiện và các panel ở dưới. Khi lỗi tải đầu: Back + Thử lại. | Giữ thẻ tóm tắt, CTA cấp chuyến, chỉ báo GPS/sync, điểm khả dụng. Tách form từng stop, POD, Incident, queue chi tiết; mở Map hiện hành. | Một ScrollView chứa toàn bộ stop, task, thông tin liên hệ, tọa độ, thời điểm kế hoạch/thực tế và POD. Spinner tải đầu, retry, lỗi làm mới có snapshot, notice/xung đột. Có lệnh offline và trạng thái local, nhưng màn hình tải detail qua API khi focus. | Mount/unmount làm mất form, key retry hoặc trạng thái POD; cho phép thao tác qua snapshot cũ, khóa nhầm scroll, chạy GPS lifecycle hai lần. |
| `/trips/[id]/map` · `driver-navigation/screens/DriverTripMapScreen.tsx` + `components/DriverTripMap.tsx` | Mapbox, marker, vị trí xe và điều hướng ngoài. **S3–4**: chuyến, vùng map, chú giải, thẻ điều hướng nếu có target. **A1–3**: Back, định tâm khi có GPS, Điều hướng khi có target; lỗi tải Trip có Thử lại. | Giữ nguyên route/instance, vùng map tách khỏi scroll, camera tự căn một lần, nhóm marker trùng tọa độ, Google Maps. Đưa chú giải vào vùng phụ có thể mở. | Hai vùng tách riêng; footer vẫn có thể dài. Có tải Trip/SDK, guard native/token, lỗi style/tile, tọa độ thiếu, GPS thiếu/cũ và lịch sử read-only. Offline có thể thiếu tile; chưa có offline map pack. | Pinch bị ScrollView giành gesture, mất fallback điều hướng, tự recenter mỗi điểm GPS, mất route param hoặc không gọi tải khi focus. |

### Panel Driver đang gắn trong Trip Detail

Các hàng này giải thích phần biến thiên của **A** ở Trip Detail, không phải route đang tồn tại.

| Component | S/A và chức năng | Giữ / tách · scroll và trạng thái · rủi ro |
|---|---|---|
| `driver-trips/components/execution/DriverStopExecutionPanel.tsx` | Kho **S1/A1** hoàn thành. Pickup/delivery **S3–4**: số lượng, lý do, ghi chú/người nhận, kết quả giao nếu có. **A9 + 2B**: 8 lý do, 1 xác nhận và 2 lựa chọn cho mỗi task có kế hoạch đúng 1; task lớn hơn dùng ô nhập. ARRIVE là 1 CTA riêng ở screen cha trước nhánh này. | Giữ validator, giá trị thực tế, suy ra outcome, lý do và người nhận. Tách Stop Execution để tránh cuộn qua mọi stop. Lỗi field, loading submit, local pending và conflict phải còn. Rủi ro form mapping theo task ID hoặc mất draft khi focus/Back. |
| `driver-trips/components/pod/DriverPodPanel.tsx` | **S2–4**: yêu cầu/tệp, ảnh & review, chữ ký, preview khi mở. Ở nhánh editable chưa chọn ảnh có 3 CTA ảnh/chữ ký/làm mới; review thay 1 nút ảnh bằng 3; ký thêm 2; retry thêm 1; mỗi tệp có Xem lại và có thể Thay ảnh tùy quyền; modal có Đóng. Read-only có nhánh riêng. | Tách vào e-POD của stop để giảm ảnh, canvas, hàng tệp và nút lặp. Giữ local preview, upload/retry/thay thế, link xem có hạn, chữ ký tùy policy và trạng thái upload/rỗng/lỗi. Rủi ro chính: Overview mất thông tin readiness hoặc coi ảnh local là đã upload. |
| `driver-tracking/components/DriverTrackingPanel.tsx` | **S1/A0–3** theo mode: bắt đầu tracking **hoặc** 2 hành động quyền vị trí, thêm sync GPS khi phù hợp. | Giữ số GPS chờ gửi, mốc sync và cảnh báo quyền; hiển thị tóm tắt trên Overview, chi tiết mở khi cần. GPS queue và execution queue phải có nhãn riêng. |
| `driver-offline/components/OfflineDriverQueuePanel.tsx` | **S0–1/A0–2**: không hiển thị nếu không có hàng đợi phù hợp; đồng bộ, tải lại khi lỗi/xung đột. | Giữ pending/syncing/conflict/failed/blocked và phục hồi. Tách khi cần, giữ summary luôn thấy nếu có vấn đề. Tải lại không được xóa pending hay đổi wire version đã gửi. |
| `driver-incidents/components/DriverIncidentPanel.tsx`, `DriverIncidentForm.tsx` | Panel **S1/A0–4 + N**: Báo, Làm mới, Xem thêm, Thử tải lại tùy nhánh, mỗi card 1 toggle. Modal thêm 2 CTA gửi/đóng, các lựa chọn và checkbox Order liên quan theo dữ liệu. | Đưa sang route Incident, tái sử dụng list/card/modal và hook. Có spinner, empty, retry, phân trang, lỗi gửi chưa rõ kết quả. Giữ quyền PRIMARY/ASSIGNED ở trạng thái cho phép, scope Order và key retry. |

### Customer và màn hình chung

| Route và component | Chức năng, S/A | Giữ lại và phần có thể tách | Scroll và trạng thái | Rủi ro khi đổi |
|---|---|---|---|---|
| `/` Customer · `auth/screens/CustomerHomeScreen.tsx` | Hồ sơ và lối vào đơn. **S3/A4**: lời chào, thẻ tài khoản, nhóm thao tác Đơn/Tạo đơn/Làm mới/Đăng xuất. | Dùng lại thẻ hồ sơ trong Profile riêng. Đưa danh sách đơn thành landing. | Vào đơn phải qua hồ sơ, 4 nút xếp dọc. Làm mới profile có loading/lỗi và giữ snapshot; trường thiếu có fallback. | Vòng lặp redirect sau đăng nhập/đăng xuất, mất profile khi refresh lỗi. |
| `/orders` · `orders/screens/CustomerOrderListScreen.tsx` | Lọc, mở chi tiết, tạo đơn; refresh/phân trang. **S2/A9 + N**: Back, Tạo đơn, 7 chip, mỗi đơn 1; empty có thể thêm 1 CTA. | Giữ FlatList, filter và card một vùng chạm. Tách CTA tạo khỏi empty khi đã có CTA cố định. | Nhiều chip theo chiều ngang; spinner/error/empty tương tự Driver, thông báo tạo đơn không phù hợp với mọi filter lỗi/rỗng. | Đổi filter lẫn cache/response, thay backend sort, mất scroll hoặc pagination. |
| `/orders/[id]` · `orders/screens/CustomerOrderDetailScreen.tsx` + `components/CustomerOrderTrackingPanel.tsx` | Chi tiết đơn, tracking từng Trip, hành trình và kiện. **S4–5/A1–2**: hero, tracking, hành trình, hàng hóa, ghi chú tùy dữ liệu; Back + Thử lại khi detail/tracking lỗi theo nhánh. | Giữ phân biệt trạng thái Order/Trip, cảnh báo GPS, ETA theo kế hoạch, tất cả Trip. Có thể gấp chi tiết kiện, tọa độ và liên hệ sau tiêu đề. | Một scroll dài với metrics, nhiều Trip, stops và items. Tracking tải/poll riêng, giữ snapshot khi lỗi; có chưa điều phối/chưa GPS/stale/vị trí cuối. Badge đơn từ detail, tracking từ snapshot khác. | Trộn hai nguồn trạng thái, nhân timer hoặc bỏ sót Trip khi Order chia chuyến, hiển thị snapshot của ID trước. |
| `/orders/create` · `orders/screens/CustomerCreateOrderScreen.tsx` | Chọn chi nhánh, địa chỉ lấy/giao, kiện, ghi chú. **S5/A3 + B + 3I + R**: Back, Thêm, Gửi; B chi nhánh; 3 lựa chọn loại/kiện; R nút xóa, chỉ khi >1 kiện; lỗi chi nhánh có 1 retry, thành công có 1 CTA trong alert. | Giữ form/DTO/validator và giới hạn hiện tại. Tách từng bước trong cùng route, gom từng kiện và màn rà soát. | Hai khối địa chỉ, tối đa 20 loại kiện, bàn phím và nút cuối scroll. Có loading/empty/error chi nhánh, lỗi field và cảnh báo gửi chưa rõ. Không có offline creation queue. | Mất draft khi đổi bước, bỏ trường bắt buộc, đổi idempotency key khi retry cùng payload. |
| `/login` · `auth/screens/LoginScreen.tsx` | **S1/A2**: form 2 trường, Đăng nhập và link Đăng ký. | Giữ session, lỗi xác thực, chống submit lặp. Đồng bộ visual shell ở phase cuối. | Form ngắn; loading nút, lỗi inline/banner; cần đảm bảo bàn phím và lỗi mạng. | Sai redirect theo role, bỏ xử lý session lỗi. |
| `/register` · `auth/screens/RegisterScreen.tsx` | **S1/A2**: 6 trường (username, họ tên, điện thoại, email tùy chọn, mật khẩu, xác nhận), submit/link; thành công có CTA trong alert. | Giữ validator và API, không cần wizard cho đăng ký. | Form cuộn với keyboard; loading submit, lỗi field/server. Offline giữ dữ liệu đang nhập, không tự gửi. | Mất field, lỗi username/password hoặc điều hướng sau đăng ký bị hồi quy. |
| `/session-error`, `/unsupported-role` · `auth/screens/SessionErrorScreen.tsx`, `UnsupportedRoleScreen.tsx` | Mỗi màn **S1**. Session error **A2** kiểm tra lại/đăng xuất, role không hỗ trợ **A1** đăng xuất. | Giữ fallback độc lập route và thông báo có thể hành động; dùng chung state layout. | Nội dung ngắn; pending retry hoặc lỗi sign-out tùy màn. Root có `FullScreenLoader` riêng khi khôi phục phiên. | Mất đường thoát, redirect loop hoặc mở nhầm role. |

`DriverPlaceholderScreen.tsx` còn trong source, nhưng entry Driver thực tế tái xuất `DriverTripListScreen`. Placeholder không tính là màn hình hoạt động. Incident, e-POD và queue hiện là panel/modal, Driver Profile chưa có route.

## 2. Navigation Architecture · đề xuất

App dùng **Expo Router** theo file, với `Stack`, `Stack.Protected`, `useFocusEffect` và `router.push/replace` từ `expo-router`. Đọc `src/app/_layout.tsx` và ba group layout xác nhận mỗi role đang là stack, header tùy chỉnh. Giữ cấu trúc này. `AuthProvider`, tác vụ GPS và hai lifecycle giữ ở root, không chuyển vào tab hay screen con.

| Role | Điểm vào và tuyến đề xuất |
|---|---|
| Driver | Landing **Chuyến** tại `/trips`; group index làm alias như hiện tại hoặc redirect có test để chỉ còn một bản stack. `/trips/[id]` là **Tổng quan**. Con: `/trips/[id]/stops/[stopId]`, `.../stops/[stopId]/pod`, `.../map` hiện có, `.../incidents`, `.../sync` khi cần. **Tài khoản** từ header, route cụ thể ví dụ `/driver/profile`. |
| Customer | Landing **Đơn vận chuyển** tại `/orders`; `/orders/[id]` giữ Tracking ở cùng screen; `/orders/create` là wizard điều khiển trong một route. **Tài khoản** từ header, ví dụ `/customer/profile`. Group index đổi landing sau khi kiểm tra redirect. |
| Chung | Giữ login/register/session-error/unsupported-role và bảo vệ route. Screen con đọc ID từ params, tải đúng context hoặc fallback an toàn; Back về cha, giữ filter/scroll khi hợp lệ. Hệ thống không xem role/ownership chỉ từ route. |

**Đề xuất chưa dùng Bottom Tabs.** Mỗi role có một điểm vào chính và tài khoản là hành động ít dùng; chuyến, đơn, bản đồ và forms là điểm đến có ngữ cảnh. Một lựa chọn header sang Profile đủ cho MVP và giữ không gian dọc. Cần duyệt hành vi Back rời form chưa lưu và UI landing Customer trước khi đổi route.

## 3. Driver Trip Detail · blueprint ưu tiên

| Khối đích | Vai trò và giới hạn |
|---|---|
| **Trip Overview** | Mã, xe, trạng thái, tiến độ đã xác nhận `x/y` (phân biệt bỏ qua), stop khả dụng và CTA theo trạng thái. Nếu có thao tác local, hiển thị riêng số đang chờ. Rút gọn GPS + queue thành hai hàng có nhãn/phục hồi. Bản đồ, Sự cố, danh sách điểm, thời gian/phân công chi tiết là lối tắt hoặc phần mở rộng. |
| **Stop Execution** | Một stop theo `stopId`; title, thứ tự/loại, địa chỉ/liên hệ, dự kiến/thực tế, task và số lượng. Pending dùng ARRIVE theo guard hiện tại. Arrived hợp lệ dùng form xác nhận thực tế, giữ validator, outcome, lý do và người nhận. Stop lịch sử chỉ đọc; stop có conflict/failed dẫn đến queue. Link e-POD khi đã có attempt; không dựng attempt từ completion local chờ đồng bộ. |
| **Trip Map** | Tái sử dụng `DriverTripMapScreen`, `DriverTripMap`, selector và panel điều hướng. Không mount Mapbox trong Overview/Stop. Giữ marker trùng tọa độ, camera và gestures độc lập. |
| **Incident / e-POD** | Dùng lại panel và hook; chuyển khối nội dung vào route có đúng Trip/Stop. Giữ read-only theo quyền/trạng thái, online-only theo policy đã có, retry cùng key, ảnh xem trước và khóa thao tác khi upload/ký. |
| **Offline Queue** | Overview có số chờ, lỗi và nút xem chi tiết. Route sync có trạng thái từng lệnh ở mức UI phù hợp, cơ chế đồng bộ/tải lại hiện có, và lý do block. Không bổ sung xóa, reorder, ép replay hay xử lý nghiệp vụ mới. |

**CTA theo trạng thái.** DISPATCHED có Start nếu đủ điều kiện hiện hành; IN_PROGRESS ưu tiên **Mở điểm hiện tại** hoặc **Xử lý đồng bộ** tùy blocking state; khi các điểm xong nhưng POD thiếu, dẫn đúng attempt cần xử lý. Chỉ hiện **Hoàn thành chuyến** khi stop đã được server xác nhận terminal, queue sạch, POD readiness cho mọi delivery theo guard hiện tại và online. Hoàn thành/hủy chỉ đọc. Chuyển route không phải là thành công của lệnh; refresh Trip sau mutation và khi Overview focus, giữ chống double-tap và khóa hiện hành.

**Phụ thuộc cần giải quyết trước khi tách POD.** Hiện `DriverTripDetailScreen` tạo map readiness theo tripId/attemptId từ callback của các `DriverPodPanel` được mount. Khi panel rời Overview, cần nguồn read model dùng **API/hook POD hiện có**, độc lập với việc panel có mount hay không. Đề xuất trích phần đọc theo tripId/attemptId và làm mới khi Overview focus, khi attempt thay đổi và sau upload/replace. Bảo vệ request đến muộn và fail-closed khi loading/lỗi/unknown. Cache nhỏ chỉ hỗ trợ hiển thị trong cùng scope; kết quả upload local không tự bật Complete Trip. Nếu chưa chứng minh giá trị guard giống baseline ở mọi trạng thái, giữ readiness tại layout/chỗ mount tương thích trong bước chuyển tiếp.

## 4. Customer · blueprint

- **Danh sách.** Ưu tiên mã đơn, badge trạng thái, thời điểm, số kiện và khối lượng; toàn bộ thẻ là CTA xem chi tiết. Giữ mọi chọn trạng thái, phân trang, refresh và thứ tự API. Phân biệt empty thật, bộ lọc không kết quả, lỗi tải và offline có snapshot. Không đòi thêm field địa chỉ vào response list.
- **Detail/Tracking.** Thứ tự ưu tiên là Order status → từng Trip, GPS/thời điểm và ETA kế hoạch → hành trình → kiện/ghi chú. Một đơn có nhiều Trip hiển thị riêng từng card. Dữ liệu tĩnh vẫn xem được nếu poll lỗi, có mốc cập nhật và thử lại. Tiếp tục polling 30 giây khi focus + foreground, single-flight/generation, dùng stale theo `measuredAt`. Nếu badge Order và tracking khác nhịp, dùng refresh detail theo cơ chế đã có hoặc đề xuất refetch có guard ở phase triển khai, không tự suy ra Order từ Trip.
- **Create.** Đề xuất 3 bước: (1) Chi nhánh + lấy/giao, (2) Hàng hóa, (3) Rà soát + ghi chú. Bước 1 giữ địa chỉ, tọa độ và tên/số điện thoại liên hệ cho cả hai điểm. Bước 2 giữ tên kiện, loại, số lượng, khối lượng mỗi kiện và đủ ba chiều. Bước 3 giữ ghi chú tùy chọn và nhắc yêu cầu chờ duyệt. Dùng cùng form state, validator/DTO, giới hạn số kiện và key chống trùng. Bước sai được focus lại đúng trường; retry dùng đúng key/payload, sửa payload tạo key mới như hiện tại. Lưu draft trong bộ nhớ cùng route; lưu offline qua đóng app là quyết định riêng.

## 5. Design system · đề xuất

| Thành phần | Quy ước Android |
|---|---|
| Color | Dùng `theme.ts` hiện có: background `#F4F7FB`, surface `#FFFFFF`, primary `#1456D9`, text `#172033`, muted `#667085`, border `#D6DDE8`; dùng danger/success hiện tại. Thêm token warning đề xuất text `#854A0E`/surface `#FFF4D6`, và info dùng primary/surface nhẹ. Kiểm tra độ tương phản thực tế; trạng thái luôn có chữ. |
| Typography | Dùng font hệ thống và scaling: title 24/30, section 18/24, body 16/22, metadata 14/20, badge/caption 12/16; mức chữ đậm 600–800. Mã dài có thể xuống dòng, số lượng/đơn vị đi cùng nhau. |
| Spacing/radius | Giữ 6/10/16/24/32 dp đang có. Padding screen 16, card 16, gap 10–16. Bo 12 cho input/nút, 16–18 cho card, pill cho badge. Vùng chạm tối thiểu đề xuất 48 dp. |
| Cards/badges | Card chia theo nhiệm vụ, một hàng chính có mã + status, metadata rút gọn. Badge có chữ cho Order/Trip/Stop và đồng bộ. Dùng màu khác nhau cho chờ, đang làm, thành công, lỗi, read-only. |
| Buttons/icons | Mỗi ngữ cảnh có một primary rõ ràng. Secondary outline cho lối tắt; action phá hủy có màu và xác nhận phù hợp. Tái sử dụng Back và ký hiệu hiện có. Thêm bộ icon thống nhất chỉ nếu dependency được xác minh có sẵn ở phase code; dùng chữ và accessibility label cho hành động. |
| Loading/empty/error/offline | Skeleton tĩnh bằng View cho first load list/detail, spinner nhỏ cho refresh/submit. Empty có nguyên nhân và hành động phù hợp; error full-state khi chưa có dữ liệu, banner khi còn snapshot; offline badge có nhãn riêng, không giả đã sync. Ưu tiên lỗi blocking gần CTA, tránh nhiều banner giống nhau. |
| Bottom action bar | Safe area, 1 primary + tối đa 1 secondary theo ngữ cảnh; có khoảng chừa footer/keyboard. Dùng cho Stop Execution, Trip Overview và wizard. Khi loading/blocked vẫn hiện lý do; chữ lớn hoặc keyboard không che điều khiển. |

## 6. Wireframe text

Ký hiệu **[ ]** là CTA và **▸** là nội dung mở rộng. Các đường kẻ cho biết phần ưu tiên hoặc thanh thao tác.

### Driver · Chuyến được phân công

```text
Chuyến                 [Tài khoản]
[Tất cả] [Đã điều phối] [Đang thực hiện] …
Mã chuyến                  Đang thực hiện
Xe • lịch                    4 điểm dừng
[Chạm thẻ để mở Tổng quan]
```

Ngay: trạng thái và lịch. Phụ: metadata chi tiết ở Overview; Profile chứa logout. First load dùng skeleton, lỗi/empty theo filter có retry, offline hiển thị snapshot nếu đang có.

### Driver · Tổng quan

```text
[‹] Tổng quan
Mã chuyến • Xe             Đang thực hiện
2/4 điểm đã xác nhận       1 thao tác chờ
Điểm hiện tại · 3. Giao hàng · Địa chỉ
GPS: Đang theo dõi          Đồng bộ: Chờ 1
[Bản đồ] [Sự cố] [Đồng bộ]   ▸ Lịch / Phân công / Điểm dừng
──────────────────────────────────────────
[Mở điểm hiện tại]
```

Ngay: progress, stop và trạng thái. Primary đổi đúng guard thành Start, mở stop, xử lý lỗi, bổ sung POD hoặc Complete Trip. Secondary đi route con. Loading/lỗi toàn trang khi chưa có snapshot; offline còn snapshot ghi rõ số pending và giới hạn hành động.

### Driver · Thực hiện điểm

```text
[‹] Điểm 3 / 4                   Đã đến
Giao hàng · Địa chỉ · Người liên hệ
Kiện A          Kế hoạch 1       [1] [0]
Kết quả giao • Người nhận
▸ Lý do / Ghi chú  |  ▸ Kích thước / Mốc thời gian
[Bằng chứng giao hàng] khi có DeliveryAttempt
──────────────────────────────────────────
[Xác nhận giao hàng]
```

Ngay: thông tin thực hiện. Primary trước khi đến là ARRIVE; sau ARRIVE là COMPLETE. Bắt buộc mở lý do/ghi chú khi validator yêu cầu. Secondary quay Tổng quan hoặc mở e-POD đúng attempt. Khi offline ghi local pending gần CTA; version conflict dẫn sang Đồng bộ; fetch lỗi cho retry và giữ dữ liệu nhập phù hợp.

### Driver · Bản đồ

```text
[‹] Bản đồ chuyến                 Mã chuyến
┌─────────────────────────────────────┐
│ Mapbox hiện có      KĐ1 L2 KK4       │
│ G3      XE               [Vị trí tôi]│
└─────────────────────────────────────┘
Điểm hiện tại • trạng thái GPS/đồng bộ
[Điều hướng Google Maps]     ▸ Chú giải
```

Ngay: map, marker và stop; phụ: legend trong vùng cuộn tách biệt. Recenter là hành động trên map; điều hướng ngoài là CTA của ngữ cảnh nếu target hợp lệ. Khi tile lỗi giữ marker ở mức SDK hỗ trợ, có thông báo và fallback; thiếu GPS/permission vẫn xem stop, lỗi native/token không làm hỏng Overview.

### Customer · Đơn vận chuyển

```text
Đơn vận chuyển                [Tài khoản]
[Tất cả] [Chờ duyệt] [Đang vận chuyển] …
Mã đơn                     Đang vận chuyển
Ngày tạo • 2 kiện • 20 kg
[Chạm thẻ xem chi tiết]             [Tạo đơn]
```

Ngay: mã và trạng thái. Secondary là filter/Profile; CTA bền vững là Tạo đơn. First load skeleton; empty lọc có xóa filter, chưa có đơn gợi ý tạo, lỗi/offline có retry và snapshot nếu có.

### Customer · Chi tiết / Theo dõi

```text
[‹] Chi tiết đơn
Mã đơn                      Trạng thái đơn
Theo dõi vận chuyển
Chuyến A • Đang vận chuyển · Dự kiến theo kế hoạch
Vị trí mới/cũ · mốc cập nhật
Chuyến B • Đã hoàn thành · vị trí cuối chuyến
▸ Hành trình   ▸ Kiện hàng (2)   ▸ Ghi chú
```

Ngay: trạng thái, từng Trip và freshness. Hành trình mở ra địa chỉ và liên hệ; kiện mở metrics chi tiết. Đây là màn chỉ đọc, không tạo CTA nghiệp vụ. Khi lỗi có **Thử lại** tại đúng vùng detail/tracking; chưa điều phối, chưa có GPS và GPS stale hiển thị riêng. Back về danh sách.

### Customer · Tạo yêu cầu

```text
[‹] Tạo đơn                      Bước 1/3
Chi nhánh → Điểm lấy và điểm giao
Bước 2: Kiện 1 ▸  [Thêm loại kiện]
Bước 3: Rà soát · Ghi chú · Chờ duyệt
──────────────────────────────────────────
[Quay lại]                  [Tiếp tục / Gửi]
```

Ngay: trường bắt buộc của bước, thứ tự và lỗi field. Phụ: mở từng kiện và chỉnh từ bước review. Loading/empty chi nhánh giữ form; offline giữ nhập tại chỗ, nhắc cần mạng để gửi. Kết quả gửi chưa rõ giữ đúng payload/key khi bấm gửi lại. Thành công về detail của đúng đơn; Back trong wizard lùi một bước.

## 7. Component reuse / refactor plan

| Tái sử dụng | Phần ghép hoặc trích xuất khi được duyệt |
|---|---|
| `PrimaryButton`, `ScreenMessage`, `FullScreenLoader`, theme, header Driver/Order và form fields | Thống nhất biến thể, token và spacing. Trích `BottomActionBar`/state layout khi có hai nơi dùng thật. Giữ keyboard/safe-area. |
| `DriverTripCard`, `OrderCard`, status badge và label hiện tại | Chỉnh hierarchy trong card, không sửa enum/sort/pagination. Giữ label nghiệp vụ, gom mất mạng/lỗi đúng ngữ cảnh. |
| `useDriverTripDetail`, `useDriverTripExecution`, `useOfflineDriverQueue`, overlay selectors | Route con dùng đúng trip/stop và cùng nguồn logic. Xác định nơi giữ snapshot/readiness và form state trước khi đổi route. Không nhân lifecycle; không thêm lệnh queue mới. |
| `DriverStopExecutionPanel`, `DriverPodPanel`, Incident hooks, TrackingPanel, QueuePanel, Mapbox và navigation service | Đổi vị trí render/shell trước, giữ handler và validator. Thay chỉ bố cục theo phase để dễ đối chiếu. |
| `useCustomerOrders`, `useCustomerOrderTracking`, `useCustomerBranches`, `useCreateCustomerOrder`, `PackageItemEditor` | Một tracking hook cho một màn đang focus; wizard giữ form và submit lifecycle tại route. Profile dùng lại auth/refresh, Driver có logout guard đã dùng tại Trip List. |

## 8. Regression risk matrix

| Rủi ro | Bảo vệ và bằng chứng cần có |
|---|---|
| **Cao · offline/version** | Giữ queue theo owner, FIFO, wire version, key, replay, fail-closed và local/server label. Test route đổi, kill/relaunch, reconnect, outdated version, 401, logout/switch owner; một event/command sau retry. |
| **Cao · mandatory e-POD** | Kiểm tra readiness theo attempt sau khi tách panel, ảnh local/upload lỗi/ảnh thay chưa xác nhận không bật Complete. Test toàn bộ delivery, chế độ read-only và trước/sau PHOTO trên thiết bị. |
| **Cao · GPS lifecycle** | Root lifecycle một lần; chỉ đọc snapshot ở UI, mẫu cũ không đè mẫu mới; giữ restore, permission, background, reconnect, stop/logout. Đếm GPS Trip và xác nhận không thêm watcher. |
| **Cao · Customer ownership / polling** | Role guard và API giữ nguyên; stop poll khi Out of focus/background, cùng Order không tạo timer thứ hai. Test mở A→B, 401/404, nhiều Trip, dữ liệu cuối của đúng Trip, giữ snapshot và stale 2 phút. |
| **Cao · execution state** | Primary/actionable, invalid role/stop, partial/failed, đầu/cuối độc lập, Order terminal theo packages. Không suy ra đơn hoàn thành từ Trip. |
| **Cao · create / incident idempotency** | Retry giữ yêu cầu chưa rõ kết quả; keyboard/back giữ nháp theo phạm vi; dữ liệu cần vẫn nằm trong payload. Đối chiếu không phát sinh Order/Incident trùng khi retry. |
| **Vừa · Mapbox / cử chỉ** | Một Mapbox route; test native thiếu/token/tiles, GPS thiếu, marker trùng, không recenter theo mẫu. Pinch độc lập cuộn, quay lại từ Google Maps và Back đúng cha. |
| **Vừa · navigation / session / UI** | Protected group vẫn đúng, deep link sai ID báo lỗi hữu ích, Back từ wizard/panel không loop, kích thước nhỏ/chữ lớn/keyboard/TalkBack. |

## 9. Milestone plan · chỉ triển khai sau duyệt

| Mốc đề xuất | Nội dung và gate nghiệm thu |
|---|---|
| **M4.1.1 · Driver Overview & Stop** | Chốt dữ liệu state/CTA, tách một Stop Execution, giữ đường dẫn detail. GPS/queue summary và Account entry dùng hiện trạng. Gate: Start → ARRIVE → COMPLETE, partial/failed, depot, version conflict và nhập form/Back; regression authority và role. |
| **M4.1.2 · Driver phụ trợ** | Tách Incident/POD/sync theo route và dùng lại Mapbox. Test tự động chứng minh Tổng quan kiểm tra e-POD độc lập. Gate nghiệm thu Android gồm guard hoàn thành, khôi phục queue, GPS nền và Back giữa các route. |
| **M4.1.3 · Customer** | Landing Order List, Detail/Tracking, Profile và wizard. Gate: đúng owner, multi-Trip/fresh/stale, 30s foreground, 1–20 loại kiện, nháp bước, retry cùng payload, 1 Order. |
| **M4.1.4 · Design QA & E2E** | Đồng nhất shared UI, chữ lớn/keyboard/TalkBack, chụp bằng chứng trước–sau. Chạy typecheck, lint, Jest, Metro Android bundle và Android development APK QA. Lặp Driver → Customer trên fixture test, ghi rõ automated/manual và số bản ghi. |

Gate thiết kế trước code: duyệt stack không tabs, layout Overview + Stop, cách giữ POD readiness, wizard 3 bước và các ưu tiên hiển thị. Các mốc không mở thêm API/business rule. Giữ changeset theo lát cắt để có thể rà diff và trở về UI trước nếu cần.

## 10. Android UI QA checklist

Trạng thái trong M4.1.0: **NOT RUN** cho thiết kế mới. Dùng development APK tương thích Mapbox và Backend local/test trong đợt triển khai. Checklist này là kế hoạch, không ghi đè các PASS lịch sử M4.0.

| ID | Kịch bản | PASS khi |
|---|---|---|
| U01 | Driver/Customer đăng nhập, session restore, sai role, Back/đăng xuất | Landing đúng role, không loop/unmatched route; cảnh báo pending giữ nguyên. |
| U02 | List có dữ liệu, filter rỗng, fetch lỗi, kéo làm mới và tải thêm | CTA và lỗi đúng ngữ cảnh; chỉ một danh sách logic, không mất vị trí cuộn bất ngờ. |
| U03 | Trip dài, màn nhỏ/chữ lớn | Điểm khả dụng và CTA thấy ngay khi mở Overview; thông tin chi tiết mở được, không che nút. |
| U04 | Depot, pickup, giao đủ/thiếu/thất bại; đổi stop/Back với keyboard | Đúng thứ tự và quyền, số lượng/lý do/người nhận đúng, không gửi hai lần, dữ liệu lỗi có thể sửa. |
| U05 | Offline ARRIVE/COMPLETE, app restart, đổi account, reconnect và conflict | Pending phân biệt server confirmed, giữ FIFO/owner/key/version; không mất lệnh hay nhảy stop sai; audit không trùng. |
| U06 | Complete Trip khi thiếu ảnh, ảnh local/failed rồi upload thành công | Guard vẫn chặn khi chưa đủ, một lần Complete sau ảnh active; quay từ POD về cập nhật readiness đúng attempt. |
| U07 | GPS permission denied, background, reconnect, rời từng route, logout | Không thêm watcher, không mất queue GPS, cảnh báo và nút khôi phục phù hợp. |
| U08 | Map pinch/pan + cuộn footer, marker trùng tọa độ, offline tile, external nav | Đủ nhãn theo sequence, cử chỉ độc lập, camera không giật; lỗi tile không cản điều hướng hợp lệ. |
| U09 | Incident thiếu quyền, gửi và timeout/retry, lọc Order liên quan | Đúng assignment/scope, một Incident sau retry, read-only giữ đúng. |
| U10 | Customer nhiều Trip, từ fresh sang stale, nền/foreground, chuyển Order và ownership | Một poll 30s khi focus/foreground; dữ liệu thuộc đúng Order/Trip, không leak, GPS cuối không lấy từ chuyến khác. |
| U11 | Wizard 1 và 20 loại kiện, thiếu chi nhánh, field sai, Back và retry | Đủ trường; lỗi đúng bước; nháp còn trong route; cùng payload tạo đúng một Order DRAFT. |
| U12 | TalkBack, chữ lớn, dark system setting nếu ảnh hưởng, bàn phím Android | Focus/label rõ, trạng thái có chữ, target đủ rộng, action bar không che form; ghi ảnh/clip trước–sau. |
| U13 | Driver → Customer xuyên suốt | Cùng Trip/Order, 4 stop, GPS thật, Order đúng trạng thái, ảnh trước Complete; đối chiếu event/command và Customer API theo runbook M4.0. |

## 11. Trạng thái triển khai M4.1.1

- `/trips/[id]` là Tổng quan. `/trips/[id]/stops/[stopId]` là màn thực thi một điểm. Cả hai cùng dùng workspace theo tài khoản và chuyến. Đường dẫn Mapbox hiện có tiếp tục dùng được. Ngữ cảnh Trip đang mở được giữ trong bộ nhớ khi vào Stop lúc mất mạng; lạnh app hoặc deep link offline vẫn cần snapshot/API hợp lệ.
- Tổng quan hiển thị tiến độ xác nhận từ server và số điểm hoàn thành local chờ đồng bộ riêng. CTA dựa trên assignment, trạng thái Trip, stop khả dụng, queue, mạng và e-POD. Stop giữ bản nháp khi refresh trong màn hình, yêu cầu xác nhận bỏ nháp trên Back và giữ dữ liệu nếu từ chối. Khi persist-first chấp nhận lệnh, nháp trong form được xóa vì payload đã thuộc hàng đợi hiện có.
- e-POD, Incident, GPS và Sync vẫn có đường vào trong Overview. Panel e-POD tiếp tục mount khi thu gọn theo attempt ID. Readiness chưa biết, đang tải/đang upload hoặc có lỗi đều khóa Complete. Route e-POD/Incident/Sync riêng và read model POD độc lập dành cho M4.1.2.
- Tự động: **307/307 Jest PASS** (48 suites) ở mốc export, TypeScript, ESLint, Expo dependency check, Doctor **20/20** và Android export PASS. Sau chỉnh UI đồng bộ: **309/309 Jest PASS**. Android QA xác nhận luồng chính, mốc đồng bộ Pickup và guard trước/sau PHOTO. Xem [bằng chứng và checklist thiết bị](../04-testing/test-cases.md#m411--driver-trip-overview--stop-execution).

| Nhóm | File thay đổi dưới `mobile/src/` |
|---|---|
| Expo Router | Di chuyển entry từ `app/(driver)/trips/[id].tsx` sang `app/(driver)/trips/[id]/index.tsx`; thêm `[id]/_layout.tsx` và `[id]/stops/[stopId].tsx`. |
| Driver screens | `features/driver-trips/screens/DriverTripDetailScreen.tsx`, `DriverStopExecutionScreen.tsx`, `driver-trip-screens.spec.tsx`. |
| Workspace và state | `features/driver-trips/providers/DriverTripWorkspace.tsx`, `selectors/driver-trip-workflow.ts`, `hooks/useDriverTripDetail.ts`. |
| UI hiện có | `features/driver-trips/components/DriverTripHeader.tsx`, `execution/DriverStopExecutionPanel.tsx`, `pod/DriverPodPanel.tsx`, `pod/DriverPodPanel.spec.tsx`. |

## 12. Trạng thái triển khai M4.1.2

| Route | Điểm vào và dữ liệu |
|---|---|
| `/trips/[id]/incidents` | Lối tắt Tổng quan. Danh sách theo chuyến và form hiện có. Gửi online khi phân công PRIMARY/ASSIGNED ở DISPATCHED hoặc IN_PROGRESS. |
| `/trips/[id]/sync` | Lối tắt Tổng quan hoặc từ điểm dừng bị chặn. Hiển thị tóm tắt và từng lệnh theo chuyến từ queue đã lọc tài khoản. Retry qua coordinator hiện có. |
| `/trips/[id]/stops/[stopId]/pod` | Từ Stop Execution hoặc lối tắt Tổng quan. Trip, điểm giao và lần giao được kiểm tra với dữ liệu server. Trip hoàn thành và phân công chỉ xem vẫn xem được bằng chứng theo quyền hiện có. |

- Trip workspace theo tài khoản và chuyến dùng chung giữa Overview, Stop, Map và ba màn phụ. Ảnh/chữ ký gửi chưa rõ kết quả giữ file, tham số và idempotency key trong workspace để thử lại khi mở lại màn e-POD. Queue thực thi tiếp tục dùng SQLite, FIFO và expectedTripVersion qua coordinator hiện có. GPS dùng lifecycle ở root.
- Khi Overview focus, app tải chi tiết Trip rồi kiểm tra e-POD qua GET hiện có của từng điểm giao đã hoàn thành. Trip/version, danh sách attempt hoặc thay đổi upload làm mất hiệu lực kết quả trước đó. Khi rời focus hoặc đổi ngữ cảnh, phản hồi cũ bị bỏ qua. App đọc lại sau upload và thay ảnh, theo sự kiện và thao tác thử lại.
- UI chỉ mở Complete Trip cho PRIMARY/ASSIGNED trên chuyến IN_PROGRESS, online, queue sạch, các stop/task đã được xác nhận và mọi e-POD bắt buộc đã đủ. PHOTO phải do server báo UPLOADED và active. Trạng thái đang tải, lỗi hoặc thiếu dữ liệu giữ nút đóng. Backend tiếp tục áp dụng `POD_REQUIRED`.
- Chi tiết Trip chỉ trả attempt mới nhất cho mỗi điểm. Nếu `attemptNumber > 1`, Mobile giữ khóa Complete vì còn lần giao trước cần xác minh. Các lần giao ở nhiều điểm khác nhau đều được kiểm tra. Trường hợp cần hoàn thành chuyến có nhiều attempt cùng điểm phải thống nhất contract bổ sung với nhóm Backend.
- Theo dõi [checklist và kết quả Android M4.1.2](../04-testing/test-cases.md#m412--driver-supporting-screens--pod-readiness).

## 13. Chuẩn bị triển khai M4.1.3

Hiện tại route gốc Customer mở `CustomerHomeScreen` chứa profile. Từ đó người dùng mới vào `/orders` hoặc `/orders/create`. Màn tạo đơn lưu toàn bộ dữ liệu trong một form và chỉ gọi `validateCreateOrder` khi gửi. Tracking đã có chu kỳ 30 giây khi màn chi tiết focus và app ở foreground.

Kiểm tra trước khi đổi giao diện ngày 20/11/2026 đạt **48/48 Jest PASS** cho Orders/Auth và **TypeScript PASS**.

| Thứ tự | Thay đổi đề xuất | Điều kiện nghiệm thu |
|---|---|---|
| 1. Landing và Profile | Dùng Order List làm landing Customer, giữ deep link `/orders`. Đưa Profile sang route riêng từ header, tái sử dụng logic làm mới và đăng xuất của `CustomerHomeScreen`. Giữ Expo Router Stack. | Login, restore và Back đến đúng route. Đăng xuất về Login. Danh sách giữ filter, phân trang, kéo làm mới và lối tắt tạo đơn. |
| 2. Chi tiết và Tracking | Ưu tiên mã đơn, trạng thái, thời điểm tạo và Tracking. Đưa điểm lấy/giao, hàng hóa và ghi chú xuống dưới. Giữ `CustomerOrderTrackingPanel` và `useCustomerOrderTracking`. | Hiển thị đúng nhiều Trip, chưa có GPS, GPS mới/cũ và vị trí cuối. Chỉ có một poll mỗi 30 giây khi focus/foreground. Deep link đơn ngoài quyền tiếp tục được API từ chối. |
| 3. Tạo đơn ba bước | Chi nhánh và hai điểm → kiện hàng → rà soát, ghi chú và gửi. Giữ một form state, `validateCreateOrder` cho lần gửi cuối và `useCreateCustomerOrder` cho chống gửi trùng. Đề xuất lưu nháp trong màn, Back để quay bước trước và hỏi xác nhận khi thoát với nháp. | Giữ toàn bộ trường, giới hạn 1–20 loại kiện và bước chứa lỗi. Quay từng bước giữ dữ liệu. Timeout thử lại cùng payload dùng cùng key. Bấm đúp chỉ tạo một đơn DRAFT. |

Các quyết định cần duyệt trước code là landing ở Order List và hành vi Back khi thoát đơn nháp. Kiểm tra trên Android gồm màn nhỏ/chữ lớn, Back với bàn phím, mất mạng lúc gửi, chi nhánh không còn active, login/logout và chuyển qua lại giữa hai đơn đang tracking.
