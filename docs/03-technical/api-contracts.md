# API Contracts - Smart TMS Mobile

## M1 Customer Authentication - IMPLEMENTED (2026-11-14)

Phần này mô tả contract đã được triển khai và được ưu tiên hơn các đoạn `PROPOSED` cũ của M0 về authentication.

### `POST /auth/register/customer` - CURRENT

Endpoint public dùng để tạo đồng thời một `User` và một `Customer` liên kết 1-1.

Request:

```json
{
  "username": "customer01",
  "password": "StrongPass123",
  "fullName": "Nguyen Van A",
  "phone": "090-000-0000",
  "email": "customer@example.com"
}
```

Quy tắc:

- `username`: 4-50 ký tự, được trim, chuyển lowercase; chỉ gồm `a-z`, số, `.`, `_`, `-`.
- `password`: 8-72 ký tự, không được trả lại hoặc ghi log.
- `fullName`: bắt buộc, tối đa 100 ký tự; trim và gộp khoảng trắng liên tiếp.
- `phone`: 9-15 chữ số, có thể bắt đầu bằng `+`; bỏ khoảng trắng, dấu chấm và gạch ngang.
- `email`: tùy chọn, tối đa 254 ký tự; trim, lowercase và phải đúng định dạng nếu có.
- Field ngoài DTO bị từ chối. Client không được gửi `role`, `branchId`, `locationId` hoặc `customerId`.
- Backend luôn gán `role=CUSTOMER`, hash password bằng bcrypt cost 12 và dùng Prisma transaction.

Response `201`:

```json
{
  "user": {
    "id": "uuid",
    "username": "customer01",
    "fullName": "Nguyen Van A",
    "phone": "0900000000",
    "email": "customer@example.com",
    "role": "CUSTOMER",
    "active": true,
    "createdAt": "2026-11-14T00:00:00.000Z"
  },
  "customer": {
    "id": "uuid",
    "code": "CUS-UUID",
    "name": "Nguyen Van A",
    "phone": "0900000000",
    "email": "customer@example.com"
  }
}
```

Lỗi chính:

| HTTP | `errorCode` | Trường hợp |
|---|---|---|
| 400 | validation mặc định | Thiếu/sai field hoặc có field không được phép |
| 409 | `USERNAME_ALREADY_EXISTS` | Trùng `User.username` |
| 409 | `EMAIL_ALREADY_EXISTS` | Trùng `User.email` |
| 409 | `PHONE_ALREADY_EXISTS` | Trùng `Customer.phone` |
| 409 | `CUSTOMER_REGISTRATION_CONFLICT` | Unique conflict không xác định được field |

### `POST /auth/login` - CURRENT

Giữ contract Web Admin hiện hữu:

```json
{ "username": "admin", "pass": "password" }
```

Mobile cũng có thể dùng alias:

```json
{ "username": "customer01", "password": "StrongPass123" }
```

Response vẫn gồm `accessToken` và `user`; chưa có refresh token. Backend từ chối sai mật khẩu và tài khoản `active=false` bằng HTTP `401`. Username đăng nhập chỉ được trim, không tự đổi lowercase, để không phá contract tài khoản cũ.

### `GET /auth/profile` - CURRENT

Header: `Authorization: Bearer <accessToken>`.

Backend lấy `User.id` từ JWT đã xác minh, sau đó đọc lại database. Với role `CUSTOMER`, response có thêm `customer`; client không gửi và backend không tin `customerId` từ request.

```json
{
  "id": "user-uuid",
  "username": "customer01",
  "fullName": "Nguyen Van A",
  "role": "CUSTOMER",
  "phone": "0900000000",
  "email": "customer@example.com",
  "active": true,
  "branchId": null,
  "locationId": null,
  "customer": {
    "id": "customer-uuid",
    "code": "CUS-UUID",
    "name": "Nguyen Van A",
    "phone": "0900000000",
    "email": "customer@example.com"
  }
}
```

JWT thiếu/sai/hết hạn hoặc user inactive trả `401`. User mang role `CUSTOMER` nhưng thiếu relation Customer trả `409/CUSTOMER_PROFILE_NOT_FOUND`. Response không query và không trả password.

## 1. Quy ước

- Base URL lấy từ cấu hình môi trường, không hardcode trong app.
- JWT gửi bằng `Authorization: Bearer <token>`.
- Client gửi `x-correlation-id` nếu có; backend luôn trả header này.
- Command có thể retry phải có UUID idempotency key.
- `CURRENT` là endpoint đã tồn tại; `PROPOSED` chưa được triển khai.

Error envelope hiện tại:

```json
{
  "statusCode": 409,
  "errorCode": "HTTP_409",
  "message": "Tài nguyên đã thay đổi",
  "timestamp": "2026-11-14T10:00:00.000Z",
  "path": "/orders/example",
  "correlationId": "uuid"
}
```

## 2. Authentication

### `POST /auth/register/customer` - PROPOSED

Request:

```json
{
  "username": "customer01",
  "password": "strong-password",
  "fullName": "Nguyen Van A",
  "phone": "0900000000",
  "email": "customer@example.com"
}
```

Server luôn tạo role `CUSTOMER`; request không có `role`, `branchId`, `locationId` hoặc `customerId`.

Response `201`:

```json
{
  "user": {
    "id": "uuid",
    "username": "customer01",
    "fullName": "Nguyen Van A",
    "role": "CUSTOMER"
  },
  "customer": {
    "id": "uuid",
    "code": "CUS-...",
    "name": "Nguyen Van A",
    "phone": "0900000000"
  }
}
```

### `POST /auth/login` - CURRENT, cần chuẩn hóa DTO

Request đề xuất chỉ dùng `username` và `password`. Response hiện trả `accessToken` và user. Refresh token chưa có và chưa được chốt cho MVP.

### `GET /auth/profile` - CURRENT, cần mở rộng

`PROPOSED`: với CUSTOMER, trả thêm Customer id/profile bằng server lookup; không lấy customerId từ JWT claim làm nguồn sự thật lâu dài.

## 3. Customer Orders

### `GET /customer/orders` - CURRENT (M2.1)

Chỉ role `CUSTOMER`. Customer được xác định từ JWT và `Customer.userId`; không nhận `customerId` hoặc `branchId`.

Query:

| Field | Quy tắc |
|---|---|
| `status` | Tùy chọn, phải thuộc `OrderStatus` |
| `page` | Số nguyên dương, mặc định `1` |
| `limit` | Số nguyên `1..100`, mặc định `20` |

Response `200`:

```json
{
  "items": [
    {
      "id": "order-uuid",
      "orderNumber": "ORD-20261115-001",
      "status": "DRAFT",
      "version": 1,
      "notes": "Hàng dễ vỡ",
      "totalPackages": 4,
      "totalWeightKg": 50,
      "totalVolumeM3": 0.12,
      "orderedAt": "2026-11-15T01:00:00.000Z",
      "createdAt": "2026-11-15T01:00:00.000Z",
      "updatedAt": "2026-11-15T01:00:00.000Z",
      "stops": []
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "totalPages": 1
}
```

Danh sách sort `createdAt DESC, id DESC`. Query thừa như `customerId`/`branchId` hoặc page/limit/status sai trả `400`.

### `GET /customer/orders/:id` - CURRENT (M2.1)

Trả cùng `404` khi ID không tồn tại hoặc không thuộc Customer hiện tại. `id` phải là UUID.

Item trong response:

```json
{
  "id": "item-uuid",
  "description": "Thùng hàng A",
  "packageType": "CARTON",
  "quantity": 4,
  "lineWeightKg": 50,
  "unitWeightKg": 12.5,
  "lengthCm": 40,
  "widthCm": 30,
  "heightCm": 25,
  "lineVolumeM3": 0.12,
  "unitVolumeM3": 0.03
}
```

`stops` được sort theo `sequence`. Response không có `totalAmount`, payment, `customerId`, `branchId`, Customer profile hoặc dữ liệu optimizer. CUSTOMER thiếu relation trả `409/CUSTOMER_PROFILE_NOT_FOUND`. ADMIN/DISPATCHER/STAFF/DRIVER trả `403`.

### `GET /customer/branches` - CURRENT (M2.2)

Chỉ role `CUSTOMER`. Endpoint trả mảng Branch đang `active=true`, sắp xếp ổn định theo `code ASC, id ASC`:

```json
[
  {
    "id": "branch-uuid",
    "code": "DAD",
    "name": "Chi nhánh Đà Nẵng"
  }
]
```

Response dùng Prisma `select` allowlist và không trả địa chỉ kho, tọa độ, giá nhiên liệu, chính sách phạt hoặc dữ liệu vận hành. Endpoint `/branches` của Web Admin không thay đổi.

### `POST /customer/orders` - CURRENT (M2.2)

```json
{
  "idempotencyKey": "uuid",
  "branchId": "branch-uuid",
  "pickup": {
    "address": "Kho A",
    "latitude": 10.1,
    "longitude": 106.1,
    "contactName": "Nguoi giao",
    "contactPhone": "0900000001"
  },
  "delivery": {
    "address": "Kho B",
    "latitude": 10.2,
    "longitude": 106.2,
    "contactName": "Nguoi nhan",
    "contactPhone": "0900000002"
  },
  "items": [
    {
      "description": "Thung hang A",
      "packageType": "CARTON",
      "quantity": 4,
      "unitWeightKg": 12.5,
      "lengthCm": 40,
      "widthCm": 30,
      "heightCm": 25
    }
  ],
  "notes": "Hang de vo"
}
```

Quy tắc request:

| Field | Validation |
|---|---|
| `idempotencyKey` | UUID bắt buộc |
| `branchId` | UUID bắt buộc; Branch phải tồn tại và `active=true` |
| `pickup`, `delivery` | Mỗi loại đúng một object; address/contactName không rỗng; phone 9-15 chữ số, có thể bắt đầu `+` |
| `latitude`, `longitude` | Số hữu hạn trong `[-90,90]` và `[-180,180]` |
| `items` | 1-20 loại kiện |
| `quantity` | Số nguyên `1..500` mỗi loại |
| `unitWeightKg` | Số hữu hạn `>0` và `<=1000` |
| `lengthCm` | Số hữu hạn `>0` và `<=1000` |
| `widthCm`, `heightCm` | Số hữu hạn `>0` và `<=300` |
| `notes` | Tùy chọn, tối đa 2000 ký tự |

`customerId`, `status`, `orderNumber`, `orderedAt`, `totalAmount` và các tổng do client gửi đều bị Global ValidationPipe từ chối `400`.

Response `201`:

```json
{
  "id": "order-uuid",
  "orderNumber": "ORD-CUS-20261115-0001",
  "status": "DRAFT",
  "version": 1,
  "totalPackages": 5,
  "totalWeightKg": 1620,
  "totalVolumeM3": 5.988,
  "createdAt": "2026-11-15T08:00:00.000Z",
  "orderedAt": "2026-11-15T08:00:00.000Z",
  "branch": {
    "id": "branch-uuid",
    "code": "DAD",
    "name": "Chi nhánh Đà Nẵng"
  }
}
```

Backend resolve Customer bằng `JWT sub -> Customer.userId`, tính `lineWeightKg = unitWeightKg * quantity`, `lineVolumeM3 = lengthCm * widthCm * heightCm * quantity / 1_000_000`, rồi kiểm tra lại mọi tổng là số hữu hạn. Order, hai OrderStop (pickup sequence 1, delivery sequence 2), OrderItem, OrderEvent và ProcessedCommand được ghi trong cùng transaction. `totalAmount=0` chỉ là giá trị kỹ thuật “chưa báo giá” và không xuất hiện trong response Customer.

Cùng Customer + idempotency key + payload trả lại cùng Order; cùng key nhưng payload khác trả `409`. Advisory transaction lock bảo vệ idempotency và cấp số `ORD-CUS-YYYYMMDD-NNNN` khi request đồng thời. Branch không tồn tại/inactive trả `400/CUSTOMER_BRANCH_NOT_AVAILABLE`; Customer relation thiếu trả `409/CUSTOMER_PROFILE_NOT_FOUND`.

Branch active không bị từ chối chỉ vì pickup khác khu vực. Hệ thống chưa có service-area mapping; nhân viên kiểm tra thủ công khi duyệt ở M2.3. Time window, edit/cancel, pricing, Package, Trip và Confirm không thuộc M2.2.

### API vận hành hiện hữu - CURRENT sau M2.0

- `/orders`, `/customers`, `/trips`, `/branches`, `/vehicles`, `/drivers` yêu cầu JWT và role `ADMIN` hoặc `DISPATCHER`.
- `DISPATCHER` bắt buộc có branch và chỉ nhận/tác động dữ liệu thuộc branch đó; branch null hoặc query branch khác trả `403`.
- `ADMIN` giữ quyền liên branch theo contract Web Admin hiện hữu.
- `GET /orders/:id` và `PATCH /orders/:id` kiểm tra `Order.branchId` từ database trước khi trả/sửa dữ liệu.
- Generic `PATCH /orders/:id` không nhận `status`; field này bị Global ValidationPipe từ chối `400`.
- Quyền DRIVER cũ trên `GET /trips/:id/load-plan` đã được loại bỏ ở M3.1; endpoint này hiện chỉ dành cho ADMIN/DISPATCHER.
- Customer dùng API riêng `/customer/branches` và `/customer/orders`; CUSTOMER gọi API vận hành nhận `403`.

Web Admin vẫn dùng contract hiện tại để tạo Order mới ở `CONFIRMED`, đọc danh sách và sửa thông tin Order trong đúng Branch.

### M2.3 — Xác nhận đơn Customer từ Web Admin

`POST /orders/:id/confirm` yêu cầu JWT của ADMIN active hoặc DISPATCHER active đúng Branch. ID là UUID. Đơn phải ở `DRAFT`, có audit nguồn `CUSTOMER_APP`, thuộc Branch active, có dữ liệu kiện và điểm dừng hợp lệ, chưa có Package vật lý.

Body chỉ nhận `expectedVersion` (số nguyên JSON 1–2147483647, lấy từ Order đang được xem) và `idempotencyKey` (UUID cho lần gửi).

```json
{
  "expectedVersion": 1,
  "idempotencyKey": "d76baade-ecb1-42c3-ac69-f1284b1b13b1"
}
```

HTTP 200

```json
{
  "orderId": "e87916e7-0b20-462e-bcd4-ffa9f6f79b19",
  "orderNumber": "TMS-EXAMPLE-001",
  "status": "CONFIRMED",
  "version": 2,
  "confirmedAt": "2026-11-22T08:30:00.000Z"
}
```

| HTTP | Cách Web Admin xử lý |
| --- | --- |
| 400 | Kiểm tra UUID, kiểu dữ liệu và field ngoài contract. |
| 401/403/404 | Xử lý phiên, quyền/Branch hoặc Order không tồn tại. |
| 409 `ORDER_VERSION_CONFLICT` / `ORDER_STATE_CONFLICT` | Tải lại đơn, hiện version/trạng thái mới và yêu cầu người dùng xem lại. Tạo key mới cho lượt xác nhận mới. |
| 409 `ORDER_CONFIRM_IDEMPOTENCY_CONFLICT` | Key đã dùng cho Order hoặc version khác. |
| 409 `ORDER_NOT_CONFIRMABLE` | Kiểm tra nguồn đơn hoặc Package vật lý đã tồn tại. |
| 422 `ORDER_BRANCH_INACTIVE` / `ORDER_VALIDATION_FAILED` | Đơn vẫn ở DRAFT. Điều phối kiểm tra Branch hoặc dữ liệu vận chuyển. |

Khi mạng lỗi hoặc chưa biết kết quả, gửi lại nguyên Order ID, version và key với cùng tài khoản. Replay trả receipt gốc nếu vẫn còn quyền, kể cả khi đơn đã sang ASSIGNED. UI tắt nút khi đang gửi và tải lại đơn sau khi nhận receipt. Hiện nút theo vai trò, Branch và trạng thái. Backend quyết định quyền thao tác.

`PATCH /orders/:id` vẫn nhận body cũ. Web nên bổ sung `expectedVersion` lấy từ lúc mở form để phát hiện bản người dùng đã xem bị cũ. Nếu bỏ field, server phát hiện ghi cạnh tranh từ lần đọc đầu của request. Mỗi PATCH có thay đổi tăng version một lần. PATCH gửi lại dữ liệu giống hệt giữ version và ID Items/Stops. Field `status` vẫn bị từ chối. Khi sửa kiện của Customer DRAFT, tổng khối lượng/thể tích giữ độ chính xác của các dòng để validation Confirm đối chiếu. [Contract G1](g1-customer-order-confirmation-contract.md)

### `POST /orders/:id/cancel` - PROPOSED

Request gồm `idempotencyKey`, `expectedVersion`, `reason`. Không dùng generic PATCH để Customer tự đổi status.

## 4. Driver APIs

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/driver/me` | Hồ sơ tài xế đang đăng nhập, chỉ đọc — CURRENT M5.2 |
| GET | `/driver/trips` | Danh sách Trip được phân công — CURRENT M3.1 |
| GET | `/driver/trips/history` | Lịch sử Trip đã hoàn thành hoặc đã hủy theo assignment — CURRENT M5.3 |
| GET | `/driver/trips/:id` | Snapshot theo assignment và thông số xe gắn với Trip — CURRENT M3.1/M5.2 |
| POST | `/trips/:id/start` | Bắt đầu Trip |
| POST | `/trips/:id/stops/:stopId/arrive` | Xác nhận đến stop |
| POST | `/trips/:id/tasks/:taskId/confirm` | Xác nhận actual quantity |
| POST | `/trips/:id/delivery-attempts` | Giao đủ/thiếu/thất bại |
| POST | `/trips/:id/incidents` | Báo sự cố |
| POST | `/trips/:id/complete` | Hoàn thành Trip khi đủ điều kiện |

Command envelope đề xuất:

```json
{
  "commandId": "uuid",
  "expectedTripVersion": 3,
  "occurredAt": "2026-11-15T05:00:00.000Z",
  "payload": {}
}
```

## 5. GPS và tracking - CURRENT Backend M3.6B

### `POST /driver/trips/:tripId/gps`

- Authentication: Bearer JWT; chỉ role `DRIVER`.
- Ownership: `JWT.sub → Driver.userId → DriverAssignment ASSIGNED/PRIMARY → Trip`.
- Trip phải `IN_PROGRESS`; Trip `COMPLETED` chỉ nhận backlog trong 30 phút sau `actualEndTime` và mọi `measuredAt` phải nằm giữa actual start/end.
- Không nhận `driverId`, `userId`, `vehicleId` hoặc `branchId`; Vehicle lấy từ Trip.
- Batch từ 1 đến 20 point. `deviceCode` và `deviceSessionId` là UUID; sequence là số nguyên dương.

```json
{
  "deviceCode": "uuid",
  "deviceSessionId": "uuid",
  "points": [
    {
      "sequence": 101,
      "latitude": 10.123,
      "longitude": 106.456,
      "accuracyM": 12.5,
      "speedMps": 8.2,
      "headingDeg": 180,
      "measuredAt": "2026-11-17T02:00:00.000Z"
    }
  ]
}
```

Backend đổi `speedMps × 3.6` sang `GpsEvent.speedKph`, đặt `receivedAt` bằng server time và bulk insert. Unique `(deviceCode, deviceSessionId, sequence)` chống ghi trùng. Cùng session dùng cho Driver/Trip/Vehicle/device khác trả `409 TRACKING_SESSION_CONFLICT`.

```json
{
  "tripId": "uuid",
  "deviceSessionId": "uuid",
  "acceptedCount": 3,
  "duplicateCount": 2,
  "receivedAt": "2026-11-17T02:00:45.000Z"
}
```

`Vehicle.currentLatitude/currentLongitude/lastLocationAt` chỉ cập nhật khi point mới nhất trong batch có `measuredAt` lớn hơn `lastLocationAt`; `GpsEvent` vẫn là history source of truth.


#### M5.8.3A — Ràng buộc phiên thu và gửi GPS trên Mobile

| Tầng | Định danh, thời gian và kiểm tra |
|---|---|
| Android LocationManager → Expo Location/TaskManager | Android cung cấp thời điểm đo của fix. Mỗi lần đăng ký có tên task ngẫu nhiên riêng, đi qua định danh task native và `executionInfo.taskName`. Foreground watcher giữ cùng tên qua closure. |
| Callback JS | Tra đúng tên task trong binding SQLite. Binding xác định User, Trip và `deviceSessionId` của phiên đã đăng ký. Kiểm quyền vị trí, JWT DRIVER đúng `sub`, hạn và fingerprint của JWT trước khi ghi. Thời điểm kích hoạt là lớp bổ sung loại fix được cache trước khi đăng ký. |
| SQLite GPS | Transaction xác nhận lại chính xác task, owner, Trip, session và trạng thái ACTIVE rồi mới cấp sequence và ghi `measuredAt` cùng thời điểm enqueue. Bảng binding là bổ sung cục bộ. Các phiên cũ thiếu binding hoặc thuộc JWT đã kết thúc được cách ly và vẫn chịu giới hạn lưu dữ liệu hiện có. |
| Worker | Đọc row theo User/Trip/session, giữ nguyên sequence và thời điểm đo. Mỗi batch giữ JWT gốc đã đối chiếu. Đổi phiên huỷ epoch JS và các request đang chờ. Đọc kết quả HTTP chỉ khi phiên vẫn hợp lệ. |
| Backend → PostgreSQL | Backend xác minh JWT, ánh xạ User sang Driver rồi kiểm assignment cho Trip. `GpsEvent` lưu Driver, Trip, mã thiết bị, `deviceSessionId`, sequence, `measuredAt` và `receivedAt`. Giữ nguyên contract ingest và khóa chống trùng. |

Logout và hết hạn vô hiệu epoch trong JS trước khi gỡ task native. Gỡ task/service Android là thao tác bất đồng bộ. Callback đến trễ bị kiểm theo tên đăng ký và binding đã thu hồi, hoặc theo JWT đang được lưu. Request đã được Backend tiếp nhận trước lúc hủy có thể đã ghi dữ liệu với JWT gốc. Queue GPS độc lập với SQLite execution FIFO. M5.8.3A giữ cơ chế lập lịch GPS hiện tại. Kết quả nghiệm thu giao điểm với app còn ở nền được theo dõi riêng tại báo cáo M5.8.
### `GET /trips/:tripId/tracking/latest`

- Role: `ADMIN`, `DISPATCHER`.
- ADMIN được cross-branch; DISPATCHER theo `Trip.managingBranchId`, fallback `Vehicle.homeBranchId`.
- Chưa có GPS trả `404 GPS_POSITION_NOT_FOUND`.
- `isStale=true` khi `measuredAt` cũ hơn 2 phút.

```json
{
  "tripId": "uuid",
  "vehicleId": "uuid",
  "latitude": 10.123,
  "longitude": 106.456,
  "accuracyM": 12.5,
  "speedKph": 29.52,
  "headingDegrees": 180,
  "measuredAt": "2026-11-17T02:00:00.000Z",
  "receivedAt": "2026-11-17T02:00:10.000Z",
  "isStale": false
}
```

Response không trả Driver profile, device/session identifier hoặc history. M3.6B chưa phát Socket.IO GPS.

### Customer tracking - CURRENT M3.6D.1

### `GET /customer/orders/:id/tracking`

Chỉ `CUSTOMER`. Backend lấy Customer từ `JWT.sub`; không nhận `customerId` hoặc `tripId` từ client. Order không tồn tại và Order không thuộc Customer đều trả `404`. User thiếu Customer relation trả `409 CUSTOMER_PROFILE_NOT_FOUND`.

Response:

```json
{
  "orderId": "uuid",
  "orderStatus": "IN_TRANSIT",
  "trackingStatus": "AVAILABLE",
  "trips": [
    {
      "id": "uuid",
      "tripNumber": "TRIP-001",
      "status": "IN_PROGRESS",
      "version": 4,
      "plannedDeliveryAt": "2026-11-15T05:30:00.000Z",
      "etaSource": "PLANNED",
      "vehicleLocation": {
        "latitude": 10.1,
        "longitude": 106.1,
        "accuracyM": 12,
        "measuredAt": "2026-11-15T05:00:00.000Z",
        "receivedAt": "2026-11-15T05:00:03.000Z",
        "isStale": false
      }
    }
  ]
}
```

- Chưa có Trip: `trackingStatus = NOT_ASSIGNED`, `trips = []`.
- Có Trip: `trackingStatus = AVAILABLE`; trạng thái chi tiết nằm ở từng `trip.status` để hỗ trợ Order chia qua nhiều Trip.
- Chưa có GPS của Trip: `vehicleLocation = null`.
- `isStale = true` khi `measuredAt` cũ hơn 2 phút.
- `plannedDeliveryAt` lấy từ delivery TripStop có StopTask `UNLOAD` của đúng Order; có thể `null`. `etaSource` hiện luôn là `PLANNED`, chưa có dynamic ETA.
- Trip hoàn thành chỉ dùng latest `GpsEvent` gắn với chính Trip; không đọc `Vehicle.currentLocation`.
- Không trả Driver, device/session identifier, GPS history, routeGeometry hoặc stop của Order khác.

#### Mobile consumer - CURRENT M3.6D.2

- `CustomerOrderDetailScreen` gọi đúng endpoint trên thông qua `ordersService`; Screen không gọi HTTP trực tiếp.
- Mobile kiểm tra cấu trúc response trước khi đưa vào UI. `trackingStatus` chỉ chấp nhận `NOT_ASSIGNED` hoặc `AVAILABLE`; tọa độ, thời gian và cấu trúc từng Trip phải hợp lệ.
- Khi màn hình đang focus và ứng dụng ở foreground, Mobile tải ngay rồi polling mỗi 30 giây. Polling dừng khi blur, background hoặc unmount và tải lại ngay khi trở về foreground.
- Lỗi polling không xóa snapshot thành công gần nhất. UI giữ dữ liệu cũ, hiện cảnh báo nhẹ và cho phép thử lại thủ công.
- Mobile hiển thị toàn bộ `trips[]`, phân biệt chưa có GPS, vị trí mới/cũ và vị trí cuối của Trip hoàn thành. Không hiển thị tọa độ thô, bản đồ, lịch sử hoặc dynamic ETA trong MVP.

## 6. Driver e-POD - CURRENT (M3.5)

Delivery được hoàn tất trước để tạo `DeliveryAttempt`; ảnh/chữ ký được upload sau và liên kết đúng attempt. Chỉ DRIVER có assignment `ASSIGNED`, role `PRIMARY` của Trip `IN_PROGRESS` hoặc `COMPLETED` được truy cập. Chuỗi ownership được kiểm tra từ JWT User đến Driver, Trip, Stop DELIVERY và DeliveryAttempt; ID không tồn tại hoặc không thuộc chuỗi đều trả `404`.

### `POST /driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod`

Request `multipart/form-data`:

| Field | Quy tắc |
|---|---|
| `file` | Bắt buộc |
| `evidenceType` | `PHOTO` hoặc `SIGNATURE` |
| `capturedAt` | ISO date-time |
| `idempotencyKey` | UUID |
| `supersedesId` | UUID tùy chọn; PodFile `UPLOADED` cùng attempt và cùng evidence type cần thay thế |

- `PHOTO`: JPEG hợp lệ theo MIME và magic bytes, tối đa 5 MiB.
- `SIGNATURE`: PNG hợp lệ theo MIME và magic bytes, tối đa 2 MiB.
- Server tự tính SHA-256 checksum, không tin checksum từ Mobile.
- Cùng actor + command + idempotency key + cùng payload/file trả lại cùng kết quả; tái sử dụng key với payload/file khác trả `409`.
- Trạng thái file đi qua `PENDING → UPLOADING → UPLOADED`; lỗi storage chuyển sang `FAILED` và có thể retry cùng key.
- Binary được lưu Cloudinary dạng authenticated/private bằng storage key xác định; API không trả URL công khai hoặc storage key.

Response allowlist:

```json
{
  "id": "pod-file-uuid",
  "evidenceType": "PHOTO",
  "mediaType": "image/jpeg",
  "sizeBytes": 245120,
  "uploadStatus": "UPLOADED",
  "capturedAt": "2026-11-16T10:00:00.000Z",
  "uploadedAt": "2026-11-16T10:00:02.000Z"
}
```

### `GET /driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod`

Trả metadata allowlist, yêu cầu nghiệp vụ và trạng thái POD để Mobile khôi phục sau khi mở lại ứng dụng:

```json
{
  "deliveryAttempt": {
    "id": "attempt-uuid",
    "result": "SUCCESS",
    "recipientName": "Nguyen Van A"
  },
  "requirements": {
    "photoRequired": true,
    "photoUploaded": true,
    "recipientRequired": true,
    "recipientSatisfied": true,
    "podSatisfied": true
  },
  "items": []
}
```

Policy hiện tại:

- `SUCCESS` và `PARTIAL`: bắt buộc recipient name khi complete Delivery và bắt buộc ít nhất một PHOTO upload thành công.
- `FAILED` với `ADDRESS_ISSUE`, `ACCESS_RESTRICTED`, `PACKAGE_DAMAGED`: bắt buộc PHOTO.
- `FAILED` với người nhận vắng mặt/từ chối: PHOTO không bắt buộc.
- SIGNATURE là tùy chọn trong M3.5.
- Bản thay thế không xóa file cũ. Response metadata có `supersedesId` và `isSuperseded`; SIGNATURE thứ hai bắt buộc chỉ rõ chữ ký hiện hành cần thay thế.

### `GET /driver/trips/:tripId/stops/:stopId/delivery-attempts/:attemptId/pod/:podFileId/view`

- Chỉ PRIMARY Driver đúng ownership và chỉ PodFile `UPLOADED` thuộc attempt mới được cấp quyền xem.
- Trả `{ id, url, expiresAt }`; URL Cloudinary private được ký và hết hạn sau 5 phút.
- URL không được lưu vào database hoặc Mobile storage. Mỗi lần xem Mobile xin URL mới.
- Customer/Admin POD view vẫn ngoài phạm vi M3.5.

## 7. Socket.IO

- `CURRENT`: socket xác thực JWT và có room user/branch/location.
- `PROPOSED`: thêm event `order:tracking-updated`, `trip:execution-updated`, `notification:created` theo room được server gán.
- Payload socket chỉ chứa ID/version/status tối thiểu; client gọi REST để tải snapshot có authorization.

## 8. Mã lỗi đề xuất

| Code | Ý nghĩa |
|---|---|
| `CUSTOMER_PROFILE_NOT_FOUND` | User CUSTOMER chưa có Customer liên kết |
| `ORDER_ACCESS_DENIED` | Không sở hữu hoặc không có scope Order |
| `ORDER_STATE_CONFLICT` | Command không hợp lệ ở trạng thái hiện tại |
| `TRIP_ASSIGNMENT_REQUIRED` | Driver không được phân Trip |
| `STALE_TRIP_VERSION` | Mobile dùng Trip version cũ |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | Cùng key nhưng payload khác |
| `TIME_WINDOW_INVALID` | Window start/end không hợp lệ |

Các code trên đều là `PROPOSED`; exception filter hiện thường trả `HTTP_<status>`.

## 9. M3.1 Driver Assigned Trip Read API - CURRENT

Phần này thay thế đề xuất `/trips/my` ở mục Driver Trips đối với phạm vi read API đã triển khai.

### `GET /driver/trips`

- Authentication: Bearer JWT.
- Role: chỉ `DRIVER`.
- Query: `status?`, `page=1`, `limit=20`; limit tối đa 100.
- `status` chỉ nhận `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.
- Không nhận `driverId`, `branchId` hoặc `userId`.
- Ownership được lọc trong Prisma bằng Driver liên kết từ JWT user và `DriverAssignment.status=ASSIGNED`.
- Sắp xếp `plannedStartTime ASC`, tie-break `id ASC`.

Response:

```json
{
  "items": [],
  "page": 1,
  "limit": 20,
  "total": 0,
  "totalPages": 0
}
```

Mỗi item chỉ gồm Trip identity/status/version, planned/actual time, distance/duration, Vehicle allowlist, assignment hiện hành và `stopCount`.

**M5.3 Calendar.** Truyền cùng `from` và `to` để lọc. Dùng ISO-8601 có giây và `Z` hoặc offset, tối đa ba chữ số phần giây, ví dụ `2026-11-16T00:00:00+07:00`. Cặp phải có `from < to` và tối đa 31 × 24 giờ. Với query raw, mã hóa dấu `+` thành `%2B`. Điều kiện nửa mở `assignment.startTime < to && assignment.endTime > from` được áp dụng trên cùng một assignment của Driver, status `ASSIGNED`. Hai cột PostgreSQL đều `NOT NULL`. Phép so sánh range loại bản ghi thiếu biên nếu một bản sao dữ liệu không giữ constraint.

Khi lọc thời gian, `assignment` là bản ghi khớp đầu tiên theo `createdAt/id` và `calendarAssignments` chứa toàn bộ bản ghi khớp của Trip. Mỗi Trip có một item. Sort và metadata pagination giữ contract cũ. Request không range giữ nguyên shape, gồm `assignment` duy nhất và không có `calendarAssignments`.

### `GET /driver/trips/history`

- Chỉ `DRIVER` active qua JWT và assignment hiện hành `ASSIGNED`. Roles PRIMARY/RELIEF dùng cùng phạm vi đọc. Thu hồi assignment loại Trip khỏi cả History và Detail.
- Query yêu cầu `from`/`to` như Calendar, tối đa 93 × 24 giờ. `status?` nhận `COMPLETED` hoặc `CANCELLED`. `limit=20`, tối đa 100. `cursor?` lấy từ `nextCursor` của cùng bộ lọc. Cursor sai format hoặc query không hợp lệ trả 400.
- Lọc `historyAt >= from && historyAt < to`, sắp xếp `historyAt DESC, tripId DESC`. Cursor mã hóa cả hai giá trị. Trang cuối trả `nextCursor: null`.
- `COMPLETED` có mốc thực tế dùng `actualEndTime` và `ACTUAL_END`. Thiếu actual end, hoặc Trip `CANCELLED`, dùng `plannedStartTime` và `PLANNED_START`. `updatedAt` không được dùng làm thời điểm hủy.
- Trả `{ items, nextCursor }`. Item gồm `tripId, tripNumber, status, historyAt, dateBasis, vehicle, stopCount, processedStops, loadTaskCount, unloadTaskCount, loadedQuantity, unloadedQuantity, distinctPackageCount, successAttempts, partialAttempts, failedAttempts`. Vehicle dùng allowlist summary cũ.
- `processedStops` đếm COMPLETED/SKIPPED. `distinctPackageCount` đếm các `packageId` khác nhau có liên kết. LOAD và UNLOAD được đếm riêng. Tổng số thực tế của mỗi loại là `null` nếu không có tác vụ loại đó hoặc còn tác vụ chưa ghi số thực tế. Delivery attempts đếm theo kết quả đã ghi ở cấp Trip. Đây là dữ liệu vận hành chuyến.
- Projection loại contact, người nhận, URL POD, GPS và ghi chú nội bộ. Chi tiết mở route `GET /driver/trips/:id` để kiểm tra lại quyền tại thời điểm mở.

Mobile hiển thị theo `homeBranch.timezone` từ `GET /driver/me`. Khi giá trị timezone thiếu hoặc không hợp lệ, app hiển thị rõ fallback `Asia/Ho_Chi_Minh`. App tính đầu mỗi ngày theo timezone trước khi đổi thành instant. Tuần bắt đầu Thứ Hai. Một Trip xuất hiện ở từng ngày địa phương mà assignment giao với ngày đó.

### `GET /driver/trips/:id`

- Dùng cùng role, visible-status và assignment ownership như list.
- Trip không tồn tại, không được assign, assignment không còn `ASSIGNED`, hoặc Trip còn `DRAFT/PLANNED` đều trả 404.
- Response gồm Vehicle allowlist; stops theo `sequence ASC`; task LOAD/UNLOAD; Order identity tối thiểu; Package identity, trạng thái, `weightKg` và kích thước centimet.
- M5.8.1 giữ `stops[].contactPhone` kiểu `string | null`. PRIMARY/RELIEF có assignment `ASSIGNED` được đọc số của Stop ở chuyến `DISPATCHED/IN_PROGRESS` theo C1. Ở `COMPLETED/CANCELLED`, Backend luôn trả `null` và giữ `contactName`, `address` cùng metadata lịch sử. Giá trị liên hệ gốc vẫn được lưu tại Stop. Chuyến ngoài assignment trả 404.
- M5.2 thêm `vehicle.payloadCapacityKg`, `vehicle.volumeCapacityM3`, `vehicle.lengthCm`, `vehicle.widthCm`, `vehicle.heightCm` vào detail. Các trường xe cũ `id`, `plateNumber`, `model`, `vehicleType` tiếp tục dùng trong list và detail. Xe lấy trực tiếp từ Trip thuộc assignment được cấp. Projection không có `Vehicle.currentLocation`, hồ sơ bảo trì, nhiên liệu, checklist hoặc chi phí.
- Không trả Customer profile, giá/payment, `planningSnapshot`, `routeGeometry`, cost/payroll hoặc optimizer diagnostics.

### Lỗi

| HTTP/code | Điều kiện |
|---|---|
| `400` | Query sai, status không được Driver nhìn thấy, field injection |
| `401` | JWT thiếu/sai/hết hạn hoặc User inactive |
| `403` | Role không phải DRIVER |
| `404` | Trip không tồn tại hoặc không thuộc assignment hiện hành |
| `409 DRIVER_PROFILE_NOT_FOUND` | User DRIVER chưa liên kết Driver profile |

### Generic load-plan

`GET /trips/:id/load-plan` hiện chỉ cho `ADMIN` và `DISPATCHER`. Quyền DRIVER theo branch đã bị loại bỏ để đóng lỗ hổng assignment ownership. M3.1 chưa tạo Driver-specific load-plan.
## M5.2 Driver Self Profile — CURRENT

### `GET /driver/me/activity-summary` — M5.4

- Bearer JWT của User active có role `DRIVER` và hồ sơ Driver liên kết. Actor lấy từ JWT đã xác thực. Query chỉ nhận cặp `from`/`to` ISO-8601 có giây, tối đa ba chữ số phần giây, offset hoặc `Z`. Khoảng dương tối đa 93 × 24 giờ, biên `[from,to)`. Tham số thừa, thiếu hoặc sai trả 400. Thiếu hoặc hết hạn JWT trả 401, role khác trả 403, thiếu hồ sơ trả 409.
- Response gồm `range: { from, to }` ở UTC, `timeZone` từ chi nhánh cơ sở với fallback `Asia/Ho_Chi_Minh`, `asOf` từ thời điểm PostgreSQL bắt đầu câu aggregate, `completedTripCount`, `processedStopCount`, `depotStopCount`, `deliveries: { success, partial, failed, unclassified }` và `coverage: { status }`.
- Đếm Trip duy nhất từ `COMPLETE_TRIP`, loại Trip đã hủy. Đếm Stop duy nhất từ `PICKUP_COMPLETED`, `DELIVERY_COMPLETED`, `DELIVERY_FAILED` khớp loại điểm. Kho dùng `DEPOT_STOP_COMPLETED` và tách riêng. Công việc tại điểm đã ghi nhận vẫn được tính nếu chuyến hủy sau đó. `ARRIVE_STOP` và pending cục bộ nằm ngoài tập tính.
- Delivery đếm từng attempt đã đối chiếu `commandId`, Trip, Stop, actor, thời điểm và kết quả. `ProcessedCommand` phải là `COMPLETE_STOP` ở trạng thái `COMPLETED`, payload kết quả phải khớp attempt. `DELIVERY_COMPLETED` xác nhận SUCCESS hoặc PARTIAL, `DELIVERY_FAILED` xác nhận FAILED. Một attempt có thể bao gồm nhiều Order.
- `COMPLETE` nghĩa là bằng chứng đã quy được cho actor trong kỳ có dữ liệu và liên kết hợp lệ. `PARTIAL` báo khoảng trống trong tập bằng chứng đó. `unclassified` đếm attempt đã tìm được trong tập actor nhưng kết quả chưa đủ điều kiện xác minh. Event thiếu attempt làm coverage PARTIAL mà không sinh attempt giả. Attempt chỉ có command hợp lệ có thể vào `unclassified`. Attempt thiếu mọi bằng chứng actor không ảnh hưởng số liệu của bất kỳ tài xế nào.
- `NO_DATA` trả `null` cho ba count và `deliveries`. Giá trị `0` là số bản ghi đã xác minh của một loại khi có bằng chứng trong kỳ. Với PARTIAL, các số là phần đã xác minh. `occurredAt` quyết định kỳ, kể cả khi sự kiện được đồng bộ muộn. API là phép đọc, không chốt kỳ hay sinh command.

### `GET /driver/me`

Bearer JWT của User active có role `DRIVER`. Backend đối chiếu `Driver.userId = JWT.sub`. Endpoint không nhận query.

```ts
{
  id: string;
  fullName: string;
  operationalPhone: string | null;
  status: 'AVAILABLE' | 'ON_DUTY' | 'ON_LEAVE' | 'RESTING';
  homeBranch: { id: string; code: string; name: string; timezone: string };
  license: { category: string; validUntil: string; verificationStatus: string } | null;
}
```

`homeBranch` lấy từ Driver. `operationalPhone` lấy từ `Driver.phone`. GPLX lấy từ đúng một bản ghi DriverLicense, gồm ngày `YYYY-MM-DD` và trạng thái xác minh đã lưu. Khi không có hoặc có nhiều bản ghi, `license` bằng `null`. Không trả số giấy tờ, dữ liệu HR hoặc thông tin tài khoản nhạy cảm.

| HTTP/code | Điều kiện |
|---|---|
| `400` | Request có query |
| `401` | JWT thiếu/sai/hết hạn hoặc User inactive |
| `403` | Role khác DRIVER |
| `409 DRIVER_PROFILE_NOT_FOUND` | User DRIVER chưa liên kết hồ sơ |

## M3.7.1 Driver Incident API - IMPLEMENTED

Các endpoint dưới đây là contract runtime đã triển khai. Đường dẫn Driver-specific này thay thế đề xuất lịch sử `/trips/:id/incidents`.

### `POST /driver/trips/:tripId/incidents`

- Authentication: Bearer JWT; role `DRIVER`.
- Ownership: JWT User phải liên kết Driver và có assignment `ASSIGNED` role `PRIMARY` trên Trip.
- Chỉ nhận Trip `DISPATCHED` hoặc `IN_PROGRESS`.
- Không nhận `driverId`, `userId`, `vehicleId`, `branchId`, `status`, `resolution` hoặc tọa độ từ client.

Request:

```json
{
  "idempotencyKey": "9c5c08b4-c49b-4539-91b8-4d976c2cf967",
  "type": "VEHICLE_BREAKDOWN",
  "severity": "HIGH",
  "description": "Động cơ quá nhiệt, xe không thể tiếp tục an toàn.",
  "occurredAt": "2026-11-17T08:30:00.000Z",
  "affectedOrderIds": ["order-uuid"]
}
```

Response `201`:

```json
{
  "id": "incident-uuid",
  "tripId": "trip-uuid",
  "type": "VEHICLE_BREAKDOWN",
  "severity": "HIGH",
  "status": "OPEN",
  "description": "Động cơ quá nhiệt, xe không thể tiếp tục an toàn.",
  "occurredAt": "2026-11-17T08:30:00.000Z",
  "resolution": null,
  "affectedOrders": [
    { "id": "order-uuid", "orderNumber": "ORD-001" }
  ],
  "createdAt": "2026-11-17T08:31:00.000Z",
  "updatedAt": "2026-11-17T08:31:00.000Z"
}
```

Validation:

- `idempotencyKey`: UUID.
- `type` và `severity`: strict allowlist đã nêu trong tài liệu nghiệp vụ.
- `description`: trim, bắt buộc, 10-2000 ký tự.
- `occurredAt`: ISO-8601; không quá 5 phút trong tương lai và không quá 24 giờ trong quá khứ theo server time.
- `affectedOrderIds`: tùy chọn, mặc định `[]`, UUID duy nhất, không trùng, tối đa 100; mọi Order phải thuộc chính Trip.

### `GET /driver/trips/:tripId/incidents`

- Role `DRIVER`; assignment phải còn `ASSIGNED`, mọi assignment role được đọc.
- Query: `page=1`, `limit=20` (tối đa 100), `type?`, `status?`.
- Sắp xếp `occurredAt DESC`, tie-break `id DESC`.

```json
{
  "items": [],
  "page": 1,
  "limit": 20,
  "total": 0,
  "totalPages": 0
}
```

### `GET /driver/trips/:tripId/incidents/:incidentId`

- Dùng cùng assignment ownership như list.
- Incident phải thuộc đúng Trip trong URL; không tồn tại, sai Trip hoặc Trip không thuộc Driver đều trả 404.
- Response chỉ trả allowlist của create response; không trả Driver profile, device/session, internal admin note hoặc dữ liệu Order ngoài mã định danh tối thiểu.

### Error convention

| HTTP/code | Điều kiện |
|---|---|
| `400 INVALID_INCIDENT_TYPE` | Type ngoài allowlist |
| `400 INVALID_INCIDENT_SEVERITY` | Severity ngoài allowlist |
| `400 INVALID_INCIDENT_OCCURRED_AT` | Thời gian sai định dạng hoặc vượt policy |
| `401` | JWT thiếu, sai hoặc hết hạn |
| `403` | Role không phải DRIVER |
| `404 INCIDENT_NOT_FOUND` | Incident/Trip không tồn tại hoặc không thuộc assignment |
| `409 DRIVER_PROFILE_NOT_FOUND` | User DRIVER thiếu Driver relation |
| `409 DRIVER_NOT_PRIMARY` | RELIEF hoặc assignment role khác tạo Incident |
| `409 INVALID_TRIP_STATE` | Trip không cho phép tạo Incident |
| `409 INCIDENT_ORDER_NOT_IN_TRIP` | Có Order bị ảnh hưởng không thuộc Trip |
| `409 IDEMPOTENCY_PAYLOAD_MISMATCH` | Cùng key nhưng payload khác |

## M3.8.1 Driver Stop Execution Offline Hardening - CURRENT

Các endpoint thực tế dành riêng cho role `DRIVER`:

- `POST /driver/trips/:id/start`
- `POST /driver/trips/:tripId/stops/:stopId/arrive`
- `POST /driver/trips/:tripId/stops/:stopId/complete`
- `POST /driver/trips/:id/complete`

M3.8.1 chỉ harden `ARRIVE_STOP` và `COMPLETE_STOP`. `START_TRIP` và `COMPLETE_TRIP` vẫn online-only trong MVP.

Request ARRIVE:

```json
{
  "idempotencyKey": "9c5c08b4-c49b-4539-91b8-4d976c2cf967",
  "expectedTripVersion": 5,
  "occurredAt": "2026-11-18T08:30:00.000Z"
}
```

Request COMPLETE_STOP bổ sung cùng `occurredAt` bên cạnh `tasks`, `deliveryResult`, `reasonCode`, `note` và `recipientName` hiện có.

- `occurredAt` là thời điểm nghiệp vụ tài xế thao tác trên thiết bị; `ExecutionEvent.receivedAt` và các `createdAt` vẫn là thời điểm server persist.
- Trong giai đoạn tương thích với Mobile M3.4, trường này optional và thiếu thì Backend dùng server time. Mobile Offline Queue M3.8.2 bắt buộc phải gửi và giữ nguyên giá trị khi retry.
- Khi được gửi, giá trị phải là ISO-8601 nghiêm ngặt, không quá 24 giờ trong quá khứ, không quá 5 phút trong tương lai, không trước `Trip.actualStartTime`; COMPLETE_STOP không được trước `TripStop.actualArrivalTime`. Bằng arrival time được chấp nhận.
- Timestamp ngoài policy trả `400 INVALID_COMMAND_TIMESTAMP`. Trip `IN_PROGRESS` thiếu `actualStartTime`, hoặc Stop `ARRIVED` thiếu `actualArrivalTime`, trả `409 DATA_INTEGRITY_CONFLICT`.
- ARRIVE dùng business time cho `TripStop.actualArrivalTime` và `ExecutionEvent.occurredAt`.
- COMPLETE_STOP dùng business time cho `TripStop.actualDepartureTime`, `ExecutionEvent.occurredAt`, `DeliveryAttempt.occurredAt` và `OrderEvent.occurredAt`.
- `occurredAt` đã chuẩn hóa UTC nằm trong canonical idempotency hash. Cùng key và cùng instant/payload replay kết quả cũ; cùng key nhưng instant khác trả `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Response giữ nguyên: ARRIVE/COMPLETE trả `tripVersion`, Stop state/time; COMPLETE DELIVERY trả thêm `deliveryAttempt.id`.

## M3.8.2 Mobile replay contract — CURRENT

Mobile luôn gửi `occurredAt` cho ARRIVE/COMPLETE và dùng persist-first. Queue phân biệt:

- `NEVER_SENT`: được refetch Trip và kiểm tra precondition trước lần gửi đầu; chỉ rebase khi version mới chính là version trả về từ command trước trong cùng local chain.
- `SENT_UNCERTAIN`: replay exact request, không đổi key, payload, `occurredAt` hoặc `wireExpectedVersion`.

Phân loại client:

| Kết quả | Queue state |
|---|---|
| Network, timeout, 429, 5xx | `RETRY_WAIT` với backoff có giới hạn |
| 401 | `AUTH_PAUSED`, giữ dữ liệu chờ đăng nhập lại đúng owner |
| Version/state/sequence/timestamp conflict | `CONFLICT`, descendants `BLOCKED` |
| 400 khác, 403, 404, ownership/idempotency mismatch | `FAILED`, descendants `BLOCKED` |
| Success + authoritative refetch | `SYNCED`, sau đó cleanup row |

Không có batch endpoint hay command-status endpoint mới. Backend contract M3.8.1 không thay đổi.

## M3.8.4 Complete Trip e-POD precondition — CURRENT

`POST /driver/trips/:id/complete` giữ nguyên request/response thành công. Backend bổ sung precondition:

- Mọi Stop/task đã được xử lý và Delivery Stop có DeliveryAttempt.
- Với DeliveryAttempt yêu cầu ảnh, phải tồn tại `PodFile` loại `PHOTO`, trạng thái `UPLOADED` và chưa bị một file uploaded khác thay thế.
- Thiếu ảnh bắt buộc trả `409 POD_REQUIRED`; Trip status/version/actualEndTime không thay đổi và command transaction rollback.
- Signature không phải precondition Complete Trip.
