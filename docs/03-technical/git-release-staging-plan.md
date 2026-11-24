# Smart TMS — Feature branch staging plan

**Ngày 24/11/2026 · chỉ lưu snapshot lên `feat/phase-1-core-tms`.** Dùng tài liệu này cho quyết định commit/push feature. Các cổng triển khai database được theo dõi riêng. [Nghiệp vụ Driver hiện hành](driver-assignment-availability-contract.md) · [Deployment blockers](shared-backend-release-review.md)

## 1. Git và CI/CD

- Local và remote feature đều ở `2f42fc49f93dcbc6d8dcbb68a5523b79f45d638f` sau `git fetch origin feat/phase-1-core-tms`. `rev-list --left-right --count` trả **0–0**. Local có **24 modified**, **347 untracked**, **0 staged**. Allowlist bên dưới bao phủ đủ **371 path**.
- GitHub chỉ liệt kê workflow active `.github/workflows/ci.yml`. Workflow chạy khi pull request hoặc khi push nhánh `main`, chỉ cài dependency, generate Prisma Client, build, lint và test. Push feature trực tiếp không trigger workflow này. Không có bước deploy/migrate trong workflow. GitHub không trả bản ghi deployment cho ref feature; API hooks trả HTTP 401, nên tích hợp ngoài repo hoặc webhook admin chưa xác minh.
- Kiểm tra `.gitignore`, file tracked/untracked và nội dung theo mẫu credentials. Các hit DB URL/secret assignment là config mẫu và fallback test guard. Không tìm thấy secret thật theo các mẫu quét. `backend/.env`, `mobile/.env.local`, APK và khóa ký bị ignore. Không có dump, SQLite, APK/AAB hoặc private key trong allowlist. Không lấy toàn bộ thư mục để stage. Scan này áp dụng cho snapshot hiện tại, không bao phủ mọi pattern hoặc lịch sử Git.

[CI workflow](../../.github/workflows/ci.yml) · [Backend env template](../../backend/.env.example) · [Mobile env template](../../mobile/.env.example)

## 2. Code hiện tại và phạm vi chưa triển khai

- Driver giữ `ASSIGNED`. Start đổi `DISPATCHED → IN_PROGRESS`, Complete đổi `IN_PROGRESS → COMPLETED`. Giữ PRIMARY/RELIEF, owner, version, receipt, PHOTO/SIGNATURE, PHOTO guard, GPS, Incident và offline workflow.
- Sửa lỗi hai yêu cầu Start cho hai Trip cùng tài xế đều thành công. Start giữ khóa Trip theo hiện trạng và khóa transaction theo driver identity trước khi kiểm tra Trip đang chạy. Từ chối chuyến thứ hai với `409 DRIVER_ALREADY_ON_TRIP` dù planned slots không trùng. Cập nhật fixture để các test dùng chung driver không để lại chuyến mở của ca trước. Giữ `ASSIGNED` và không cần migration. Không bổ sung chức năng nhận chuyến hoặc sửa planner.
- Trên schema feature, các endpoint/dữ liệu hiện tại và regression Driver/Mobile hoạt động. **Chưa triển khai** availability đầy đủ theo ca/nghỉ/di chuyển, confirm chuyến bổ sung, protocol chung giữa phân công và Start, completion evidence bằng assignment, event `TRIP_COMPLETED` và reserve command trước mutation. Các mục đó là proposal; guard Start chỉ xử lý việc khởi động hai chuyến cùng tài xế trên đường API hiện hành.
- M3.5 chạy được trên clean DB feature từ SQL trong repo. Có thể lưu nguyên schema/migration vào Git feature cùng writer và DTO, với phạm vi push lưu code. **Supabase deployment NO-GO** vì schema đích có `sizeBytes` trước, FK/thứ tự command và CHECK/trigger cần hòa hợp. Không sửa ledger, migration lịch sử hay ứng dụng DDL vào Supabase.

[Start guard](../../backend/src/trips/driver-trip-execution.service.ts) · [PostgreSQL Driver regression](../../backend/test/trips/driver-trip-execution.postgres.spec.ts) · [Mobile README](../../mobile/README.md)

## 3. Regression cuối

| Kiểm tra | Kết quả |
| --- | --- |
| Repro Start song song với code cũ | **FAIL dự kiến**, hai request cùng trả 201 |
| Backend Jest unit/regression | **297/297 PASS** |
| PostgreSQL disposable theo migration feature | **185/185 PASS** với 13 suite nguyên bản, gồm case Start mới |
| PostgreSQL suite G1 | **10/10 PASS** trên cùng disposable DB. Bản sao của suite được sửa đúng cổng và tên DB được phép, giữ nguyên assertions. File repo giữ nguyên guard QA cố định. |
| Nest build, Backend ESLint | **PASS** |
| Mobile Jest, TypeScript, ESLint | **461/461 PASS**; typecheck/lint **PASS** |
| Mobile navigation sau chuẩn hóa khoảng trắng cuối file | **37/37 PASS**, ba suite chạy lại |
| Expo Android JS export | **PASS**, 1.502 modules. Kiểm bundle JS, không phải APK native. |
| Production/DB QA chung, Android native và acceptance availability/completion proposal | **NOT RUN** |

DB chạy trên PostgreSQL disposable với credentials riêng, chỉ bind loopback và dựng bằng sáu file SQL feature hiện có. Cổng/DB QA chung không được sử dụng. Bằng chứng chi tiết ở thư mục tạm `tms-feature-final-x0pdeuwz` ngoài repo.

Đã sửa whitespace được phát hiện trong 11 path A, chỉ gồm dòng trống cuối file và ký hiệu xuống dòng Markdown. Nội dung và hành vi của các module navigation giữ nguyên.

## 4. Quy tắc chọn file

| Nhóm | Số path | Quyết định |
| --- | ---: | --- |
| A · READY TO STAGE | **339** | Source, tests, schema/migration M3.5 dùng với feature, Expo app config, lockfile, assets và docs. 87 file Backend trước đây chờ review dùng chung được đưa vào snapshot feature sau khi kiểm chứng nội bộ. Deployment vẫn có cổng riêng. |
| B · REVIEW REQUIRED | **4** | Profile EAS cần owner xác nhận; ba tài liệu cần xử lý link tới Stitch/QA artifacts trước khi phát hành cùng snapshot. |
| C · EXCLUDE | **28** | Seed QA, script/package diff chỉ phục vụ QA, design exports, editor cá nhân và tài liệu QA đi cùng. Giữ file `backend/package.json` phiên bản đã track; diff local của file này chỉ thêm ba lệnh seed QA. |

## 5. READY TO STAGE · dùng đúng danh sách dưới đây

`M` là path tracked có thay đổi. `A` là path mới. Các lệnh dùng path tương đối từ root. Stage tất cả các nhóm A trong snapshot để schema, migration, runtime và tests đi cùng nhau.

### Git và Backend (88)

- M `.gitignore`
- A `backend/prisma/migrations/20261116090000_driver_epod/migration.sql`
- M `backend/prisma/schema.prisma`
- M `backend/src/auth/auth.controller.ts`
- M `backend/src/auth/auth.service.ts`
- M `backend/src/auth/branch-scope.ts`
- A `backend/src/auth/dto/login.dto.ts`
- A `backend/src/auth/dto/register-customer.dto.ts`
- M `backend/src/auth/roles.guard.ts`
- M `backend/src/branches/branches.controller.ts`
- M `backend/src/branches/branches.service.ts`
- M `backend/src/common/services/cloudinary.service.ts`
- M `backend/src/customers/customers.controller.ts`
- A `backend/src/drivers/driver-activity.query.ts`
- A `backend/src/drivers/driver-self.controller.ts`
- M `backend/src/drivers/drivers.controller.ts`
- M `backend/src/drivers/drivers.module.ts`
- M `backend/src/drivers/drivers.service.ts`
- A `backend/src/drivers/dto/query-driver-activity.dto.ts`
- A `backend/src/orders/customer-branches.controller.ts`
- A `backend/src/orders/customer-order-confirmation.service.ts`
- A `backend/src/orders/customer-order-confirmation.validation.ts`
- A `backend/src/orders/customer-order-tracking.service.ts`
- A `backend/src/orders/customer-orders.controller.ts`
- A `backend/src/orders/customer-orders.service.ts`
- A `backend/src/orders/dto/confirm-customer-order.dto.ts`
- A `backend/src/orders/dto/create-customer-order.dto.ts`
- A `backend/src/orders/dto/query-customer-orders.dto.ts`
- M `backend/src/orders/dto/update-order.dto.ts`
- A `backend/src/orders/order-write.ts`
- M `backend/src/orders/orders.controller.ts`
- M `backend/src/orders/orders.module.ts`
- M `backend/src/orders/orders.service.ts`
- A `backend/src/trips/driver-gps.controller.ts`
- A `backend/src/trips/driver-gps.service.ts`
- A `backend/src/trips/driver-incidents.constants.ts`
- A `backend/src/trips/driver-incidents.controller.ts`
- A `backend/src/trips/driver-incidents.service.ts`
- A `backend/src/trips/driver-pod-policy.ts`
- A `backend/src/trips/driver-pod.controller.ts`
- A `backend/src/trips/driver-pod.service.ts`
- A `backend/src/trips/driver-trip-execution.constants.ts`
- A `backend/src/trips/driver-trip-execution.controller.ts`
- A `backend/src/trips/driver-trip-execution.service.ts`
- A `backend/src/trips/driver-trip-history.query.ts`
- A `backend/src/trips/driver-trips.controller.ts`
- A `backend/src/trips/driver-trips.service.ts`
- A `backend/src/trips/dto/driver-gps.dto.ts`
- A `backend/src/trips/dto/driver-incident.dto.ts`
- A `backend/src/trips/dto/driver-pod.dto.ts`
- A `backend/src/trips/dto/driver-trip-command.dto.ts`
- A `backend/src/trips/dto/driver-trip-date-range.ts`
- A `backend/src/trips/dto/query-driver-trip-history.dto.ts`
- A `backend/src/trips/dto/query-driver-trips.dto.ts`
- A `backend/src/trips/trip-tracking.controller.ts`
- M `backend/src/trips/trips.controller.ts`
- M `backend/src/trips/trips.module.ts`
- M `backend/src/trips/trips.service.ts`
- M `backend/src/vehicles/vehicles.controller.ts`
- M `backend/src/vehicles/vehicles.service.ts`
- A `backend/test/auth/auth.dto.spec.ts`
- A `backend/test/auth/auth.service.spec.ts`
- M `backend/test/auth/branch-scope.spec.ts`
- A `backend/test/auth/customer-auth.postgres.spec.ts`
- A `backend/test/auth/jwt.strategy.spec.ts`
- A `backend/test/auth/roles.guard.spec.ts`
- A `backend/test/auth/transport-authorization.postgres.spec.ts`
- A `backend/test/auth/transport-role-matrix.spec.ts`
- A `backend/test/common/services/cloudinary.service.spec.ts`
- A `backend/test/orders/create-customer-order.dto.spec.ts`
- A `backend/test/orders/customer-create-order.postgres.spec.ts`
- A `backend/test/orders/customer-order-confirmation.postgres.spec.ts`
- A `backend/test/orders/customer-order-confirmation.spec.ts`
- A `backend/test/orders/customer-order-tracking.postgres.spec.ts`
- A `backend/test/orders/customer-order-tracking.service.spec.ts`
- A `backend/test/orders/customer-orders.postgres.spec.ts`
- A `backend/test/orders/customer-orders.service.spec.ts`
- A `backend/test/orders/query-customer-orders.dto.spec.ts`
- A `backend/test/trips/driver-gps.postgres.spec.ts`
- A `backend/test/trips/driver-gps.service.spec.ts`
- A `backend/test/trips/driver-incidents.postgres.spec.ts`
- A `backend/test/trips/driver-incidents.service.spec.ts`
- A `backend/test/trips/driver-pod-policy.spec.ts`
- A `backend/test/trips/driver-pod.postgres.spec.ts`
- A `backend/test/trips/driver-trip-execution.postgres.spec.ts`
- A `backend/test/trips/driver-trip-execution.service.spec.ts`
- A `backend/test/trips/driver-trips.postgres.spec.ts`
- A `backend/test/trips/driver-trips.service.spec.ts`

```powershell
git add -- '.gitignore' 'backend/prisma/migrations/20261116090000_driver_epod/migration.sql' 'backend/prisma/schema.prisma' 'backend/src/auth/auth.controller.ts' 'backend/src/auth/auth.service.ts' 'backend/src/auth/branch-scope.ts' 'backend/src/auth/dto/login.dto.ts' 'backend/src/auth/dto/register-customer.dto.ts' 'backend/src/auth/roles.guard.ts' 'backend/src/branches/branches.controller.ts' 'backend/src/branches/branches.service.ts' 'backend/src/common/services/cloudinary.service.ts' 'backend/src/customers/customers.controller.ts' 'backend/src/drivers/driver-activity.query.ts' 'backend/src/drivers/driver-self.controller.ts' 'backend/src/drivers/drivers.controller.ts' 'backend/src/drivers/drivers.module.ts' 'backend/src/drivers/drivers.service.ts' 'backend/src/drivers/dto/query-driver-activity.dto.ts' 'backend/src/orders/customer-branches.controller.ts' 'backend/src/orders/customer-order-confirmation.service.ts' 'backend/src/orders/customer-order-confirmation.validation.ts' 'backend/src/orders/customer-order-tracking.service.ts' 'backend/src/orders/customer-orders.controller.ts' 'backend/src/orders/customer-orders.service.ts' 'backend/src/orders/dto/confirm-customer-order.dto.ts' 'backend/src/orders/dto/create-customer-order.dto.ts' 'backend/src/orders/dto/query-customer-orders.dto.ts' 'backend/src/orders/dto/update-order.dto.ts' 'backend/src/orders/order-write.ts' 'backend/src/orders/orders.controller.ts' 'backend/src/orders/orders.module.ts' 'backend/src/orders/orders.service.ts' 'backend/src/trips/driver-gps.controller.ts' 'backend/src/trips/driver-gps.service.ts' 'backend/src/trips/driver-incidents.constants.ts' 'backend/src/trips/driver-incidents.controller.ts' 'backend/src/trips/driver-incidents.service.ts' 'backend/src/trips/driver-pod-policy.ts' 'backend/src/trips/driver-pod.controller.ts' 'backend/src/trips/driver-pod.service.ts' 'backend/src/trips/driver-trip-execution.constants.ts' 'backend/src/trips/driver-trip-execution.controller.ts' 'backend/src/trips/driver-trip-execution.service.ts' 'backend/src/trips/driver-trip-history.query.ts' 'backend/src/trips/driver-trips.controller.ts' 'backend/src/trips/driver-trips.service.ts' 'backend/src/trips/dto/driver-gps.dto.ts' 'backend/src/trips/dto/driver-incident.dto.ts' 'backend/src/trips/dto/driver-pod.dto.ts' 'backend/src/trips/dto/driver-trip-command.dto.ts' 'backend/src/trips/dto/driver-trip-date-range.ts' 'backend/src/trips/dto/query-driver-trip-history.dto.ts' 'backend/src/trips/dto/query-driver-trips.dto.ts' 'backend/src/trips/trip-tracking.controller.ts' 'backend/src/trips/trips.controller.ts' 'backend/src/trips/trips.module.ts' 'backend/src/trips/trips.service.ts' 'backend/src/vehicles/vehicles.controller.ts' 'backend/src/vehicles/vehicles.service.ts' 'backend/test/auth/auth.dto.spec.ts' 'backend/test/auth/auth.service.spec.ts' 'backend/test/auth/branch-scope.spec.ts' 'backend/test/auth/customer-auth.postgres.spec.ts' 'backend/test/auth/jwt.strategy.spec.ts' 'backend/test/auth/roles.guard.spec.ts' 'backend/test/auth/transport-authorization.postgres.spec.ts' 'backend/test/auth/transport-role-matrix.spec.ts' 'backend/test/common/services/cloudinary.service.spec.ts' 'backend/test/orders/create-customer-order.dto.spec.ts' 'backend/test/orders/customer-create-order.postgres.spec.ts' 'backend/test/orders/customer-order-confirmation.postgres.spec.ts' 'backend/test/orders/customer-order-confirmation.spec.ts' 'backend/test/orders/customer-order-tracking.postgres.spec.ts' 'backend/test/orders/customer-order-tracking.service.spec.ts' 'backend/test/orders/customer-orders.postgres.spec.ts' 'backend/test/orders/customer-orders.service.spec.ts' 'backend/test/orders/query-customer-orders.dto.spec.ts' 'backend/test/trips/driver-gps.postgres.spec.ts' 'backend/test/trips/driver-gps.service.spec.ts' 'backend/test/trips/driver-incidents.postgres.spec.ts' 'backend/test/trips/driver-incidents.service.spec.ts' 'backend/test/trips/driver-pod-policy.spec.ts' 'backend/test/trips/driver-pod.postgres.spec.ts' 'backend/test/trips/driver-trip-execution.postgres.spec.ts' 'backend/test/trips/driver-trip-execution.service.spec.ts' 'backend/test/trips/driver-trips.postgres.spec.ts' 'backend/test/trips/driver-trips.service.spec.ts'
```

### Mobile config, lockfile và assets (17)

- A `mobile/.env.example`
- A `mobile/.gitignore`
- A `mobile/AGENTS.md`
- A `mobile/app.json`
- A `mobile/assets/android-icon-background.png`
- A `mobile/assets/android-icon-foreground.png`
- A `mobile/assets/android-icon-monochrome.png`
- A `mobile/assets/favicon.png`
- A `mobile/assets/icon.png`
- A `mobile/assets/splash-icon.png`
- A `mobile/eslint.config.js`
- A `mobile/jest.setup.ts`
- A `mobile/LICENSE`
- A `mobile/package-lock.json`
- A `mobile/package.json`
- A `mobile/README.md`
- A `mobile/tsconfig.json`

```powershell
git add -- 'mobile/.env.example' 'mobile/.gitignore' 'mobile/AGENTS.md' 'mobile/app.json' 'mobile/assets/android-icon-background.png' 'mobile/assets/android-icon-foreground.png' 'mobile/assets/android-icon-monochrome.png' 'mobile/assets/favicon.png' 'mobile/assets/icon.png' 'mobile/assets/splash-icon.png' 'mobile/eslint.config.js' 'mobile/jest.setup.ts' 'mobile/LICENSE' 'mobile/package-lock.json' 'mobile/package.json' 'mobile/README.md' 'mobile/tsconfig.json'
```

### Mobile source và tests (213)

- A `mobile/src/app/_layout.tsx`
- A `mobile/src/app/(auth)/_layout.tsx`
- A `mobile/src/app/(auth)/login.tsx`
- A `mobile/src/app/(auth)/register.tsx`
- A `mobile/src/app/(customer)/_layout.tsx`
- A `mobile/src/app/(customer)/index.tsx`
- A `mobile/src/app/(customer)/orders/[id].tsx`
- A `mobile/src/app/(customer)/orders/create.tsx`
- A `mobile/src/app/(customer)/orders/index.tsx`
- A `mobile/src/app/(driver)/_layout.tsx`
- A `mobile/src/app/(driver)/(tabs)/_layout.tsx`
- A `mobile/src/app/(driver)/(tabs)/account.tsx`
- A `mobile/src/app/(driver)/(tabs)/activity.tsx`
- A `mobile/src/app/(driver)/(tabs)/calendar.tsx`
- A `mobile/src/app/(driver)/(tabs)/index.tsx`
- A `mobile/src/app/(driver)/trips/[id]/_layout.tsx`
- A `mobile/src/app/(driver)/trips/[id]/incidents.tsx`
- A `mobile/src/app/(driver)/trips/[id]/index.tsx`
- A `mobile/src/app/(driver)/trips/[id]/map.tsx`
- A `mobile/src/app/(driver)/trips/[id]/stops.tsx`
- A `mobile/src/app/(driver)/trips/[id]/stops/[stopId].tsx`
- A `mobile/src/app/(driver)/trips/[id]/stops/[stopId]/pod.tsx`
- A `mobile/src/app/(driver)/trips/[id]/sync.tsx`
- A `mobile/src/app/(driver)/trips/index.tsx`
- A `mobile/src/app/session-error.tsx`
- A `mobile/src/app/unsupported-role.tsx`
- A `mobile/src/features/auth/components/AuthScreenLayout.tsx`
- A `mobile/src/features/auth/components/FormField.tsx`
- A `mobile/src/features/auth/components/OfflineDriverWorkspace.tsx`
- A `mobile/src/features/auth/hooks/useAuth.ts`
- A `mobile/src/features/auth/hooks/useRegisterCustomer.ts`
- A `mobile/src/features/auth/providers/auth-reducer.ts`
- A `mobile/src/features/auth/providers/AuthProvider.tsx`
- A `mobile/src/features/auth/screens/CustomerHomeScreen.tsx`
- A `mobile/src/features/auth/screens/DriverPlaceholderScreen.tsx`
- A `mobile/src/features/auth/screens/LoginScreen.tsx`
- A `mobile/src/features/auth/screens/RegisterScreen.tsx`
- A `mobile/src/features/auth/screens/SessionErrorScreen.tsx`
- A `mobile/src/features/auth/screens/UnsupportedRoleScreen.tsx`
- A `mobile/src/features/auth/services/auth.service.ts`
- A `mobile/src/features/auth/services/offline-driver-identity.spec.ts`
- A `mobile/src/features/auth/services/offline-driver-identity.ts`
- A `mobile/src/features/auth/types/auth.types.ts`
- A `mobile/src/features/auth/validation/auth.validation.spec.ts`
- A `mobile/src/features/auth/validation/auth.validation.ts`
- A `mobile/src/features/driver-home/hooks/useDriverAccountData.ts`
- A `mobile/src/features/driver-home/hooks/useDriverHomeData.ts`
- A `mobile/src/features/driver-home/screens/driver-home.spec.tsx`
- A `mobile/src/features/driver-home/screens/DriverAccountScreen.tsx`
- A `mobile/src/features/driver-home/screens/DriverHomeScreen.tsx`
- A `mobile/src/features/driver-home/services/driver-profile.service.spec.ts`
- A `mobile/src/features/driver-home/services/driver-profile.service.ts`
- A `mobile/src/features/driver-incidents/components/DriverIncidentCard.tsx`
- A `mobile/src/features/driver-incidents/components/DriverIncidentForm.tsx`
- A `mobile/src/features/driver-incidents/components/DriverIncidentPanel.spec.tsx`
- A `mobile/src/features/driver-incidents/components/DriverIncidentPanel.tsx`
- A `mobile/src/features/driver-incidents/hooks/useCreateDriverIncident.spec.ts`
- A `mobile/src/features/driver-incidents/hooks/useCreateDriverIncident.ts`
- A `mobile/src/features/driver-incidents/hooks/useDriverIncidents.spec.ts`
- A `mobile/src/features/driver-incidents/hooks/useDriverIncidents.ts`
- A `mobile/src/features/driver-incidents/services/driver-incidents.service.spec.ts`
- A `mobile/src/features/driver-incidents/services/driver-incidents.service.ts`
- A `mobile/src/features/driver-incidents/types/driver-incident.types.ts`
- A `mobile/src/features/driver-incidents/validation/driver-incident.validation.spec.ts`
- A `mobile/src/features/driver-incidents/validation/driver-incident.validation.ts`
- A `mobile/src/features/driver-navigation/components/DriverMapErrorBoundary.tsx`
- A `mobile/src/features/driver-navigation/components/DriverMapStopPanel.tsx`
- A `mobile/src/features/driver-navigation/components/DriverNavigationPanel.spec.tsx`
- A `mobile/src/features/driver-navigation/components/DriverNavigationPanel.tsx`
- A `mobile/src/features/driver-navigation/components/DriverTripMap.spec.tsx`
- A `mobile/src/features/driver-navigation/components/DriverTripMap.tsx`
- A `mobile/src/features/driver-navigation/screens/DriverTripMapScreen.tsx`
- A `mobile/src/features/driver-navigation/selectors/driver-map.selector.spec.ts`
- A `mobile/src/features/driver-navigation/selectors/driver-map.selector.ts`
- A `mobile/src/features/driver-navigation/selectors/driver-navigation-stop.selector.spec.ts`
- A `mobile/src/features/driver-navigation/selectors/driver-navigation-stop.selector.ts`
- A `mobile/src/features/driver-navigation/services/external-navigation.service.spec.ts`
- A `mobile/src/features/driver-navigation/services/external-navigation.service.ts`
- A `mobile/src/features/driver-navigation/types/driver-map.types.ts`
- A `mobile/src/features/driver-navigation/types/driver-navigation.types.ts`
- A `mobile/src/features/driver-offline/components/OfflineDriverExecutionLifecycle.tsx`
- A `mobile/src/features/driver-offline/components/OfflineDriverQueuePanel.spec.tsx`
- A `mobile/src/features/driver-offline/components/OfflineDriverQueuePanel.tsx`
- A `mobile/src/features/driver-offline/hooks/useOfflineDriverQueue.ts`
- A `mobile/src/features/driver-offline/selectors/offline-driver-overlay.spec.ts`
- A `mobile/src/features/driver-offline/selectors/offline-driver-overlay.ts`
- A `mobile/src/features/driver-offline/services/offline-command-serialization.spec.ts`
- A `mobile/src/features/driver-offline/services/offline-command-serialization.ts`
- A `mobile/src/features/driver-offline/services/offline-driver-command-sync.service.spec.ts`
- A `mobile/src/features/driver-offline/services/offline-driver-command-sync.service.ts`
- A `mobile/src/features/driver-offline/services/offline-driver-execution.coordinator.ts`
- A `mobile/src/features/driver-offline/services/single-flight.spec.ts`
- A `mobile/src/features/driver-offline/services/single-flight.ts`
- A `mobile/src/features/driver-offline/storage/offline-driver-command.storage.spec.ts`
- A `mobile/src/features/driver-offline/storage/offline-driver-command.storage.ts`
- A `mobile/src/features/driver-offline/types/offline-driver-command.types.ts`
- A `mobile/src/features/driver-tracking/components/DriverTrackingLifecycle.spec.tsx`
- A `mobile/src/features/driver-tracking/components/DriverTrackingLifecycle.tsx`
- A `mobile/src/features/driver-tracking/components/DriverTrackingPanel.spec.tsx`
- A `mobile/src/features/driver-tracking/components/DriverTrackingPanel.tsx`
- A `mobile/src/features/driver-tracking/hooks/useDriverTracking.spec.ts`
- A `mobile/src/features/driver-tracking/hooks/useDriverTracking.ts`
- A `mobile/src/features/driver-tracking/services/driver-gps-api.service.ts`
- A `mobile/src/features/driver-tracking/services/driver-gps-authorization.ts`
- A `mobile/src/features/driver-tracking/services/driver-gps.engine.spec.ts`
- A `mobile/src/features/driver-tracking/services/driver-gps.engine.ts`
- A `mobile/src/features/driver-tracking/services/driver-tracking.service.spec.ts`
- A `mobile/src/features/driver-tracking/services/driver-tracking.service.ts`
- A `mobile/src/features/driver-tracking/storage/device-code.storage.spec.ts`
- A `mobile/src/features/driver-tracking/storage/device-code.storage.ts`
- A `mobile/src/features/driver-tracking/storage/driver-gps.storage.spec.ts`
- A `mobile/src/features/driver-tracking/storage/driver-gps.storage.ts`
- A `mobile/src/features/driver-tracking/tasks/driver-location.registration.ts`
- A `mobile/src/features/driver-tracking/tasks/driver-location.task.spec.ts`
- A `mobile/src/features/driver-tracking/tasks/driver-location.task.ts`
- A `mobile/src/features/driver-tracking/types/driver-tracking.types.ts`
- A `mobile/src/features/driver-trips/components/DriverStopContact.tsx`
- A `mobile/src/features/driver-trips/components/DriverStopListChrome.tsx`
- A `mobile/src/features/driver-trips/components/DriverTripCard.tsx`
- A `mobile/src/features/driver-trips/components/DriverTripHeader.tsx`
- A `mobile/src/features/driver-trips/components/DriverTripStatusBadge.tsx`
- A `mobile/src/features/driver-trips/components/DriverTripStopRow.tsx`
- A `mobile/src/features/driver-trips/components/DriverTripSupportScreen.tsx`
- A `mobile/src/features/driver-trips/components/execution/DriverStopExecutionPanel.spec.tsx`
- A `mobile/src/features/driver-trips/components/execution/DriverStopExecutionPanel.tsx`
- A `mobile/src/features/driver-trips/components/pod/DriverPodPanel.spec.tsx`
- A `mobile/src/features/driver-trips/components/pod/DriverPodPanel.tsx`
- A `mobile/src/features/driver-trips/hooks/useDriverLogout.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverPod.spec.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverPod.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripApiError.spec.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripApiError.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripDetail.spec.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripDetail.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripExecution.spec.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripExecution.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTripPodReadiness.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTrips.spec.ts`
- A `mobile/src/features/driver-trips/hooks/useDriverTrips.ts`
- A `mobile/src/features/driver-trips/providers/DriverTripWorkspace.tsx`
- A `mobile/src/features/driver-trips/schedule/driver-schedule-dates.spec.ts`
- A `mobile/src/features/driver-trips/schedule/driver-schedule-dates.ts`
- A `mobile/src/features/driver-trips/schedule/DriverActivityMetrics.tsx`
- A `mobile/src/features/driver-trips/schedule/DriverScheduleScreens.tsx`
- A `mobile/src/features/driver-trips/schedule/useDriverScheduleRead.ts`
- A `mobile/src/features/driver-trips/screens/driver-trip-screens.spec.tsx`
- A `mobile/src/features/driver-trips/screens/DriverStopExecutionScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverStopPodScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverTripDetailScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverTripIncidentsScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverTripListScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverTripStopsScreen.tsx`
- A `mobile/src/features/driver-trips/screens/DriverTripSyncScreen.tsx`
- A `mobile/src/features/driver-trips/selectors/driver-stop-contact.spec.ts`
- A `mobile/src/features/driver-trips/selectors/driver-stop-contact.ts`
- A `mobile/src/features/driver-trips/selectors/driver-stop-list.ts`
- A `mobile/src/features/driver-trips/selectors/driver-trip-workflow.ts`
- A `mobile/src/features/driver-trips/services/driver-pod.service.spec.ts`
- A `mobile/src/features/driver-trips/services/driver-pod.service.ts`
- A `mobile/src/features/driver-trips/services/driver-trips.service.spec.ts`
- A `mobile/src/features/driver-trips/services/driver-trips.service.ts`
- A `mobile/src/features/driver-trips/storage/offline-trip-snapshots.spec.ts`
- A `mobile/src/features/driver-trips/storage/offline-trip-snapshots.ts`
- A `mobile/src/features/driver-trips/types/driver-trip.types.ts`
- A `mobile/src/features/driver-trips/validation/driver-pod.validation.spec.ts`
- A `mobile/src/features/driver-trips/validation/driver-pod.validation.ts`
- A `mobile/src/features/driver-trips/validation/driver-trip-execution.validation.spec.ts`
- A `mobile/src/features/driver-trips/validation/driver-trip-execution.validation.ts`
- A `mobile/src/features/orders/components/CustomerOrderTrackingPanel.spec.tsx`
- A `mobile/src/features/orders/components/CustomerOrderTrackingPanel.tsx`
- A `mobile/src/features/orders/components/OrderCard.tsx`
- A `mobile/src/features/orders/components/OrderFormField.tsx`
- A `mobile/src/features/orders/components/OrderScreenHeader.tsx`
- A `mobile/src/features/orders/components/OrderStatusBadge.tsx`
- A `mobile/src/features/orders/components/PackageItemEditor.tsx`
- A `mobile/src/features/orders/hooks/useCreateCustomerOrder.spec.ts`
- A `mobile/src/features/orders/hooks/useCreateCustomerOrder.ts`
- A `mobile/src/features/orders/hooks/useCustomerBranches.ts`
- A `mobile/src/features/orders/hooks/useCustomerOrderDetail.ts`
- A `mobile/src/features/orders/hooks/useCustomerOrders.spec.ts`
- A `mobile/src/features/orders/hooks/useCustomerOrders.ts`
- A `mobile/src/features/orders/hooks/useCustomerOrderTracking.spec.ts`
- A `mobile/src/features/orders/hooks/useCustomerOrderTracking.ts`
- A `mobile/src/features/orders/hooks/useOrderApiError.spec.ts`
- A `mobile/src/features/orders/hooks/useOrderApiError.ts`
- A `mobile/src/features/orders/screens/customer-order-navigation.spec.tsx`
- A `mobile/src/features/orders/screens/CustomerCreateOrderScreen.tsx`
- A `mobile/src/features/orders/screens/CustomerOrderDetailScreen.spec.tsx`
- A `mobile/src/features/orders/screens/CustomerOrderDetailScreen.tsx`
- A `mobile/src/features/orders/screens/CustomerOrderListScreen.tsx`
- A `mobile/src/features/orders/services/orders.service.spec.ts`
- A `mobile/src/features/orders/services/orders.service.ts`
- A `mobile/src/features/orders/types/order-tracking.types.ts`
- A `mobile/src/features/orders/types/order.types.ts`
- A `mobile/src/features/orders/validation/order.validation.spec.ts`
- A `mobile/src/features/orders/validation/order.validation.ts`
- A `mobile/src/shared/api/api-client.spec.ts`
- A `mobile/src/shared/api/api-client.ts`
- A `mobile/src/shared/api/api-error.ts`
- A `mobile/src/shared/assets/driver-tabs/account.png`
- A `mobile/src/shared/assets/driver-tabs/activity.png`
- A `mobile/src/shared/assets/driver-tabs/calendar.png`
- A `mobile/src/shared/assets/driver-tabs/home.png`
- A `mobile/src/shared/components/FullScreenLoader.tsx`
- A `mobile/src/shared/components/PrimaryButton.tsx`
- A `mobile/src/shared/components/ScreenMessage.tsx`
- A `mobile/src/shared/config/environment.ts`
- A `mobile/src/shared/storage/token-storage.ts`
- A `mobile/src/shared/theme/driver-theme.ts`
- A `mobile/src/shared/theme/theme.ts`
- A `mobile/src/tests/auth-reducer.spec.ts`
- A `mobile/src/tests/AuthProvider.spec.tsx`
- A `mobile/src/types/user-role.ts`

```powershell
git add -- 'mobile/src/app/_layout.tsx' 'mobile/src/app/(auth)/_layout.tsx' 'mobile/src/app/(auth)/login.tsx' 'mobile/src/app/(auth)/register.tsx' 'mobile/src/app/(customer)/_layout.tsx' 'mobile/src/app/(customer)/index.tsx' 'mobile/src/app/(customer)/orders/[id].tsx' 'mobile/src/app/(customer)/orders/create.tsx' 'mobile/src/app/(customer)/orders/index.tsx' 'mobile/src/app/(driver)/_layout.tsx' 'mobile/src/app/(driver)/(tabs)/_layout.tsx' 'mobile/src/app/(driver)/(tabs)/account.tsx' 'mobile/src/app/(driver)/(tabs)/activity.tsx' 'mobile/src/app/(driver)/(tabs)/calendar.tsx' 'mobile/src/app/(driver)/(tabs)/index.tsx' 'mobile/src/app/(driver)/trips/[id]/_layout.tsx' 'mobile/src/app/(driver)/trips/[id]/incidents.tsx' 'mobile/src/app/(driver)/trips/[id]/index.tsx' 'mobile/src/app/(driver)/trips/[id]/map.tsx' 'mobile/src/app/(driver)/trips/[id]/stops.tsx' 'mobile/src/app/(driver)/trips/[id]/stops/[stopId].tsx' 'mobile/src/app/(driver)/trips/[id]/stops/[stopId]/pod.tsx' 'mobile/src/app/(driver)/trips/[id]/sync.tsx' 'mobile/src/app/(driver)/trips/index.tsx' 'mobile/src/app/session-error.tsx' 'mobile/src/app/unsupported-role.tsx' 'mobile/src/features/auth/components/AuthScreenLayout.tsx' 'mobile/src/features/auth/components/FormField.tsx' 'mobile/src/features/auth/components/OfflineDriverWorkspace.tsx' 'mobile/src/features/auth/hooks/useAuth.ts' 'mobile/src/features/auth/hooks/useRegisterCustomer.ts' 'mobile/src/features/auth/providers/auth-reducer.ts' 'mobile/src/features/auth/providers/AuthProvider.tsx' 'mobile/src/features/auth/screens/CustomerHomeScreen.tsx' 'mobile/src/features/auth/screens/DriverPlaceholderScreen.tsx' 'mobile/src/features/auth/screens/LoginScreen.tsx' 'mobile/src/features/auth/screens/RegisterScreen.tsx' 'mobile/src/features/auth/screens/SessionErrorScreen.tsx' 'mobile/src/features/auth/screens/UnsupportedRoleScreen.tsx' 'mobile/src/features/auth/services/auth.service.ts' 'mobile/src/features/auth/services/offline-driver-identity.spec.ts' 'mobile/src/features/auth/services/offline-driver-identity.ts' 'mobile/src/features/auth/types/auth.types.ts' 'mobile/src/features/auth/validation/auth.validation.spec.ts' 'mobile/src/features/auth/validation/auth.validation.ts' 'mobile/src/features/driver-home/hooks/useDriverAccountData.ts' 'mobile/src/features/driver-home/hooks/useDriverHomeData.ts' 'mobile/src/features/driver-home/screens/driver-home.spec.tsx' 'mobile/src/features/driver-home/screens/DriverAccountScreen.tsx' 'mobile/src/features/driver-home/screens/DriverHomeScreen.tsx' 'mobile/src/features/driver-home/services/driver-profile.service.spec.ts' 'mobile/src/features/driver-home/services/driver-profile.service.ts' 'mobile/src/features/driver-incidents/components/DriverIncidentCard.tsx' 'mobile/src/features/driver-incidents/components/DriverIncidentForm.tsx' 'mobile/src/features/driver-incidents/components/DriverIncidentPanel.spec.tsx' 'mobile/src/features/driver-incidents/components/DriverIncidentPanel.tsx' 'mobile/src/features/driver-incidents/hooks/useCreateDriverIncident.spec.ts' 'mobile/src/features/driver-incidents/hooks/useCreateDriverIncident.ts' 'mobile/src/features/driver-incidents/hooks/useDriverIncidents.spec.ts' 'mobile/src/features/driver-incidents/hooks/useDriverIncidents.ts' 'mobile/src/features/driver-incidents/services/driver-incidents.service.spec.ts' 'mobile/src/features/driver-incidents/services/driver-incidents.service.ts' 'mobile/src/features/driver-incidents/types/driver-incident.types.ts' 'mobile/src/features/driver-incidents/validation/driver-incident.validation.spec.ts' 'mobile/src/features/driver-incidents/validation/driver-incident.validation.ts' 'mobile/src/features/driver-navigation/components/DriverMapErrorBoundary.tsx' 'mobile/src/features/driver-navigation/components/DriverMapStopPanel.tsx' 'mobile/src/features/driver-navigation/components/DriverNavigationPanel.spec.tsx' 'mobile/src/features/driver-navigation/components/DriverNavigationPanel.tsx' 'mobile/src/features/driver-navigation/components/DriverTripMap.spec.tsx' 'mobile/src/features/driver-navigation/components/DriverTripMap.tsx' 'mobile/src/features/driver-navigation/screens/DriverTripMapScreen.tsx' 'mobile/src/features/driver-navigation/selectors/driver-map.selector.spec.ts' 'mobile/src/features/driver-navigation/selectors/driver-map.selector.ts' 'mobile/src/features/driver-navigation/selectors/driver-navigation-stop.selector.spec.ts' 'mobile/src/features/driver-navigation/selectors/driver-navigation-stop.selector.ts' 'mobile/src/features/driver-navigation/services/external-navigation.service.spec.ts' 'mobile/src/features/driver-navigation/services/external-navigation.service.ts'
git add -- 'mobile/src/features/driver-navigation/types/driver-map.types.ts' 'mobile/src/features/driver-navigation/types/driver-navigation.types.ts' 'mobile/src/features/driver-offline/components/OfflineDriverExecutionLifecycle.tsx' 'mobile/src/features/driver-offline/components/OfflineDriverQueuePanel.spec.tsx' 'mobile/src/features/driver-offline/components/OfflineDriverQueuePanel.tsx' 'mobile/src/features/driver-offline/hooks/useOfflineDriverQueue.ts' 'mobile/src/features/driver-offline/selectors/offline-driver-overlay.spec.ts' 'mobile/src/features/driver-offline/selectors/offline-driver-overlay.ts' 'mobile/src/features/driver-offline/services/offline-command-serialization.spec.ts' 'mobile/src/features/driver-offline/services/offline-command-serialization.ts' 'mobile/src/features/driver-offline/services/offline-driver-command-sync.service.spec.ts' 'mobile/src/features/driver-offline/services/offline-driver-command-sync.service.ts' 'mobile/src/features/driver-offline/services/offline-driver-execution.coordinator.ts' 'mobile/src/features/driver-offline/services/single-flight.spec.ts' 'mobile/src/features/driver-offline/services/single-flight.ts' 'mobile/src/features/driver-offline/storage/offline-driver-command.storage.spec.ts' 'mobile/src/features/driver-offline/storage/offline-driver-command.storage.ts' 'mobile/src/features/driver-offline/types/offline-driver-command.types.ts' 'mobile/src/features/driver-tracking/components/DriverTrackingLifecycle.spec.tsx' 'mobile/src/features/driver-tracking/components/DriverTrackingLifecycle.tsx' 'mobile/src/features/driver-tracking/components/DriverTrackingPanel.spec.tsx' 'mobile/src/features/driver-tracking/components/DriverTrackingPanel.tsx' 'mobile/src/features/driver-tracking/hooks/useDriverTracking.spec.ts' 'mobile/src/features/driver-tracking/hooks/useDriverTracking.ts' 'mobile/src/features/driver-tracking/services/driver-gps-api.service.ts' 'mobile/src/features/driver-tracking/services/driver-gps-authorization.ts' 'mobile/src/features/driver-tracking/services/driver-gps.engine.spec.ts' 'mobile/src/features/driver-tracking/services/driver-gps.engine.ts' 'mobile/src/features/driver-tracking/services/driver-tracking.service.spec.ts' 'mobile/src/features/driver-tracking/services/driver-tracking.service.ts' 'mobile/src/features/driver-tracking/storage/device-code.storage.spec.ts' 'mobile/src/features/driver-tracking/storage/device-code.storage.ts' 'mobile/src/features/driver-tracking/storage/driver-gps.storage.spec.ts' 'mobile/src/features/driver-tracking/storage/driver-gps.storage.ts' 'mobile/src/features/driver-tracking/tasks/driver-location.registration.ts' 'mobile/src/features/driver-tracking/tasks/driver-location.task.spec.ts' 'mobile/src/features/driver-tracking/tasks/driver-location.task.ts' 'mobile/src/features/driver-tracking/types/driver-tracking.types.ts' 'mobile/src/features/driver-trips/components/DriverStopContact.tsx' 'mobile/src/features/driver-trips/components/DriverStopListChrome.tsx' 'mobile/src/features/driver-trips/components/DriverTripCard.tsx' 'mobile/src/features/driver-trips/components/DriverTripHeader.tsx' 'mobile/src/features/driver-trips/components/DriverTripStatusBadge.tsx' 'mobile/src/features/driver-trips/components/DriverTripStopRow.tsx' 'mobile/src/features/driver-trips/components/DriverTripSupportScreen.tsx' 'mobile/src/features/driver-trips/components/execution/DriverStopExecutionPanel.spec.tsx' 'mobile/src/features/driver-trips/components/execution/DriverStopExecutionPanel.tsx' 'mobile/src/features/driver-trips/components/pod/DriverPodPanel.spec.tsx' 'mobile/src/features/driver-trips/components/pod/DriverPodPanel.tsx' 'mobile/src/features/driver-trips/hooks/useDriverLogout.ts' 'mobile/src/features/driver-trips/hooks/useDriverPod.spec.ts' 'mobile/src/features/driver-trips/hooks/useDriverPod.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripApiError.spec.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripApiError.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripDetail.spec.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripDetail.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripExecution.spec.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripExecution.ts' 'mobile/src/features/driver-trips/hooks/useDriverTripPodReadiness.ts' 'mobile/src/features/driver-trips/hooks/useDriverTrips.spec.ts' 'mobile/src/features/driver-trips/hooks/useDriverTrips.ts' 'mobile/src/features/driver-trips/providers/DriverTripWorkspace.tsx' 'mobile/src/features/driver-trips/schedule/driver-schedule-dates.spec.ts' 'mobile/src/features/driver-trips/schedule/driver-schedule-dates.ts'
git add -- 'mobile/src/features/driver-trips/schedule/DriverActivityMetrics.tsx' 'mobile/src/features/driver-trips/schedule/DriverScheduleScreens.tsx' 'mobile/src/features/driver-trips/schedule/useDriverScheduleRead.ts' 'mobile/src/features/driver-trips/screens/driver-trip-screens.spec.tsx' 'mobile/src/features/driver-trips/screens/DriverStopExecutionScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverStopPodScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverTripDetailScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverTripIncidentsScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverTripListScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverTripStopsScreen.tsx' 'mobile/src/features/driver-trips/screens/DriverTripSyncScreen.tsx' 'mobile/src/features/driver-trips/selectors/driver-stop-contact.spec.ts' 'mobile/src/features/driver-trips/selectors/driver-stop-contact.ts' 'mobile/src/features/driver-trips/selectors/driver-stop-list.ts' 'mobile/src/features/driver-trips/selectors/driver-trip-workflow.ts' 'mobile/src/features/driver-trips/services/driver-pod.service.spec.ts' 'mobile/src/features/driver-trips/services/driver-pod.service.ts' 'mobile/src/features/driver-trips/services/driver-trips.service.spec.ts' 'mobile/src/features/driver-trips/services/driver-trips.service.ts' 'mobile/src/features/driver-trips/storage/offline-trip-snapshots.spec.ts' 'mobile/src/features/driver-trips/storage/offline-trip-snapshots.ts' 'mobile/src/features/driver-trips/types/driver-trip.types.ts' 'mobile/src/features/driver-trips/validation/driver-pod.validation.spec.ts' 'mobile/src/features/driver-trips/validation/driver-pod.validation.ts' 'mobile/src/features/driver-trips/validation/driver-trip-execution.validation.spec.ts' 'mobile/src/features/driver-trips/validation/driver-trip-execution.validation.ts' 'mobile/src/features/orders/components/CustomerOrderTrackingPanel.spec.tsx' 'mobile/src/features/orders/components/CustomerOrderTrackingPanel.tsx' 'mobile/src/features/orders/components/OrderCard.tsx' 'mobile/src/features/orders/components/OrderFormField.tsx' 'mobile/src/features/orders/components/OrderScreenHeader.tsx' 'mobile/src/features/orders/components/OrderStatusBadge.tsx' 'mobile/src/features/orders/components/PackageItemEditor.tsx' 'mobile/src/features/orders/hooks/useCreateCustomerOrder.spec.ts' 'mobile/src/features/orders/hooks/useCreateCustomerOrder.ts' 'mobile/src/features/orders/hooks/useCustomerBranches.ts' 'mobile/src/features/orders/hooks/useCustomerOrderDetail.ts' 'mobile/src/features/orders/hooks/useCustomerOrders.spec.ts' 'mobile/src/features/orders/hooks/useCustomerOrders.ts' 'mobile/src/features/orders/hooks/useCustomerOrderTracking.spec.ts' 'mobile/src/features/orders/hooks/useCustomerOrderTracking.ts' 'mobile/src/features/orders/hooks/useOrderApiError.spec.ts' 'mobile/src/features/orders/hooks/useOrderApiError.ts' 'mobile/src/features/orders/screens/customer-order-navigation.spec.tsx' 'mobile/src/features/orders/screens/CustomerCreateOrderScreen.tsx' 'mobile/src/features/orders/screens/CustomerOrderDetailScreen.spec.tsx' 'mobile/src/features/orders/screens/CustomerOrderDetailScreen.tsx' 'mobile/src/features/orders/screens/CustomerOrderListScreen.tsx' 'mobile/src/features/orders/services/orders.service.spec.ts' 'mobile/src/features/orders/services/orders.service.ts' 'mobile/src/features/orders/types/order-tracking.types.ts' 'mobile/src/features/orders/types/order.types.ts' 'mobile/src/features/orders/validation/order.validation.spec.ts' 'mobile/src/features/orders/validation/order.validation.ts' 'mobile/src/shared/api/api-client.spec.ts' 'mobile/src/shared/api/api-client.ts' 'mobile/src/shared/api/api-error.ts' 'mobile/src/shared/assets/driver-tabs/account.png' 'mobile/src/shared/assets/driver-tabs/activity.png' 'mobile/src/shared/assets/driver-tabs/calendar.png' 'mobile/src/shared/assets/driver-tabs/home.png' 'mobile/src/shared/components/FullScreenLoader.tsx' 'mobile/src/shared/components/PrimaryButton.tsx' 'mobile/src/shared/components/ScreenMessage.tsx' 'mobile/src/shared/config/environment.ts' 'mobile/src/shared/storage/token-storage.ts' 'mobile/src/shared/theme/driver-theme.ts' 'mobile/src/shared/theme/theme.ts' 'mobile/src/tests/auth-reducer.spec.ts' 'mobile/src/tests/AuthProvider.spec.tsx' 'mobile/src/types/user-role.ts'
```

### Tài liệu (21)

- A `docs/01-project-overview/member-2-scope.md`
- A `docs/02-business/customer-order-flow.md`
- A `docs/02-business/driver-trip-flow.md`
- A `docs/03-technical/api-contracts.md`
- A `docs/03-technical/driver-assignment-availability-contract.md`
- A `docs/03-technical/driver-map-navigation-survey.md`
- A `docs/03-technical/driver-product-expansion-survey.md`
- A `docs/03-technical/driver-start-trip-accept-contract.md`
- A `docs/03-technical/driver-visual-design-specification.md`
- A `docs/03-technical/g1-customer-order-confirmation-contract.md`
- A `docs/03-technical/g2-dynamic-eta-late-risk-contract.md`
- A `docs/03-technical/git-release-staging-plan.md`
- A `docs/03-technical/graduation-requirements-coverage-audit.md`
- A `docs/03-technical/mobile-ui-ux-audit-redesign.md`
- A `docs/03-technical/shared-backend-release-review.md`
- A `docs/03-technical/technical-decisions.md`
- A `docs/03-technical/web-admin-driver-customer-integration-handoff.md`
- A `docs/04-testing/driver-customer-e2e-qa.md`
- A `docs/04-testing/g31-android-emulator-api33-gps-qa.md`
- A `docs/04-testing/test-cases.md`
- A `docs/06-graduation/graduation-notes.md`

```powershell
git add -- 'docs/01-project-overview/member-2-scope.md' 'docs/02-business/customer-order-flow.md' 'docs/02-business/driver-trip-flow.md' 'docs/03-technical/api-contracts.md' 'docs/03-technical/driver-assignment-availability-contract.md' 'docs/03-technical/driver-map-navigation-survey.md' 'docs/03-technical/driver-product-expansion-survey.md' 'docs/03-technical/driver-start-trip-accept-contract.md' 'docs/03-technical/driver-visual-design-specification.md' 'docs/03-technical/g1-customer-order-confirmation-contract.md' 'docs/03-technical/g2-dynamic-eta-late-risk-contract.md' 'docs/03-technical/git-release-staging-plan.md' 'docs/03-technical/graduation-requirements-coverage-audit.md' 'docs/03-technical/mobile-ui-ux-audit-redesign.md' 'docs/03-technical/shared-backend-release-review.md' 'docs/03-technical/technical-decisions.md' 'docs/03-technical/web-admin-driver-customer-integration-handoff.md' 'docs/04-testing/driver-customer-e2e-qa.md' 'docs/04-testing/g31-android-emulator-api33-gps-qa.md' 'docs/04-testing/test-cases.md' 'docs/06-graduation/graduation-notes.md'
```

## 6. REVIEW REQUIRED · giữ lại

- A `mobile/eas.json`
- A `docs/03-technical/driver-beyond-mvp-gap-audit.md`
- A `docs/04-testing/driver-m5-final-android-e2e-report.md`
- A `docs/05-development/development-log.md`

## 7. EXCLUDE · giữ ngoài snapshot

- M `backend/package.json`
- A `backend/prisma/seed-customer-tracking-qa.ts`
- A `backend/prisma/seed-driver-customer-e2e-qa.ts`
- A `backend/prisma/seed-driver-demo.ts`
- A `backend/prisma/seed-driver-incident-qa.ts`
- A `docs/04-testing/stitch-phase2-qa.cjs`
- A `mobile/stitch_smart_tms_driver_app/danh_s_ch_50_i_m_d_ng/code.html`
- A `mobile/stitch_smart_tms_driver_app/danh_s_ch_50_i_m_d_ng/screen.png`
- A `mobile/stitch_smart_tms_driver_app/h_ng_i_ng_b_ngo_i_tuy_n/code.html`
- A `mobile/stitch_smart_tms_driver_app/h_ng_i_ng_b_ngo_i_tuy_n/screen.png`
- A `mobile/stitch_smart_tms_driver_app/kh_ng_gian_chuy_n_i_b_n_mapbox/code.html`
- A `mobile/stitch_smart_tms_driver_app/kh_ng_gian_chuy_n_i_b_n_mapbox/screen.png`
- A `mobile/stitch_smart_tms_driver_app/smart_tms_driver_design_system/DESIGN.md`
- A `mobile/stitch_smart_tms_driver_app/x_c_nh_n_giao_h_ng_e_pod/code.html`
- A `mobile/stitch_smart_tms_driver_app/x_c_nh_n_giao_h_ng_e_pod/screen.png`
- A `mobile/stitch_smart_tms_driver_app_v2/ho_t_ng_l_ch_s_d_li_u_v_n_h_nh/code.html`
- A `mobile/stitch_smart_tms_driver_app_v2/ho_t_ng_l_ch_s_d_li_u_v_n_h_nh/screen.png`
- A `mobile/stitch_smart_tms_driver_app_v2/l_ch_l_m_vi_c_chuy_n_c_g_n/code.html`
- A `mobile/stitch_smart_tms_driver_app_v2/l_ch_l_m_vi_c_chuy_n_c_g_n/screen.png`
- A `mobile/stitch_smart_tms_driver_app_v2/smart_tms_driver_design_system/DESIGN.md`
- A `mobile/stitch_smart_tms_driver_app_v2/t_c_v_i_m_d_ng_li_n_h_a_n_h_ng/code.html`
- A `mobile/stitch_smart_tms_driver_app_v2/t_c_v_i_m_d_ng_li_n_h_a_n_h_ng/screen.png`
- A `mobile/stitch_smart_tms_driver_app_v2/t_i_kho_n_t_i_x_c_u_h_nh_thi_t_b/code.html`
- A `mobile/stitch_smart_tms_driver_app_v2/t_i_kho_n_t_i_x_c_u_h_nh_thi_t_b/screen.png`
- A `mobile/.claude/settings.json`
- A `docs/03-technical/driver-beyond-mvp-stitch-handoff.md`
- A `docs/03-technical/driver-stitch-handoff-audit.md`
- A `docs/04-testing/stitch-phase2-android-qa.md`

## 8. Lệnh commit và push đề xuất

**GO cho feature commit và push lưu code** sau khi stage đúng A và kiểm tra staged diff. **NO-GO cho triển khai Supabase hiện tại**. Nếu môi trường có tích hợp CI/CD ngoài repo mà team đã biết, xác nhận nó không theo dõi feature trước khi push.

```powershell
git branch --show-current
git fetch origin feat/phase-1-core-tms
git rev-list --left-right --count HEAD...origin/feat/phase-1-core-tms
git diff --cached --check
git diff --cached --name-status
git commit -m "feat(tms): save validated Driver and Customer feature snapshot"
git push origin HEAD:refs/heads/feat/phase-1-core-tms
```

Trước commit, kiểm nhánh là `feat/phase-1-core-tms`, remote chưa đi trước và index chỉ chứa nhóm A. Không đưa nhóm B/C vào commit bằng staging toàn worktree. Audit này chưa stage, commit hay push.
