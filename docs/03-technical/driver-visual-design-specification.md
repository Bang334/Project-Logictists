# M4.1.2C.0 — Đặc tả thiết kế giao diện Driver

20/11/2026 · **Đã duyệt đặc tả. C.1 và C.2 đã triển khai, chờ Android QA.**

Mục tiêu là giúp tài xế biết ngay chuyến nào cần xử lý, điểm nào đến lượt và bước tiếp theo có bị chặn hay không. Thứ tự nội dung ưu tiên thao tác trên đường, sau đó là tình trạng, lịch và dữ liệu đối chiếu. Phạm vi gồm chín màn Driver đang có trong Expo Router Stack.

## 1. Bằng chứng và audit hiện tại

- Căn cứ: [AGENTS](../../AGENTS.md), [Mobile AGENTS](../../mobile/AGENTS.md), [kế hoạch TMS](../../KE_HOACH_TMS.md) §11–12 và T08/T11/T12/T16/T19/T20, [blueprint M4.1.0–M4.1.3](mobile-ui-ux-audit-redesign.md), [khảo sát mở rộng Driver](driver-product-expansion-survey.md), [checklist hiện hữu](../04-testing/test-cases.md).
- Repo chỉ tìm thấy ảnh asset ứng dụng trong phạm vi tìm kiếm ảnh, chưa có bộ screenshot Android của chín màn theo cùng bản build. Ảnh lịch sử trong hội thoại cho thấy Overview dùng các cụm riêng cho trạng thái, điểm cần xử lý và thiết bị; ảnh Map lịch sử cho thấy viewport và vùng chi tiết. Những ảnh này thuộc các mốc trước. Ảnh bốn khu vực trong M4.1.2A là mockup định hướng. M4.1.2B đã được người dùng kiểm tra thực tế; tài liệu automated hiện có xác nhận 345/345 Jest ở bản polish. Không suy ra từng ca thiết bị PASS từ thông tin tổng quát.
- Cần chụp lại để đối chiếu cùng bản development APK: Home tên dài và hai phạm vi queue, List nhiều mã dài, Overview có stop pending/blocked, Stop có bàn phím, Incident list/form, Sync hỗn hợp, POD trước/đang/sau tải, Map khi xem toàn tuyến và Account có cảnh báo logout. Ghi kích thước khả dụng, cỡ chữ, trạng thái Trip và cấu hình điều hướng Android. Biểu tượng bánh răng nổi là overlay của Development APK, ngoài phạm vi sửa và nghiệm thu giao diện Smart TMS.

| Màn / source | Hiện trạng thấy từ source | Hướng xử lý |
|---|---|---|
| Home · `DriverHomeScreen` | Tên nằm riêng trong header có vùng cuộn. Hero, lịch đã điều phối, truy cập nhanh và thiết bị là bốn vùng. Progress đã tách local và server. Queue của Trip và toàn tài khoản đã tách sau M4.1.2B. | Giữ thẻ công việc chính và CTA tiếp tục. Gom lối tắt thành hàng có nhãn, hiển thị lỗi cạnh đúng phạm vi. Giữ trường hợp nhiều Trip đang chạy yêu cầu chọn. |
| Trip List · `DriverTripListScreen`, `DriverTripCard` | Filter ngang, FlatList phân trang, kéo mới. Mỗi card lặp hai mốc giờ, actual nếu có, xe, stop và assignment. Banner lỗi có thể đứng cạnh rỗng; logout còn có lối vào tại header List. | Ưu tiên mã, trạng thái, giờ, xe, số điểm. Giờ actual và vai trò chỉ nổi bật khi giúp quyết định. Tách lần tải lỗi khỏi filter rỗng. Chuyển logout về Account sau khi kiểm tra lối vào từ List và deep link. |
| Overview · `DriverTripDetailScreen` | Có progress và nút theo policy, nhưng GPS, Sync, Map, Incident, từng POD và disclosure chiếm nhiều hàng. `DriverNavigationPanel` ở cuối nhắc lại điểm đích. | Đặt hành động gần điểm hiện tại. Tóm tắt GPS/Sync cùng hàng, Map/Sự cố là shortcut. Đưa POD theo stop và giữ đường vào từ CTA bị chặn. Gộp điều hướng ngoài vào ngữ cảnh điểm hiện tại hoặc Map. |
| Stop · `DriverStopExecutionScreen`, `DriverStopExecutionPanel` | Khi ARRIVED, danh sách task kế hoạch và form số lượng cùng xuất hiện. ARRIVE có action bar riêng, COMPLETE nằm trong nội dung. Form hiện một thông điệp lỗi chung, kết quả giao được suy từ số lượng. | Dùng một hàng cho mỗi task với kế hoạch và thực tế cạnh nhau. Hiện phụ thuộc người nhận/lý do theo validator. Đặt lỗi sát trường khi xác định được và giữ fallback cho lỗi tổng quát. |
| Incident · `DriverTripIncidentsScreen`, `DriverIncidentPanel/Form/Card` | Accordion có mô tả preview. Làm mới, tải thêm và tạo dùng nhiều nút. Form modal có chọn loại/mức độ/đơn và mô tả. | Dòng tình trạng + mức độ/ngày, preview ngắn, chi tiết mở theo yêu cầu. Một CTA báo sự cố. Kéo mới và nút thử lại thuộc ngữ cảnh tải. |
| Offline Sync · `DriverTripSyncScreen`, `OfflineDriverQueuePanel` | Tổng hợp và card lệnh tách riêng, mỗi lệnh tốn một card. Status đầy đủ nhưng lỗi blocking có thể nằm xa CTA xử lý. | Nhóm theo tình trạng để đọc, giữ thứ tự xử lý FIFO của coordinator. Hiện lệnh chặn và tác động trước, thu gọn phần đã đồng bộ nếu còn dữ liệu. |
| e-POD · `DriverStopPodScreen`, `DriverPodPanel` | Kiểm tra attempt server, có ảnh local, xem/thay ảnh, chữ ký và retry. Các hành động tạo, thử lại và làm mới tạo nhiều nút. Hook cung cấp trạng thái đang tải lên, chưa có tỷ lệ byte để hiển thị phần trăm. | PHOTO bắt buộc là khối chính. Mỗi giai đoạn có một CTA. Chữ ký và lịch sử ảnh thu gọn. Trạng thái upload dạng tiến trình chưa xác định tỷ lệ. |
| Map · `DriverTripMapScreen`, `DriverTripMap`, `DriverNavigationPanel` | Map và vùng cuộn chi tiết tách sẵn. Header, heading card, cảnh báo, chú giải và panel dưới cạnh tranh chiều cao. | Rút mã chuyến/xe thành metadata ngắn. Giữ viewport và recenter của map. Đưa điểm đích, độ mới và nút mở dẫn đường vào vùng dưới. Chú giải mặc định thu gọn. |
| Account · `DriverAccountScreen`, `useDriverLogout` | Tên và username là dữ liệu phiên. Có lỗi đăng xuất và cảnh báo nếu queue chưa sạch. | Hai dòng định danh chỉ đọc. Đặt Đăng xuất tách khỏi thao tác hàng ngày, vẫn dễ tới bằng một tay. Dùng cùng guard; dựa vào hồ sơ account hiện có. |

Source chính: [Driver Home](../../mobile/src/features/driver-home/screens/DriverHomeScreen.tsx), [Trip List](../../mobile/src/features/driver-trips/screens/DriverTripListScreen.tsx), [Overview](../../mobile/src/features/driver-trips/screens/DriverTripDetailScreen.tsx), [Stop](../../mobile/src/features/driver-trips/screens/DriverStopExecutionScreen.tsx), [Map](../../mobile/src/features/driver-navigation/screens/DriverTripMapScreen.tsx).

## 2. Hướng thiết kế Modern Logistics Operations App

Light mode, nền trung tính và bề mặt trắng. Dùng xanh dương cho hành động chính và trạng thái đang chọn. Gắn chữ với mọi màu trạng thái. Một bề mặt nhấn mạnh điểm hoặc việc cần xử lý; các thông tin liền mạch dùng dòng và divider thay cho card lồng. Giảm các nút toàn chiều ngang bằng shortcut ngắn có nhãn.

Mỗi màn trả lời ba câu hỏi theo thứ tự: **Tôi đang ở đâu? Việc tiếp theo là gì? Khi chưa làm được, tôi cần xử lý gì?** Dữ liệu chuyến và hành động chính ở gần nhau. Chi tiết lịch, phân công, task phụ, ảnh cũ và chú giải mở theo yêu cầu. Hành động lặp trong thực thi đặt gần mép dưới và tôn trọng bàn phím. Màn đọc như danh sách dùng cả card làm đích chạm. Hệ thống hình ảnh được thiết kế cho nghiệp vụ Smart TMS.

## 3. Design token specification

Ưu tiên [theme hiện có](../../mobile/src/shared/theme/theme.ts), font hệ điều hành và icon hiện có đã được kiểm kê trước khi code. Các giá trị thêm dưới đây giới hạn cho Driver trước khi cân nhắc đưa vào theme chung.

| Nhóm | Giá trị và cách dùng |
|---|---|
| Nền và surface | `#F4F7FB` nền, `#FFFFFF` bề mặt, `#E9F0FC` nền thẻ việc chính hoặc trạng thái thông tin. Text `#172033`, metadata `#667085`. |
| Primary và secondary | `#1456D9` primary với chữ trắng, pressed `#0D3FAD`. Secondary nền trắng hoặc trong suốt, chữ xanh và viền khi cần. Tertiary là text action với vùng chạm riêng. |
| Semantic | Success `#18794E/#ECFDF3`; warning `#854A0E/#FFF4DC`; error `#C62828/#FFF1F1`; info `#16418A/#E9F0FC`. Neutral dùng chữ xám và surface trung tính. Tỷ lệ các cặp đã tính lần lượt 5,13; 6,44; 5,11; 8,50:1. Chữ trắng trên primary 6,24:1. |
| Typography | Tiêu đề màn 24/32, tiêu đề cụm 18/24, nội dung/CTA 16/22, metadata 14/20 (size/line height). Title 700–800, body 400, nút và trạng thái 600–700. Giữ scaling theo hệ thống, cho xuống dòng, tránh đặt chiều cao cố định cho khối chữ. |
| Spacing | 6/10/16/24/32 từ theme. Lề màn 16; padding cụm 12–16; gap cùng chủ đề 6–10; chuyển vùng 16–24. Dùng 24–32 cho khoảng kết thúc màn và cuộn qua action bar. |
| Bo góc / elevation | 16 cho hero/card chính, 12 cho field/button, 10 cho banner, pill cho badge. Card và row mặc định phẳng. Chỉ nâng action bar cố định hoặc modal khi cần phân lớp. |
| Divider / focus | Divider hairline `#D6DDE8` giữa row, tăng bằng trạng thái focus/selected dễ thấy. Viền divider chỉ dùng phân nhóm; label, độ tương phản và đường focus thể hiện tương tác. |
| Badge | Chip theo **nhóm** Trip / Stop / GPS / Sync / Incident / POD. Text và kích thước linh hoạt, xuống hàng ở chữ lớn. Nếu chip có thể bấm thì vùng tương tác theo quy tắc nút. Không dùng badge để thay label dài, lỗi hoặc lý do bị khóa. |
| Button / icon / vùng chạm | Primary tối thiểu 50 dp cao theo component hiện có, mọi control tối thiểu 48×48 dp. Icon 18–20 cho hàng, 24 cho control chính. Mỗi nút icon có nhãn trợ năng. Khi thiếu icon đồng nhất, dùng nhãn chữ có sẵn. |
| Safe area | Lề theo inset trên/dưới/hai bên. Action bar dùng inset dưới đúng một lần. Nội dung cuộn có khoảng cuối để không bị nút che; khi IME mở, CTA hoặc vùng cuộn vẫn tới được ở trường cuối. Preserve font scaling ở Android. |

Mục tiêu QA dùng tương phản tối thiểu 4,5:1 cho chữ thông thường và vùng chạm ít nhất 48×48 dp. Kiểm tra riêng pressed, disabled, chip trên nền màu và icon trên map. [Android accessibility](https://developer.android.com/guide/topics/ui/accessibility/apps) · [React Native Text](https://reactnative.dev/docs/text#allowfontscaling)

### Quy ước trạng thái

| Phạm vi | Nhãn và ngữ nghĩa chính |
|---|---|
| Trip | Đã điều phối · info, Đang thực hiện · primary/info, Hoàn thành · success, Đã hủy · neutral. Phân công chỉ xem luôn ghi rõ ở ngữ cảnh thao tác. |
| Stop | Chưa đến · neutral, Đã đến · info, Đã xác nhận · success, Bỏ qua · neutral, Đã lưu trên máy/chờ đồng bộ · warning, Xung đột/thất bại · error. X/Y dùng COMPLETED và SKIPPED từ server, ghi riêng số bỏ qua. |
| GPS | Đang theo dõi, thiếu quyền, tắt vị trí, gửi lỗi và mẫu cũ dùng nhãn riêng. Dùng đúng snapshot của chuyến, thời điểm và số điểm GPS chờ. |
| Sync | Pending/tạm dừng/chờ retry · warning; đang gửi · info; conflict/failed/blocked · error; đã đồng bộ · success. Hàng đợi chuyến và hàng đợi tài khoản có nhãn phạm vi. |
| Incident và POD | Severity khác status xử lý. POD phân biệt thiếu ảnh bắt buộc, ảnh trên máy, đang gửi, upload lỗi, ảnh active được server xác nhận, ảnh đã thay. Chữ ký tùy chọn có nhãn riêng. |

## 4. Component patterns và ranh giới tái sử dụng

Tên pattern là vai trò giao diện. Chỉ tách component mới khi cùng hợp đồng trình bày được dùng ở nhiều màn hoặc cần cô lập cử chỉ/trạng thái.

| Pattern | Tái sử dụng và đặc tả |
|---|---|
| **AppHeader** | Nền tảng `DriverTripHeader`, tham chiếu header riêng đã polish ở Home. Back + title, metadata tùy ngữ cảnh, tối đa một action phụ. Tên dài được xuống dòng. |
| **TripCard**, **StatusBadge** | Giữ `DriverTripCard`, `DriverTripStatusBadge` và map label hiện có. Card bấm toàn vùng, mã đầy đủ cho TalkBack/chi tiết. Dùng khác variant cho Home và List nếu tái sử dụng khả thi. |
| **ProgressIndicator**, **CurrentStopCard**, **StopTimeline** | Dùng tiến độ đã có ở Home/Overview. CurrentStop đọc selector workflow/navigation, có reason nếu khóa. Timeline là disclosure và các hàng theo sequence, không tạo cây task mới ở Overview. |
| **GPSStatus**, **SyncStatus** | Dùng snapshot GPS từ hook hiện tại, panel GPS cho permission/settings/flush. Dùng summary queue theo Trip hoặc tài khoản, `OfflineDriverQueuePanel` cho thao tác hiện có. |
| **AlertBanner**, **EmptyState**, **ErrorState**, **LoadingState** | Bắt đầu từ `ScreenMessage`, `ActivityIndicator` và trạng thái rỗng hiện có. Banner chỉ một nguyên nhân ở mỗi phạm vi. Sửa copy theo ngữ cảnh trước khi thêm tone/component chung. Loading lần đầu khác refreshing; giữ snapshot khi phù hợp. |
| **QuickAction**, **BottomActionBar** | Giữ Pressable hiện có và semantics accessibility. Shortcut icon + chữ hoặc chữ, xuống hàng. Dùng action bar của Stop làm mẫu rồi mở rộng khi gặp lặp thật. Hành động mutation đi qua handler/validator sẵn có. |
| **FormSection** | Dùng đầu mục, divider và trường sẵn có trong `DriverStopExecutionPanel` hoặc `DriverIncidentForm`. Label/required/lỗi cạnh trường; chỉ giữ form tổng quát nếu không xác định được field lỗi. |

## 5. Wireframe chín màn

Trong các khung, các dòng đi từ trên xuống. `[...]` là thao tác, dòng trong ngoặc đơn là nội dung phụ hoặc có điều kiện. Các biến thể đều dùng Stack hiện tại.

### 1. Driver Home · `/`

```text
Công việc                                      [Tài khoản]
Tên tài xế có thể xuống dòng
(Offline / dữ liệu có thể đã cũ)
CHUYẾN ĐANG THỰC HIỆN
Mã chuyến                         Đang thực hiện
Biển số · Xe     X/Y điểm đã xác nhận      [progress]
Điểm kế tiếp · loại/sequence · địa chỉ ngắn
[Tiếp tục chuyến]
CHUYẾN ĐÃ ĐIỀU PHỐI                         [Xem tất cả]
Giờ · Trạng thái
Xe · phần nhận diện mã chuyến                              ›
[Danh sách chuyến] [Lịch sử chuyến]
GPS đúng Trip / lệnh chuyến hiện tại / tổng tài khoản
```

**CTA/navigation:** Tiếp tục → Overview, nhiều Trip → Chọn chuyến, RELIEF → Xem chuyến. Account và list là shortcut phụ. **Reuse:** hero/progress Home, badge, queue/GPS summary và formatter. **Variants:** loading từng vùng, rỗng active/upcoming, lỗi cùng nút tải lại, offline giữ snapshot phiên và nhãn cũ. **Responsive:** header cuộn, tên toàn hàng, shortcut xuống dòng và khối queue giữ nhãn phạm vi.

### 2. Trip List · `/trips`

```text
[Quay lại] Chuyến                              [Tài khoản]
[Tất cả] [Đã điều phối] [Đang thực hiện] [...]
Mã chuyến                                      Trạng thái ›
Giờ bắt đầu – kết thúc
Biển số · Loại xe                           Số điểm
──────────────────────────
...
Đang tải thêm …
```

**CTA/navigation:** Chạm cả TripCard → Overview. Filter ngang giữ selected, có thể cuộn, kéo mới và phân trang giữ như hiện tại. **Reuse:** FlatList, `useDriverTrips`, TripCard/badge. **Variants:** rỗng theo filter, lỗi tải có thử lại, lỗi tải thêm giữ trang đang có, offline giữ snapshot khả dụng. **Responsive:** status có thể xuống hàng, giờ và xe không đè mã; label truy cập đầy đủ nếu mã hiển thị rút gọn.

### 3. Trip Overview · `/trips/:id`

```text
[Quay lại] Tổng quan chuyến
A. Mã · Trạng thái · Xe
B. X/Y xác nhận                      (Bỏ qua / Local chờ)
C. Điểm cần xử lý · sequence · địa chỉ · trạng thái
   (Lý do khóa)                             [Điều hướng ↗]
D. [Hành động đúng bước]
E. [Bản đồ] [Sự cố] [Đồng bộ]     GPS · tình trạng
F. [Điểm dừng ▸]                 [Lịch và phân công ▸]
```

**CTA/navigation:** Giữ thứ tự từ workflow: Bắt đầu, Mở điểm, Xem đồng bộ khi bị chặn, Bổ sung ảnh hoặc Hoàn thành theo điều kiện. Nút phụ dẫn đường chỉ dùng target hợp lệ, hiển thị cạnh điểm và dẫn vào app ngoài; có thể đặt tại Map nếu không đủ không gian. Tooltip/label giải thích khi target bị chặn. POD vẫn truy cập được từ Stop/CTA hiện hữu. **Reuse:** workspace, selector, progress, GPS panel, timeline và navigation target. **Variants:** loading/lỗi/không còn stop, trạng thái chỉ xem, offline, thiếu POD, conflict, không có target. **Responsive:** không render task list ở Overview; shortcut xếp lại, CTA ở vùng gần điểm hiện tại, chỉ một CTA nổi bật. Khi mở GPS hay timeline, scroll tới mục mở theo thứ tự focus rõ.

### 4. Stop Execution · `/trips/:id/stops/:sid`

```text
[Quay lại] Giao hàng · Điểm 3/7
Địa chỉ · Liên hệ                            [Thời gian ▸]
Trạng thái điểm / offline / local chờ
HÀNG HÓA
Mã kiện · Đơn · Kế hoạch                 Thực tế [    ]
(Lỗi cạnh trường / kích thước khi mở)
Kết quả từ số lượng · Người nhận
(Lý do khi thiếu/thất bại · Ghi chú)
(e-POD khi attempt đã xác nhận)
────────────────────────────────────────
[Đã đến điểm / Xác nhận lấy hoặc giao / Hoàn thành kho]
```

**CTA/navigation:** Action bar theo trạng thái, gọi validator và handler hiện tại. Người nhận và lý do theo policy, kết quả giao suy từ thực tế như hiện có. Với kho bỏ khu vực hàng. Back giữ dialog nháp. **Reuse:** task input, draft, validator, overlay và action bar hiện có. **Variants:** loading, lỗi sai Stop, read-only, đang gửi, local chờ xác nhận, blocked. **Responsive:** hàng task xếp dọc ở màn nhỏ/chữ lớn, IME cho cuộn tới trường đang focus và lỗi đầu tiên. Giữ submit trực tiếp khi đủ dữ liệu và phần mô tả lý do dễ tới.

### 5. Incident · `/trips/:id/incidents`

```text
[Quay lại] Sự cố · Mã chuyến
(Offline hoặc quyền chỉ xem)
Loại sự cố                     Mức độ · Trạng thái  ▸
Giờ · Mô tả ngắn
  (Mở rộng: mô tả, đơn liên quan, kết quả xử lý)
...
[Báo sự cố]
Modal: Loại → Mức độ → Mô tả → Đơn liên quan → [Gửi]
```

**CTA/navigation:** Báo sự cố chỉ hiện/cho phép theo quyền hiện có. Khi form mở, CTA chính là Gửi; tải thêm và refresh là thao tác phụ. **Reuse:** list, accordion, modal và hooks hiện hành. **Variants:** rỗng, lỗi tải, loading, offline giữ nội dung, read-only Trip hoàn thành, timeout cho retry đúng yêu cầu. **Responsive:** chip xuống hàng, modal cuộn khi bàn phím mở, focus trở về nút mở.

### 6. Offline Sync · `/trips/:id/sync`

```text
[Quay lại] Đồng bộ · Mã chuyến
Số lệnh chưa gửi / mạng / hành động cần xử lý
XUNG ĐỘT HOẶC BỊ CHẶN
Điểm · loại thao tác · trạng thái / hướng xử lý
ĐANG CHỜ
Điểm · loại thao tác · chờ/đang gửi/chờ thử lại
[Đã đồng bộ ▸]
[Thử đồng bộ] hoặc [Tải lại chuyến] theo policy
```

**CTA/navigation:** Thử gửi hoặc tải lại theo hành vi sẵn có. Chỉ một nút được nhấn mạnh theo tình trạng, nút còn lại giữ phụ nếu hợp lệ. **Reuse:** workspace/queue summary và coordinator, max một phép regroup render với thứ tự gốc trong từng nhóm. **Variants:** rỗng, offline, gửi, hết phiên, xung đột, thất bại, blocked và thành công. **Responsive:** lý do dài xuống hàng, không swipe để xóa, CTA có thể tiếp cận qua scroll và TalkBack. Thứ tự nhóm chỉ là cách đọc, FIFO và thứ tự gửi giữ nguyên.

### 7. e-POD · `/trips/:id/stops/:sid/pod`

```text
[Quay lại] Bằng chứng · Điểm giao
ẢNH BẮT BUỘC                    Thiếu / Đang gửi / Đã xác nhận
(Ảnh xem trước hoặc active)
(Lỗi + việc cần làm)     [Xem ảnh] [Thay ảnh] khi hợp lệ
[Chụp ảnh / Xác nhận tải lên / Thử tải lại] theo giai đoạn
[Chữ ký tùy chọn ▸]
[Ảnh từng thay ▸]
```

**CTA/navigation:** Chỉ một hành động tải nổi bật; mở preview, đổi ảnh và refresh dùng đường phụ. Back về Stop/Overview kích hoạt refresh readiness hiện có. **Reuse:** camera, preview, viewer, chữ ký, retry store và e-POD service. **Variants:** attempt chưa xác nhận, loading metadata, permission, ảnh local, trạng thái đang upload không phần trăm, lỗi, active, superseded và read-only. **Responsive:** viewer tách vùng, không cản ký một ngón; CTA cuộn tới được khi ảnh hoặc chữ lớn.

### 8. Trip Mapbox · `/trips/:id/map`

```text
[Quay lại] Bản đồ · Mã chuyến
╔══════════ Viewport Mapbox ══════════╗
║ Marker hành trình, điểm và xe       ║
║                          [Định tâm] ║
╚═════════════════════════════════════╝
Điểm đích · sequence · địa chỉ
(GPS cũ / không có tọa độ / lý do khóa)
[Mở điều hướng]
[Chú giải ▸]
```

**CTA/navigation:** Mở app điều hướng theo target và policy hiện có. Recenter dùng control Mapbox đang có, có nhãn đọc. **Reuse:** Mapbox component/error boundary, GPS snapshot/selector và vùng chi tiết cuộn độc lập. **Variants:** đang tải, lỗi tile/native, thiếu tọa độ, GPS stale và Trip kết thúc xem lại; giữ đường dẫn hợp lệ khi map lỗi. **Responsive:** ưu tiên viewport, không phủ phần attribution, để panel dưới cuộn độc lập. Giữ pan/pinch/tap marker và recenter như hiện tại.

### 9. Driver Account · `/account`

```text
[Quay lại] Tài khoản
Tên tài xế
Tên đăng nhập
(Lỗi phiên hoặc lỗi đăng xuất)
[Đăng xuất]
Xác nhận khi còn lệnh pending: [Ở lại] [Vẫn đăng xuất]
```

**CTA/navigation:** Back về nguồn mở, logout theo guard và về đăng nhập. **Reuse:** AuthProfile, `useDriverLogout`, header và nút phụ. **Variants:** session loading/error theo root, tài khoản có tên dài, đang logout, offline có pending. **Responsive:** tên nhiều dòng, nút tách khỏi metadata, dialog focus rõ và đọc được số pending.

## 6. CTA hierarchy và state variants

| Tình trạng | CTA và feedback |
|---|---|
| Đang chạy, có hành động hợp lệ | Một primary. Ở Home dùng Tiếp tục, Overview dùng hành động từ workflow, Stop dùng bước hiện tại. Map, Incident, lịch và chi tiết là shortcut có chữ. |
| Chuyến chỉ xem hoặc không có việc | Dùng CTA điều hướng có ích. Hành động ghi không hiện. Nếu điều kiện tạm thời chưa thỏa, mô tả lý do cạnh thao tác hoặc hiển thị đường khắc phục. |
| Mất mạng | Banner ghi dữ liệu đã tải có thể cũ hoặc chưa có snapshot. Stop diễn đạt **lưu trên máy, chờ đồng bộ** chỉ khi queue mới ghi. Existing policy chặn các hành động cần server, có hướng nối mạng hoặc xem queue. |
| Loading và refresh | Đang tải lần đầu dùng indicator và nhãn. Refresh giữ thông tin đã tải đúng scope. Tránh báo rỗng trước khi nhận kết quả. Nút đang gửi có nhãn và busy; chống bấm lặp theo hook hiện tại. |
| Error và conflict | Phân biệt mất mạng, lỗi API, dữ liệu thay đổi, sai quyền và lỗi file. Inline cho field, banner cho phạm vi màn, retry tại vị trí lỗi. Conflict nêu vì sao dừng và đường vào Sync phù hợp. |
| Thành công | Phản hồi local dùng nhãn pending. Server đã xác nhận mới đổi sang success. Upload chưa có byte progress dùng trạng thái “Đang tải lên”, ảnh active phải do server trả. |

## 7. Android accessibility và thao tác một tay

- Thử màn hẹp đại diện khoảng 320–360 dp, cỡ chữ mặc định/lớn nhất và tăng kích thước hiển thị. Đây là cấu hình QA, không phải breakpoint bắt buộc. Cho hàng chuyển sang dọc khi thiếu chỗ; mọi nút dài và tên có dấu đọc được.
- Dùng vùng chạm 48×48 dp. Các hành động lặp nằm ở nửa dưới khi khả thi; thao tác thay/hủy hiếm hoặc có tác động được đặt cách nút chính. Không yêu cầu vuốt hoặc kéo để thực hiện tác vụ cốt lõi.
- IME số cho số lượng theo field hiện có. Khi bàn phím mở, cuộn tới trường focus và lỗi, action bar đẩy đúng inset hoặc hiện trong nội dung nếu chiều cao không đủ. Thử Android Back khi bàn phím mở rồi khi modal/nháp đang hoạt động; giữ thứ tự hệ điều hành và guard hiện có.
- Safe area ở cả gesture navigation và 3 nút hệ thống, status bar và cutout. Không đếm inset dưới hai lần. Cửa sổ map độc lập với scroll chi tiết; không dùng gesture wrapper chặn pinch hoặc ký.
- TalkBack đọc theo ngữ cảnh: title → status → công việc → CTA → thông tin phụ. Label nói rõ chuyến hoặc điểm dừng khi cần. Disclosure thông báo expanded, chip selected, button busy/disabled. Progress đọc X/Y một lần, thanh trang trí ẩn khỏi cây trợ năng. Thông báo kết quả quan trọng dùng live region thích hợp, tránh đọc lại mỗi nhịp GPS. [React Native Accessibility](https://reactnative.dev/docs/accessibility)

## 8. Reuse/refactor plan và các lát cắt

| Lát cắt đề xuất | Phạm vi và điều kiện hoàn tất |
|---|---|
| C.1 · Nền UI và Trip List | Bắt đầu bằng token Driver, header, TripCard/badge, loading/empty/error. Giữ phân trang, filter và route. Áp dụng tối thiểu vào Home/Account để thống nhất typography và khoảng cách; giữ queue context M4.1.2B. |
| C.2 · Overview và Stop | Dùng workspace/selector cũ, giảm vùng lặp, tóm tắt Stop và gom hành động. Dùng lại task input để hợp nhất planned/actual. Chỉ bổ sung hiển thị lỗi theo trường khi suy được từ validation hiện có, giữ fallback. Gate có Back/nháp, bàn phím và offline/queue/POD. |
| C.3 · Incident, Sync và e-POD | Tối ưu disclosure, trạng thái và một CTA theo pha; không sửa API, thứ tự xử lý queue, identity retry hay chính sách bằng chứng. |
| C.4 · Map và Android QA | Rút header/legend và điểm đích; giữ SDK/config/gesture/lifecycle. Chạy regression và QA trên development APK theo checklist, sau đó ghi kết quả. |

Ưu tiên thay phần render và style ở màn đang có. Giữ protected group và link cũ, Trip workspace theo user + ID, auth/GPS/offline lifecycle ở root, service và business selector hiện có. Nếu cần đổi API hoặc quy tắc để hoàn tất một pattern thì tách thành quyết định ngoài scope này. M4.1.3 Customer tiếp tục kế hoạch riêng.

## 9. Regression risk matrix

| Rủi ro | Bất biến và kiểm chứng |
|---|---|
| Execution/nháp | ARRIVE trước COMPLETE, planned/actual tách, phân công chỉ xem và trạng thái kết quả đúng. Back, thay đổi version và hai lần chạm không làm mất/nhân đôi thao tác. Test thành công, giao một phần/thất bại (T08), kho và quyền RELIEF. |
| M3.8 Queue | Owner, Trip, FIFO, idempotency key, expected version và retry giữ đúng. Thử offline/reconnect, conflict, hết phiên, logout, mở chuyến khác, đối chiếu thứ tự gửi (T12/T16). |
| M3.8.4 POD_REQUIRED | Thiếu hoặc chưa xác nhận ảnh active vẫn khóa Complete theo backend. Thử nhiều stop, ảnh local/thất bại/ảnh thay và Back về Overview, server guard độc lập (T19). |
| M3.6C GPS | Route/shortcut chỉ đọc đúng snapshot, không tạo watcher, giữ lifecycle start/background/stop/logout và stale; kiểm tra không lẫn GPS queue với execution queue (T11). |
| M3.7 Incident | Quyền/assignment và scope, trạng thái chỉ xem, retry cùng idempotency, form offline giữ đúng policy. |
| M3.9.2 Mapbox | Một viewport, gesture không bị cuộn trang giành; test recenter, marker, external target, thiếu GPS/tiles và Back. |
| M4.1.2B Home | Tên dài, một/nhiều/không có Trip, cache theo phiên, scope GPS/queue, filter lịch sử và Account logout guard. Không sinh request/mutation mới chỉ vì đổi layout. |
| Customer Tracking và role | Protected routes, Customer không mở Driver, Driver không thấy chuyến ngoài quyền. Luồng Driver cập nhật điểm và Customer đúng chủ theo journey đã có, không ghép ID GPS sang Trip khác (T20). |

## 10. Checklist nghiệm thu

Kết quả của thiết kế mới **NOT RUN** cho đến khi có UI. Dùng thiết bị Android với development APK có Mapbox và QA local/test. Chọn một fixture riêng khi có ghi, giữ các chuyến M4.0/M4.1.1 làm bằng chứng chỉ đọc. Mỗi ca ghi ảnh hoặc clip cùng cỡ chữ, trạng thái Trip và màn hình; đánh dấu PASS/FAIL/NOT RUN theo bằng chứng.

| ID | Điều kiện PASS |
|---|---|
| C0-01 · Phân cấp | Chín màn theo thứ tự nội dung, chỉ một primary cho mỗi ngữ cảnh, Overview có CTA cạnh điểm và không lặp card điều hướng hay task list. |
| C0-02 · Home/List/Account | Tên không chồng chữ, mã dài vẫn nhận diện và mở đúng Trip, filter/pagination/refresh, deep link và logout guard hoạt động. |
| C0-03 · Stop | Một input số thực tế theo task, lỗi có thể tìm và sửa, IME không che trường hoặc CTA, Back giữ nháp theo lựa chọn, depot đúng flow. |
| C0-04 · Offline/Sync/GPS | Queue biệt lập theo Trip/account, hiểu được trạng thái và lệnh chặn, retry giữ thứ tự. Đi qua các route, tắt màn và mở lại mà GPS vẫn xử lý theo lifecycle. |
| C0-05 · POD/Incident | Upload local/chưa xác nhận khác active, guard Complete chỉ mở khi đủ, ảnh xem/thay và chữ ký đúng quyền. Incident đọc/tạo/retry đúng scope. |
| C0-06 · Map/Android | Không xung đột pinch/pan với scroll; recenter và CTA ngoài app sử dụng được. Kiểm tra 3 nút/gesture, safe area, cỡ chữ lớn/TalkBack và vùng chạm. |
| C0-07 · Regression quyền | Driver/Customer restore, role, Back và deep link. Customer Tracking giữ dữ liệu cùng Trip và chỉ hiện cho chủ đơn. |
| C0-08 · Kiểm thử và bằng chứng | Lát cắt thực thi chạy Jest mục tiêu/full, TypeScript, ESLint và Android export theo phạm vi. Manual ghi riêng, có ảnh trước/sau cho chín màn. |

## 11. Trạng thái triển khai C.1

- `driver-theme.ts` kế thừa màu và spacing từ theme hiện có, bổ sung palette trạng thái Driver, typography 24/32–18/24–16/22–14/20, radius 16/12 và vùng chạm 48 dp. C.1 dùng biến thể gọn của `DriverTripHeader` và `DriverTripStatusBadge` trên Home, Trip List và Account. Kiểu mặc định của các màn Driver khác tiếp tục được dùng. Button, ScreenMessage và ActivityIndicator tiếp tục dùng component hiện có.
- Trip List trước đây dùng card có viền, hiển thị lặp giờ bắt đầu thực tế và vai trò/trạng thái phân công. Bố cục mới ưu tiên mã/trạng thái → giờ kế hoạch → biển số, loại xe và số điểm. Assignment chỉ xem được ghi khi có ý nghĩa. Card vẫn bấm toàn vùng, mã trợ năng đầy đủ và điều hướng bằng Trip ID.
- Header List có Back và Tài khoản. Đăng xuất thực hiện tại Account với guard hàng đợi hiện có. Home và Account thống nhất typography và bố cục, giữ xử lý chuyến, GPS, queue và session.
- List tách first loading, refreshing, lỗi API, rỗng theo filter và lỗi tải tiếp. Retry trang sau không xóa trang đang có. Snapshot chỉ giữ trong màn của filter hiện tại, có nhãn dữ liệu có thể cũ khi mất mạng. Việc đổi filter khởi tạo lượt đọc riêng. Deep link, phân trang theo server và các trạng thái Driver được giữ.
- C.2 giữ Overview và Stop; C.3 dành cho Incident, Sync và e-POD; C.4 dành cho Map và Android QA tổng hợp. [Checklist Android C.1](../04-testing/test-cases.md#m412c1--driver-design-foundation--trip-list-ui-polish)

## 12. Trạng thái triển khai C.2

- Overview dùng header/badge Driver từ C.1. Một khối chứa tóm tắt mã chuyến, trạng thái, xe, tiến độ server, điểm cần xử lý và CTA. Bản đồ, Sự cố, Đồng bộ dùng lối tắt gọn; GPS và lịch/danh sách stop mở theo yêu cầu. Điều hướng ngoài nằm cạnh đúng điểm đích và dùng cùng handler. e-POD mở qua CTA khi thiếu bằng chứng hoặc qua chi tiết điểm giao.
- Stop dùng header theo loại điểm. Mỗi kiện chỉ xuất hiện một lần trong chế độ đang nhập, gồm dữ liệu đối chiếu, kế hoạch và thực tế. Form vẫn suy kết quả giao từ số lượng và dùng cùng dữ liệu người nhận/lý do/ghi chú. Lỗi do validator trả được trình bày gần trường tương ứng, lỗi không gắn được trường dùng thông báo chung. Màn cuộn đến lỗi đã bố trí và giữ nút đến/hoàn thành trong thanh dưới, ngoài vùng cuộn. Giữ draft và Android Back guard hiện có.
- Tiến độ X/Y vẫn dùng điểm COMPLETED hoặc SKIPPED do server xác nhận. Số hoàn thành trên thiết bị chờ gửi hiển thị riêng; queue và GPS vẫn dùng workspace của chuyến. Bộ xử lý queue, validator, selector và POD readiness độc lập giữ nguyên.

| Ngữ cảnh | CTA hiển thị |
|---|---|
| DISPATCHED, PRIMARY/ASSIGNED online | Bắt đầu chuyến. Mất mạng có lý do khóa theo selector. |
| IN_PROGRESS có điểm hành động | Mở điểm hiện tại. Tại Stop, chỉ hiện Đã đến hoặc Xác nhận nếu selector cho phép. |
| Pending khi hết điểm hoặc conflict/failed | Xem đồng bộ khi selector yêu cầu. Progress local tiếp tục có nhãn riêng. |
| Thiếu PHOTO bắt buộc hoặc trạng thái e-POD chưa rõ | Bổ sung bằng chứng khi có attempt, hoặc hiển thị lý do chưa đủ. Khi chưa rõ có đường kiểm tra lại. |
| e-POD đủ, tiến độ/queue hợp lệ, online, Trip đã làm mới | Hoàn thành chuyến. Backend vẫn thực thi `POD_REQUIRED`. |
| RELIEF hoặc assignment chỉ xem, COMPLETED/CANCELLED | Xem điểm dừng hoặc mở timeline. Không hiện CTA thực thi. |

C.3 giữ thiết kế bên trong Incident/Sync/e-POD. C.4 giữ layout Map và Android QA tổng hợp. [Checklist Android C.2](../04-testing/test-cases.md#m412c2--driver-trip-overview--stop-execution-ui-polish)
