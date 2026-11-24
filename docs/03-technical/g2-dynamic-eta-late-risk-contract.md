# G2.1 — Contract ETA động và nguy cơ giao trễ

Ngày 22/11/2026 · **PROPOSED — chờ nhóm duyệt.** Các API, ngưỡng và mô hình mới dưới đây là thiết kế. Phạm vi đối chiếu gồm Customer Tracking, GPS, thực thi chuyến, planner và Web Dashboard.

## 1. Hiện trạng đã kiểm chứng

| Khu vực | Hành vi hiện tại |
| --- | --- |
| G0, G1 và G3 | G0 ghi nhận ETA động và cảnh báo trễ là khoảng trống. G1/M2.3 Backend đã GO cho xác nhận Customer DRAFT và eligibility planner, chưa có nghiệp vụ cam kết hạn giao. G3.2 chứng minh GPS có thể gửi ở nền khi có callback nhưng realtime vẫn NO-GO. Mốc flush 45 giây chỉ được xét khi callback chạy. Realme có batch chờ trước `onStartJob`. [G0](graduation-requirements-coverage-audit.md) · [G1](g1-customer-order-confirmation-contract.md) · [Đối chứng GPS](../04-testing/g31-android-emulator-api33-gps-qa.md) |
| Customer Tracking | `GET /customer/orders/:id/tracking` yêu cầu CUSTOMER và ownership. Dùng quan hệ qua StopTask để trả các Trip. Mỗi Trip lấy planned arrival của stop `UNLOAD` cuối cùng của chính Order theo sequence. `etaSource` luôn là `PLANNED`. Latest GPS theo Trip. `isStale` tính theo `measuredAt` với ngưỡng lớn hơn 2 phút. Mobile kiểm tra cứng `etaSource === 'PLANNED'` và poll 30 giây khi màn theo dõi hoạt động theo hook hiện hữu. [Service](../../backend/src/orders/customer-order-tracking.service.ts) · [Controller](../../backend/src/orders/customer-orders.controller.ts) · [Mobile parser](../../mobile/src/features/orders/services/orders.service.ts) · [Polling](../../mobile/src/features/orders/hooks/useCustomerOrderTracking.ts) · [API hiện hành](api-contracts.md) |
| GPS ingest và latest | Driver gửi `POST /driver/trips/:tripId/gps` theo quyền PRIMARY/ASSIGNED và policy trạng thái chuyến. Backend lưu `measuredAt` và `receivedAt`, chống trùng theo device/session/sequence. `GET /trips/:tripId/tracking/latest` dành cho ADMIN/DISPATCHER và kiểm Branch của Trip với fallback về home branch của xe. Latest sắp theo `measuredAt DESC`, rồi `receivedAt DESC` và ID. Có cửa sổ nhận backlog sau khi hoàn thành Trip. [GPS service](../../backend/src/trips/driver-gps.service.ts) · [Tracking controller](../../backend/src/trips/trip-tracking.controller.ts) |
| Planner và Mapbox | Planner truyền road matrix, mốc planning epoch và thời gian phục vụ. `buildOptimizerOrders` hiện không gửi các field time window theo Order. Python `OrderPair` có window mặc định từ 0 đến 30 ngày, tính theo giây của bài toán. `route_costing.py` tính penalty theo `ordered_at_sec + delivery_grace_days × 86400`. `getRoadMatrix` dùng `mapbox/driving`. `getRoute` trả geometry và tổng duration đã làm tròn phút. [Planner mapper](../../backend/src/trips/trips.service.ts) · [Mapbox](../../backend/src/mapbox/mapbox.service.ts) · [Optimizer model](../../optimizer/app/models.py) · [Costing](../../optimizer/app/route_costing.py) |
| Web Dashboard | Trang tải dữ liệu Branch, Vehicle, Driver, Location, Order và Trip khi mount. Map Dashboard hiển thị mạng kho/chi nhánh và bảng chuyến hiện có. Chưa thấy projection ETA/risk hoặc polling cảnh báo tại trang này. [Dashboard](../../frontend/src/pages/DashboardPage.tsx) · [Map markers](../../frontend/src/utils/dashboardMap.ts) |

## 2. Dữ liệu có sẵn và khoảng trống

| Dữ liệu | Dùng cho G2 |
| --- | --- |
| `Trip` | `status`, `version`, planned/actual start/end, vehicle và branch. `routeGeometry` tùy chọn. `planningSnapshot` của luồng apply lưu version tài nguyên. Optimization Job có snapshot input/matrix nhưng chưa có contract ánh xạ leg ổn định cho mọi Trip, đặc biệt chuyến tạo tay hoặc sửa tuyến. |
| `TripStop` | `sequence`, tọa độ, planned/actual arrival/departure và trạng thái. Apply chuyển giây của solver sang thời điểm tuyệt đối từ planning epoch. Schema không lưu riêng travel, service hay wait của mỗi leg trên TripStop. Tổng thời lượng và polyline không đủ suy ra thời gian từng leg. |
| `StopTask` và `Package` | LOAD/UNLOAD, `orderId`, `packageId`, planned/actual quantity. `orderStopId` nullable. Nối theo đúng Order, Trip và tập kiện đã xác minh. Khi thiếu mapping hoặc lịch của phần hàng còn lại, độ bao phủ là không đầy đủ. |
| `ExecutionEvent`, `DeliveryAttempt` và `OrderEvent` | ARRIVE_STOP ghi `actualArrivalTime` từ thời điểm thao tác được Backend kiểm tra. COMPLETE_STOP ghi `actualDepartureTime`, actual quantities và DeliveryAttempt cho stop DELIVERY. Attempt có kết quả ở cấp stop. `DELIVERY_COMPLETED` cũng có thể là PARTIAL. Order chuyển COMPLETED theo trạng thái các Package đang hoạt động. Dùng dữ liệu này để đối chiếu phần hàng đã giao và mốc giao đủ. |
| `GpsEvent` | Tọa độ, accuracy có thể null, thời điểm đo và nhận. Dùng GPS của đúng Trip. Áp dụng thêm thứ tự theo thời điểm đo và kiểm tra tuổi GPS tại lúc đọc. GPS nhận muộn sau completion có thể phục vụ đối chiếu lịch sử. |
| Delivery commitment | `OrderStop` có `serviceDurationMinutes` nhưng chưa có deadline giao vận tải. Các trường promised collection của nghiệp vụ điểm nhận hàng, penalty, ETA kế hoạch, thời hạn Trip và window mặc định của solver thuộc phạm vi khác. |

Các trường và cách ghi mốc được đối chiếu từ [Prisma schema](../../backend/prisma/schema.prisma) · [Execution service](../../backend/src/trips/driver-trip-execution.service.ts) · [Execution constants](../../backend/src/trips/driver-trip-execution.constants.ts) · [Planner persistence](../../backend/src/trips/trips.service.ts).

## 3. Semantics và mô hình ETA

| Mốc | Định nghĩa |
| --- | --- |
| Planned ETA | `TripStop.plannedArrivalTime` của phiên bản kế hoạch hiện hành. Dùng làm baseline và fallback có nhãn kế hoạch. |
| Predicted arrival ETA | Thời điểm dự đoán tới stop trong Trip đang chạy. Tính từ dữ liệu và thời gian phía server, có nguồn, thời điểm tính và hạn sử dụng. |
| Predicted completion | Thời điểm dự đoán hoàn tất giao phần hàng tại stop, gồm phần phục vụ còn lại. Đây là mốc dùng so với deadline giao đủ theo đề xuất. |
| Actual arrival | `TripStop.actualArrivalTime` đã được Backend xác nhận. Khi arrival đã có, hiển thị actual cho mốc đến và vẫn có thể dự đoán mốc hoàn tất. |
| Actual delivered | Mốc thao tác giao đủ đã được Backend xác nhận. Dùng event Order hoàn tất từ thực thi, đối chiếu DeliveryAttempt, command và tập kiện đã giao. Nếu thiếu bằng chứng, actual delivery là null. |
| GPS đo/nhận | `measuredAt` xác định độ tuổi. `receivedAt` cho biết lúc server nhận và giúp đo độ trễ. Mẫu nhận muộn không được ưu tiên chỉ vì vừa đến. |

### So sánh phương án MVP

| Phương án | Ưu điểm | Giới hạn |
| --- | --- | --- |
| A. Dịch lịch theo tiến độ đã xác nhận | Lấy độ lệch actual so với planned ở stop gần nhất, lan sang các stop còn lại. Nhanh, ít phụ thuộc provider và dùng được làm đối chứng MAE. | Bỏ qua vị trí xe đang đi, sai khi giữ nguyên độ trễ cho các chặng khác nhau. Không dùng làm prediction công khai trong MVP. |
| B. GPS và thời gian đường bộ trên tuyến hiện hành | Dùng road duration từ GPS đến stop tiếp theo, sau đó thêm thời gian đường bộ và phục vụ cho các stop theo sequence. Phản ánh tiến độ thực, giải thích được và không cần huấn luyện ML. | Phụ thuộc GPS và Matrix đủ tin cậy. Cần cache leg, giới hạn số lần gọi, xử lý tuyến không tìm được và chất lượng GPS. |

**Chọn B**, với A làm comparator khi đánh giá. Cả hai dùng thứ tự chuyến đã được điều phối. MVP dùng road duration của `mapbox/driving` theo contract hiện hành. Traffic trực tiếp, suy tốc độ từ vài fix, ML và tối ưu lại tuyến để sau.

### Thuật toán đề xuất

1. Chỉ dự đoán với Trip `IN_PROGRESS` và tiến độ hợp lệ. `PLANNED` / `DISPATCHED` trả planned nếu có. `DRAFT` theo projection hiện hữu và chưa dự đoán. `COMPLETED` / `CANCELLED` dừng dự đoán mới, ưu tiên mốc actual có bằng chứng.
2. Đọc latest GPS theo Trip, giới hạn trong vòng đời chuyến và loại timestamp/accuracy bất thường. Ngưỡng ban đầu cần duyệt là `0 <= now - measuredAt <= 120s`, accuracy hữu hạn từ trên 0 đến 100 m. GPS null, quá hạn, timestamp tương lai hoặc quality thiếu đều không dùng làm điểm xuất phát. Ingest chấp nhận một số timestamp tương lai trong dung sai, projection áp dụng kiểm tra chặt hơn. Giữ timestamp mẫu và lý do quality. Nếu newest không hợp lệ, trả unavailable ở MVP để tránh nhặt lại điểm cũ mà người dùng hiểu nhầm là vị trí mới.
3. Xác định stop đầu tiên chưa xử lý theo sequence. Bỏ các stop COMPLETED hoặc SKIPPED khi tính chặng, đồng thời ghi khoảng trống bao phủ nếu stop bỏ qua mang phần hàng phải giao. Nếu đã ARRIVED và actual arrival hợp lệ, neo vào stop đã xác nhận, dùng phần phục vụ còn lại và bỏ road duration đến chính stop đó. Nhánh này có thể tính với GPS stale/không có nếu actual arrival đủ mới và thời lượng phục vụ hợp lệ. Đề xuất cho phép trong 120 giây sau arrival, sau đó chờ dữ liệu mới hoặc trả unavailable. Nếu đã quá thời lượng phục vụ dự kiến mà stop vẫn mở, trả confidence thấp hoặc unavailable theo policy được duyệt. MVP đề xuất unavailable để tránh đoán giờ rời stop.
4. Với xe đang di chuyển, dùng `now + roadDuration(latestFix, nextStop)`. Lấy now của Backend để không cho dự đoán về quá khứ. Hạ confidence theo tuổi GPS. Road duration giữa các stop lấy từ matrix theo đúng hướng của cặp stop và cache theo route revision hoặc fingerprint thứ tự/tọa độ. Chỉ dùng leg từ snapshot lịch sử khi đã kiểm được ánh xạ, đơn vị và độ hiệu lực. Tính lần lượt `arrival[i] = depart[i-1] + travel[i-1,i]`, `departure[i] = arrival[i] + wait[i] + service[i]`. Lấy service từ breakdown đã ánh xạ nếu có, tiếp theo là khoảng planned departure trừ planned arrival làm proxy chỉ khi biết khoảng đó chưa bao gồm wait đang tính riêng. Dùng `OrderStop.serviceDurationMinutes` nếu ánh xạ một-một đã xác minh. Thiếu dữ liệu cần thiết thì dừng projection tại đoạn thiếu. Wait chỉ lấy từ ràng buộc thực thi đã lưu và được duyệt. Mọi forecast kế tiếp kế thừa chất lượng thấp nhất của đầu vào liên quan.
5. Matrix trả null/unreachable, timeout, expiry hoặc sai version thì trả predicted null với lý do và giữ planned tách riêng. Không thay thế bằng khoảng cách đường chim bay. Kết quả async cần kiểm lại revision của tuyến, trạng thái, phiên bản tiến độ và GPS input trước khi publish. Tách khóa cache hình học ổn định khỏi khóa snapshot tiến độ thường xuyên đổi khi tài xế thực thi.
6. Tính trên tất cả stop của tuyến ở Backend để cộng đúng thời gian phục vụ. Projection Customer lọc theo Order và chỉ đưa các stop `UNLOAD` của Order đó. LOAD ảnh hưởng thời gian đi tiếp nhưng không hoàn thành giao. PARTIAL/FAILED đóng attempt, phần hàng thiếu chỉ có ETA mới khi xác minh còn phân công hợp lệ ở một stop/chuyến tiếp theo.
7. Với Order tách nhiều Trip, hiển thị từng Trip và từng điểm giao thuộc Order. Chỉ tính mốc giao đủ dự đoán bằng max của các mốc phần hàng đã giao và dự đoán hoàn tất phần còn lại nếu mọi kiện active đều được đối soát đúng một lần. Thiếu Trip, chưa phân công lại, thiếu mapping hoặc có part chưa có prediction thì trả aggregate null với coverage `PARTIAL` hoặc `UNKNOWN`. Trip kết thúc chỉ đóng phần projection của Trip, mốc actual giao đủ vẫn cần bằng chứng cấp Order.

## 4. Deadline và cam kết giao

Đề xuất deadline là **hạn hoàn tất giao đủ tại điểm delivery của Order**, do bên điều phối xác nhận qua luồng được nhóm duyệt. MVP Customer hiện có một pickup và một delivery. Mô hình đích giữ định danh delivery OrderStop và phiên bản commitment để xử lý replan hoặc nhiều đợt giao. Đề xuất lưu `committedDeliveryBy` dạng timestamptz, nguồn, người/thời điểm xác nhận và revision. Thời gian hiển thị theo timezone đã thống nhất, API trả UTC ISO-8601. Giờ bắt đầu window nếu bổ sung sau chỉ ảnh hưởng wait khi có binding thực thi. Deadline là cận trên, giao đúng bằng deadline được tính đúng hạn.

Contract G1 hiện không nhận deadline. Đề xuất thao tác cam kết riêng theo quyền Branch và audit thay đổi. G2.2 cần duyệt nơi lưu, lúc chốt hạn, ai được đổi, quyền hiển thị và xử lý dữ liệu cũ. Khi chưa được duyệt storage, ETA vẫn có thể thiết kế/test độc lập, còn late risk cho bản ghi thiếu deadline trả `UNKNOWN`. Fixture có thể truyền deadline cho evaluator ở lớp test. Việc mở deadline thật cần contract lưu trữ và phê duyệt schema/migration riêng nếu cần. Nếu deadline được dùng tiếp cho optimizer, owner Planner quyết định map hard/soft window và giây tương đối từ planning epoch. [Kế hoạch giao trễ](../../KE_HOACH_TMS.md) · [Contract xác nhận G1](g1-customer-order-confirmation-contract.md)

## 5. Late risk và chống cảnh báo lặp

| State | Quy tắc đề xuất |
| --- | --- |
| `ON_TRACK` | Hạn hợp lệ và forecast hoàn tất còn đủ dư địa, hoặc đã giao đủ với mốc actual đúng hạn. Dùng reason khác nhau cho forecast và actual. |
| `AT_RISK` | Chưa giao đủ, forecast hoàn tất áp sát trong 10 phút trước hạn hoặc vượt hạn. Vượt hạn theo forecast vẫn là dự đoán. |
| `LATE` | Có bằng chứng actual giao đủ sau deadline. Thời gian nhận event offline được ghi riêng và không dùng thay thời điểm giao. |
| `UNKNOWN` | Thiếu hạn, dữ liệu, mapping phần hàng hoặc forecast đủ tin cậy. Áp dụng cả chuyến chưa chạy nếu chưa có actual. |

Đề xuất tách `deadlinePassed` và reason `OVERDUE_UNCONFIRMED` cho mốc đã qua hạn nhưng chưa có actual hoàn tất. Điều phối thấy nghiệp vụ đang quá hạn theo dữ liệu hiện có. Customer chỉ thấy thông báo phù hợp độ tin cậy và không nhận nhãn “đã giao trễ” trước khi có actual. Nếu actual offline tới muộn nhưng chứng minh đã giao đúng hạn, đóng cảnh báo mở với reason và giữ audit. Cách biểu diễn quá hạn chưa xác nhận là điểm cần duyệt vì kế hoạch có nhắc cả hai nghĩa của “đã trễ”.

- **Hysteresis đề xuất.** Enter `AT_RISK` sau hai snapshot hợp lệ liên tiếp từ hai cập nhật đầu vào khác nhau, cách nhau ít nhất 30 giây và có slack tối đa 10 phút. Clear sau hai snapshot hợp lệ có slack ít nhất 15 phút. Vùng trên 10 và dưới 15 phút giữ trạng thái đã xác lập. Nếu chưa có trạng thái, slack trên 10 phút khởi tạo `ON_TRACK`, còn snapshot đầu đủ điều kiện vào risk trả `UNKNOWN` với reason `PENDING_CONFIRMATION` cho tới khi xác nhận. Khi đang `ON_TRACK` và chỉ có một mẫu vi phạm, giữ state trước đó và ghi reason chờ xác nhận. Các ngưỡng enter/clear chỉ áp dụng forecast. Actual giao đủ hoặc quan sát deadline đã qua được cập nhật ngay.
- **Expiry.** Stale, timeout hoặc mất coverage chuyển projection forecast sang `UNKNOWN` ngay. Episode cảnh báo mở chuyển sang suspended và ngừng phát lại khi input không còn hiệu lực. Giữ lịch sử và chỉ resolve khi có bằng chứng đủ hoặc đã supersede commitment.
- **Chống spam.** Đề xuất một episode đang mở cho mỗi `Order + delivery commitment revision + alert type`, upsert atomic. Dedupe theo input revision/source event và chuyển trạng thái nghiệp vụ. Chỉ ghi một lần khi mở, chuyển trạng thái đáng kể hoặc đóng. Poll, retry và redelivery của cùng input không tăng số lần đánh giá liên tiếp hay tạo thông báo. Có thể hiển thị elapsed deadline bằng bảng cảnh báo theo cùng episode. Event độ trễ/push nếu được duyệt dùng khóa ổn định và publisher có retry. MVP ưu tiên in-app Dashboard.

## 6. API đề xuất và phân quyền

### Customer Tracking theo cơ chế additive

Giữ nguyên `GET /customer/orders/:id/tracking` và các field cũ, đặc biệt `plannedDeliveryAt`, `etaSource: "PLANNED"`, `vehicleLocation` và thứ tự Trip. Mobile bản cũ bỏ qua field mới. Bản mới đọc thêm `trips[].deliveryEstimates[]` và `deliverySummary` tùy chọn cấp Order. Mỗi estimate chỉ chứa các mốc thuộc điểm giao của Order được truy vấn.

| Field mới đề xuất | Kiểu và ý nghĩa |
| --- | --- |
| `trips[].deliveryEstimates[].tripStopId` | ID stop UNLOAD khi thuộc đúng Order và đã áp dụng policy hiển thị. Gộp nhiều task cùng điểm. |
| `plannedArrivalAt`, `predictedArrivalAt`, `predictedCompletionAt`, `actualArrivalAt` | Mỗi field là UTC ISO-8601 hoặc null. `predictedArrivalAt` là null khi đã có actual arrival. |
| `source`, `freshness`, `reason` | `source` là `GPS_ROAD_MATRIX`, `ACTUAL_STOP_ROAD_MATRIX` hoặc `NONE` cho forecast. `freshness` là `FRESH`, `STALE`, `UNAVAILABLE`. `reason` là allowlist, ví dụ `NOT_STARTED`, `GPS_STALE`, `GPS_QUALITY`, `ROUTE_UNAVAILABLE`, `INCOMPLETE_COVERAGE`, `TERMINAL_TRIP` hoặc null. |
| `computedAt`, `validUntil`, `inputGpsMeasuredAt`, `inputGpsReceivedAt` | Thời điểm tính, hạn hợp lệ và mốc GPS đã dùng. Các mốc nullable. Với nhánh actual stop không dùng GPS thì hai mốc GPS null. `validUntil` là mốc sớm nhất giữa hết hạn GPS/anchor, dữ liệu route và TTL projection áp dụng. Tại hoặc sau mốc đó, predicted fields null và freshness phản ánh trạng thái mất hiệu lực. |
| `deliverySummary` | `coverage` là `COMPLETE`, `PARTIAL` hoặc `UNKNOWN`. Có `predictedDeliveredAt`, `actualDeliveredAt`, `committedDeliveryBy`, `lateRisk` và `evaluatedAt`. Các mốc có thể null. Public deadline/risk áp dụng khi cam kết đã được duyệt để hiển thị cho Customer. Nếu policy chỉ nội bộ thì public deadline null và risk `UNKNOWN`. |

API vẫn resolve Customer bằng JWT đang xác thực. Wrong owner/missing Order trả 404 theo API hiện có. Thiếu Customer profile giữ 409. Cache hoặc worker không thay thế authorization lúc đọc. Gộp theo Order trước khi tạo DTO. Không lộ GPS history, token, thiết bị/session, PII Driver, nội dung POD, Order khác hoặc các stop trung gian của Order khác. Lý do thất bại tránh nêu danh tính hay vị trí của khách khác.

### Dashboard

Đề xuất `GET /trips/delivery-risks?branchId=&state=&cursor=&limit=` cho ADMIN/DISPATCHER. ADMIN chọn Branch. DISPATCHER lấy Branch tài khoản, sai Branch hoặc null fail closed theo `resolveBranchScope`. Dùng branch quyền của Trip `managingBranchId ?? vehicle.homeBranchId`. Đề xuất kiểm thêm Branch của Order khi trả Order ID/mã đơn cho DISPATCHER. Trip ngoài scope được loại khỏi list. Drill-down ngoài scope trả lỗi theo current trip tracking. Policy cross-branch cần signoff, mặc định không đưa Order ID ngoài quyền. Row đề xuất chứa `alertId`, `orderId`, `orderNumber`, `tripId`, `tripStopId` nếu được phép, `state`, `reason`, `deadlinePassed`, hạn và các mốc forecast/actual, `evaluatedAt`, `validUntil`. Dùng cursor với khóa phụ ổn định, limit mặc định 20 và tối đa 100. [Branch scope](../../backend/src/auth/branch-scope.ts) · [Current Trip latest](../../backend/src/trips/trip-tracking.controller.ts)

## 7. Điểm tích hợp và cập nhật

- Sau commit GPS mới nhất hoặc thực thi thay đổi tiến độ, lên lịch tính projection cho Trip có liên quan. Có thể dùng dirty key/worker được duyệt hoặc scanner theo watermark ở MVP. Tính gộp theo Trip rồi fan-out theo Order. Đọc projection đã cache khi poll. Tại lúc đọc luôn kiểm expiry, trạng thái và quyền từ server. Không thực hiện HTTP Matrix trong transaction hoặc mỗi lần đọc Customer/Dashboard.
- Coalesce cập nhật của cùng Trip, đề xuất refresh tối đa một lần mỗi 30 giây khi có fix mới hoặc progress thay đổi. Tách cache đầu chặng TTL ngắn theo mẫu GPS/stop mục tiêu và cache cặp stop TTL dài hơn theo route fingerprint. Đề xuất budget request, giới hạn số cặp theo horizon, timeout, backoff và circuit break theo provider. Cắt forecast tại nơi không đủ đầu vào. Replan, cancel và stale invalidate hoặc expire snapshot. Deadline đã qua có thể đánh giá bằng clock phía Backend và cập nhật projection/read mà không đợi GPS.
- Customer tận dụng polling 30 giây hiện có. Dashboard thêm polling riêng 30 giây cho panel đang mở, backoff khi lỗi và dừng khi tab ẩn. Sau khi duyệt realtime, event hiện hữu có thể dùng như tín hiệu invalidate theo Branch. Poll tiếp tục là đường đọc nhất quán. Các lệnh G1 và workflow Driver giữ contract hiện tại. [Polling Mobile](../../mobile/src/features/orders/hooks/useCustomerOrderTracking.ts) · [Dashboard](../../frontend/src/pages/DashboardPage.tsx) · [GPS ingest](../../backend/src/trips/driver-gps.service.ts)

## 8. Ownership đề xuất

| Phạm vi | Owner đề xuất và điểm giao |
| --- | --- |
| Backend ETA/Late Risk | Mobile + Backend owner triển khai evaluator, projection và policy expiry. Backend chung duyệt nơi lưu commitment/alert, phân quyền và worker, mã lỗi và version API. |
| Planner | Optimizer owner xác nhận provenance matrix/leg, đơn vị, time windows và tiêu chí reuse snapshot. |
| Customer UI | Mobile owner tích hợp DTO additive, fallback planned, từng Trip và các trạng thái stale/missing. |
| Dashboard Alert UI | Web Admin owner tích hợp filter Branch, cảnh báo/episode và drill-down đủ quyền. |
| Nghiệm thu liên module | Các owner cùng xác nhận deadlines, scope cross-branch, ngân sách provider, metric và fixture QA. Chỉ định một người chốt acceptance. |

Phân công theo chức năng. Shared Backend và đầu mối nghiệm thu vẫn **OWNER TO CONFIRM**. [Phân công](../../PHAN_CONG_3_NGUOI.md) · [G0 ownership](graduation-requirements-coverage-audit.md) · [G1 ownership](g1-customer-order-confirmation-contract.md)

## 9. Test matrix và metric

| Ca | Bằng chứng chấp nhận đề xuất |
| --- | --- |
| Chưa chạy, đã hoàn thành, hủy | Chưa chạy chỉ có kế hoạch. Trip terminal không phát forecast mới. Actual giữ theo event đủ điều kiện. |
| GPS fresh, tiến độ bình thường | Fixture matrix theo hướng và clock cố định cho expected arrival/completion từng stop. Test thời gian phục vụ và ràng buộc wait không được cộng trùng. |
| Predicted completion sát/vượt hạn | Hysteresis enter/clear đúng ngưỡng. Vượt theo dự đoán vẫn là AT_RISK. Một poll lặp cùng revision không tính lần thứ hai. |
| Giao đủ đúng biên hoặc giao trễ thực tế | Actual bằng hạn thì ON_TRACK. Actual vượt thì LATE. Event offline nhận sau deadline nhưng occurredAt đúng hạn vẫn ON_TRACK. |
| GPS stale, null, accuracy thiếu, timestamp tương lai | Prediction GPS null, fallback planned đúng nhãn. Test nhánh ARRIVED có neo thực thi mới. |
| GPS cũ nhận muộn hoặc GPS sau completion | Không ghi đè projection theo đo mới hơn. Backlog của chuyến terminal không sinh dự đoán. |
| Stop mới ARRIVED/COMPLETED/SKIPPED | Điểm đã đến chuyển sang actual. Stop đã xong không cộng lại service. Stop bị bỏ qua ảnh hưởng coverage của các kiện. Async Matrix về muộn không ghi đè revision mới. |
| Multi Order / multi Trip, LOAD, partial/failed | Route tính cả stop dùng chung, DTO chỉ trả phần của owner. Order aggregate chỉ có khi bao phủ đủ. Trip kết thúc hoặc DELIVERY_COMPLETED dạng PARTIAL không tự hoàn tất giao đủ. |
| Sai Customer hoặc Branch, Branch null | Customer wrong owner 404. Dashboard lọc đúng Branch, DISPATCHER sai Branch hoặc thiếu Branch bị từ chối. Cross-branch không lộ ID ngoài quyền. |
| Retry, cạnh tranh, expiry | Idempotent episode khi hai worker cập nhật cùng input và polling lặp. Tắt phát khi stale. Timeout, unreachable hoặc lỗi quota giữ planned, không tạo giả một ETA động. |
| End-to-end với dữ liệu thay đổi | Fixture cùng Order qua Trip đang chạy. Đổi GPS/đến stop/cập nhật commitment hoặc actual bằng luồng test hợp lệ, quan sát ETA, state, reason và alert tăng/giảm theo server. Chạy lại Customer client cũ. |

**Đo chất lượng đề xuất.** ETA MAE tính theo phút trên các dự đoán có actual tương ứng, tách arrival và completion, chia theo horizon và tầng freshness. Báo coverage và số mẫu bị loại cùng MAE, so với Planned và A ở cùng checkpoint để tránh dùng dữ liệu tương lai. Tỷ lệ phát hiện nguy cơ là số ca giao đủ trễ có cảnh báo trước deadline chia số ca trễ có nhãn. False positive rate là số ca giao đúng hạn từng cảnh báo chia số ca đúng hạn có nhãn. Báo thêm precision và số episode lặp theo Order nếu đủ dữ liệu. Lead time dùng `deadline - firstAlertAt`, báo thêm lead time tới actual và phân phối percentile. Đo GPS freshness bằng `now - measuredAt`, ingest latency bằng `receivedAt - measuredAt`, end-to-end bằng `firstRenderedAt - measuredAt`. Đo thêm lag tới projection và tới poll UI. Gắn nhãn sample nhận muộn/lệch đồng hồ, tách thiết bị và offline, báo sample size. Ca partial hoặc chưa có actual giữ nhãn chưa quan sát. Fixture nhân tạo kiểm chức năng. Đánh giá MAE/false positive cần tập chuyến thực có nhãn và policy đã duyệt.

## 10. Rủi ro và giới hạn

- Android có thể trì hoãn cả native job lẫn callback. GPS giả lập hoặc một cửa sổ PASS chỉ chứng minh luồng của phiên đo, không xác nhận SLA thực địa. Chuyến có dữ liệu stale phải trả rõ mức độ bao phủ.
- Matrix `mapbox/driving` hiện là road duration theo profile đã có. Độ trễ giao thông, nghỉ tài xế, xe tải bị giới hạn đường, thời gian bốc hàng biến động và replan làm sai số tăng. Giá trị 120 giây, 100 m và các ngưỡng cảnh báo là tham số cần hiệu chỉnh.
- Lệnh Driver offline có thể tới muộn. Forecast và late risk cần gắn input timestamp, version và audit để cho phép sửa kết luận khi actual xuất hiện. PII chỉ xuất qua DTO theo scope và chính sách retention đã chốt.
- Chuẩn hóa projection/cache và alert episode có thể cần storage nếu nhóm chọn persistence. Tính deadline, forecast và alert độc lập để vẫn demo ETA khi commitment chưa được giải quyết. Quyền write, retry và time window của planner cần owner review riêng.

## 11. Quyết định cần signoff

1. Cam kết so theo **giao đủ** hay **đến điểm**, nguồn cam kết và ai được nhập/đổi. Chốt storage, version/audit, timezone và quyền hiển thị cho Customer.
2. Chốt status khi quá hạn chưa có actual. Duyệt 10/15 phút, số mẫu hysteresis, khoảng phân cách, cách suspend và policy thông báo.
3. Chốt giới hạn freshness/accuracy, tuổi của anchor ARRIVED, fallback khi quality thấp, quy tắc coverage multi-Trip và service duration khi thiếu provenance.
4. Chốt quota, TTL/cache, footprint worker, Mapbox privacy và phạm vi chia sẻ forecast. Owner Planner ký schema ánh xạ leg/time window nếu reuse snapshot.
5. Chốt DTO additive, quyền Dashboard cross-branch, endpoint phân trang, vị trí lưu alert và người chịu trách nhiệm Backend chung.
6. Chốt fixture nội bộ, cách lấy nhãn thực, mục tiêu metric và tiêu chí GO về ETA/risk. GPS realtime giữ NO-GO theo G3 và được nghiệm thu riêng.

## 12. Roadmap G2.2–G2.6

| Mốc | Đầu ra sau khi duyệt | Gate |
| --- | --- | --- |
| G2.2 | Chốt commitment, scope Branch/Customer, DTO, quy đổi time window và fixtures thống nhất. | Các owner ký semantics và quyết định có cần schema/migration riêng. |
| G2.3 | Backend prediction thuần, Mapbox/cache projection, expiry và concurrency. So A/B qua fixtures, unit và PostgreSQL local. | ETA fresh/stale/actual/partial và replan đúng ngay cả khi không có deadline. |
| G2.4 | Late risk evaluator, episode idempotent và API Dashboard theo Branch. | Actual vs forecast, event offline, hysteresis, sai quyền và dedupe qua test. |
| G2.5 | Customer Mobile và Web Dashboard tích hợp theo owner. | Client cũ đọc được. Client mới phân biệt planned, predicted, actual và thiếu dữ liệu. |
| G2.6 | QA đầu cuối cùng Order/Trip, đo coverage, MAE, false positive, lead time và độ trễ GPS. | Báo kết quả theo fixture/thiết bị. Chỉ GO theo các ngưỡng nhóm phê duyệt và bằng chứng đo được. |

**Điểm dừng G2.1.** Tài liệu thiết kế chờ signoff. Tất cả ca nghiệm thu G2 ở trên là đề xuất.
