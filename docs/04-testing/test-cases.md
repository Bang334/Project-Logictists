# Test Cases - Customer Authentication M1

## 1. Phạm vi và môi trường

- Unit test dùng Jest, mock Prisma/JWT nhưng dùng bcrypt thật ở các kiểm tra hash/login.
- Integration test dùng Nest application thật, Prisma thật và PostgreSQL test riêng qua `TEST_DATABASE_URL`.
- Script `npm run test:postgres` có guard: URL phải khác database phát triển và tên database phải chứa `test`.
- Ngày 2026-11-14, năm migration hiện có đã được áp dụng bằng `prisma migrate deploy` vào PostgreSQL test local `tms_auth_test`; không tạo/sửa migration và không dùng `migrate reset` hoặc `db push`.

## 2. Ma trận test M1

| ID | Tình huống | Cấp test | Kỳ vọng |
|---|---|---|---|
| AUTH-01 | Đăng ký hợp lệ | Unit + PostgreSQL | 201; đúng một User CUSTOMER và Customer liên kết; hash hợp lệ; không lộ password |
| AUTH-02 | Username trùng | Unit + PostgreSQL | 409 `USERNAME_ALREADY_EXISTS` |
| AUTH-03 | Email trùng | Unit + PostgreSQL | 409 `EMAIL_ALREADY_EXISTS` theo unique của User |
| AUTH-04 | Phone trùng | Unit + PostgreSQL | 409 `PHONE_ALREADY_EXISTS` theo unique của Customer |
| AUTH-05 | Input sai | DTO + PostgreSQL | 400, không ghi dữ liệu |
| AUTH-06 | Role/branch/customer injection | DTO + PostgreSQL | 400; không thể tự gán quyền/scope |
| AUTH-07 | Customer insert thất bại | Unit + PostgreSQL | Transaction lỗi; User trung gian bị rollback |
| AUTH-08 | Hai đăng ký đồng thời | PostgreSQL | Một 201, một 409; DB chỉ có một cặp record |
| AUTH-09 | Login đúng/sai mật khẩu | Unit + PostgreSQL | Có JWT hoặc 401 tương ứng |
| AUTH-10 | User inactive | Unit + PostgreSQL | 401 |
| AUTH-11 | Profile | Unit + PostgreSQL | Có Customer liên kết, không có password |
| AUTH-12 | JWT hợp lệ/không hợp lệ | Unit strategy + PostgreSQL HTTP | 200/401 tương ứng |
| AUTH-13 | CUSTOMER thiếu relation | Unit + PostgreSQL | 409 `CUSTOMER_PROFILE_NOT_FOUND` |

## 3. Kết quả thực tế ngày 2026-11-14

| Lệnh | Kết quả |
|---|---|
| `npx jest --runInBand test/auth/auth.dto.spec.ts test/auth/auth.service.spec.ts test/auth/jwt.strategy.spec.ts` | PASS: 3 suites, 17 tests |
| `npx jest --runInBand test/auth/customer-auth.postgres.spec.ts` | PASS: 1 suite, 9 tests |
| `npm run test:postgres` | PASS: 4 suites, 13 tests |
| `npm test -- --runInBand` | PASS: 40 suites, 158 tests; 0 failed, 0 skipped |
| `npx eslint` trên các file source M1 | PASS |
| `npm run build` | PASS |

PostgreSQL integration test đã chạy trên container `postgres:16-alpine`, database local `tms_auth_test` qua `127.0.0.1:55433`. `DATABASE_URL` và `DIRECT_URL` chỉ được override trong tiến trình migration/test; URL Supabase trong `.env` không bị thay đổi.

## 4. Cách chạy

```powershell
cd backend
npm ci
npm run build
npm test -- --runInBand test/auth
```

Để chạy PostgreSQL integration test, cấu hình `TEST_DATABASE_URL` trỏ tới database test đã có schema, sau đó:

```powershell
npm run test:postgres
```

Không đặt `TEST_DATABASE_URL` bằng `DATABASE_URL` phát triển.

## 5. Mobile automated test và Android manual test

### 5.1 Automated test

| Hạng mục | Kết quả thực tế |
|---|---|
| Mobile Jest | PASS: 4 suites, 13/13 tests |
| TypeScript strict check | PASS |
| ESLint | PASS |
| Expo Doctor | PASS: 20/20 checks |
| Android production bundle | PASS |

Các test Mobile tự động bao phủ validation đăng ký/đăng nhập, auth reducer, khôi phục phiên trong `AuthProvider`, xử lý HTTP/network error, Bearer token và bảo đảm request đăng ký/đăng nhập không tự retry.

### 5.2 Manual test trên Android thật

Ngày 2026-11-14, người dùng đã kiểm thử trực tiếp ứng dụng bằng Expo Go trên điện thoại Android thật với Backend NestJS và PostgreSQL test local.

| ID | Kịch bản thủ công | Kết quả |
|---|---|---|
| MOB-AUTH-01 | Đăng ký Customer hợp lệ | PASS |
| MOB-AUTH-02 | Đăng nhập đúng thông tin | PASS |
| MOB-AUTH-03 | Đóng/mở ứng dụng và khôi phục JWT/profile từ SecureStore | PASS |
| MOB-AUTH-04 | Đăng xuất và quay về màn hình Login | PASS |
| MOB-AUTH-05 | Validation dữ liệu đăng ký/đăng nhập | PASS |
| MOB-AUTH-06 | Đăng ký tài khoản đã tồn tại | PASS |
| MOB-AUTH-07 | Đăng nhập sai mật khẩu | PASS |
| MOB-AUTH-08 | Mất kết nối mạng và hiển thị lỗi phù hợp | PASS |

Manual test chứng minh luồng giao diện và tích hợp trên thiết bị thật. Jest chứng minh hành vi đơn vị/component trong môi trường test; hai loại bằng chứng không thay thế lẫn nhau.

## 6. Kết luận M1

- Backend PostgreSQL integration: PASS 13/13.
- Backend regression: PASS 158/158.
- Mobile Jest: PASS 13/13.
- Android manual test: PASS toàn bộ checklist M1 nêu trên.
- M1 Customer Authentication đủ điều kiện đóng phạm vi; Order ownership chưa thuộc M1 và phải được triển khai, kiểm thử riêng trong M2.

## 7. M2.0 Authorization Hardening - kết quả 2026-11-15

### Automated authorization tests

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| AUTHZ-01 | API vận hành thiếu JWT | PostgreSQL HTTP | PASS: `401` |
| AUTHZ-02 | CUSTOMER gọi Orders/Customers/Trips/Branches/Vehicles/Drivers | PostgreSQL HTTP | PASS: toàn bộ `403` |
| AUTHZ-03 | STAFF gọi Transport Orders | PostgreSQL HTTP | PASS: `403` |
| AUTHZ-04 | DISPATCHER thiếu branch | Unit + PostgreSQL HTTP | PASS: `403`, không query không filter |
| AUTHZ-05 | DISPATCHER query branch khác | PostgreSQL HTTP | PASS: `403` |
| AUTHZ-06 | DISPATCHER đọc Order cùng/khác branch theo ID | PostgreSQL HTTP | PASS: `200/403` |
| AUTHZ-07 | ADMIN đọc Order liên branch | PostgreSQL HTTP | PASS: `200` |
| AUTHZ-08 | Generic PATCH gửi `status` | DTO + PostgreSQL HTTP | PASS: `400`, trạng thái DB không đổi |
| AUTHZ-09 | Generic PATCH cùng/khác branch | PostgreSQL HTTP | PASS: `200/403` |
| AUTHZ-10 | Branch list/detail của DISPATCHER | PostgreSQL HTTP | PASS: chỉ branch được gán |
| AUTHZ-11 | Role metadata của sáu controller vận hành | Unit | PASS |
| AUTHZ-12 | DRIVER vẫn có metadata quyền load plan hiện hữu | Unit | PASS |

### Lệnh và kết quả thực tế

| Lệnh | Kết quả |
|---|---|
| `npx jest --runInBand test/auth/branch-scope.spec.ts test/auth/transport-role-matrix.spec.ts` | PASS: 2 suites, 19 tests |
| `npx jest --runInBand test/auth/transport-authorization.postgres.spec.ts` sau database safety gate | PASS: 1 suite, 15 tests |
| `npm run test:postgres` | PASS: 5 suites, 28 tests |
| `npm test -- --runInBand --silent` | PASS: 42 suites, 184 tests |
| `npm run lint` | PASS |
| `npm run build` | PASS |

Không chạy migration, `migrate reset`, `db push` hoặc tác động database remote. Integration test chỉ tạo fixture có prefix ngẫu nhiên trong PostgreSQL test local và xóa đúng fixture của suite.

## 8. M2.1 Customer Order Read API - kết quả 2026-11-15

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| ORD-READ-01 | CUSTOMER list/detail Order của mình | Unit + PostgreSQL HTTP | PASS |
| ORD-READ-02 | Customer A đọc Order B | PostgreSQL HTTP | PASS: `404` |
| ORD-READ-03 | Order không tồn tại | PostgreSQL HTTP | PASS: `404` giống cross-owner |
| ORD-READ-04 | ADMIN/DISPATCHER/STAFF/DRIVER gọi Customer API | Guard + PostgreSQL HTTP | PASS: `403` |
| ORD-READ-05 | Thiếu/sai JWT | PostgreSQL HTTP | PASS: `401` |
| ORD-READ-06 | CUSTOMER thiếu Customer relation | Unit + PostgreSQL HTTP | PASS: `409/CUSTOMER_PROFILE_NOT_FOUND` |
| ORD-READ-07 | Defaults, status filter và pagination | DTO + PostgreSQL HTTP | PASS |
| ORD-READ-08 | page/limit/status sai | DTO + PostgreSQL HTTP | PASS: `400` |
| ORD-READ-09 | Injection `customerId`/`branchId` | DTO + PostgreSQL HTTP | PASS: `400` |
| ORD-READ-10 | Stable sort và ownership trong Prisma query | Unit + PostgreSQL HTTP | PASS |
| ORD-READ-11 | Mapping line/unit weight, volume và stop sequence | Unit + PostgreSQL HTTP | PASS |
| ORD-READ-12 | Không lộ totalAmount/payment/customerId/branchId | Unit + PostgreSQL HTTP | PASS |
| ORD-READ-13 | `/orders` Web Admin vẫn hoạt động | PostgreSQL HTTP + regression | PASS |

Kết quả thực tế:

- Unit mục tiêu: PASS 24/24 thuộc 4 suite.
- M2.1 PostgreSQL integration: PASS 18/18.
- Toàn bộ PostgreSQL integration: PASS 46/46 thuộc 6 suite.
- Backend regression: PASS 218/218 thuộc 46 suite.
- ESLint và Nest build: PASS.

Không chạy migration/reset/db push. Fixture M2.1 dùng prefix ngẫu nhiên và được xóa đúng phạm vi sau suite.

## 9. M2.2 Customer Create Order - kết quả 2026-11-15

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| ORD-CREATE-01 | CUSTOMER lấy danh sách Branch active, response allowlist/sort ổn định | Unit + PostgreSQL HTTP | PASS |
| ORD-CREATE-02 | ADMIN/DISPATCHER/STAFF/DRIVER hoặc thiếu/sai JWT | PostgreSQL HTTP | PASS: `403/401` |
| ORD-CREATE-03 | Tạo DRAFT với đúng pickup/delivery/items/totals | Unit + PostgreSQL HTTP | PASS |
| ORD-CREATE-04 | Branch inactive/không tồn tại | PostgreSQL HTTP | PASS: `400`, không có command mồ côi |
| ORD-CREATE-05 | Branch active nhưng pickup khác khu vực | PostgreSQL HTTP | PASS: tạo DRAFT, chờ kiểm tra thủ công |
| ORD-CREATE-06 | CUSTOMER thiếu Customer relation | PostgreSQL HTTP | PASS: `409/CUSTOMER_PROFILE_NOT_FOUND` |
| ORD-CREATE-07 | Injection customerId/status/totalAmount/orderNumber | DTO + PostgreSQL HTTP | PASS: `400` |
| ORD-CREATE-08 | Biên quantity/weight/dimensions/items, tọa độ, phone, NaN/Infinity | DTO unit + HTTP | PASS |
| ORD-CREATE-09 | Backend tự tính line/Order weight và volume | Unit + PostgreSQL | PASS |
| ORD-CREATE-10 | Cùng key/cùng payload tuần tự và đồng thời | PostgreSQL | PASS: cùng một Order |
| ORD-CREATE-11 | Cùng key/khác payload | PostgreSQL HTTP | PASS: `409` |
| ORD-CREATE-12 | Nhiều key tạo đồng thời | PostgreSQL HTTP | PASS: ID/orderNumber duy nhất |
| ORD-CREATE-13 | Lỗi OrderEvent sau khi đã create Order/Command | PostgreSQL transaction | PASS: rollback cả Order và Command |
| ORD-CREATE-14 | Event đúng actor; không tạo Package/Trip | PostgreSQL | PASS |
| ORD-CREATE-15 | DRAFT không vào available-for-dispatch; M2.1 vẫn đọc được | PostgreSQL HTTP | PASS |

Kết quả mục tiêu trước regression:

- DTO/service unit M2.2: PASS 23/23 thuộc 2 suite.
- PostgreSQL M2.2: PASS 18/18 thuộc 1 suite.
- Không chạy migration, reset, db push; không truy cập database remote.

Kết quả complete suite:

- Toàn bộ PostgreSQL integration: PASS 64/64 thuộc 7 suite.
- Backend regression: PASS 255/255 thuộc 48 suite.
- `npm run lint`: PASS.
- `npm run build`: PASS.

Các log lỗi Mapbox/Optimization/Outbox xuất hiện trong regression là dữ liệu của test chủ động mô phỏng nhánh lỗi; các suite tương ứng PASS.

## 10. M2.4 Mobile Customer Transport Order - kết quả 2026-11-15

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| MOB-ORDER-01 | Validation biên quantity/weight/dimensions/items/tọa độ/phone | Jest unit | PASS |
| MOB-ORDER-02 | Chuẩn hóa phone, chuỗi và mapping form sang request | Jest unit | PASS |
| MOB-ORDER-03 | Parse list/detail/create response theo allowlist | Jest service | PASS |
| MOB-ORDER-04 | Service gửi JWT, pagination, status và POST body đúng contract | Jest service | PASS |
| MOB-ORDER-05 | Response sai format hoặc thiếu SecureStore token | Jest service | PASS |
| MOB-ORDER-06 | Timeout rồi retry cùng payload giữ nguyên UUID | Jest hook | PASS |
| MOB-ORDER-07 | Sửa payload sau kết quả chưa rõ dùng UUID mới | Jest hook | PASS |
| MOB-ORDER-08 | Double tap chỉ gọi create service một lần | Jest hook | PASS |
| MOB-ORDER-09 | Customer Home điều hướng tới list/create route | Jest component | PASS |
| MOB-ORDER-10 | Customer API trả 401 thì đăng xuất; 403/409 giữ phiên và hiển thị lỗi | Jest hook | PASS |
| MOB-ORDER-11 | Callback reload/refresh ổn định qua render, không tạo vòng lặp `useFocusEffect` | Jest hook regression | PASS |

Kết quả thực tế:

- Test mục tiêu Orders: PASS 23/23 thuộc 6 suite.
- Toàn bộ Mobile Jest: PASS 36/36 thuộc 10 suite.
- TypeScript strict: PASS.
- ESLint: PASS.
- Expo Doctor: PASS 20/20.
- Android production bundle: PASS, 1183 modules.
- Manual Android M2.4 — luồng chính: **PASS**.

### Manual QA trên Android thật bằng Expo Go

| Tình huống | Kết quả |
|---|---|
| CUSTOMER đăng nhập và mở màn hình Đơn vận chuyển | PASS |
| List/load/filter/pull-to-refresh | PASS |
| Mở form và tải Branch active từ Backend | PASS |
| Tạo Order hợp lệ; Order mới ở DRAFT và xuất hiện trong list | PASS |
| Mở detail; pickup/delivery/items/quantity/weight/volume đúng | PASS |
| Không hiển thị `totalAmount` hoặc giá chưa báo | PASS |
| Validation form | PASS |
| Branch bị inactive đúng lúc Customer đang tạo Order | **NOT RUN** |
| Mất mạng/timeout trong POST rồi retry cùng idempotency key | **NOT RUN** |
| Server đã tạo Order nhưng Client mất response rồi retry | **NOT RUN** |
| End-to-end DRAFT → CONFIRMED → Trip | **BLOCKED bởi M2.3** |

Automated test chứng minh validation, mapping, idempotency hook và regression code; manual Android QA chứng minh luồng UI–API chính trên thiết bị thật. Ba tình huống NOT RUN không được suy diễn là PASS.

**Kết luận:** M2.4 hoàn thành trong phạm vi Customer Mobile hiện tại. Luồng duyệt và điều phối tiếp theo vẫn phụ thuộc M2.3 Confirm Order chưa được triển khai.

## 11. M3.1 Driver Assigned Trip Read API - kết quả 2026-11-15

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| DRV-READ-01 | DRIVER đọc list/detail Trip có assignment ASSIGNED | Unit + PostgreSQL HTTP | PASS |
| DRV-READ-02 | Trip Driver khác hoặc cùng branch nhưng khác assignment | PostgreSQL HTTP | PASS: 404 |
| DRV-READ-03 | Trip không tồn tại và DRAFT/PLANNED | PostgreSQL HTTP | PASS: 404 |
| DRV-READ-04 | DRIVER thiếu Driver profile | Unit + PostgreSQL HTTP | PASS: 409/DRIVER_PROFILE_NOT_FOUND |
| DRV-READ-05 | JWT thiếu/sai, User inactive | PostgreSQL HTTP | PASS: 401 |
| DRV-READ-06 | ADMIN/DISPATCHER/STAFF/CUSTOMER gọi `/driver/**` | PostgreSQL HTTP | PASS: 403 |
| DRV-READ-07 | Injection driverId/branchId/userId và query sai | DTO + PostgreSQL HTTP | PASS: 400 |
| DRV-READ-08 | Filter, pagination, total và sort ổn định | Unit + PostgreSQL | PASS |
| DRV-READ-09 | Nhiều assignment không duplicate Trip; assignment không ASSIGNED không cấp quyền | PostgreSQL | PASS |
| DRV-READ-10 | Stops sequence, LOAD/UNLOAD, Package BigInt sang kg/cm JSON-safe | PostgreSQL HTTP | PASS |
| DRV-READ-11 | Response không lộ Customer/pricing/planningSnapshot/routeGeometry | PostgreSQL HTTP | PASS |
| DRV-READ-12 | DRIVER bị chặn generic load-plan; ADMIN/DISPATCHER không regression | Role metadata + PostgreSQL HTTP | PASS |

Kết quả thực tế:

- M3.1 PostgreSQL mục tiêu: PASS 22/22 thuộc 1 suite.
- Unit/authorization mục tiêu: PASS 23/23 thuộc 2 suite.
- Toàn bộ PostgreSQL integration: PASS 86/86 thuộc 8 suite.
- Regression không-PostgreSQL: PASS 206/206 thuộc 42 suite.
- Tổng tập Backend đã chạy: PASS 292/292 thuộc 50 suite.
- ESLint source/Prisma: PASS.
- Nest build: PASS.
- Không migration/reset/db push; database test local được bảo vệ bởi `require-test-database.cjs`.

## 12. M3.2 Mobile Driver Trip List/Detail - kết quả 2026-11-15

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| MOB-DRV-01 | Parse list response, pagination/status query, không gửi driverId/branchId | Jest service | PASS |
| MOB-DRV-02 | Parse detail, sort stop sequence, LOAD/UNLOAD và package metrics | Jest service | PASS |
| MOB-DRV-03 | Response allowlist không giữ Customer/pricing/planningSnapshot/routeGeometry | Jest service | PASS |
| MOB-DRV-04 | Response sai status/shape hoặc thiếu SecureStore token | Jest service | PASS |
| MOB-DRV-05 | Filter status, pagination nối trang và loại ID trùng | Jest hook | PASS |
| MOB-DRV-06 | Empty/error/loading và reload/refresh callback ổn định | Jest hook | PASS |
| MOB-DRV-07 | 401 logout; 403 giữ phiên; 404 dùng thông báo chung | Jest hook | PASS |
| MOB-DRV-08 | 409 DRIVER_PROFILE_NOT_FOUND có thông báo rõ | Jest hook | PASS |
| MOB-DRV-09 | List điều hướng sang detail | Jest component | PASS |
| MOB-DRV-10 | Detail render stop sequence, task và package weight/dimensions | Jest component | PASS |

Kết quả thực tế:

- Target Driver Trips: PASS 15/15 thuộc 4 suite.
- Toàn bộ Mobile Jest: PASS 51/51 thuộc 14 suite.
- TypeScript strict: PASS.
- ESLint: PASS.
- Expo Doctor: PASS 20/20.
- Android production bundle: PASS, 1194 modules.
- Manual Android với tài khoản DRIVER và Trip thật: **NOT RUN**.

Automated test và Android export không thay thế manual QA trên thiết bị. Cần fixture User DRIVER liên kết Driver profile, assignment `ASSIGNED` và Trip Driver-visible trước khi kiểm thử Expo Go.
## 13. M3.4 Mobile Driver Execution - kết quả đóng milestone 2026-11-16

### 13.1 Automated tests

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| DRV-EXEC-01 | Driver chỉ đọc Trip được phân công và response đúng contract | Backend unit | PASS trong bộ Driver mục tiêu 29/29 |
| DRV-EXEC-02 | PRIMARY Driver thực hiện start/arrive/complete stop/complete trip | Backend unit | PASS trong bộ Driver mục tiêu 29/29 |
| DRV-EXEC-03 | Role/ownership, thứ tự stop, state và optimistic version bị kiểm tra | Backend unit | PASS trong bộ Driver mục tiêu 29/29 |
| DRV-EXEC-04 | Mobile service gọi đúng execution API, không tự gửi driverId/branchId | Mobile Jest | PASS trong regression 78/78 |
| DRV-EXEC-05 | Hook giữ idempotency key khi kết quả chưa rõ, khóa double tap và refetch sau mutation | Mobile Jest | PASS trong regression 78/78 |
| DRV-EXEC-06 | UI hiển thị action theo Trip/Stop state và validate quantity/delivery result | Mobile Jest | PASS trong regression 78/78 |

Kiểm tra tĩnh mới nhất khi đóng tài liệu: Mobile TypeScript và ESLint **PASS**. Automated tests kiểm tra logic cô lập và contract; chúng không thay thế kiểm thử thiết bị thật.

### 13.2 PostgreSQL integration

| ID | Tình huống | Kết quả |
|---|---|---|
| DRV-PG-01 | User DRIVER liên kết Driver profile và assignment `ASSIGNED` đọc đúng Trip | PASS |
| DRV-PG-02 | Chỉ PRIMARY Driver được mutation; Driver khác/RELIEF không được thực thi | PASS |
| DRV-PG-03 | `DISPATCHED → IN_PROGRESS → COMPLETED`, Stop/Task/Package/Order cập nhật trong transaction | PASS |
| DRV-PG-04 | Command retry cùng key/payload trả cùng kết quả; khác payload bị từ chối | PASS |
| DRV-PG-05 | Trip version stale, stop sai thứ tự và trạng thái sai bị từ chối | PASS |
| DRV-PG-06 | Delivery SUCCESS/PARTIAL/FAILED tạo `DeliveryAttempt` đúng dữ liệu hiện có | PASS |

Bộ PostgreSQL mục tiêu Driver Trip Read + Execution chạy mới nhất: **34/34 PASS**. Database test local riêng được sử dụng; không chạy migration/reset/db push trong lần đóng tài liệu.

### 13.3 Android manual QA

Manual QA bằng Expo Go trên thiết bị Android thật:

| Luồng | Kết quả |
|---|---|
| Login bằng tài khoản DRIVER PRIMARY | PASS |
| Mở Trip `DISPATCHED` được phân công | PASS |
| Start Trip | PASS |
| Arrive Stop theo thứ tự | PASS |
| Complete Pickup | PASS |
| Complete Delivery | PASS |
| Complete Depot stop | PASS |
| Complete Trip | PASS |
| Refetch hiển thị đúng state/version mới | PASS |
| UI execution hoạt động ổn định trên thiết bị thật | PASS |

### 13.4 Kết luận và giới hạn

M3.4 **hoàn thành trong phạm vi Driver Execution MVP**. Các hạng mục sau không thuộc M3.4 và chưa được đánh dấu hoàn thành: e-POD, GPS background, Incident, offline queue/sync, Driver-specific load-plan và map navigation.

End-to-end `Customer DRAFT → CONFIRMED → Optimizer/Trip → Driver` vẫn chưa thể nghiệm thu trọn vẹn vì M2.3 Confirm Order chưa hoàn thành.

## 14. M3.5 Driver e-POD - kết quả 2026-11-16

### 14.1 Automated tests

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| POD-01 | PRIMARY Driver upload JPEG PHOTO và PNG SIGNATURE hợp lệ | PostgreSQL integration | PASS |
| POD-02 | Driver khác, RELIEF, role khác, JWT thiếu/sai và ownership mismatch bị chặn | PostgreSQL integration | PASS |
| POD-03 | MIME/magic bytes, file rỗng, PHOTO >5 MiB và SIGNATURE >2 MiB bị từ chối | PostgreSQL integration | PASS |
| POD-04 | Retry cùng key/payload trả cùng PodFile; đổi payload bị `409` | PostgreSQL integration | PASS |
| POD-05 | Hai upload đồng thời không tạo hai PodFile | PostgreSQL integration | PASS |
| POD-06 | Provider lỗi không đánh dấu `UPLOADED`; retry có thể reconcile asset đã tồn tại | PostgreSQL integration | PASS |
| POD-07 | GET metadata dùng allowlist và hoạt động khi Trip đã `COMPLETED` | PostgreSQL integration | PASS |
| POD-08 | Validation Mobile cho evidence type/file và mapping response | Mobile Jest | PASS |
| POD-09 | Hook giữ idempotency khi kết quả chưa rõ, khóa double tap và không auto retry | Mobile Jest | PASS |
| POD-10 | UI camera-only, chữ ký tùy chọn, loading/error/retry/status | Mobile Jest | PASS |
| POD-11 | Preview local, chụp lại/hủy trước upload và chỉ upload khi xác nhận | Mobile Jest | PASS |
| POD-12 | Thay PHOTO/SIGNATURE giữ file cũ bằng `supersedesId` | PostgreSQL integration | PASS |
| POD-13 | Signed URL 5 phút đúng ownership và tải được private asset | Integration + kiểm tra provider thật | PASS |

Kết quả chạy thực tế:

- M3.5 PostgreSQL integration: **18/18 PASS**.
- Toàn bộ Backend PostgreSQL integration: **116/116 PASS**, 10 suite.
- Backend regression không-PostgreSQL: **222/222 PASS**, 44 suite.
- Backend ESLint và Nest build: **PASS**.
- Mobile Jest regression: **97/97 PASS**, 21 suite.
- Mobile TypeScript strict và ESLint: **PASS**.
- Expo Doctor: **20/20 PASS**.
- Android production bundle: **PASS**, 1221 modules.

### 14.2 Manual Android và Cloudinary verification

Manual QA bằng Expo Go trên thiết bị Android thật:

| Luồng | Kết quả |
|---|---|
| Chụp PHOTO trực tiếp bằng camera và upload | PASS |
| Ký bằng một ngón tay và upload SIGNATURE | PASS |
| Mở lại màn hình/app và khôi phục metadata POD từ Backend | PASS |
| Chủ động retry sau lỗi | PASS |
| PostgreSQL ghi nhận PodFile ở trạng thái `UPLOADED` | PASS |
| Cloudinary có asset `authenticated` thực tế cho PHOTO/SIGNATURE | PASS |

Kiểm tra tích hợp ngoài thiết bị cũng xác nhận signed URL 5 phút tải được private asset với HTTP 200. Các PodFile `FAILED` chỉ dùng trong manual test đã được dọn khỏi PostgreSQL local/test; không tác động dữ liệu production.

Các ca preview/chụp lại/hủy trước upload, thay thế file đã upload và xem signed URL mới có automated coverage nhưng chưa được ghi nhận là manual Android PASS riêng. Ca mất mạng đúng thời điểm provider đã nhận file nhưng client chưa nhận response cũng chưa chạy thủ công; nhánh reconciliation đã PASS trong PostgreSQL integration test.

### 14.3 Kết luận và giới hạn

M3.5 **hoàn thành trong phạm vi Driver e-POD MVP**. Automated tests, manual Android QA và kiểm tra Cloudinary/PostgreSQL thật được ghi tách biệt; kết quả của lớp này không được dùng thay bằng chứng cho lớp khác.

M3.5 không bao gồm GPS tracking nền, Incident, offline execution queue, Customer live tracking hoặc M2.3 Confirm Order. Vì vậy chưa thể tuyên bố toàn bộ luồng Customer-to-Driver end-to-end đã hoàn thành.

## 15. M3.6B Backend GPS Ingest & Latest Position - kết quả 2026-11-17

### 15.1 Automated tests

| ID | Tình huống | Cấp test | Kết quả |
|---|---|---|---|
| GPS-01 | PRIMARY Driver gửi batch 1-20 điểm cho Trip `IN_PROGRESS` | Unit + PostgreSQL integration | PASS |
| GPS-02 | Backend derive Driver/Vehicle/Trip và đổi `speedMps` sang `speedKph` | Unit + PostgreSQL integration | PASS |
| GPS-03 | Retry và hai request đồng thời được dedupe bởi unique key trong PostgreSQL | PostgreSQL integration | PASS |
| GPS-04 | Một device session không được dùng chéo Driver/Trip/Vehicle | Unit + PostgreSQL integration | PASS |
| GPS-05 | Driver khác, RELIEF, role khác, JWT thiếu và Driver profile thiếu bị chặn | PostgreSQL integration | PASS |
| GPS-06 | Trip sai trạng thái bị chặn; backlog `COMPLETED` chỉ nhận trong cửa sổ cho phép | PostgreSQL integration | PASS |
| GPS-07 | Latitude/longitude/accuracy/speed/heading, batch, future timestamp và field injection được validate | Unit + PostgreSQL integration | PASS |
| GPS-08 | Điểm đến muộn vẫn lưu nhưng không làm `Vehicle.lastLocationAt` lùi | PostgreSQL integration | PASS |
| GPS-09 | ADMIN/DISPATCHER xem latest đúng branch; role khác bị chặn | PostgreSQL integration | PASS |
| GPS-10 | Chưa có GPS trả 404; latest quá 2 phút được đánh dấu stale | Unit + PostgreSQL integration | PASS |

Kết quả chạy thực tế:

- M3.6B unit mục tiêu: **17/17 PASS**.
- M3.6B PostgreSQL integration: **15/15 PASS**.
- Toàn bộ Backend PostgreSQL integration: **131/131 PASS**, 11 suite.
- Backend regression không-PostgreSQL: **239/239 PASS**, 45 suite.
- Backend ESLint, TypeScript check và Nest build: **PASS**.

PostgreSQL integration được chạy với `TEST_DATABASE_URL` trỏ tới database Docker local `tms_auth_test` tại `127.0.0.1:55433`. `DATABASE_URL` và `DIRECT_URL` chỉ được override trong tiến trình test; không chạy migration/reset/db push và không tác động Supabase.

### 15.2 Chưa kiểm thử trong M3.6B

- Mobile background GPS và quyền vị trí Android: **NOT RUN**, vì M3.6B chỉ triển khai Backend.
- Customer live tracking, WebSocket/realtime và bản đồ: **NOT IMPLEMENTED**.
- Đo tải/rate limit ở quy mô production: **NOT RUN**; endpoint không phụ thuộc rate để đảm bảo tính đúng nghiệp vụ.

## 16. M3.6C Mobile Driver Background GPS - kết quả 2026-11-17

### 16.1 Automated verification

| ID | Tình huống | Kết quả |
|---|---|---|
| MOB-GPS-01 | deviceCode tạo một lần và persist bằng SecureStore | PASS |
| MOB-GPS-02 | Trip/session restore, sequence tăng qua nhiều callback | PASS |
| MOB-GPS-03 | Mapping Location, loại số invalid và không gửi altitude | PASS |
| MOB-GPS-04 | Batch tối đa 20, đúng sequence, accepted/duplicate cleanup | PASS |
| MOB-GPS-05 | Network error giữ queue, backoff và không retry loop | PASS |
| MOB-GPS-06 | 400 drop poison batch; 401/404/409 dừng session phù hợp | PASS |
| MOB-GPS-07 | START success mới bật tracking; COMPLETE timeout reconcile | PASS |
| MOB-GPS-08 | Permission denied và background-denied foreground fallback | PASS |
| MOB-GPS-09 | Restore IN_PROGRESS/COMPLETED, logout và user-switch cleanup | PASS |
| MOB-GPS-10 | UI hiển thị mode, pending, last sync, warning và Settings | PASS |
| MOB-GPS-11 | Không log JWT hoặc raw coordinate trong engine | PASS |

- M3.6C target Jest: **37/37 PASS**, 6 suite.
- Toàn bộ Mobile Jest: **128/128 PASS**, 26 suite.
- TypeScript strict và ESLint: **PASS**.
- Expo Doctor: **20/20 PASS**; dependency check: **PASS**.
- Android production JS export: **PASS**, 1280 modules.

### 16.2 Manual Android development build

**PASS.** Development APK đã chứng minh background/screen-off, offline/reconnect, app reopen, completion không sinh point mới, logout/resume và revoke permission trên Android thật. PostgreSQL local xác nhận dữ liệu GPS thực tế.

### 16.3 GPS state/UI hardening sau manual QA

Sau khi Backend đã nhận GPS thành công nhưng Mobile vẫn hiện `SYNC_ERROR`, đã bổ sung các ca hồi quy:

| ID | Tình huống | Kết quả |
|---|---|---|
| MOB-GPS-12 | Không chạy restore chồng khi Android còn mở luồng xin quyền vị trí | PASS |
| MOB-GPS-13 | Cấp lại quyền nền sẽ xóa warning quyền cũ trong session | PASS |
| MOB-GPS-14 | Session đã sync thành công sẽ thoát `SYNC_ERROR` và trở lại `BACKGROUND` | PASS |
| MOB-GPS-15 | UI chỉ báo queue đầy khi nhận đúng `GPS_QUEUE_LIMIT_REACHED` | PASS |

- Focused service/component Jest: **14/14 PASS**, 2 suite.
- Toàn bộ Mobile Jest sau hardening: **132/132 PASS**, 26 suite.
- TypeScript strict và ESLint: **PASS**.
- Android production JS export sau hardening: **PASS**, 1280 modules.
- Retest giao diện trên Android thật sau bản sửa: **NOT RUN**, cần người dùng xác nhận lại.

### 16.4 SQLite contention khi app trở lại foreground

Manual QA phát hiện TaskManager trả `Error code 5: database is locked` khi callback GPS nền và luồng restore/flush cùng truy cập SQLite. Bản sửa bổ sung `busy_timeout`, retry giới hạn cho `SQLITE_BUSY`, tuần tự hóa thao tác ghi và task-boundary không reject.

| ID | Tình huống | Kết quả |
|---|---|---|
| MOB-GPS-16 | Thao tác ghi gặp `database is locked` được retry giới hạn | PASS |
| MOB-GPS-17 | Hai thao tác ghi đồng thời được thực thi tuần tự | PASS |
| MOB-GPS-18 | TaskManager resolve an toàn khi collection hoặc ghi error state thất bại | PASS |

- Focused SQLite/TaskManager/service/panel Jest: **19/19 PASS**, 4 suite.
- Toàn bộ Mobile Jest: **137/137 PASS**, 28 suite.
- TypeScript strict và ESLint không warning: **PASS**.
- Manual đóng/mở ứng dụng Android sau bản sửa contention: **PASS** trên Android thật.
- Trip `QA-DRIVER-20261117042151-83V9` hoàn thành thành công: PostgreSQL local xác nhận `COMPLETED`, **54 GPS points**, điểm cuối được nhận trước `actualEndTime` và **0** điểm được đo/nhận sau completion.
- Offline/reconnect, logout và revoke permission vẫn cần biên bản manual riêng nếu chưa thực hiện.

### 16.5 Manual QA permission, reconnect và logout

| Tình huống | Quan sát thực tế | Kết luận |
|---|---|---|
| Mất mạng rồi bật lại | Pending 2 biến mất, `lastSyncAt` đổi 13:25:07 → 13:25:56; Backend tiếp tục nhận GPS | PASS |
| Thu hồi quyền vị trí | Mobile hiển thị cảnh báo quyền đúng | PASS |
| Logout khi Trip đang chạy | Tracking dừng; đến 13:06 không có point mới sau point nhận lúc 12:38:46 | PASS |

Sau đăng nhập lại, Trip vẫn `IN_PROGRESS` nhưng tracking hiển thị `Chưa bắt đầu`. Đây là khoảng trống resume-after-login: logout xóa local session/queue theo privacy policy, còn lifecycle hiện chỉ restore session có sẵn và chưa tạo session mới cho Trip đang chạy.

### 16.6 Resume tracking after login hardening

Đã bổ sung luồng kiểm tra Trip `IN_PROGRESS` khi Driver đăng nhập mà không còn local tracking session. Chỉ khi có đúng một Trip, Mobile hỏi tài xế; đồng ý mới tạo session UUID mới và xin quyền tracking. Không khôi phục backlog đã bị xóa và không tự chọn nếu có nhiều Trip.

| ID | Tình huống | Kết quả automated |
|---|---|---|
| MOB-GPS-19 | Có đúng một Trip đang chạy và tài xế đồng ý resume | PASS |
| MOB-GPS-20 | Tài xế chọn để sau, không hỏi lặp trong cùng phiên | PASS |
| MOB-GPS-21 | Đã restore được local session thì không gọi API tìm Trip | PASS |
| MOB-GPS-22 | Có nhiều Trip `IN_PROGRESS` thì không tự chọn | PASS |

- Toàn bộ Mobile Jest: **141/141 PASS**, 29 suite.
- TypeScript strict, ESLint và Android JS export 1280 modules: **PASS**.
- Manual Android resume-after-login: **PASS**; hộp thoại xuất hiện và session mới tiếp tục gửi GPS.

Nếu chọn `Để sau`, panel Trip `IN_PROGRESS` nay hiển thị nút `Bắt đầu tracking` để bật lại mà không cần logout. Automated test xác nhận có thể từ chối rồi bấm lại và đồng ý; manual Android cho nút mới này: **PASS**.

- Toàn bộ Mobile Jest sau bổ sung nút: **143/143 PASS**, 29 suite.
- TypeScript, ESLint và Android JS export 1280 modules: **PASS**.

Các luồng chức năng M3.6C đã manual PASS trên Android bằng development APK. PostgreSQL local xác nhận Trip `QA-DRIVER-20261117053302-OS3R` có 162 GPS points trên 6 session và điểm mới nhất được nhận trong vòng 27 giây trước lần kiểm tra; Trip đã hoàn thành không có point đo sau `actualEndTime`. Native background QA chính thức: **PASS**.

## 17. M3.6D.1 Customer Tracking Backend - kết quả 2026-11-17

| ID | Tình huống | Kết quả |
|---|---|---|
| CUS-TRACK-01 | Customer xem đầy đủ nhiều Trip của Order mình | PASS |
| CUS-TRACK-02 | Latest GPS lấy riêng theo từng Trip và stale sau 2 phút | PASS |
| CUS-TRACK-03 | Trip chưa có GPS trả `vehicleLocation: null` | PASS |
| CUS-TRACK-04 | Order chưa có Trip trả `200 NOT_ASSIGNED` | PASS |
| CUS-TRACK-05 | Order khác Customer và không tồn tại cùng trả 404 | PASS |
| CUS-TRACK-06 | Thiếu Customer relation trả 409 đúng error code | PASS |
| CUS-TRACK-07 | ADMIN/DISPATCHER/STAFF/DRIVER bị chặn | PASS |
| CUS-TRACK-08 | Không lộ Driver, device/session, route, stop khác hoặc Vehicle.currentLocation | PASS |

- Unit M3.6D.1: **4/4 PASS**.
- PostgreSQL M3.6D.1: **10/10 PASS**.
- Toàn bộ PostgreSQL integration: **141/141 PASS**, 12 suite.
- Backend regression không-PostgreSQL: **243/243 PASS**, 46 suite.
- ESLint và Nest build: **PASS**.
- Mobile Customer polling/UI: **IMPLEMENTED** trong M3.6D.2; automated PASS, manual Android chưa chạy.

## 18. M3.6D.2 Mobile Customer Tracking - kết quả 2026-11-17

| ID | Tình huống | Kết quả |
|---|---|---|
| MOB-CUS-TRACK-01 | Service gọi đúng endpoint và parse response nhiều Trip | PASS |
| MOB-CUS-TRACK-02 | Parser từ chối response sai status/cấu trúc/số không hữu hạn | PASS |
| MOB-CUS-TRACK-03 | `NOT_ASSIGNED` và `vehicleLocation: null` có UI phù hợp | PASS |
| MOB-CUS-TRACK-04 | Render đầy đủ nhiều Trip, status lạ có fallback | PASS |
| MOB-CUS-TRACK-05 | Phân biệt fresh, stale và vị trí cuối của Trip hoàn thành | PASS |
| MOB-CUS-TRACK-06 | Fetch ngay khi focus, polling mỗi 30 giây | PASS |
| MOB-CUS-TRACK-07 | Background/unmount dừng polling; foreground tải lại ngay | PASS |
| MOB-CUS-TRACK-08 | Polling lỗi giữ snapshot cũ và cho phép retry | PASS |
| MOB-CUS-TRACK-09 | Tracking lỗi không làm hỏng Order Detail | PASS |
| MOB-CUS-TRACK-10 | Manual Android với dữ liệu GPS thật | NOT RUN |

- Target M3.6D.2: **25/25 PASS**, 4 suite.
- Toàn bộ Mobile Jest: **164/164 PASS**, 32 suite.
- TypeScript, ESLint, Expo dependency check và Android production export: **PASS**.
- Expo Doctor: **20/20 PASS**.
- Manual Android chưa được thực hiện; không ghi nhận UI/polling thật là PASS ở thời điểm này.

## 19. M3.6D.3 Customer Tracking Integration & Android QA - 2026-11-17

### 19.1 Fixture-generated integration

| Case | Dữ liệu fixture/API local | Kết quả |
|---|---|---|
| A | Order không có StopTask/Trip → `NOT_ASSIGNED`, `trips: []` | PASS |
| B | Trip `IN_PROGRESS`, GPS mới dưới 2 phút → `isStale: false` | PASS |
| C | Trip `IN_PROGRESS`, GPS cũ hơn 2 phút, planned delivery null → stale + fallback input | PASS |
| D | Một Order liên kết hai Trip, mỗi Trip có GPS/stale riêng | PASS |
| E | Trip `COMPLETED` trả GPS cuối theo chính Trip | PASS |
| I | Customer B gọi tracking Order Customer A | PASS — 404 |

- Seed chạy hai lần giữ nguyên User/Customer/Order/Trip ID: **PASS**.
- Customer order list trả đủ 5 Order fixture của Customer A: **PASS**.
- Completed case không dùng `Vehicle.currentLocation`: **PASS**.
- API thật trên Backend tạm dùng PostgreSQL local: **PASS**.
- Target PostgreSQL `customer-order-tracking.postgres.spec.ts`: **10/10 PASS**.
- Dữ liệu GPS trong các case trên là **fixture-generated**, chưa phải GPS Android thật.

### 19.2 Android manual checklist

| ID | Tình huống | Trạng thái |
|---|---|---|
| A | NOT_ASSIGNED | PASS |
| B | Fresh GPS | PASS |
| C | Stale GPS | PASS |
| D | Multi-Trip | PASS |
| E | Completed Trip wording “Vị trí cuối của chuyến” | PASS |
| F | Polling foreground nhận dữ liệu mới không cần reopen | PASS |
| G | Background dừng polling, foreground fetch ngay | PASS |
| H | Mất mạng giữ last successful data và Order Detail | PASS |
| I | Cross-customer ownership không hiển thị dữ liệu | PASS; API xác nhận 404 |

Manual QA được người dùng thực hiện trên Android thật. Ảnh xác nhận trực tiếp Fresh/Stale/Multi-Trip và việc case Fresh đổi từ stale sang fresh sau khi fixture được làm mới mà không sai cấu trúc UI; người dùng xác nhận các case A–I còn lại đều hoạt động đúng.

Kiểm tra lại sau manual QA: PostgreSQL container healthy, Backend local port 4000 hoạt động, A trả 0 Trip, D trả 2 Trip, E trả `COMPLETED`, ownership trả 404. Case B trở lại stale sau hơn 2 phút là hành vi đúng của ngưỡng Backend, không phải lỗi.

M3.6D Customer Tracking MVP: **CLOSED — PASS**. GPS dùng trong lượt này vẫn là fixture-generated; không ghi là GPS thật từ Driver development APK.
## M3.7.1 Backend Driver Incident API

### Automated unit/DTO — PASS

- `test/trips/driver-incidents.service.spec.ts`: **17/17 PASS**.
- Bao phủ role metadata, PRIMARY create, RELIEF reject, state reject, idempotent replay/mismatch, audit failure và DTO/query validation.

### PostgreSQL target — PASS

- `test/trips/driver-incidents.postgres.spec.ts`: **19/19 PASS**.
- Xác minh Incident/IncidentOrder/ExecutionEvent/ProcessedCommand được persist thật.
- Xác minh PRIMARY/RELIEF, ownership 404, missing profile, role guard, state, time window, affected Orders, pagination/filter/detail.
- Xác minh hai request concurrent cùng key chỉ tạo một Incident.
- Xác minh audit insert failure rollback Incident và ProcessedCommand.
- Xác minh Trip status/version không thay đổi.

### Regression — PASS

- Full PostgreSQL: **160/160 PASS**, 13 suite.
- Backend không-PostgreSQL: **260/260 PASS**, 47 suite.
- ESLint: **PASS**.
- Nest build/TypeScript: **PASS**.
- `git diff --check`: **PASS**; chỉ có cảnh báo line-ending trên file cũ, không có whitespace error.

### Manual QA

- **NOT RUN**: M3.7.1 chỉ triển khai Backend; Android UI thuộc M3.7.2/M3.7.3.

## M3.7.2 Mobile Driver Incident

### Automated — PASS

- Target Driver Incident: **50/50 PASS**, 5 suite.
- Target Incident + Driver Trip screen integration: **56/56 PASS**, 6 suite.
- Full Mobile Jest: **214/214 PASS**, 37 suite.
- Bao phủ service endpoints/parser, validation, affected Orders, list pagination/error isolation, idempotent retry, changed payload, double tap, PRIMARY/RELIEF/state visibility, form và detail resolution.

### Static/build — PASS

- TypeScript strict: **PASS**.
- ESLint: **PASS**.
- Expo dependency check: **PASS**.
- Expo Doctor: **20/20 PASS**.
- Android production export: **PASS** (`dist/m372-android`).
- Secret scan: **PASS**; không phát hiện connection string, JWT/API secret hardcode trong Mobile source/package được quét.
- `mobile/.env.local` vẫn được `.gitignore` loại trừ. `git diff --check`: **PASS**, chỉ có cảnh báo line-ending ở Backend cũ.

### Manual Android

- **NOT RUN**. Chưa tuyên bố PASS trên thiết bị thật; chuyển sang M3.7.3 để kiểm tra PRIMARY, RELIEF, retry mất mạng và Trip completed.

## M3.7.3 Driver Incident Android Manual QA — kết quả 2026-11-18

Manual QA được người dùng thực hiện trên Android bằng development APK Expo SDK 58. Kết quả thiết bị, PostgreSQL verification và automated evidence được ghi tách biệt.

| Case | Tình huống | Kết quả |
|---|---|---|
| A | Incident list ban đầu rỗng | PASS — người dùng xác nhận UI; fixture ban đầu có 0 Incident |
| B | `VEHICLE_BREAKDOWN`, không affected Order | PASS — PostgreSQL có 1 Incident OPEN, 0 IncidentOrder |
| C | `PACKAGE_DAMAGED`, một affected Order | PASS — đúng 1 IncidentOrder |
| D | Nhiều affected Orders | PASS — đúng 2 Order thuộc Trip, không duplicate |
| E | Incident detail và resolution null | PASS — người dùng xác nhận UI không crash và không có action resolve/edit |
| F | Double tap | PASS — chỉ một Incident, một ExecutionEvent và một ProcessedCommand cho kết quả tương ứng |
| G | Mất mạng và retry thủ công | PASS — manual xác nhận giữ/retry payload; PostgreSQL không có duplicate; nhánh mất response sau server commit được automated test bao phủ |
| H | Mobile validation | PASS — người dùng xác nhận Mobile chặn input sai; không có command/Incident ngoài các submit hợp lệ |
| I | COMPLETED read-only | PASS — Incident mẫu vẫn đọc được, không phát sinh Incident mới |
| J | CANCELLED read-only | PASS — không phát sinh Incident mới |
| K | RELIEF read-only | PASS — Incident mẫu vẫn giữ nguyên, không phát sinh Incident mới từ RELIEF |
| L | Foreign Driver ownership | PASS API — PostgreSQL integration xác nhận 404; UI không expose foreign Trip |
| M | Execution/e-POD/GPS coexistence | PASS — người dùng xác nhận Incident panel không làm hỏng các panel còn lại |

### PostgreSQL verification sau manual

- Trip được QA: `QA-M373-PRIMARY-20261118082040-7LN4A`.
- Trip giữ nguyên `DISPATCHED`, version `1` sau khi tạo Incident.
- Có **6 Incident**, **6** `ExecutionEvent INCIDENT_REPORTED` và **6 ProcessedCommand COMPLETED**.
- Mỗi Incident có đúng một event và một command result.
- Affected Orders quan sát được lần lượt gồm 0, 1 và 2 Order; các Order đều thuộc StopTask của Trip.
- Số duplicate IncidentOrder, duplicate event theo Incident và duplicate command result đều bằng **0**.
- Trip COMPLETED giữ version `1` và một Incident mẫu; CANCELLED không có Incident mới; RELIEF giữ đúng một Incident mẫu.

### Automated evidence tham chiếu

- Backend Incident unit/DTO: **17/17 PASS**.
- Backend Incident PostgreSQL: **19/19 PASS**.
- Mobile Driver Incident target: **50/50 PASS**; full Mobile gần nhất: **214/214 PASS**.
- TypeScript, ESLint, Expo dependency check và Expo Doctor 20/20: **PASS**.
- Development APK SDK 58 fingerprint `2337982bb4330fda1bf3edfb207ab8e54acfcbaf`: **FINISHED**.

M3.7 Driver Incident MVP: **CLOSED — PASS** trong phạm vi Driver create/list/detail, affected Orders, idempotency và read-only theo assignment/state. Dispatcher/Admin resolution, ảnh Incident, location snapshot, IncidentPackage, offline command queue, WebSocket và Customer Incident view vẫn ngoài phạm vi.

## M3.8.1 — Backend Offline Command Hardening

Automated kết quả thực tế ngày 2026-11-18:

- Target unit/DTO Driver execution: **16/16 PASS**.
- Target PostgreSQL Driver execution: **17/17 PASS**.
- Toàn bộ PostgreSQL integration: **165/165 PASS**.
- Backend regression không PostgreSQL: **262/262 PASS**.
- ESLint và Nest build: **PASS**.

PostgreSQL target đã kiểm tra:

- ARRIVE/COMPLETE lưu đúng action time cũ hơn receive time, trong khi `receivedAt` vẫn là server time.
- Exact replay không duplicate ExecutionEvent, ProcessedCommand, Package/Order transition hoặc DeliveryAttempt.
- Hai COMPLETE_STOP đồng thời cùng actor/key/payload đều nhận result tương đương nhưng chỉ có một mutation, một event và một DeliveryAttempt.
- Cùng key nhưng `occurredAt` khác trả `IDEMPOTENCY_PAYLOAD_MISMATCH`; cùng instant biểu diễn bằng timezone khác được chuẩn hóa và replay đúng.
- Chặn quá 5 phút tương lai, quá 24 giờ quá khứ, trước Trip start và complete trước arrival; complete bằng arrival được chấp nhận.

Tại checkpoint M3.8.1, manual Android offline queue là **NOT RUN** vì M3.8.2 khi đó chưa được triển khai.

## M3.8.2 — Mobile Offline Driver Execution Queue

### Automated thực tế ngày 2026-11-18

- M3.8.2 target: **36/36 PASS** (8 suites), bao phủ SQLite initialization/owner scope/FIFO metadata, serialization, overlay, sync/replay/version chain, retry, auth pause, conflict, expiry, failed descendants, single-flight và Complete Trip guard.
- Full Mobile Jest: **236/236 PASS** (43 suites).
- TypeScript strict: **PASS**.
- ESLint: **PASS** sau khi xử lý warning test import có chủ đích.
- Expo dependency check: **PASS**; Expo Doctor: **20/20 PASS**.
- Android production export: **PASS** tại `mobile/dist/m382-android-final`.

### Phạm vi automated

- `NEVER_SENT` refetch/precondition và version chaining.
- `SENT_UNCERTAIN` replay đúng key/payload/occurredAt/wire version.
- Timeout/5xx → retry; 401 → auth pause; external version/command quá 24 giờ → conflict; permanent error → failed; descendants → blocked.
- Owner isolation, optimistic stop presentation, pending/conflict/failed UI, double-tap/persist-first và Complete Trip guard.
- Regression đầy đủ gồm GPS, e-POD và Incident hiện hữu trong full Jest.

### Manual Android M3.8.3

**NOT RUN.** Chưa đánh dấu PASS cho airplane mode, app restart, reconnect FIFO, lost response thật, conflict, logout/user switch, PostgreSQL duplicate checks hoặc coexistence trên thiết bị. Fixture local đã được tạo an toàn tại `127.0.0.1:55433/tms_auth_test`: Trip `QA-DRIVER-20261118105024-KCA5`, `DISPATCHED`, version 1, PRIMARY/ASSIGNED, bốn stop gồm Pickup/Delivery. M3.8.3 cần đăng nhập `driver.demo`, start Trip khi online rồi mới thực hiện checklist ngoại tuyến; tài liệu không lưu password.

### Kết quả M3.8.3 ngày 2026-11-19

- Người dùng xác nhận các case Android offline/reconnect/restart/logout hoạt động đúng.
- PostgreSQL Trip `QA-DRIVER-20261118105024-KCA5`: `IN_PROGRESS`, version 10, 4/4 Stop resolved, 4 ARRIVE_STOP và 4 COMPLETE_STOP có command/event unique, một DeliveryAttempt, không có COMPLETE_TRIP khi offline.
- M3.8.3 offline queue: **PASS**. Việc thiếu e-POD completion gate được tách và sửa trong M3.8.4.

## M3.8.4 — Mandatory e-POD before Complete Trip

- Backend policy/execution unit: **22/22 PASS**.
- Driver execution PostgreSQL target: **17/17 PASS**; test chứng minh thiếu ảnh trả `POD_REQUIRED`, Trip giữ `IN_PROGRESS`, thêm ảnh uploaded thì Complete Trip thành công.
- Full Backend: **433/433 PASS** (61 suites).
- Backend ESLint và Nest build: **PASS**.
- Mobile POD/execution/screen target: **26/26 PASS**, gồm case ẩn Complete Trip khi offline.
- Full Mobile: **240/240 PASS** (43 suites); TypeScript và ESLint: **PASS**.
- Expo dependency check và Doctor 20/20: **PASS**; Android production export: **PASS** tại `mobile/dist/m384-android-final`.
- Android manual cho completion gate mới: **PASS** ngày 2026-11-19. Đã xác nhận Trip không thể hoàn tất khi thiếu ảnh e-POD bắt buộc; sau khi ảnh tải thành công, Driver hoàn tất Trip bình thường.
- PostgreSQL hậu kiểm Trip `QA-DRIVER-20261118105024-KCA5`: `COMPLETED`, version 11, có `actualEndTime`; Order liên quan `COMPLETED`; đúng 1 `COMPLETE_TRIP` command/event; không có command ID trùng.
- Bằng chứng giao hàng của Trip gồm đúng 1 ảnh `PHOTO` active/`UPLOADED` và 1 `SIGNATURE` active/`UPLOADED`; DeliveryAttempt có kết quả `SUCCESS`.
- Kết luận M3.8.4: **PASS — CLOSED**.

## M3.9.1 — Driver External Navigation MVP

| Nhóm | Kết quả |
|---|---|
| URL builder/coordinate validation/Linking | PASS |
| Stop selector: Trip state, sequence, depot, offline overlay, conflict | PASS |
| Navigation panel: success, failure, invalid coordinate, blocked, double tap | PASS |
| Driver Trip Detail integration và offline rendering | PASS |
| M3.9.1 target | **49/49 PASS** (4 suites) |
| Driver feature regression | **218/218 PASS** (33 suites, trước thay đổi test cuối) |
| Full Mobile regression cuối | **280/280 PASS** (46 suites) |
| TypeScript strict / ESLint | PASS |
| Expo dependency check / Doctor | PASS / 20/20 PASS |
| Android production export | PASS tại `mobile/dist/m391-android-verified` |
| Android manual QA | **NOT RUN** |

Prettier không được cài trong project; không tải thêm dependency trái phạm vi. Formatting được kiểm tra bằng ESLint và diff review.

## M3.9.2 — Embedded Driver Mapbox

| Nhóm | Kết quả automated |
|---|---|
| Marker sequence/type, invalid coordinate, M3.8 pending/conflict | PASS |
| GPS mới/cũ/thiếu và nút “Vị trí của tôi” | PASS |
| M3.9.1 + Driver Trip + M3.8/M3.7/M3.6/M3.5 regression qua full suite | PASS |
| Full Mobile Jest | **287/287 PASS** (48 suites) |
| TypeScript strict / ESLint | PASS / PASS |
| Expo dependency check / Doctor | PASS / **20/20 PASS** |
| Android production export | PASS — `mobile/dist/m392-android-final` |
| EAS development Android | **FINISHED** — `4ad8d2e8-fe24-48ca-8bc7-ae052a348bd4` |
| Android native manual QA M3.9.3 | **PASS** cho mở bản đồ và ba ca kiểm tra lại cử chỉ |

Jest dùng Mapbox mock. Bằng chứng hiển thị bản đồ thật được ghi riêng ở phần M3.9.3 bên dưới.

### Chuẩn bị M3.9.3

1. Cài [EAS development APK](https://expo.dev/accounts/truonganhtung9/projects/smart-tms-mobile/builds/4ad8d2e8-fe24-48ca-8bc7-ae052a348bd4).
2. Thêm public token Mapbox riêng của Mobile vào `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN` trong `mobile/.env.local`. Kiểm tra `EXPO_PUBLIC_API_URL` dùng địa chỉ LAN của Backend local.
3. Chạy `npx expo start --dev-client --lan --clear` trong `mobile`. Mở Smart TMS development client trên Android và kết nối Metro để nạp bản JavaScript hiện tại.
4. Đăng nhập Driver QA, mở Trip Detail → **Xem bản đồ chuyến**, rồi chạy checklist A–V. Kiểm tra cả lúc nền bản đồ lỗi, vị trí không có mẫu, sample quá hai phút và lúc tải lại Trip sau đồng bộ.

### M3.9.3 — Kết quả Android ngày 2026-11-20

- ADB xác nhận điện thoại đã cài đúng APK EAS theo SHA-256. Ảnh Android thật xác nhận nền Mapbox, marker xe, marker điểm dừng và nút **Vị trí của tôi** xuất hiện.
- Người dùng báo đã chạy nhóm ca QA còn lại và ghi nhận zoom/pan xung đột với cuộn dọc. Kết quả riêng của các ca GPS di chuyển, mất mạng/đồng bộ, Google Maps và chuyến hoàn thành chưa được đối chiếu độc lập.
- Người dùng xác nhận **PASS** trên Android thật sau khi tách hai vùng: kéo và pinch trên bản đồ không cuộn màn hình, cuộn chi tiết không đổi góc nhìn bản đồ, và **Vị trí của tôi** đưa camera về marker xe.
- Cảnh báo mới khi tile tải lỗi đã có test tự động. Chưa có kết quả Android riêng cho nội dung cảnh báo sau bản sửa.
- Sau bản sửa cử chỉ: Mobile Jest **293/293 PASS**, TypeScript và ESLint **PASS**. Test kiểm tra hai vùng hiển thị tách biệt và phân biệt lỗi tile với lỗi tải style.

## M4.0 — Driver → Customer Integration QA Preparation

- Fixture local `QA-M40-DRIVER-CUSTOMER` / `QA-M40-ORDER`, baseline `DISPATCHED` v1 và GPS 0.
- API detail/tracking của chủ đơn 200, truy cập chéo 404. PostgreSQL regression mục tiêu **42/42 PASS**.
- Các bước thao tác, đối chiếu PostgreSQL trước/sau và trạng thái manual nằm trong [checklist Driver → Customer](driver-customer-e2e-qa.md).
- **Android E2E PASS** cho luồng chính và ba ca bổ sung: polling fresh → stale, chặn hoàn thành trước PHOTO và GPS độc lập giữa hai chuyến cùng xe. PostgreSQL xác minh Trip `-02` hoàn thành sau ảnh, có đúng một DeliveryAttempt và một lần Complete Trip.

## M4.1.1 — Driver Trip Overview & Stop Execution

Automated **307/307 PASS** (48 suites), TypeScript, ESLint, Expo dependency check và Expo Doctor **20/20 PASS**. Android production export PASS tại `mobile/dist/m411-android-verified`. Suite màn hình kiểm tra route/params, role/assignment, server progress vs local, conflict, offline depot completion, giao một phần, nháp, lifecycle khi đổi màn, POD readiness, read-only và khóa Complete khi còn lệnh trong queue. Full suite gồm các ca hiện có cho replay/double tap, giao thất bại, quyền GPS, Incident, e-POD và Mapbox.

**Android manual: luồng chính và guard e-POD PASS.** Các ca Back/nháp, màn nhỏ và chuyển tiếp UI offline chưa có bằng chứng riêng trong lần chạy này. Dùng Smart TMS development APK có Mapbox và reload qua Metro. Hai chuyến M4.0 giữ làm bằng chứng và có thể mở read-only.

1. Mở Tổng quan Trip mới. Kiểm tra mã, trạng thái, progress, điểm khả dụng và CTA. Start chỉ gửi một lần; mở Stop phải mang đúng `tripId` và `stopId`. Thử Back từ Stop và từ Map.
2. Ở Stop, chạy ARRIVE/COMPLETE online; thử kho, pickup và delivery với số thực tế/nhận hàng. Nhập nháp rồi bấm Back trên Android và header, chọn ở lại để xác nhận dữ liệu còn. Thử lấy lại bàn phím và confirm bỏ nháp ở lượt riêng.
3. Khi đang xem Trip, tắt mạng và mở Stop từ Tổng quan đã tải. Kiểm tra ARRIVE/COMPLETE lưu pending, progress server giữ nguyên, nhãn local xuất hiện. Bật mạng lại và thử Sync, kiểm tra không gửi trùng. Với fixture conflict, CTA dẫn tới sync thay vì chạy mutation mới.
4. Sau tất cả stop, kiểm tra thiếu ảnh, ảnh local, upload lỗi hoặc trạng thái POD chưa rõ đều chặn Complete. Upload PHOTO có phản hồi thành công, queue sạch và online thì Complete xuất hiện. Kiểm tra Trip hoàn thành chỉ xem.
5. Mở Incident từ lối tắt, Mapbox đúng Trip và điều hướng ngoài đúng điểm. Đổi Overview ↔ Stop ↔ Map khi tracking chạy. Kiểm tra tracker vẫn gửi GPS, không tạo watcher mới. Kiểm tra màn nhỏ, chữ lớn, bàn phím và safe area.

### Fixture Android M4.1.1

- Trip `QA-M411-OVERVIEW-STOP` (`3d985541-b787-442e-8b5c-ad0f1ef7534f`), `DISPATCHED` v1, xe `QA-M411.01`, Driver `driver.demo` `PRIMARY/ASSIGNED`.
- Order `QA-M411-ORDER` (`410d67d3-8385-4911-96a9-182040852ca6`), `ASSIGNED`. Task LOAD/UNLOAD đều có planned quantity 1 và cùng liên kết một Package `ALLOCATED`. GPS và execution event ban đầu bằng 0.
- Chuyến Incident `QA-M373-PRIMARY-20261118082040-7LN4A` thiếu Package ở các StopTask. Dùng fixture Incident cho kiểm tra sự cố, tránh dùng cho luồng execution. Lệnh thất bại của chuyến cũ được giữ lại và chỉ chặn chính chuyến đó.
- Từ `backend`, đọc trạng thái bằng `npx --no-install ts-node prisma/seed-driver-customer-e2e-qa.ts inspect overview-qa`. Chế độ `seed overview-qa` tái sử dụng đúng ID, giữ nguyên tiến độ nếu đã chạy. Script khóa đích PostgreSQL local `127.0.0.1:55433/tms_auth_test`.

### Mốc Android sau Pickup

- Người dùng xác nhận bài test đã ổn đến mốc kiểm tra đồng bộ. PostgreSQL xác nhận Trip `IN_PROGRESS` v6, kho đầu và Pickup đã hoàn thành, LOAD thực tế 1, Package `LOADED`, Order `IN_TRANSIT` v2. Có 5 ExecutionEvent khớp 5 ProcessedCommand và 6 GPS của chuyến.
- ADB đọc hàng đợi của chuyến M4.1.1 thấy 0 bản ghi còn lại. Lệnh `FAILED` của fixture Incident vẫn nằm riêng. **PASS** cho kết quả sau đồng bộ trên chuyến mới. Các chuyển tiếp UI offline và Back/nháp không được ghi riêng cho lần chạy này.
- Tại mốc Pickup, Delivery và kho cuối còn `PENDING`, chưa có DeliveryAttempt.

### Mốc Android trước PHOTO

- **PASS** theo xác nhận của người dùng trên Android. PostgreSQL xác nhận 4/4 điểm đã hoàn thành, một DeliveryAttempt `SUCCESS` và Order `COMPLETED` v3. Trip vẫn `IN_PROGRESS` v10, chưa có thời điểm kết thúc, ảnh PHOTO active `UPLOADED` hoặc sự kiện `COMPLETE_TRIP`.

### Mốc Android sau PHOTO và Complete Trip

- **PASS.** Chuyến `QA-M411-OVERVIEW-STOP` lên `COMPLETED` v11 lúc 19:57:01 (UTC+7), sau ảnh PHOTO active `UPLOADED` lúc 19:56:47. Chữ ký cũng đã tải lên.
- PostgreSQL xác nhận 4/4 điểm hoàn thành, một DeliveryAttempt `SUCCESS`, Order `COMPLETED` v3, Package `DELIVERED` và 13 GPS của Trip.
- Có 10 ExecutionEvent và 10 ProcessedCommand khớp nhau. Chỉ có một sự kiện và một lệnh `COMPLETE_TRIP`.

## M4.1.2 — Driver Supporting Screens & POD Readiness

### Automated · PASS

| Kiểm tra | Kết quả |
|---|---|
| Jest mục tiêu cho Driver screens, POD, Incident và offline | 128/128 PASS, 14 suites |
| Jest regression toàn Mobile | 325/325 PASS, 48 suites |
| TypeScript strict và ESLint | PASS |
| Expo dependency check và Expo Doctor | PASS, Doctor 20/20 |
| Metro Android export | PASS, `mobile/dist/m412-android-verified` |

Automated kiểm tra guard Complete bằng GET e-POD trong khi POD Panel chưa mount, ảnh local/FAILED/superseded, nhiều điểm giao, ảnh của attempt không đủ dữ liệu, phản hồi đến muộn, focus và sau upload. Bộ regression tái chạy kiểm thử hiện có cho queue, quyền route, GPS, Incident và Mapbox.

### Android manual · NOT RUN

Ngày 20/11/2026, người dùng phản hồi M4.1.2 nhìn chung ổn. Chưa có kết quả theo mã ca nên bảng giữ trạng thái từng ca. Đối chiếu lại ngày này bằng Jest mục tiêu **128/128 PASS** trên 14 suites.

Dùng Smart TMS development APK có Mapbox, Metro phục vụ bản Mobile mới và Backend local/test. Dùng một Trip QA riêng cho ca có ghi dữ liệu. Dùng `QA-M411-OVERVIEW-STOP` cho ca chỉ đọc để giữ bằng chứng M4.1.1.

| ID | Thao tác | PASS khi | Kết quả |
|---|---|---|---|
| M412-01 | Từ Tổng quan mở Incident, Sync, Map; vào Stop rồi mở e-POD. Back bằng header và nút Android. | Đúng mã chuyến và điểm giao. Về lại màn cha, Trip được làm mới, GPS vẫn chạy. | NOT RUN |
| M412-02 | Thử deep link với Trip/Stop/attempt hợp lệ và ID sai. Thử sau logout hoặc khi đăng nhập Customer. | Route hợp lệ mở đúng dữ liệu Driver. ID sai hiện lỗi, role khác bị chặn. | NOT RUN |
| M412-03 | Driver PRIMARY gửi Incident, mất mạng lúc form đang mở, kết nối lại và thử gửi cùng yêu cầu. Mở lịch sử của chuyến hoàn thành. | Offline khóa gửi và giữ mô tả. Retry cùng dữ liệu tạo tối đa một Incident. Chuyến hoàn thành chỉ đọc. | NOT RUN |
| M412-04 | Ghi ARRIVE/COMPLETE offline, qua các route, mở Sync, bật mạng và thử đồng bộ. Mở chuyến khác có lệnh cũ lỗi. | Lệnh giữ đúng tài khoản/chuyến. UI hiển thị pending và lỗi phù hợp. Queue sạch sau khi máy chủ xác nhận. Lỗi chuyến cũ chỉ hiện trong chuyến đó. | NOT RUN |
| M412-05 | Hoàn thành stop/task. Mở Tổng quan khi chưa mở e-POD, rồi chụp ảnh, giữ ảnh local hoặc mô phỏng upload lỗi. | Complete Trip bị chặn trong mọi trạng thái chưa được server xác nhận. | NOT RUN |
| M412-06 | Upload PHOTO, Back về Tổng quan, xem lại ảnh và thay ảnh. Thử lại một upload chưa rõ kết quả sau khi mở lại e-POD. | Ảnh active được server xác nhận trước khi mở Complete. Overview đọc lại readiness. Retry dùng cùng yêu cầu và không tạo thêm ảnh trùng. | NOT RUN |
| M412-07 | Dùng Trip QA có hai điểm giao, tải ảnh cho một điểm rồi cho điểm còn lại. | Thiếu một ảnh bắt buộc giữ khóa. Đủ cả hai và queue sạch mới mở Complete. | NOT RUN |
| M412-08 | Mở Incident, Sync, e-POD và Map trên Trip hoàn thành. | Xem được lịch sử và ảnh theo quyền. Không có thao tác upload hoặc báo sự cố. Map vẫn kéo/phóng to bình thường. | NOT RUN |
| M412-09 | Kiểm tra ký một ngón, bàn phím Incident, Android Back với nháp Stop và màn nhỏ/chữ lớn. | Nút chính chạm được, cuộn và ký tách biệt, Back từ Stop vẫn hỏi giữ/bỏ nháp. | NOT RUN |

## M4.1.2B — Driver Home Dashboard

### Automated · PASS

- Full Mobile Jest **339/339 PASS** (49 suites), gồm 14 ca Home. Jest dùng Expo Router, protected Stack và AuthProvider thực với API/storage giả lập. Kiểm tra login, khôi phục phiên, quyền Driver, deep link và Back, filter, một/nhiều/không có chuyến, progress, lỗi, cache theo phiên, offline/reconnect, gộp refresh và guard đăng xuất. Sự kiện RefreshControl được giả lập; động tác kéo thật thuộc manual QA.
- TypeScript strict, ESLint, Expo dependency check và Expo Doctor **20/20 PASS**. Android export **PASS** tại `mobile/dist/m412b-android-verified`.

### Android manual · NOT RUN

Dùng Smart TMS development APK có Mapbox, Metro và Backend local/test. Dùng tài khoản Driver test và Trip QA riêng cho các ca có thao tác ghi. Các chuyến bằng chứng M4.0/M4.1.1 chỉ dùng để xem lại.

| ID | Thao tác | PASS khi | Kết quả |
|---|---|---|---|
| M412B-01 | Đăng nhập Driver, đóng/mở lại app, thử URL Driver khi đang đăng nhập Customer. | Driver vào Home hoặc đúng deep link. Customer không mở được Trip Driver. Back và đăng xuất về đúng màn. | NOT RUN |
| M412B-02 | Xem Home khi có một, không có, hoặc có nhiều chuyến IN_PROGRESS. | Một chuyến có đúng mã/xe/tiến độ/điểm tiếp theo. Rỗng có thông báo riêng. Nhiều chuyến mở danh sách chọn. | NOT RUN |
| M412B-03 | Chạm Tiếp tục chuyến, Xem tất cả, Lịch sử chuyến và Tài khoản. Thử Back hệ thống. | Mở đúng route/filter/Trip. Back về một Home và không tự phát sinh lệnh. | NOT RUN |
| M412B-04 | Thử mất mạng lúc Home đã tải và khi vào Home chưa có snapshot. Kéo làm mới khi nối lại. | App ghi đúng snapshot có thể cũ hoặc chưa có dữ liệu. Kết nối lại làm mới; danh sách rỗng không thay cho lỗi. | NOT RUN |
| M412B-05 | Mở Home khi có lệnh stop chờ và GPS đang theo dõi. Di chuyển giữa các màn. | Tiến độ server giữ nguyên khi chỉ có kết quả local. GPS và queue tiếp tục theo đúng tài khoản/chuyến. | NOT RUN |
| M412B-06 | Đăng xuất từ Tài khoản khi queue chưa sạch, chọn ở lại rồi xác nhận đăng xuất. | Có cảnh báo, lệnh vẫn được giữ cho đúng tài khoản. | NOT RUN |
| M412B-07 | Kiểm tra màn nhỏ, chữ lớn, TalkBack, mã chuyến dài và kéo làm mới. | Mã nhận diện được, CTA chạm được và thứ tự focus rõ. | NOT RUN |
| M412B-08 | Mở Incident, e-POD, Mapbox, điều hướng ngoài và luồng Customer Tracking. | Các màn và quyền truy cập hiện có hoạt động theo contract; Complete vẫn kiểm tra e-POD. | NOT RUN |

## Stitch Integration Phase 1 — Driver Theme & Scalable Stop List

Jest dùng dữ liệu trong tiến trình test cho 0/1/4/50/75 điểm, kiểm tra thứ tự, số hàng render ban đầu, tìm điểm cuối, phân quyền, overlay offline và nhánh phục hồi khi FlatList chưa đo hàng. Đánh giá tốc độ vẽ và cuộn trên Android cần QA riêng.

Ngày 21/11/2026, Jest mục tiêu **59/59 PASS**, toàn bộ Mobile Jest **364/364 PASS** (49 suites). TypeScript, ESLint, kiểm tra dependency Expo, Expo Doctor **20/20**, Android export và Git diff check đều đạt. Trong một lượt đo Jest trên Windows, ca 50 và 75 điểm mất lần lượt 27 ms và 31 ms cho tổ hợp mount trong test renderer, tìm điểm cuối và assertion. Ca phục hồi cuộn được mô phỏng mất 251 ms. Các số đo Android về render, cuộn và font scaling vẫn **NOT RUN**.

| Case | Thao tác Android trên local/test | Tiêu chí PASS | Manual |
|---|---|---|---|
| ST1-01 | Mở Overview, chọn “Xem tất cả điểm dừng”. Mở một hàng rồi dùng Back. Kiểm tra thêm deep link vào đúng chuyến. | Overview chỉ hiển thị một điểm và tiến độ. Danh sách mở đúng Trip, hàng mở đúng Stop, Back về đúng màn. | NOT RUN |
| ST1-02 | Cuộn chuyến có ít và nhiều điểm. Với dữ liệu QA cho phép, kiểm tra 50+ điểm ở 360/400 dp, font thường và font lớn. | Không mất thứ tự kế hoạch, chữ không đè hoặc cắt nút. Ghi thời gian từ lúc chọn shortcut đến hàng đầu tiên và quan sát độ mượt khi cuộn nhanh. | NOT RUN |
| ST1-03 | Tìm bằng số điểm, địa chỉ có dấu/không dấu, tên hoặc điện thoại. Đổi lần lượt năm bộ lọc. | Kết quả đúng, thứ tự không đổi. Truy vấn không khớp hiển thị trạng thái rỗng. | NOT RUN |
| ST1-04 | Dùng tìm kiếm hoặc bộ lọc ẩn điểm hiện tại, sau đó chọn “Đến điểm hiện tại”. Thử điểm nằm xa đầu danh sách, có hàng cao khác nhau. | Có thông báo bỏ điều kiện lọc và cuộn tới đúng điểm. Ghi lại thời gian từ lúc bấm đến lúc điểm đích hiển thị. | NOT RUN |
| ST1-05 | Mở chuyến bằng RELIEF, so với chuyến PRIMARY. Mở danh sách đã tải khi mất mạng và quan sát pending/conflict có sẵn trên local/test. | RELIEF chỉ xem. Trạng thái đã xác nhận và trạng thái thiết bị tách biệt. Mở, lọc, tìm và cuộn không tạo thao tác thực thi. | NOT RUN |
| ST1-06 | Quay về Overview và mở Mapbox, Sync, Incident và e-POD theo flow hiện hành. | Đúng Trip và quyền. Trạng thái GPS, đồng bộ và e-POD hoạt động theo các guard hiện có. | NOT RUN |

## Stitch Integration Phase 2 — Stop Execution và e-POD

Ngày 21/11/2026, Jest mục tiêu **92/92 PASS**, toàn bộ Mobile Jest **367/367 PASS** (49 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và Git diff check đạt. Android smoke dùng development APK trên realme RMX3370, 360 dp, dữ liệu QA hiện có.

| Case | Kết quả | Bằng chứng hoặc điều kiện cần xác nhận |
|---|---|---|
| ST2-01 · Stop có nhiều task và lỗi đồng bộ | PASS · Android | Mở đúng điểm lấy hàng, thấy hai task, badge “Đã đến” và badge đồng bộ thất bại riêng, CTA hoàn thành bị chặn. |
| ST2-02 · CTA điểm kho | PASS · Android UI | CTA hiển thị sát đáy ở điểm kho đã đến và còn thao tác hợp lệ. |
| ST2-03 · e-POD chuyến hoàn thành | PASS · Android UI | Đọc đúng lần giao, hai ảnh đã tải và một chữ ký, chế độ chỉ xem. |
| ST2-04 · Số lượng 0/một phần/thất bại, giữ nháp Back, sai attempt, RELIEF | PASS · Jest | Kiểm thử form và quyền qua route. Lặp lại trên fixture Android trước khi nghiệm thu luồng ghi. |
| ST2-05 · Tải ảnh, chữ ký và Complete Trip | PASS · Android và PostgreSQL local | `QA-STITCH-PHASE2-EPOD` hoàn thành v11. Có một ảnh active và một chữ ký đã tải, đúng một lệnh Complete Trip thành công. Sau khi mở lại e-POD, UI ở chế độ chỉ xem. |
| ST2-06 · Hủy/thay ảnh, retry, hoàn thành khi chưa ký và chặn khi thiếu ảnh | Chưa đủ bằng chứng Android | Cần kiểm thử riêng. Chuyến ST2-05 đã có cả ảnh và chữ ký trước khi hoàn thành. |

## Stitch Integration Phase 3 — Offline Sync và Incident

Hai fixture PostgreSQL test local đều bắt đầu `DISPATCHED` v1 và có 0 sự kiện chạy chuyến. Trip `QA-STITCH-PHASE3-SYNC` (`280e3a4f-81b2-49e9-9544-04f8351ceca1`) có `driver.demo` PRIMARY và `driver.relief.demo` RELIEF. Trip `QA-STITCH-PHASE3-OTHER` (`91c3e8ef-43b6-4540-83d0-7024c44be6bb`) chỉ có PRIMARY. Khi gọi lại seed, cả hai trả `reused`. Từ root repo có thể đối chiếu bằng `node docs/04-testing/stitch-phase2-qa.cjs inspect phase3-main` hoặc thay đối số cuối bằng `phase3-other`.

Jest mục tiêu **136/136 PASS**, toàn bộ Mobile **371/371 PASS** (49 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và Git diff check đạt.

Sau smoke Android, chuyến chính vẫn `DISPATCHED` v1 và có một `INCIDENT_REPORTED`. Chuyến đối chiếu vẫn `DISPATCHED` v1 với 0 sự kiện, dùng cho ca hàng đợi độc lập.

| Case | Thao tác trên Android | Kết quả hoặc tiêu chí PASS |
|---|---|---|
| ST3-01 | Mở Đồng bộ của chuyến chính ở baseline. | **PASS Android**. Hiện đúng mã chuyến và hàng đợi rỗng. |
| ST3-02 | Xem lỗi đồng bộ đã có ở chuyến QA M3.7.3, rồi đối chiếu chuyến Phase 3. | **PASS Android UI**. Lỗi dữ liệu nằm ở nhóm cần chú ý của chuyến cũ; chuyến Phase 3 hiện 0. Chỉ mở các màn để đọc. |
| ST3-03 | Bắt đầu chuyến Phase 3 khi online, mở điểm kho, tắt mạng, thực hiện ARRIVE rồi COMPLETE. Đóng và mở lại APK. | **NOT RUN Android**. Hai lệnh thuộc đúng chuyến còn trong hàng đợi, theo đúng sequence. Chuyến thiếu snapshot offline có thể cần tải lại chi tiết khi online. |
| ST3-04 | Bật lại mạng, thử đồng bộ nếu còn lệnh đủ điều kiện. Kiểm tra Trip/event sau đó. | **PASS PostgreSQL** cho trạng thái và thứ tự đã lưu. Quan sát queue sau khi bật lại mạng **chưa xác minh riêng trên Android**. |
| ST3-05 | Tạo xung đột thật trên fixture với hai phiên QA. Một phiên ghi lệnh offline, phiên còn lại xác nhận cùng điểm trước khi phiên đầu nối lại. | **NOT RUN Android**. Hiện lý do theo phản hồi thật khi lệnh bị chặn. Kiểm tra chuyến đối chiếu vẫn dùng hàng đợi riêng. |
| ST3-06 | Mở Sự cố của chuyến chính, tạo sự cố QA với PRIMARY. Mở lại bằng RELIEF để đọc và dùng Back. | **PASS Android** cho PRIMARY tạo/đọc một sự cố với đúng một đơn ảnh hưởng. API local cho RELIEF đọc chuyến được giao (200) và chặn chuyến khác (404). RELIEF chỉ xem có bằng chứng Jest, phần UI trên Android **NOT RUN**. |
| ST3-07 | Thử mô tả dài, font lớn, ngắt phiên đăng nhập, chuyển tài khoản, kiểm tra GPS/e-POD trên chuyến QA. | **PASS Android UI** cho thẻ Incident với mô tả 120 ký tự và font 1.35. Thiết bị đã được trả về 1.0. Font lớn của Sync, đổi tài khoản, GPS/e-POD **NOT RUN Android**. |

PHOTO missing, retry cùng tệp và hoàn thành khi chưa ký của Phase 2 tiếp tục theo dõi ở ST2-06.

### Android retest và đối chiếu PostgreSQL · 21/11/2026

- **ST3-08 · Điều hướng Home — PASS Android.** Kiểm tra qua USB xác nhận chạm thẻ trong “Chuyến đã điều phối” mở đúng Tổng quan chuyến. Người dùng xác nhận đã thử lại thành công. Test hồi quy mô phỏng router toàn cục chưa sẵn sàng. Bộ Driver Home chạy lại **22/22 PASS**. Lượt xác minh bản sửa ghi nhận full Mobile Jest **372/372 PASS**, TypeScript và ESLint **PASS**.
- **ST3-04 · Kết quả phía máy chủ — PASS PostgreSQL.** Hai lệnh inspect chỉ đọc trên database local xác nhận mỗi fixture ở `IN_PROGRESS` v6, đã hoàn thành kho xuất phát và lấy hàng, đơn ở `IN_TRANSIT`. Thứ tự sự kiện trên mỗi chuyến là đến kho → hoàn thành kho → đến điểm lấy → hoàn thành lấy. Chuyến chính có 6 ExecutionEvent và 6 ProcessedCommand, gồm một báo cáo sự cố. Chuyến đối chiếu có 5 bản ghi ở mỗi nhóm. Các sự kiện đã ghi nhận khớp từng lệnh, không thấy bản ghi trùng trong hai fixture.
- **Còn mở trên Android.** Xác nhận chung của người dùng được ghi nhận ở lượt retest. Checklist riêng vẫn thiếu bằng chứng cho việc đóng/mở APK khi còn lệnh chờ, quan sát queue đồng bộ sau khi bật mạng, tạo xung đột phiên bản mới, UI RELIEF, đổi tài khoản, font lớn của Sync và hồi quy GPS/e-POD. Cả hai fixture hiện chờ giao hàng và chưa có DeliveryAttempt hoặc PodFile.

## Stitch Integration Phase 4A — Mapbox Workspace

Jest mục tiêu **122/122 PASS**, full Mobile Jest **382/382 PASS** (49 suites), TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và kiểm tra khoảng trắng Git **PASS**.

| Case | Kết quả quan sát |
|---|---|
| 4A-01 · Viewport 360 dp, font 1.0, safe area | **PASS Android**. Bản đồ khoảng 56% toàn màn hình. CTA chính và phụ nhìn thấy ngay. |
| 4A-02 · Pan, định tâm | **PASS Android**. Kéo dịch bản đồ, sau đó dùng nút vị trí đưa camera về XE. Pinch hai ngón **NOT RUN**. |
| 4A-03 · Điểm hiện tại, cụm trùng tọa độ và Back | **PASS Android**. Deep link đúng chuyến, mở điểm giao 3/4. Chạm cụm KĐ1/L2/KK4 và chọn L2 mở đúng điểm lấy 2/4. Back từ Stop trở lại bản đồ, dữ liệu kho/lấy/giao giữ nguyên. |
| 4A-04 · Chỉ đường ngoài | **PASS Android** cho thao tác mở Google Maps. Test service xác minh dữ liệu tọa độ và các nhánh fallback. |
| 4A-05 · GPS độc lập theo chuyến | **PASS Android**. Chuyến chính có XE và định tâm, chuyến đối chiếu báo chưa có vị trí và ẩn nút định tâm. Stale, quyền bị từ chối và dịch vụ vị trí tắt **PASS Jest**, **NOT RUN Android**. |
| 4A-06 · Font 1.35 | **PASS Android** cho bố cục, CTA chính xuống hai dòng. Đã trả thiết bị về 1.0. Development APK hiện cảnh báo linking khi Android khởi tạo lại activity sau đổi font; sau khi app ổn định, mở lại deep link vào đúng workspace. |
| 4A-07 · RELIEF chỉ xem, xung đột queue và lỗi tiles | **PASS Jest**, **NOT RUN Android** trong lượt này. |
| 4A-08 · Driver → Customer cùng Trip/Order, e-POD và GPS nền | **NOT RUN Android E2E** trong 4A. Giữ cho QA tổng hợp 4B. |

Đọc PostgreSQL test local sau QA, cả hai fixture vẫn version 6. Fixture chính có 6 ExecutionEvent và 6 ProcessedCommand, fixture đối chiếu có 5 ở mỗi nhóm. Cả hai có 0 PodFile. Thao tác trên Map chỉ mở màn hình và ứng dụng ngoài.

## Stitch Integration Phase 4B — Android QA tổng hợp

Ngày 21/11/2026 (GMT+7). Realme RMX3370, development APK `com.smarttms.mobile` 1.0.0, 360 dp. Backend local cổng 4000 kết nối PostgreSQL 16 qua TCP `127.0.0.1:55433/tms_auth_test`. Metro cổng 8081 phục vụ build ban đầu. Sau khi bản dev ở 8081 hiện màn trắng khi mở lại, Metro riêng cổng 8082 qua USB chạy được cùng workspace và giúp thử tải JavaScript khi tắt mạng trên điện thoại. Người dùng đã xác nhận Cloudinary đang cấu hình được phép nhận ảnh QA.

| Trip / Order | PostgreSQL trước → sau | ExecutionEvent / ProcessedCommand | Attempt / PodFile |
|---|---|---|---|
| `QA-STITCH-PHASE3-SYNC` / `QA-STITCH-PHASE3-ORDER` | Trip IN_PROGRESS v6 → COMPLETED v11; Order IN_TRANSIT → COMPLETED | 6/6 → 11/12. Cả 11 event khớp ID command riêng. Tổng gồm 11 lệnh có sự kiện và một lệnh upload PHOTO. | 0/0 → 1/1; một PHOTO active UPLOADED, 0 SIGNATURE |
| `QA-STITCH-PHASE3-OTHER` / `QA-STITCH-PHASE3-ORDER-02` | Trip IN_PROGRESS v6 → v7; Order IN_TRANSIT; điểm 3 ARRIVED | 5/5 → 6/6. Chỉ thêm ARRIVE từ phiên Backend dùng để tạo conflict. | 0/0 → 0/0 |
| `QA-STITCH-PHASE2-EPOD` / `QA-STITCH-PHASE2-ORDER` | COMPLETED v11 cả trước và sau | 10/12 cả trước và sau | 1/2 cả trước và sau |

| ID | Kết quả | Bằng chứng |
|---|---|---|
| 4B-01 · Lưu offline và local overlay | **PASS Android/SQLite/PostgreSQL** | Điểm giao và kho cuối đều lưu ARRIVE sequence 1 rồi COMPLETE sequence 2, cùng một owner/Trip. Stop hiện chờ đồng bộ, PostgreSQL còn PENDING với version trước khi replay. |
| 4B-02 · Khởi động lại khi vẫn offline | **PASS SQLite · FAIL Android UI** | Hai lệnh vẫn `PENDING/NEVER_SENT` sau force-stop. Metro USB tải được JS nhưng app dừng ở “Không thể kiểm tra phiên đăng nhập”. `AuthProvider` gọi profile khi khôi phục phiên và hiển thị lỗi kết nối, vì vậy chưa mở queue được trong ca cold start offline. |
| 4B-03 · Reconnect FIFO và retry chính xác | **PASS Android/PostgreSQL** cho FIFO. **NOT RUN Android** cho mất phản hồi sau khi server đã nhận lệnh. | Bật mạng và thử lại phiên. Giao và kho cuối đều có ARRIVE trước COMPLETE, không thấy trùng. Jest và PostgreSQL integration chạy ca exact retry gồm key, payload/thời điểm ghi và version của lần gửi. |
| 4B-04 · Version conflict và isolation | **PASS Android/SQLite/PostgreSQL** | Điện thoại lưu hai lệnh ở v6 trên chuyến OTHER. Phiên Backend dùng API ARRIVE hợp lệ tăng v7. Sau reconnect, Sync hiện 2 lệnh cần chú ý đúng điểm giao 3. SQLite lưu ARRIVE `CONFLICT`, COMPLETE `BLOCKED`, cả hai `NEVER_SENT`, chưa có wire version. Chuyến chính vẫn replay và hoàn thành độc lập. |
| 4B-05 · PHOTO bắt buộc | **PASS Android/API/PostgreSQL** | Sau khi bốn Stop được xác nhận, UI chỉ đưa tới “Bổ sung bằng chứng”. Complete API trả `409 POD_REQUIRED`. Trip vẫn IN_PROGRESS, có một Attempt SUCCESS và 0 PodFile. |
| 4B-06 · Retry cùng ảnh | **PASS Android/Cloudinary/PostgreSQL** | Chụp ảnh QA, ngắt mạng ngay lúc gửi, thấy lỗi kết nối và PostgreSQL có 0 PodFile. Bật mạng, dùng “Thử tải lại file vừa chọn” với ảnh hiện có. Có đúng một PHOTO active và một upload command. PostgreSQL integration gửi lại cùng key/tệp sau thành công với storage mock. Tình huống mất phản hồi sau khi server đã lưu chưa tái hiện trên Android. |
| 4B-07 · Chữ ký tùy chọn | **PASS Android/PostgreSQL** | Hoàn thành chuyến bằng CTA khi chỉ có PHOTO active. Một COMPLETE_TRIP thành công, 0 SIGNATURE. |
| 4B-08 · RELIEF và ranh giới owner | **PASS Android/API/Integration** | RELIEF vào Trip, Map, Stop chỉ xem, đọc Incident và bị chặn ở màn e-POD. Chuyến đang thực hiện có CTA “Xem điểm dừng”. API đọc chuyến được giao/Incident trả 200, chuyến khác trả 404. Bộ PostgreSQL xác nhận các hạn chế mutation. Logout PRIMARY có cảnh báo giữ lệnh theo tài khoản. |
| 4B-09 · Lời nhắc GPS trên RELIEF | **FAIL trước sửa · PASS retest** | Trước sửa, chuyến IN_PROGRESS duy nhất của RELIEF làm hiện lời nhắc tiếp tục tracking. Sau giới hạn PRIMARY/ASSIGNED và reload từ Metro mới, Android về Home mà không nhắc lại. Hai test tái hiện trước sửa và PASS sau sửa. |
| 4B-10 · Bản đồ và vị trí | **PASS Android** cho pinch, với ảnh ADB trước/sau, người dùng xác nhận mượt. Pan, recenter, marker, Back, Google Maps, font 1.0/1.35 và không có GPS có bằng chứng Android Phase 4A. | **NOT RUN riêng Android 4B** cho thu hồi quyền, ép lỗi tiles và đo số watcher native khi đổi route. Bộ Jest tracking/map chạy lại. |
| 4B-11 · Driver → Customer Tracking | **PASS Android/API/PostgreSQL** | API trả điểm GPS trùng mẫu cuối PostgreSQL theo từng Trip từ StopTask của Order. Chuyến chính từng fresh, chuyến đối chiếu stale. Owner đọc 200, tài khoản khác 404, đơn chưa phân chuyến trả `NOT_ASSIGNED` và `trips: []`. Android Customer mở đúng Order chính và thấy “Đã hoàn thành”, “Vị trí cuối của chuyến”, “Vị trí có thể đã cũ”. |
| 4B-12 · Deep link và linking | **PASS warm Android**. **BLOCKED cold trên development APK**, cold release **NOT RUN**. | Warm mở đúng map/Stop/Order. Gửi URL chuyến khi process bị force-stop, dù mạng đã bật, đưa vào Development Launcher. Kết nối Metro rồi gửi lại URL vào đúng màn. Source Expo Router cho thấy cảnh báo nhiều handler chỉ được log trong development. Chưa định danh được nguyên nhân chính xác khiến handler chồng nhau sau đổi font. |

Kiểm thử cuối **268/268 Jest mục tiêu**, **384/384 Mobile Jest** (49 suites), **79/79 PostgreSQL integration** (5 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor 20/20, Android export và Git diff check đạt. SQLite QA trên máy được đọc bằng snapshot cục bộ; không xóa queue.

## Stitch Phase 4C — Offline Cold Start Recovery

Jest mục tiêu **136/136 PASS**, toàn bộ Mobile Jest **402/402 PASS** (51 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và Git diff check đạt.

| Ca | Kết quả và bằng chứng |
|---|---|
| Snapshot mã hóa và truy cập hợp lệ | **PASS Android qua USB** trên realme RMX3370. Snapshot SQLite dạng BLOB, mã fixture không xuất hiện dưới dạng văn bản. Sau force-stop và mở lại với Wi-Fi/mobile data tắt, chế độ chỉ đọc hiển thị 4 điểm cùng công việc. |
| Hàng đợi và reconnect | **PASS Android/PostgreSQL**. Khi offline ứng dụng hiện ARRIVE và COMPLETE tại kho theo thứ tự #1/#2, PostgreSQL còn `PENDING` v2. Sau khi bật mạng, app về Home và PostgreSQL ghi ARRIVE rồi DEPOT_STOP_COMPLETED. |
| Logout và đổi owner | **PASS Android**. Sau logout, force-stop rồi mở lại offline hiện Login. Đăng nhập RELIEF, mở lại offline cho thấy trạng thái thiếu snapshot và queue rỗng, không hiển thị chuyến/lệnh của PRIMARY. |
| JWT.exp, giới hạn 8h, lỗi auth, cache hỏng và race | Kiểm bằng Jest. Kiểm tra hết hạn thực tế và clock thay đổi trên Android **NOT RUN**. |
| Protected route và vận hành khi offline | Cold start recovery chỉ có đường đọc. Protected deep link có regression test. Android dùng development APK với Metro USB cung cấp JS, Backend qua Wi-Fi. Cold launcher trên APK có bundle nhúng, Android Back và đếm watcher native riêng **NOT RUN**. |

Fixture local mới `QA-STITCH-PHASE4C` (`d4df559e-287f-4217-a5c7-82e2af4a74ee`), Order `QA-STITCH-PHASE4C-ORDER` (`9ce1c6b1-e31b-464b-8c68-4292be844130`). PostgreSQL `DISPATCHED` v1, 0/0 event/command → `IN_PROGRESS` v4, 3/3 event/command, ba ID lệnh riêng và kho đầu `COMPLETED`. Ba fixture lịch sử giữ version và số lệnh/sự kiện như baseline. Exact replay key, wire version, payload và timestamp có bằng chứng Jest, ca mất response sau khi server nhận trên thiết bị chưa chạy riêng.

### Phase 4C.1 — Standalone APK Acceptance

- Fixture mới `QA-STITCH-PHASE4C1-STANDALONE` (`677a28b8-dbd7-4a4b-9500-5715a84359ed`), Order `QA-STITCH-PHASE4C1-ORDER` (`296e8b6e-b607-4df2-96bc-a5c5f533b328`). Baseline `DISPATCHED` v1, 0 ExecutionEvent, 0 ProcessedCommand. Backend local cổng 4000 kết nối TCP `127.0.0.1:55433/tms_auth_test`.
- Bản QA dùng Gradle `:app:assembleRelease` với CNG trên bản sao nguồn Mobile, cài song song bằng package `com.smarttms.mobile.qa4c1`. API LAN được cấp qua `EXPO_PUBLIC_API_URL`. HTTP cleartext chỉ dành cho cấu hình build QA tách riêng. Dữ liệu SQLite của development APK nằm trong package cũ.
- Build standalone **PASS**. Gradle release ARM64, mã gói `com.smarttms.mobile.qa4c1`, phiên bản `1.0.0` (code 1), ký bằng khóa debug dành riêng cho QA. APK có Launcher `MainActivity`, không debuggable, không có development launcher activity, bundle nhúng chứa code snapshot Phase 4C. SHA-256 `541D408C5871A9A2C8C8568EA4BF507D7B60AD5A7A32F6B525214EFC3BC206FD`.
- **Test A · PASS trên Android RMX3370 với APK code 1.** Đã force-stop, tắt Wi-Fi/dữ liệu di động, rút USB và mở từ Launcher trong lúc Metro đã dừng. Workspace hiển thị đúng Trip, bốn Stop, công việc LOAD/UNLOAD và hai thao tác chờ. Deep link Stop Execution vẫn ở vùng chỉ đọc. SQLite trước/sau cold start có đúng hai dòng, `PENDING / NEVER_SENT`, và một snapshot mã hóa. PostgreSQL giữ `IN_PROGRESS` v2, kho `PENDING`, 1 event/command của START.
- Khi bật mạng, ứng dụng xác thực lại và tự replay ARRIVE trước COMPLETE. PostgreSQL chuyển `IN_PROGRESS` v4, kho `COMPLETED`, 3 event/command với ba ID riêng. Hai event mới là `ARRIVE_STOP` và `DEPOT_STOP_COMPLETED`. SQLite và màn Đồng bộ đều về 0. Trip không được đánh dấu hoàn thành vì còn ba điểm.
- Ca bổ sung Đăng xuất ở workspace tái hiện crash Android trên code 1. Hàm xử lý được khởi tạo sau nhánh return, khiến nút gọi giá trị chưa khởi tạo. Đã chuyển khởi tạo lên trước hai nhánh và thêm ca hồi quy. Test mới tái hiện lỗi trước bản sửa. Sau sửa, Jest mục tiêu **129/129**, toàn bộ **403/403**, TypeScript, ESLint, Expo dependency check và Expo Doctor **20/20** đạt.
- Với APK code 2, hai lệnh ở Pickup vẫn ở `PENDING / NEVER_SENT` sau cold start và explicit logout. Lần mở lại lúc offline hiện Login. Khi bật mạng, PostgreSQL vẫn ở v4 cho đến khi đăng nhập lại đúng owner. Replay xác nhận Pickup, số lượng thực tế 1 và Order `IN_TRANSIT`. Trip v6 với 5 ExecutionEvent và 5 ProcessedCommand, mỗi dữ liệu gắn ID lệnh riêng và SQLite về 0. Arrival và completion giữ đúng timestamp đã ghi trên thiết bị.
- Code 2 còn lỗi `Unmatched Route` ngay khi logout. Ca hồi quy Expo Router tái hiện lỗi. Bản sửa đặt đích fallback `/login` khi state chuyển sang anonymous. Các guard theo role và fallback khi reconnect được giữ theo trạng thái hiện hành.
- Cold start lần đầu khi offline, chưa từng xác thực trên APK QA code 1 **PASS**. Ứng dụng hiện Login.
- **Test B · BLOCKED tại 4C.1.** Backend mặc định cấp JWT 7 ngày. Ca hết hạn thực tế đã được nghiệm thu trong Phase 4C.2 bên dưới.
- APK cuối `1.0.0` (code 3) SHA-256 `6C5F57EE0E66A31E0D29A9B248D09745D5BF42E7EA6E65E54A7DB8A845FD9A68`, hash bản cài khớp bản build. Thiết bị `realme/RMX3370/RE5473:13/TP1A.220905.001/R.1a88165-1ce22-e0695:user/release-keys`. Kiểm tra lại code 3 qua ADB khi Metro tắt và điện thoại offline. Cold start vào workspace, đăng xuất về Login ngay. Hai lượt rút USB khi mở từ Launcher dùng code 1 và 2.
- Negative Android code 3 **PASS** cho tài khoản RELIEF thiếu snapshot, cách ly snapshot của PRIMARY và chỉ đọc chuyến được phân công sau khi đã mở online. Ca snapshot hỏng và 401/403 có bằng chứng Jest, Android riêng **NOT RUN**.
- Kiểm thử cuối ngày 21/11/2026. Jest mục tiêu **153/153**, full **404/404** (51 suites), TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, standalone Gradle build và Git diff check đạt. Bằng chứng Android, SQLite và PostgreSQL ở thư mục QA ngoài repository `D:/Tn/SmartTms-Phase4C1-QA/evidence`.

### Phase 4C.2 — JWT Expiry Android QA

**Test B · PASS trên Android thật ngày 21/11/2026.** APK Gradle release ARM64, v1.0.0 code 4, có bundle nhúng, package `com.smarttms.mobile.qa4c1`. SHA-256 bản cài `7CFFE1AB993C99DE55B2EC3735758DB4C901404A53A48363CC00EC4572661447`. Fingerprint thiết bị `realme/RMX3370/RE5473:13/TP1A.220905.001/R.1a88165-1ce22-e0695:user/release-keys`.

Fixture mới `QA-STITCH-PHASE4C2-JWT-EXPIRY` (`4470f42a-816a-41a9-bf71-d2356a675126`), ban đầu `DISPATCHED` v1, 0 event/command. Harness riêng ở `127.0.0.1:4402` dùng ADB reverse khi online. Trước cold start hết hạn, đã tắt Wi-Fi/dữ liệu di động, gỡ reverse và xác nhận Android không có default network. APK được mở bằng Launcher intent qua ADB, Metro tắt.

| Checkpoint | Android và SQLite | PostgreSQL |
|---|---|---|
| Trước hết hạn | JWT có `iat=1795242004`, `exp=1795242184` (13:20:04–13:23:04 UTC+7), TTL 180 giây. Profile 200. Cold start offline mở snapshot mã hóa và hiện 2 lệnh. Harness trả 503 sau xác thực ở lần gửi ARRIVE đầu để ghi nhận chính xác trạng thái gửi chưa rõ kết quả. | Trip `IN_PROGRESS` v2, kho `PENDING`, 1 ProcessedCommand và 1 ExecutionEvent của START. |
| Sau hết hạn | Đồng hồ Android đã qua `exp` 6 giây. Cùng JWT gọi profile trả 401. APK về Login, deep link Stop vẫn ở Login. Hai lệnh giữ nguyên trạng thái, payload fingerprint, hash idempotency key, `occurredAt` và version. | v2, 1 command/event, kho `PENDING`. |
| Tài khoản RELIEF | Chuyến QA bị từ chối khi online, workspace riêng offline hiện queue rỗng. Inspector chỉ đọc vẫn thấy 2 lệnh thuộc Driver ban đầu. | v2, 1 command/event, kho `PENDING`. |
| Tái xác thực đúng Driver | Coordinator xử lý ARRIVE rồi COMPLETE. ARRIVE giữ nguyên body hash, key, timestamp và wire version 2. COMPLETE lần đầu gửi dùng version 3 sau kết quả ARRIVE. Hai key và payload đối chiếu khớp request hash trong DB. SQLite và UI về 0. | v4, kho `COMPLETED`, 3 command/event tổng cộng với ID riêng. Trip vẫn `IN_PROGRESS`. |

Harness chỉ bind loopback và dùng PostgreSQL test local. Khóa ký tồn tại trong bộ nhớ, log chỉ chứa thời hạn, mã trạng thái và hash đối chiếu. Guard và kiểm tra hạn/chữ ký dùng cơ chế thật. Harness và ADB reverse đã tắt sau QA. Bằng chứng nằm ngoài repository tại `D:/Tn/SmartTms-Phase4C2-QA`.

Jest mục tiêu **153/153**, toàn bộ Mobile Jest **404/404** (51 suites), TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, standalone Gradle release và Git diff check **PASS**.

### M5.1 C1 — Driver Contact và Android Dialer

| Ca | Kết quả |
|---|---|
| PRIMARY / RELIEF ở Trip còn quyền | **PASS Android thật**. PRIMARY ở `IN_PROGRESS` mở Pickup và Delivery đúng số QA. RELIEF ở `DISPATCHED` mở Dialer đúng số cấp Stop, giữ nhãn chỉ xem. RELIEF tại depot đã đến không có nút thực thi. API local trả 404 cho Trip ngoài assignment và Android không mở contact. |
| Android Back và nháp | **PASS Android thật**. Dialer hệ thống mở với số đã điền, không thực hiện cuộc gọi. Back về đúng Pickup/Delivery, nháp số lượng của Pickup và nháp người nhận của Delivery vẫn còn. Trip version giữ nguyên. |
| PII và offline | **PASS Android thật** với `COMPLETED/CANCELLED`, cold-start `OFFLINE_READ_ONLY` và đổi tài khoản. Số và CTA bị ẩn theo policy. Snapshot mới bỏ phone trước khi mã hóa, snapshot v1 cũ bỏ phone khi đọc. Đồng hồ expiry trong workspace đang mở có test Jest. |
| Dữ liệu và lỗi | **PASS Jest** cho số thiếu, số ngoài 9–15 chữ số, USSD, URI/control/extension, Dialer báo lỗi, nhiều task ở một Stop, số không rò ở historical projection và không gọi execution/đổi route khi mở Dialer. |
| APK và permissions | **PASS release ARM64** trên realme RMX3370, bundle nhúng, code 5, SHA-256 `D98EB058C063E9891F6BA39C92FEB2911DFF7C9390972E6EDD48DAF87D18DF10`. So khớp hash bản cài và xác nhận manifest không có `CALL_PHONE` hoặc `READ_CALL_LOG`. |
| Automated | Jest mục tiêu **152/152**, full Mobile **436/436** (53 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Gradle release và git diff check đạt. Backend không chỉnh sửa. Kiểm tra contract trên Backend local qua TCP test DB cho thấy PRIMARY/RELIEF được phân công nhận 200, ngoài assignment nhận 404. Không chạy regression suite Backend. |

Đo C2 bằng transaction PostgreSQL read-only tại `127.0.0.1:55433/tms_auth_test`. 106/106 task thiếu `orderStopId`, 8 điểm chứa nhiều Order, không có liên kết để kiểm thử contact theo đơn trên mẫu này. Xem [audit C1/C2](../03-technical/driver-beyond-mvp-gap-audit.md#m51-c1--liên-hệ-tại-điểm-dừng).

Ca RELIEF ở depot được xác minh qua Overview → Xem điểm dừng. Lần thử mở thẳng deep link của depot đó qua ADB hiện màn không tìm thấy điểm dừng. Điều hướng trở lại từ Dialer được xác minh độc lập trên Pickup/Delivery. Ca thiết bị không cài Dialer được kiểm bằng Jest.

### Android UI Polish & Queue Context · cần xác nhận lại

Jest mục tiêu **108/108 PASS**, full Mobile Jest **345/345 PASS**, TypeScript và ESLint **PASS**, Expo Doctor **20/20 PASS**, Android export **PASS** tại `mobile/dist/m412b-polish-android-verified`. Jest kiểm tra cấu hình font scaling và hành vi điều hướng. Vị trí chữ thực tế, TalkBack và GPS nền cần kiểm tra trên thiết bị.

| ID | Thao tác trên Android | PASS khi | Kết quả |
|---|---|---|---|
| M412B-P01 | Mở Home với tên tài xế dài có dấu. Thử cỡ chữ mặc định/lớn nhất và màn hình hẹp. | Tiêu đề, tên và Tài khoản không đè nhau; tên xuống dòng, nút vẫn mở được và Back về Home. | NOT RUN |
| M412B-P02 | Xem chuyến đang thực hiện khi queue chuyến có lệnh pending hoặc conflict. | Số của chuyến tách khỏi tổng tài khoản. Cảnh báo chuyến chỉ hiện khi lệnh thuộc đúng chuyến. CTA mở Sync đúng ID. | NOT RUN |
| M412B-P03 | So sánh khi lỗi thuộc một chuyến khác đã tải, một chuyến chưa tải hoặc nhiều chuyến. Thử lại khi không có chuyến active. | Lỗi hiển thị theo phạm vi tài khoản/chuyến khác. Chỉ mở thẳng Sync khi khớp đúng một chuyến trong dữ liệu Home; các trường hợp còn lại mở danh sách. | NOT RUN |
| M412B-P04 | Kiểm tra thẻ chuyến đã điều phối có mã dài, chữ lớn, TalkBack và chạm mở. | Giờ, trạng thái, xe dễ đọc; mã rút gọn trên thẻ, TalkBack đọc mã đầy đủ, mở đúng chi tiết. | NOT RUN |
| M412B-P05 | Đổi Home → Trip hoặc Sync → Back khi GPS chạy, mất mạng và đăng xuất có lệnh chờ. | Nhãn GPS đúng chuyến, queue vẫn giữ đúng tài khoản, ngoại tuyến hiện thông tin phù hợp, cảnh báo đăng xuất vẫn hoạt động. | NOT RUN |

## M4.1.2C.1 — Driver Design Foundation & Trip List UI Polish

### Automated · PASS

Jest mục tiêu **73/73 PASS**, full Mobile Jest **351/351 PASS** (49 suites). TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và Git diff check đều **PASS**. Android bundle ở `mobile/dist/m412c1-android-verified`.

### Android manual · NOT RUN

Dùng development APK với Metro và môi trường local/test. Dùng chuyến bằng chứng lịch sử để xem lại, thiết lập ca ghi dưới fixture riêng.

| ID | Ca Android | Điều kiện PASS |
|---|---|---|
| C1-01 | Mở Home, List, Account trên màn hẹp với cỡ chữ mặc định và lớn nhất. | Tiêu đề, tên dài, Back và Tài khoản đọc được, không chồng/cắt cạnh safe area. |
| C1-02 | Mở các card mã dài, chuyến qua ngày, các trạng thái và RELIEF. Bật TalkBack. | Mã nhận diện được, nghe mã đầy đủ, giờ và xe đúng, nhãn chỉ xem phù hợp. Chạm card tới đúng Trip. |
| C1-03 | Chọn từng filter, kéo làm mới và cuộn tải thêm. | Filter giữ đúng trạng thái được chọn, dữ liệu và phân trang theo server, không lặp card. |
| C1-04 | Giả lập loading lần đầu, rỗng theo filter, lỗi trang đầu và lỗi tải thêm. | Loading không báo rỗng, lỗi có đường thử lại. Lỗi trang sau giữ các card trước và retry cùng trang. |
| C1-05 | Tắt mạng khi có snapshot rồi khi vào filter chưa tải, sau đó nối lại. | Có nhãn cũ hoặc chưa có dữ liệu theo tình huống. Nối lại làm mới đúng filter. |
| C1-06 | Home → List → Account → Back, thử deep link Trip. Đăng xuất khi còn lệnh chờ. | Back đúng nguồn, phiên/role đúng, Account dùng guard và yêu cầu xác nhận. |
| C1-07 | Mở Home rồi Trip khi GPS đang chạy và có lệnh chưa đồng bộ, mở lại Customer Tracking đúng chủ. | Phạm vi GPS/queue giữ đúng, quá trình thực thi và trạng thái theo dõi vẫn theo contract. |

## M4.1.2C.2 — Driver Trip Overview & Stop Execution UI Polish

### Automated · PASS

- Jest mục tiêu **155/155 PASS** (16 suites), full Mobile Jest **353/353 PASS** (49 suites). Ca mới xác minh nút hoàn thành nằm ngoài vùng cuộn, cấu hình bàn phím số, lỗi inline đúng kiện/người nhận và RELIEF vào đúng điểm chỉ xem.
- TypeScript, ESLint, Expo dependency check, Expo Doctor **20/20**, Android export và Git diff check **PASS**. Android bundle tại `mobile/dist/m412c2-android-verified`. Bố cục khi IME hiện và việc cuộn thực tế đến lỗi thuộc manual QA.

### Android manual · NOT RUN

Dùng development APK với Metro, Backend local/test và fixture riêng cho thao tác ghi. Các chuyến bằng chứng M4.0/M4.1.1 dùng để xem lại.

| ID | Ca Android | Điều kiện PASS |
|---|---|---|
| C2-01 | Mở Overview ở DISPATCHED, IN_PROGRESS, COMPLETED và CANCELLED. Thử màn hẹp/chữ lớn. | Nhìn thấy tiến độ và CTA phù hợp gần điểm cần xử lý. Chuyến kết thúc chỉ xem. Điều hướng phụ không lặp địa chỉ. |
| C2-02 | Dùng PRIMARY và RELIEF, mở điểm trên Overview và timeline. | Đúng Trip/Stop ID. RELIEF thấy ngữ cảnh chỉ xem và không có nút ghi. |
| C2-03 | Nhập số lượng hợp lệ, sai định dạng và vượt kế hoạch; thử thiếu người nhận, lý do hoặc ghi chú khi chọn Khác. | Một hàng cho mỗi kiện. Lỗi nằm cạnh trường. Bàn phím số, cuộn tới lỗi và nút thanh dưới dùng được. |
| C2-04 | Android Back khi IME đang mở và khi còn draft. Thử ở lại và bỏ nháp. | Back theo thứ tự hệ thống, giữ nội dung khi chọn ở lại, xác nhận bỏ khi rời màn. |
| C2-05 | Tắt mạng, thực hiện kho/lấy/giao, xem overlay và nối lại. Thử conflict từ chuyến QA khác theo checklist. | Số local và server tách riêng, xử lý đúng scope/version, không tự sinh hoặc trùng lệnh qua navigation. |
| C2-06 | Kiểm tra giao một phần/thất bại, thiếu PHOTO, ảnh đang tải, PHOTO hợp lệ và chữ ký tùy chọn. | Kết quả đúng validator. Complete chỉ mở khi readiness và queue hợp lệ. |
| C2-07 | Từ Overview mở Mapbox, Sự cố, Sync, GPS rồi Back trong khi GPS đang hoạt động. | Đúng chuyến, đúng điểm đích. Không mất queue, không tạo watcher mới. |

## M5.2 — Driver Profile và Assigned Vehicle

| Kiểm tra | Kết quả |
|---|---|
| Backend Jest mục tiêu và regression ngoài PostgreSQL | 15/15 và 268/268 PASS |
| PostgreSQL local, suite Driver Read | 31/31 PASS, gồm 9 test mới cho M5.2 |
| Toàn bộ PostgreSQL local `127.0.0.1:55433/tms_auth_test` | 174/174 PASS |
| Mobile Jest mục tiêu và toàn bộ | 40/40 và 443/443 PASS |
| Nest build, Backend ESLint cho file runtime thay đổi | PASS |
| Mobile TypeScript, ESLint, Expo dependency check, Expo Doctor | PASS, Doctor 20/20 |
| Android export và Gradle release ARM64 | PASS |

PostgreSQL kiểm tra schema hiện hành. Fixture tích hợp có prefix ngẫu nhiên và tự dọn dữ liệu riêng. Kết quả bao gồm JWT thiếu/sai/inactive, role khác, thiếu Driver, query chèn owner, khác chi nhánh hoặc branch tài khoản null, GPLX null/hết hạn/nhiều bản ghi, whitelist, PRIMARY/RELIEF, khác owner cùng chi nhánh, đổi xe giữa hai Trip và tính tương thích của summary. Mobile kiểm tra parse allowlist và payload cũ, chọn đúng chuyến, không gửi command từ Account, đọc offline bị chặn, guard đăng xuất và Back/deep link qua Router.

### Android QA

| ID | Ca trên thiết bị | Kết quả |
|---|---|---|
| M52-01 | Mở Account với GPLX còn hạn. Kiểm tra đúng hồ sơ/chi nhánh, số hoạt động được che và ngày GPLX. | PASS. GPLX CE, hạn 01/02/2030, trạng thái đã lưu PENDING. |
| M52-02 | Chọn hai chuyến có xe khác nhau. Kiểm tra biển số, thông số và role cho từng chuyến. | PASS. PRIMARY đổi đúng hai xe 3.500 kg và 7.000 kg. |
| M52-03 | Tài khoản RELIEF đọc chuyến được cấp; Account báo thiếu GPLX khi chưa có hồ sơ. | PASS. Xe của chuyến ASSIGNED và nhãn Hỗ trợ (RELIEF), GPLX null. |
| M52-04 | Dùng Back hoặc deep link và đăng xuất. Kiểm tra điều hướng đúng màn. | PASS. Account Back về Home, deep link mở đúng Trip, Trip Back về Home. Đăng xuất về Login. |
| M52-05 | Cold start offline. Thử deep link Account sau khi đã xác thực và mở Trip. | PASS. Tắt Wi-Fi, bật airplane mode, bỏ USB reverse API và force-stop. Deep link Account chỉ mở workspace đọc ngoại tuyến. |
| M52-06 | Có lệnh offline đang chờ. Account hiện đúng số lượng, logout vẫn có cảnh báo, dữ liệu queue được giữ. | PASS. Sau một ARRIVE_STOP offline, Account hiện 1. Bấm Đăng xuất rồi Ở lại vẫn còn 1. Kết nối lại, queue về 0. PostgreSQL chuyển Trip v1 → v2, Stop PENDING → ARRIVED, đúng một ExecutionEvent và một ProcessedCommand có liên kết. Nhánh xác nhận rời app khi còn lệnh được kiểm qua Jest Router. |

Thực hiện trên Realme RMX3370 ở 360 dp, font scale 1.0, APK QA release v1.0.0 code 6 có bundle nhúng và API qua USB reverse tới Backend local. Ảnh Account, Trip deep link, offline cold start và metadata APK ở `D:/Tn/SmartTms-M52-QA/evidence`. Dữ liệu thử là fixture riêng trong PostgreSQL local. Không dùng fixture lịch sử cho thao tác ghi.

## M5.3 — Driver Calendar và Trip History

| Kiểm thử tự động | Kết quả |
|---|---|
| Backend Jest mục tiêu / hồi quy | 15/15 · 268/268 PASS |
| PostgreSQL Driver Read / toàn bộ local | 38/38 · 181/181 PASS |
| Mobile Jest mục tiêu / toàn bộ | 45/45 · 448/448 PASS |
| Backend lint phạm vi M5.3, Nest build, Mobile ESLint và TypeScript | PASS |
| Expo dependency check, Expo Doctor, Android export và Gradle release | PASS · Doctor 20/20 |

PostgreSQL local `127.0.0.1:55433/tms_auth_test` xác nhận biên nửa mở theo offset, ca qua đêm, hai assignment một Trip, PRIMARY/RELIEF, lọc owner và assignment thu hồi, role/inactive/unlinked, cột thời gian NOT NULL, history fallback, cursor trùng timestamp, summary LOAD/UNLOAD và whitelist. Fixture tích hợp có prefix ngẫu nhiên và dọn đúng dữ liệu tạo bởi suite.

Plan PostgreSQL QA cho Calendar có sort/limit sau giao khoảng theo assignment. History lấy page trước khi tính aggregates theo Trip. Calendar phát 5 SELECT (cộng BEGIN/COMMIT) cho cả trang một Trip và trang bốn Trip. History phát một SELECT resolve Driver và một query page/summary. Kết quả trên dataset QA nhỏ dùng để xác nhận shape và không tăng số round trip theo số item. [Contract](../03-technical/api-contracts.md#get-drivertripshistory)

### Android release QA

Realme RMX3370, 360 dp, APK riêng `com.smarttms.mobile.qa4c1` v1.0.0 code 7. Fixture local riêng gồm hai tài khoản và bốn Trip. Evidence ở `D:/Tn/SmartTms-M53-QA/evidence`, có hash APK đã cài, ảnh và kết quả Backend/PostgreSQL.

| Ca kiểm thử | Kết quả |
|---|---|
| Calendar tuần/ngày, Hôm nay, tuần trống, nhiều Trip, giờ planned/actual | PASS. Hai Trip trong ngày, ngày/tuần trống có thông báo. Dải ngày một hàng và đưa ngày đang chọn vào viewport. |
| Trip qua đêm, chọn ngày sau, detail và Back | PASS. Cùng mã Trip ở 21/11 và 22/11; chỉ có một card trên từng ngày. CTA tới đúng Trip, Back giữ ngày chọn. |
| History COMPLETED/CANCELLED, lọc kỳ/trạng thái, detail và Back | PASS. COMPLETED hiển thị mốc thực, CANCELLED hiển thị mốc kế hoạch. Cursor qua timestamp trùng được kiểm ở PostgreSQL và Mobile Jest. |
| Loading, lỗi và retry | PASS. Proxy loopback giữ request History rồi trả 503. Đã chụp trạng thái tải/lỗi; retry trực tiếp vào Backend local tải lại danh sách. |
| Font scale 1.0 và 1.35 | PASS. Đọc giá trị cấu hình thiết bị, chụp cả hai màn và kiểm tra chọn ngày, kỳ, CTA và Back ở cỡ chữ lớn. |
| RELIEF và owner isolation | PASS. Lịch chỉ có Trip qua đêm được gán, History chỉ có Trip hoàn thành được gán, lọc Đã hủy trả trạng thái trống. |
| Offline đang mở app và cold-start deep link | PASS. History báo chưa có bản lưu khi mất mạng. Force-stop rồi mở Calendar offline chuyển sang workspace Phase 4C chỉ đọc. |
| Tác động GPS và queue | PASS trong fixture QA. Bốn Trip giữ version 1 và PostgreSQL ghi 0 GPS event, 0 execution event, 0 processed command trước/sau. Hồi quy FIFO, JWT expiry và logout pending guard chạy trong Mobile Jest. |

## M5.7 — Driver Bottom Tabs

| Kiểm thử | Kết quả |
|---|---|
| Mobile Jest mục tiêu và toàn bộ | 48/48 · 449/449 PASS |
| TypeScript, ESLint, Expo dependency check, Android export, Gradle release | PASS |
| Expo Doctor | 20/20 PASS |

Router test chạy JavaScript Tabs thật và kiểm tra public route, Back về tab nguồn, deep link, role, cold start offline, JWT expiry, logout với queue đang chờ và full-screen Trip. Đổi qua bốn tab giữ một lần activate coordinator theo owner, không gọi sync từ thao tác điều hướng và không mount lại tracking lifecycle. Full suite chạy thêm regression của lifecycle GPS, queue và Stop Execution.

### Android release QA

Realme RMX3370, 360 dp, gói QA release ARM64 code 8 có bundle nhúng. Đã xác minh chữ ký và SHA-256 APK đã cài. Backend chạy trên database test local hiện có, QA không ghi lệnh nghiệp vụ vào fixture lịch sử.

| Ca | Kết quả |
|---|---|
| Bốn tab, chọn qua lại, safe area ở font 1.0/1.35 | PASS. Đã chụp bốn màn ở cả hai cỡ chữ. |
| Home/Calendar/Activity/Account → Trip → Back | PASS với RELIEF. Account giữ Trip/xe đang chọn. Calendar giữ ngày, Activity giữ bộ lọc Đã hủy khi chuyển tab. Trip không hiện tab bar. |
| Warm deep link Stop List, cold deep link Trip, Back phím hệ thống và cử chỉ | PASS. Cold deep link có Home làm màn sau Back; cử chỉ Back từ Calendar đưa về Trang chủ. |
| Cold start offline với JWT hợp lệ và JWT hết hạn | PASS. QA proxy loopback dùng đăng nhập thật và cấp JWT test 45 giây. Khi token còn hạn, deep link mở workspace Phase 4C chỉ đọc. Sau khi token hết hạn thực tế, Activity deep link mở Login. Cả hai trạng thái đều không mount Tabs. |
| PRIMARY, RELIEF, CUSTOMER và logout | PASS. Hai Driver dùng cùng tab bar theo quyền Trip. Customer giữ luồng hiện hành khi mở Driver deep link và không thấy tab bar. Logout về Login. |
| Dữ liệu GPS/queue trên fixture M5.3 | Đối chiếu PostgreSQL giữ nguyên bốn Trip và 0 GPS/ExecutionEvent/ProcessedCommand. Pending queue được kiểm bằng Jest Router và regression offline. Ca có lệnh đang chờ chưa chạy lại trên thiết bị trong M5.7. |

Ảnh chụp và metadata APK ở `D:/Tn/SmartTms-M57-QA/evidence`.

## M5.4 — Driver Performance và Activity

| Kiểm thử tự động | Kết quả |
|---|---|
| Backend Jest hồi quy | 268/268 PASS |
| PostgreSQL mục tiêu / toàn bộ | 57/57 · 183/183 PASS |
| Mobile Jest mục tiêu / toàn bộ | 40/40 · 450/450 PASS |
| Backend ESLint phạm vi thay đổi, Nest build, Mobile ESLint và TypeScript | PASS |
| Expo dependency check, Android export, Gradle release | PASS |
| Expo Doctor | 20/20 PASS |

PostgreSQL local kiểm actor A/B trên cùng Trip, RELIEF, cùng chi nhánh khác owner, tài khoản không hợp lệ, pickup/delivery/depot, nhiều Order tại một Stop, chuyến hủy, thiếu event, sai liên kết, retry đồng thời thật, biên nửa mở và sự kiện đến muộn. Kiểm whitelist response và phân biệt thiếu dữ liệu với số 0. `EXPLAIN (ANALYZE, BUFFERS)` của câu tổng hợp trên fixture QA khoảng 1,67 ms. Endpoint dùng số lượt SELECT cố định; số đo này áp dụng cho tập dữ liệu local nhỏ.

### Android release QA

Realme RMX3370, 360 dp, `com.smarttms.mobile.qa4c1` code 9, bundle nhúng. APK, hash, ảnh, đối chiếu API và plan SQL lưu tại `D:/Tn/SmartTms-M54-QA`.

| Ca kiểm thử | Kết quả |
|---|---|
| PRIMARY · kỳ 30 ngày và 7 ngày | PASS. 30 ngày có 2 chuyến, 7 điểm, 2 điểm kho, 2 lần giao thành công, 2 một phần, 1 thất bại. Thu hẹp 7 ngày cho 1 chuyến, 4 điểm, 1 điểm kho và 1 lần giao mỗi loại. |
| RELIEF · theo actor | PASS. Kỳ 30 ngày có 1 điểm delivery, 1 lần thất bại và 0 chuyến hoàn thành. Kỳ 7 ngày hiện thông báo chưa có dữ liệu. |
| Tabs, History, Back, link Activity | PASS. Đổi tab và quay lại, mở Trip từ History rồi Back, mở Activity qua deep link sau khi buộc dừng. Cursor regression được xác nhận trong Jest/PostgreSQL. |
| Mất mạng | PASS. Kỳ đã xem hiện dữ liệu cũ và kỳ chưa xem hiện trạng thái chưa có bản lưu. |
| Font 1.0 và 1.35 | PASS. Xác nhận trên thiết bị và lưu ảnh. |
| Tác động ghi dữ liệu | PASS trên fixture. Hai Trip giữ version 1, giữ 12 ExecutionEvent, 6 DeliveryAttempt, 6 ProcessedCommand và 0 GPS event. Tình huống GPS đang chạy và queue đang có lệnh kiểm bằng hồi quy Mobile; fixture này gồm Trip đã kết thúc. |

## M5.8 — Driver Beyond-MVP Final Android E2E

APK release code 10 đã được kiểm trên Realme RMX3370, 360 dp. Chuyến MAIN đi qua Pickup, Delivery, PHOTO bắt buộc và hoàn thành ở v11. Đã tái chạy offline khi rút USB với JWT còn hạn và JWT đã hết hạn, owner isolation, FIFO đối chiếu SQLite và PostgreSQL, version conflict, cảnh báo thu hồi quyền GPS, Dialer giữ nháp và 26 ca direct deep link warm/cold.

Backend Jest mục tiêu/toàn bộ **85/85 · 268/268**, PostgreSQL **90/90 · 183/183**, Mobile **178/178 · 450/450**. Lint, TypeScript, Nest build, Expo dependency check, Doctor **20/20**, Android export và Gradle release đều đạt.

Kết luận ở lượt Final E2E là **NO-GO để đóng Driver**. Lượt bổ sung bên dưới cập nhật kết quả PII và GPS. [Báo cáo M5.8](driver-m5-final-android-e2e-report.md)

## M5.8.1 — Driver Contact PII

Backend mục tiêu/toàn bộ **36/36 · 272/272**. PostgreSQL **56/56 · 184/184**. Mobile Jest **259/259 · 450/450**. TypeScript, ESLint, Nest build, Expo dependency check, Expo Doctor **20/20**, Android export và Gradle release đều đạt.

12/12 request HTTP fixture đã che PII đạt. PRIMARY/RELIEF giữ contact ở Trip active. Chuyến COMPLETED/CANCELLED luôn trả trường `contactPhone: null`. Trip khác owner hoặc chỉ cùng chi nhánh trả 404. Integration kiểm cả lần đọc lại sau chuyển IN_PROGRESS → COMPLETED và xác nhận số gốc trong PostgreSQL. APK release code 10 mở đúng Native Dialer ở Pickup active và ẩn CTA ở lịch sử cho cả hai role.

## M5.8.2 — Background GPS và reconnect

Realme Android 13 standalone code 10, dùng **vị trí mô phỏng**. Trong 187 giây online ở nền, PostgreSQL nhận 0 điểm. Sau khi đưa app lên, nhận 13 điểm đo trong khoảng nền. Sau mất mạng, 1 điểm có `measuredAt` trước reconnect được nhận sau khi app lên foreground. Trong 83 giây đã khôi phục mạng nhưng app vẫn nền, PostgreSQL nhận 0 điểm. **FAIL** mức nghiệm thu upload và replay tự động ở nền, **PASS** thu GPS ở nền và gửi điểm đã đo khi mở lại app.

Foreground, bốn tab, Mapbox, hai Trip đã phân công và thu hồi quyền đạt theo phạm vi quan sát. JWT hết hạn trả về Login và chưa có GPS mới trước khi đăng nhập lại. Native service vẫn xuất hiện ở checkpoint logout, RELIEF và JWT hết hạn. Ca đổi tài khoản **FAIL P1** vì một mẫu đo trong phiên RELIEF được gán vào session PRIMARY mới. Màn hình khóa lâu và force-stop GPS chưa chạy để nghiệm thu.

[Bằng chứng và phân loại](driver-m5-final-android-e2e-report.md)

## M5.8.3 — GPS Session Isolation

| Kiểm tra | Bằng chứng mong đợi |
|---|---|
| Callback cũ sau khi đổi phiên | Tên đăng ký cũ không ánh xạ sang phiên mới. Callback không enqueue dù hai tài khoản có cùng Trip. |
| Logout trong lúc đăng ký native | Epoch bị vô hiệu ngay. Sau khi native start trả về, đăng ký vừa tạo được gỡ. Các row GPS cũ vẫn giữ định danh ban đầu. |
| Logout trong lúc callback hoặc HTTP | Kiểm lại epoch sau điểm chờ. Kết quả đến trễ không cập nhật queue mới. Backend có thể đã nhận request mang JWT gốc. |
| Cache fix và retry cùng phiên | Fix trước lúc đăng ký bị loại. Điểm hợp lệ trong cùng phiên giữ sequence khi retry, batch đi theo thứ tự queue. |
| Hai Trip và RELIEF | Hoàn thành tìm theo đúng Trip. Restore chỉ khởi động lại collection với PRIMARY/ASSIGNED trên Trip IN_PROGRESS. |
| Android D/E/F/G/H | Đối chiếu phiên hết hạn, tab/Mapbox, thu hồi quyền, đa Trip và cold start với dấu mốc native và PostgreSQL trong báo cáo M5.8. |
| Android A/B/I | Đo timestamp trước khi resume trong lượt Background Delivery riêng, sau khi Session Isolation đạt. |

Kết quả tự động M5.8.3A: 75/75 Mobile Jest mục tiêu, 461/461 Mobile Jest đầy đủ, 272/272 Backend Jest và 184/184 PostgreSQL integration local. TypeScript, ESLint, Nest build, Expo dependency check, Expo Doctor 20/20, Android export và Gradle release đã chạy. Các kết quả trên thiết bị được ghi theo từng ca trong [báo cáo M5.8](driver-m5-final-android-e2e-report.md#m583--gps-session-isolation--background-delivery-hardening).

Android M5.8.3A **PASS trong phạm vi đã kiểm chứng** cho đổi owner trên cùng Trip, hết hạn JWT, revoke quyền, tab/Mapbox, đa Trip và cold start đúng owner. M5.8.3B **FAIL** ở Launcher online và gửi bù điểm đo offline sau reconnect. Ca màn hình khóa **BLOCKED** vì injector chỉ phát được mẫu sau khi máy đã thức. Các timestamp, hash APK và bằng chứng native/SQLite/PostgreSQL nằm trong báo cáo M5.8.

## M5.8.3B.1 — Background GPS qua Wi-Fi

| Ca | Kết quả Realme Android 13 |
|---|---|
| Online Launcher | **FAIL.** Trong 100,2 giây, Android nhận intent và có job đang chờ. Marker #501 chỉ vào PostgreSQL sau khi mở lại app. |
| Offline → reconnect ở Launcher | **PASS trong cửa sổ đo.** Marker #601 và #801 vào PostgreSQL khi app còn nền, cùng session gốc. Lượt #801 đã dừng injector từ trước khi bật lại mạng và đối chiếu được callback, SQLite GPS, worker và HTTP 201. |
| Màn hình khóa | **FAIL.** Injector phát #701 với `interactive=false`, `keyguard=true`. Không nhận marker trong 100,5 giây khóa. Nhận sau khi mở lại app. |
| Đối chứng AOSP Android 13 | **NOT RUN.** Chưa có thiết bị/emulator AOSP khả dụng. |
| Đường mạng và PostgreSQL | **PASS.** Endpoint Wi-Fi riêng, ADB reverse rỗng trong lượt đo, nguồn TCP đúng IP Wi-Fi của Realme. PostgreSQL cuối có 38 điểm trong cùng session, 0 khóa trùng, Trip đối chứng 0 điểm. |

SQLite xác nhận enqueue của #801 sau khi Native/JS callback chạy trong lần reconnect. Độ bền qua dừng process trước reconnect chưa kiểm chứng. Mobile lint/typecheck đạt. M5.8 **NO-GO**. [Báo cáo và RFC](driver-m5-final-android-e2e-report.md#m583b1--đối-chứng-background-gps-qua-mạng-wi-fi)

## M5.8.3B.2 — JobScheduler trên Realme Android 13

| Ca | Expedited / Regular | Tiêu chí đã đối chiếu |
|---|---|---|
| Online Launcher | FAIL / FAIL | Schedule trả 1 cho #440 và #540. Cùng batch chỉ vào `onStartJob`, JS và SQLite sau mở lại. |
| Offline → reconnect | PASS / PASS trong cửa sổ đo | #450 và #550 giữ owner/session/timestamp, HTTP 201 khi ở nền. |
| Màn hình khóa | FAIL / FAIL | #460 và #560 phát dưới keyguard, có job được nhận trước cutoff, chỉ vào PostgreSQL sau mở lại. |
| AOSP | NOT RUN | Không có thiết bị/emulator. |

Mobile **461/461**, target **88/88**, PostgreSQL GPS **15/15**, TypeScript và ESLint PASS. Bền vững qua process death trước khi JS enqueue và chính sách Android giữ job còn mở. M5.8 **NO-GO**. [Báo cáo M5.8](driver-m5-final-android-e2e-report.md)

## G1 / M2.3 — Backend Customer Order Confirmation

Ngày 22/11/2026. PostgreSQL local tại `127.0.0.1:55433/tms_auth_test`. Fixture dùng Branch, Customer và tài khoản của lượt test. Planner query, snapshot và apply chạy qua service thật trên PostgreSQL. Road matrix và ranh giới solver được thay thế trong test.

| Bộ kiểm thử | Kết quả |
| --- | --- |
| Unit M2.3 | 25/25 PASS. DTO, validation dữ liệu đã lưu, Branch/role, CAS, thời điểm audit, receipt và idempotency. |
| PostgreSQL M2.3 | 10/10 PASS. JWT/role/Branch/404, chuyển trạng thái, replay sau khi Order tiến triển, key khác payload và hai ADMIN duyệt đồng thời. |
| Race PATCH/Confirm | PASS cả hai thứ tự. PATCH lấy khóa trước thì Confirm version cũ trả 409. Confirm lấy khóa trước thì PATCH đã đọc bản cũ trả 409, Items và notes giữ nguyên. |
| Rollback | PASS khi PostgreSQL từ chối ghi event vì unique constraint và từ chối lưu receipt vì FK. DRAFT và version được giữ, không có command/event xác nhận dở dang. Retry cùng key thành công sau khi bỏ lỗi test. |
| Planner eligibility | PASS. Cùng Order ID vắng trong snapshot trước duyệt và xuất hiện với version đúng sau duyệt. Order Branch khác bị loại, snapshot cũ giữ nguyên. Apply trả 409 khi PATCH làm version khác snapshot. |
| Regression | Backend Jest 491/491 gồm toàn bộ PostgreSQL 194/194. Customer create/list/detail, ownership, Admin POST và PATCH cũ đều nằm trong lượt chạy. |
| Build và lint | Nest build và ESLint cho source Orders đã sửa PASS. |

Phạm vi nghiệm thu Backend dừng ở API, audit/concurrency và planner eligibility. Web Admin UI và luồng G4 đầu cuối chờ tích hợp. [Contract G1](../03-technical/g1-customer-order-confirmation-contract.md)

## G3.1 — Samsung GPS Cross-Device QA

| Ca | Điều kiện nghiệm thu đặt trước | Trạng thái |
| --- | --- | --- |
| Thiết bị, APK và Wi-Fi | ADB có Samsung đã ủy quyền. Đọc model/API/fingerprint và baseline permission. SHA-256 trên máy khớp APK code 15, ADB reverse rỗng, HTTP peer xác nhận đến từ Wi-Fi Samsung. | **BLOCKED.** Windows nhận USB, ADB đã liệt kê thiết bị ở trạng thái `unauthorized`. APK, PostgreSQL TCP và Backend QA preflight đạt. |
| A — Foreground | PRIMARY start Trip QA, marker vào GpsEvent đúng Trip, Driver và session. | **NOT RUN** |
| B — Online Launcher | Marker tới PostgreSQL trong 100 giây từ thời điểm đo, app vẫn ở Launcher. Đối chiếu từng mốc native đến DB. | **NOT RUN** |
| C — Locked Screen | Marker phát dưới keyguard với màn hình non-interactive. Nhận trong 100 giây khi vẫn khóa. Nếu injector không phát marker hợp lệ, ghi BLOCKED. | **NOT RUN** |
| D — Offline → reconnect | Marker offline qua HTTP và DB trong 100 giây từ lúc Wi-Fi khôi phục khi app còn nền. Kiểm sequence, duplicate và dấu thời gian enqueue SQLite. | **NOT RUN** |
| Hồi quy bảo mật và cleanup | Logout, JWT hết hạn, PRIMARY → RELIEF → PRIMARY, revoke, Trip đối chứng 0 GPS. Ghi lại và hoàn nguyên quyền/cài đặt của lượt thử. | **NOT RUN** |

Mobile TypeScript và ESLint **PASS**. G3.1 đang BLOCKED, G3 tổng thể NO-GO. [Báo cáo Android](driver-m5-final-android-e2e-report.md#g31--đối-chứng-gps-trên-samsung-galaxy)
