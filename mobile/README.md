# Smart TMS Mobile

Ứng dụng React Native + Expo dành cho CUSTOMER và DRIVER. Mobile đã có Customer Order, Driver Trip Execution, e-POD và M3.6C Background GPS Tracking.

Customer có thể xem danh sách, chi tiết, theo dõi vận chuyển và tạo Order DRAFT. Backend có API Confirm Order M2.3 cho thao tác vận hành; Mobile Customer không gọi API này.

## Cấu hình API

Tạo `mobile/.env.local` từ `.env.example`:

```dotenv
# Android Emulator
EXPO_PUBLIC_API_URL=http://10.0.2.2:4000
```

Với Android thật, thay `10.0.2.2` bằng địa chỉ IPv4 LAN của máy chạy NestJS, ví dụ `http://192.168.x.x:4000`. Điện thoại và máy tính phải cùng mạng, firewall phải cho phép cổng 4000. Không dùng `localhost` trên điện thoại.

## Chạy Android

```powershell
cd backend
npm ci
npm run prisma:generate
npm run start:dev
```

Trong terminal khác:

```powershell
cd mobile
npm ci
npm run android
```

Các chức năng không cần native background service vẫn có thể chạy bằng Expo Go. Riêng M3.6C Background GPS phải dùng development build; Expo Go không phải môi trường nghiệm thu GPS nền.

## Android development build cho GPS nền

Project đã cấu hình `expo-dev-client`, `expo-location`, `expo-task-manager`, `expo-sqlite` và NetInfo. Với Android SDK đã cài, có thể tạo development build local bằng `npx expo run:android` từ thư mục `mobile`.

Nếu owner EAS đã xác nhận project và cung cấp profile `development` trong `eas.json`, có thể tạo APK development nội bộ:

```powershell
cd mobile
npx eas-cli login
npx eas-cli build --profile development --platform android
```

Tải APK từ build nội bộ, cài lên Android thật rồi chạy Metro cho development client:

```powershell
npx expo start --dev-client
```

Sau khi cài một native dependency hoặc đổi permission/plugin trong `app.json`, phải tạo development build mới; reload JavaScript không cập nhật AndroidManifest/native module.

## Kiểm tra code

```powershell
npm run typecheck
npm run lint
npm test
npx expo-doctor
npx expo export --platform android --output-dir dist/android
```

Access token được lưu bằng `expo-secure-store`. Ứng dụng không có refresh token, không tự retry đăng ký/đăng nhập và không ghi token/password vào log.

## Kiểm thử Customer Order trên Android

1. Chạy Backend ở cổng 4000 và cấu hình `EXPO_PUBLIC_API_URL` bằng IPv4 LAN của máy tính.
2. Đăng nhập tài khoản role CUSTOMER.
3. Mở **Đơn vận chuyển**, thử filter và pull-to-refresh.
4. Chọn **Tạo đơn mới**, chọn Branch active, nhập địa chỉ/tọa độ và ít nhất một loại kiện.
5. Xác nhận đơn mới ở DRAFT, xuất hiện trong list và detail không hiển thị giá.
6. Để kiểm tra timeout/mất mạng, chỉ thử với dữ liệu test: ngắt mạng ngay lúc gửi, bật lại mạng và bấm **Gửi lại cùng yêu cầu** mà không sửa form; Backend phải trả cùng Order thay vì tạo trùng.

Kết quả Jest/bundle không thay thế manual test trên thiết bị thật; ghi riêng kết quả sau khi thực hiện checklist.

## Manual QA M3.6C Background GPS

1. Dùng development build, đăng nhập tài khoản DRIVER PRIMARY có Trip `DISPATCHED`.
2. Bấm **Bắt đầu chuyến**; chỉ sau khi Backend trả `IN_PROGRESS`, đọc giải thích và cấp foreground/background location cùng notification permission nếu Android yêu cầu.
3. Xác minh UI báo **Đang theo dõi cả khi chạy nền**; di chuyển để tạo point và kiểm tra Backend có `GpsEvent`.
4. Đưa app xuống background, tắt màn hình và tiếp tục di chuyển; xác minh có point mới. Không dùng Expo Go cho bước này.
5. Tắt mạng, di chuyển, mở app để xem số point pending; bật mạng và xác minh backlog được flush theo đúng session/sequence.
6. Mở lại app trong Trip `IN_PROGRESS`, xác minh session cũ được khôi phục thay vì tạo session mới.
7. Hoàn thành Trip, xác minh không thu point mới; backlog đo trước `actualEndTime` vẫn được flush trong cửa sổ 30 phút.
8. Logout và xác minh task GPS dừng. Queue thực thi offline chưa đồng bộ vẫn thuộc tài khoản cũ và chỉ tiếp tục đồng bộ khi đăng nhập lại đúng owner.
9. Chạy lại với background permission bị từ chối, location service bị tắt và permission bị revoke giữa chuyến; UI phải cảnh báo, không crash hoặc request permission lặp.

Force-stop, reboot và ROM tiết kiệm pin có thể dừng foreground service. M3.6C không cài custom `BOOT_COMPLETED` receiver và không cam kết tự khôi phục tuyệt đối; khi mở app lại, hệ thống đối chiếu Trip với Backend rồi mới restore tracking.
