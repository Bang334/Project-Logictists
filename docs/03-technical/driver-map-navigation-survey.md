# M3.9.0 — Driver Map Navigation Survey & Contract Design

Trạng thái: **M3.9.1 IMPLEMENTED — automated PASS, Android manual NOT RUN**\
Ngày khảo sát: 2026-11-19

## 1. Kết luận và phạm vi MVP đề xuất

Đề xuất chia M3.9 thành hai lớp độc lập:

1. **M3.9.1 — External Navigation MVP:** thêm action `Điều hướng` tại Stop hiện tại/tiếp theo, mở Google Maps bằng universal HTTPS URL và tọa độ authoritative của `TripStop`. Không thêm package, token, API Backend hoặc native configuration.
2. **M3.9.2 — Embedded Driver Map:** chỉ triển khai sau một native compatibility spike và khi nhóm xác nhận giá trị demo đủ lớn. Nếu triển khai, dùng Mapbox theo stack đã chốt; không dùng embedded Google Maps để thay provider.

MVP không tạo routing engine, dynamic ETA, traffic routing, turn-by-turn nội bộ, geofence, auto ARRIVE/COMPLETE, reorder Stop, Customer map hoặc thay đổi Optimizer.

## 2. Hiện trạng dependency và native configuration

| Thành phần | Hiện trạng đã kiểm chứng | Tác động |
|---|---|---|
| Expo | `~58.0.26`, React Native `0.88.1` | Phải dùng tài liệu Expo SDK 58 |
| `expo-location` | `~58.0.22`, đã cấu hình foreground/background Android | Tái sử dụng M3.6C; không xin thêm permission |
| `expo-linking` | `~58.0.17` | Đủ mở universal navigation URL |
| `react-native-maps` | Chưa cài | SDK 58 hỗ trợ và Expo Go có sẵn native module, nhưng production Google Maps cần cấu hình riêng; không phù hợp provider Mapbox đã chốt |
| `@rnmapbox/maps` | Chưa cài | Cần config plugin và development/native build; không chạy trong Expo Go |
| Native folders | Không có `mobile/android` hoặc `mobile/ios` | Project dùng CNG; không chỉnh native files bằng tay |
| EAS | Có development APK profile | Có thể rebuild nếu M3.9.2 được duyệt |
| Map config plugin | Chưa có | M3.9.2 sẽ phải sửa app config và rebuild |

M3.9.0 không cài package và không sửa native configuration.

## 3. Mapbox infrastructure hiện có

- Backend có `MapboxService`, dùng `MAPBOX_ACCESS_TOKEN` cho geocoding, Directions và Matrix.
- Web dùng `mapbox-gl` và biến client `VITE_MAPBOX_TOKEN` để hiển thị marker/route.
- Optimizer nhận road matrix và có thể trả `route_geometry`; Optimizer vẫn là nguồn quyết định planning/sequence.
- Prisma `Trip` có `routeGeometry`, Web Admin có consumer, nhưng Driver Trip Detail cố ý không trả field này. Mobile parser/test cũng loại bỏ field ngoài allowlist.
- Mobile `.env.example` hiện chỉ khai báo `EXPO_PUBLIC_API_URL`; chưa có Mapbox token.

Không tái sử dụng mù quáng token Backend hoặc Web. Nếu M3.9.2 được duyệt, tạo public mobile token riêng với quyền đọc tối thiểu cần cho map style. Token public có thể nằm trong client bundle theo thiết kế provider; token secret/server hoặc token có secret scopes tuyệt đối không đưa vào Mobile/Git/log.

## 4. Contract dữ liệu TripStop

`GET /driver/trips/:id` hiện đã trả trực tiếp, theo ownership Driver:

- `id`, `sequence`, `stopType`, `status`;
- `address`, `latitude`, `longitude`;
- `plannedArrivalTime`, `plannedDepartureTime`;
- actual arrival/departure;
- tasks/orders thuộc chính Trip.

`TripStop.latitude` và `TripStop.longitude` là non-null trong Prisma. Driver API lấy trực tiếp snapshot trên `TripStop`, không cần geocode địa chỉ. Mobile phải kiểm tra runtime: latitude/longitude hữu hạn và nằm trong `[-90, 90]`/`[-180, 180]` trước khi render hoặc mở navigation.

Map không được đọc Stop/Order ngoài contract Driver Trip hiện có. Không cần API Backend mới cho M3.9.1.

## 5. Nguồn vị trí Driver và chiến lược tái sử dụng

M3.6C đã có một pipeline authoritative trên thiết bị:

`Expo Location watcher/background task → DriverGpsEngine → SQLite GPS queue → Backend ingest`.

Hiện `DriverTrackingSnapshot` mới có mode, pending count và thời điểm sync; chưa expose điểm GPS cục bộ mới nhất. M3.9.2 nên mở rộng storage/service hiện hữu để snapshot có `latestLocalLocation`, đọc từ chính SQLite GPS queue. Không tạo `watchPositionAsync` thứ hai, không xin quyền lần hai và không poll Backend để biết vị trí của chính thiết bị.

- `IN_PROGRESS`: dùng latest local point của active M3.6C session.
- `DISPATCHED`: không tự khởi động tracking hoặc xin permission chỉ để xem trước map; có thể không có vehicle marker.
- `COMPLETED`/`CANCELLED`: không chạy live location cho map.
- Không dùng `Vehicle.currentLatitude/currentLongitude` làm vị trí của Driver trên chính điện thoại.

**PROPOSED:** local point cũ hơn 2 phút được đánh dấu stale, thống nhất wording/policy hiện có của M3.6B/M3.6D. Stale không chặn external navigation.

## 6. Stop ordering và marker convention

- Sắp xếp bằng `sequence`, thứ tự phụ `id`; không reorder theo khoảng cách, nearest Stop hoặc map route.
- Đánh số **mọi TripStop** theo `sequence`, gồm `DEPOT_START`, `PICKUP`, `DELIVERY`, `DEPOT_END`, để khớp API và Trip Detail.
- Marker phải có số + icon/nhãn chữ, không chỉ phân biệt bằng màu.
- Loại marker: `DEPOT_START`, `PICKUP`, `DELIVERY`, `DEPOT_END`.
- Presentation state: `COMPLETED`, `CURRENT`, `UPCOMING`, `PENDING_SYNC`, `CONFLICT_OR_FAILED`, `SKIPPED`.

Không vẽ straight-line polyline giữa Stop vì dễ bị hiểu nhầm là đường lái thực tế. Không gọi Directions mới trong Mobile. Route geometry chỉ được thêm sau khi có contract authoritative được nhóm duyệt.

## 7. Next actionable Stop và M3.8 overlay

Selector map phải tái sử dụng quy tắc từ `driver-offline/selectors/offline-driver-overlay.ts`, không chép state machine sang Screen.

| Trạng thái | Cách trình bày |
|---|---|
| Server `ARRIVED`, chưa complete | Stop đó là current actionable |
| Server `COMPLETED`/`SKIPPED` | Bỏ qua khi tìm current/next |
| `ARRIVED_PENDING_SYNC` | Stop đó vẫn là current, nhãn chờ đồng bộ |
| `COMPLETED_PENDING_SYNC` | Có thể chỉ ra Stop sau là bước tiếp theo trên thiết bị để giữ offline flow, nhưng không gọi là server-confirmed; predecessor vẫn mang nhãn chờ đồng bộ |
| `CONFLICT`/`FAILED`/`BLOCKED` | Highlight Stop gây chặn; không quảng bá Stop sau là actionable |

Đề xuất selector trả cả `stop` và `basis: SERVER | LOCAL_PENDING`, thay vì chỉ trả Stop. Điều này ngăn UI biến local overlay thành dữ liệu authoritative.

Map không enqueue command, không auto ARRIVE theo GPS và không làm thay đổi Trip/Stop state.

## 8. External navigation contract

Input nội bộ đề xuất:

```ts
interface ExternalNavigationTarget {
  latitude: number;
  longitude: number;
  label: string;
}
```

Quy tắc:

1. Validate finite/range coordinates.
2. Tạo universal URL:
   `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>&travelmode=driving&dir_action=navigate`.
3. Dùng Linking mở HTTPS URL; không hardcode Android package.
4. Google Maps app được dùng nếu có; nếu không, URL có thể mở browser.
5. Bắt lỗi và hiển thị: `Không thể mở ứng dụng bản đồ. Vui lòng thử lại.`
6. Không cần Google API key, Mapbox token hoặc Backend call.
7. Ưu tiên tọa độ; thiếu/sai tọa độ thì disable action và hiển thị `Điểm dừng chưa có tọa độ hợp lệ`. Không geocode ngầm.

Action chỉ xuất hiện trên current/next Stop phù hợp, nhãn `Điều hướng`. Địa chỉ vẫn hiển thị để Driver đối chiếu. Không log URL/location.

## 9. So sánh phương án embedded map

| Phương án | Ưu điểm | Chi phí/rủi ro | Kết luận |
|---|---|---|---|
| `react-native-maps` | SDK 58 hỗ trợ; thử trong Expo Go; marker/polyline đơn giản | Embedded Android dùng Google Maps, production cần API configuration và lệch provider Mapbox đã chốt | Không chọn cho embedded MVP |
| `@rnmapbox/maps` | Đồng bộ hệ sinh thái Mapbox; marker/camera/location puck; config plugin | Native module, không chạy Expo Go, cần development APK mới, public runtime token và compatibility spike với Expo 58/RN 0.88 | Chỉ M3.9.2 nếu được duyệt |
| Không embedded map | Không native/token/build risk; external navigation đem lại giá trị vận hành chính | Không có overview trực quan trong Smart TMS | **Khuyến nghị M3.9.1** |

Mapbox RN là package cộng đồng, không phải module Expo bundled. Trước M3.9.2 phải thử cài bằng `npx expo install`, chạy Expo Doctor, native development build và Android smoke test; không kết luận tương thích chỉ từ peer dependency.

## 10. Tích hợp UI và Trip state

### M3.9.1

Đặt nút `Điều hướng` trên Stop current/next ngay trong Trip Detail; không tạo map screen.

### M3.9.2 nếu được duyệt

Tạo screen riêng `/trips/:id/map` và nút `Bản đồ` từ Trip Detail. Không nhúng map nặng vào ScrollView execution để tránh rerender, gesture conflict và ảnh hưởng ký e-POD.

| Trip status | Hành vi |
|---|---|
| `DISPATCHED` | Xem trước Stop; cho external navigation đến Stop đầu tiên nhưng không start tracking/execution |
| `IN_PROGRESS` | Map/navigation đầy đủ tới current/next operational Stop |
| `COMPLETED` | Read-only; không live tracking, disable action `Điều hướng` để tránh hiểu là Trip còn chạy |
| `CANCELLED` | Read-only; disable navigation |

Camera proposal cho embedded map:

- Có current location + next Stop: fit hai điểm khi mở.
- Không có location: center next Stop.
- Không còn next Stop: fit tất cả Stop.
- Không auto recenter sau mỗi GPS point; có nút `Vị trí của tôi` khi location hợp lệ.

## 11. Offline, no-GPS và failure behavior

- Permission denied/GPS off: vẫn hiển thị Stop map nếu map SDK/tile khả dụng; ẩn/disable `Vị trí của tôi`; external navigation vẫn được phép vì đích có tọa độ.
- Location stale: hiển thị `Vị trí có thể đã cũ`; không chặn navigation.
- Không có location: hiển thị `Chưa xác định được vị trí hiện tại`; vẫn render Stop.
- Mất mạng: không cam kết map tile hoặc external app có route; không implement offline tile download.
- Embedded map load lỗi phải degrade về Stop list + external navigation, không unmount execution/POD/GPS/offline queue.
- Trip Detail hiện chỉ giữ snapshot trong React state, chưa persist toàn bộ Trip/Stop để reload offline. Vì vậy sau cold restart khi không có mạng, không thể cam kết map/Stop data tồn tại. Đây là giới hạn hiện hữu cần tách khỏi map; không được tuyên bố offline map đầy đủ.

## 12. Kiến trúc Mobile đề xuất

```text
src/features/driver-navigation/
  components/
    DriverNavigationAction.tsx
    DriverNavigationPanel.tsx
    DriverTripMap.tsx              # chỉ M3.9.2
    DriverStopMarker.tsx           # chỉ M3.9.2
  hooks/
    useDriverMapLocation.ts        # adapter từ tracking snapshot, không watcher mới
  selectors/
    driver-map-stop-state.ts
  services/
    external-navigation.service.ts
  types/
    driver-navigation.types.ts
  validation/
    navigation-coordinate.validation.ts

src/app/(driver)/trips/[id]/map.tsx # chỉ M3.9.2
```

Screen chỉ render và điều hướng. URL/validation nằm trong service; stop state nằm trong selector; location đi qua M3.6C service/snapshot hiện hữu.

## 13. Native build impact

M3.9.1 không cần dependency, config plugin, token hoặc rebuild vì `expo-linking` đã có. Có thể test Expo Go và development APK hiện tại.

M3.9.2 cần tối thiểu:

- thêm `@rnmapbox/maps` bằng Expo-compatible install;
- thêm config plugin vào app config;
- thêm public runtime Mapbox token qua cấu hình môi trường phù hợp;
- rebuild development APK/EAS vì Expo Go không chứa native module;
- Expo Doctor, Android bundle/build và Android device smoke test;
- kiểm tra riêng tương thích Expo SDK 58/RN 0.88 trước khi viết UI hoàn chỉnh.

Không đưa secret token vào `app.json`, `EXPO_PUBLIC_*`, APK hoặc Git. Nếu toolchain yêu cầu build credential secret, lưu bằng EAS/local secret mechanism; không ghi literal vào repo.

## 14. Automated test plan

### Unit

- finite/range coordinate validation;
- universal Google Maps URL encoding;
- missing coordinate và Linking failure;
- sequence ordering/marker numbering;
- current/next selector cho PENDING, ARRIVED, COMPLETED, SKIPPED;
- overlay ARRIVE/COMPLETE pending;
- conflict/failed/blocked không promote Stop sau;
- Trip state policy;
- stale local location theo `measuredAt`.

### Component

- navigation action visible/disabled theo Trip/Stop state;
- no GPS, stale GPS và permission denied wording;
- completed/upcoming/current marker có icon/text, không chỉ màu;
- embedded map loading/error fallback không làm mất execution panel;
- không tạo location watcher thứ hai.

### Regression

- Driver Trip Detail/execution/POD/Incident/offline queue;
- M3.6C background GPS lifecycle;
- TypeScript, ESLint, Jest, Expo Doctor và Android export/build phù hợp milestone.

## 15. Android manual QA checklist

- `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.
- External Google Maps app có/không có; browser fallback; Linking failure.
- Coordinate hợp lệ/không hợp lệ.
- Permission granted/denied và GPS service on/off.
- Fresh/stale/no local GPS.
- Mất mạng trước/sau khi mở external map.
- ARRIVE pending, COMPLETE pending và conflict queue.
- Marker sequence/type/state và accessibility label nếu có embedded map.
- Map mount/unmount không tăng watcher/background session, không tăng GPS event bất thường và không tái hiện SQLite lock.
- Execution, e-POD signature gesture, Incident và Complete Trip không regression.

## 16. Milestone split

| Milestone | Phạm vi | Điều kiện nghiệm thu |
|---|---|---|
| M3.9.0 | Survey + contract | Tài liệu được duyệt |
| M3.9.1 | External navigation | URL/validation/state tests PASS; Android mở app/browser đúng; không dependency/native change |
| M3.9.2 | Embedded Mapbox, tùy chọn | Compatibility spike PASS; marker/location/fallback hoạt động trên development APK |
| M3.9.3 | Android regression QA | Permission/GPS/offline/overlay + M3.6/M3.8 regression PASS |

Nếu M3.9.2 không đem lại đủ giá trị demo so với native/token/build risk, dừng sau M3.9.1 và chuyển M4 End-to-End/Release Readiness.

## 17. Ranh giới và quyết định cần duyệt

| Mã | Quyết định PROPOSED |
|---|---|
| MAP-01 | Duyệt M3.9.1 external navigation trước, không dependency mới |
| MAP-02 | Embedded map không bắt buộc cho MVP; chỉ làm M3.9.2 sau compatibility spike |
| MAP-03 | Nếu embedded, dùng `@rnmapbox/maps`, không dùng `react-native-maps` để đổi provider |
| MAP-04 | Local GPS stale threshold là 2 phút |
| MAP-05 | Không hiển thị route polyline trong MVP vì Driver API không có authoritative geometry |
| MAP-06 | `COMPLETED`/`CANCELLED` read-only và disable navigation action |
| MAP-07 | Cold-start offline Trip snapshot/persistence nằm ngoài M3.9; cần milestone hardening riêng nếu bắt buộc |

M2.3 Confirm Order vẫn là blocker của full Customer → Optimizer → Driver E2E và không thuộc M3.9.

## 18. Nguồn kỹ thuật đã đối chiếu

- Expo SDK 58 `react-native-maps`: <https://docs.expo.dev/versions/v58.0.0/sdk/map-view/>
- Expo SDK 58 Location: <https://docs.expo.dev/versions/v58.0.0/sdk/location/>
- Expo SDK 58 Linking: <https://docs.expo.dev/versions/v58.0.0/sdk/linking/>
- RN Mapbox Expo installation: <https://rnmapbox.github.io/docs/install>
- Google Maps universal URLs: <https://developers.google.com/maps/documentation/urls/get-started>
- Mapbox token policy: <https://docs.mapbox.com/help/getting-started/access-tokens/>

## 19. M3.9.1 implementation result

- Đã tạo feature `mobile/src/features/driver-navigation` gồm types, external navigation service, Stop selector và navigation panel.
- Universal Google Maps URL chỉ chứa destination coordinate, `travelmode=driving` và `dir_action=navigate`; không API key, Mapbox token hoặc address label.
- Coordinate validation strict, không coercion; Linking failure được chuẩn hóa thành thông báo thân thiện và double tap được khóa trong lúc đang mở app ngoài.
- Selector tái sử dụng M3.8 overlay: ARRIVE pending giữ current Stop, COMPLETE pending trình bày next local với nhãn chưa đồng bộ, conflict/failed/blocked disable navigation.
- `COMPLETED` và `CANCELLED` không render active navigation; offline/network/GPS state không chặn destination-coordinate navigation.
- Không thêm dependency, native config, watcher, Backend API, schema/migration hoặc embedded map.
- Automated: M3.9.1 target **49/49 PASS**; full Mobile **280/280 PASS**; TypeScript, ESLint, Expo dependency check, Expo Doctor 20/20 và Android export **PASS**.
- Android manual QA: **NOT RUN**. M3.9.3 vẫn cần thực hiện trên thiết bị thật.

## M3.9.2 — Embedded Driver Mapbox (IMPLEMENTED)

- Compatibility đã xác minh với Expo SDK 58, React Native 0.88.1 và `@rnmapbox/maps` 10.3.18; cấu hình bằng Expo config plugin/CNG, không tạo thủ công thư mục native.
- Token public chỉ đọc từ `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN`; `.env.example` chứa placeholder, token thật không nằm trong source/Git.
- Map là screen riêng từ Trip Detail. Marker dùng tọa độ Stop hợp lệ, đúng `sequence`, phân biệt loại bằng K/L/G và phân biệt state bằng cả nhãn/accessibility lẫn màu.
- Vị trí Driver đọc từ `DriverTrackingSnapshot.latestLocalLocation`, do watcher/background task M3.6C hiện hữu cập nhật. Không tạo watcher, queue hoặc Backend request thứ hai.
- M3.8 overlay quyết định `PENDING_SYNC`/`CONFLICT`; M3.9.1 tiếp tục cung cấp card current/next và Google Maps external navigation.
- Chỉ markers và fit bounds; không polyline, Directions, traffic, dynamic ETA hoặc offline tile pack.
- Automated Mobile **285/285 PASS**, TypeScript/ESLint/dependency check/Doctor 20/20/Android export PASS. Android manual M3.9.3: **NOT RUN**.
