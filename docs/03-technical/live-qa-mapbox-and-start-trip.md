# Smart TMS — Cấu hình Mapbox Backend và đề xuất thời điểm Start Trip

## Cấu hình Mapbox Backend

Backend đọc `MAPBOX_ACCESS_TOKEN` từ biến tiến trình hoặc `backend/.env` khi chạy NestJS. `MapboxService` dùng giá trị này cho Matrix và Directions. Cấu hình token theo môi trường bằng secret store của dịch vụ triển khai. Đề nghị owner cấp token dành riêng cho Backend với phạm vi cần cho các API đang dùng. Giữ token SDK Mobile `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN` riêng. [Mapbox Matrix API](https://docs.mapbox.com/api/navigation/matrix/) · [Quản lý token Mapbox](https://docs.mapbox.com/accounts/guides/tokens/)

Kiểm tra từ máy chạy Backend với hai tọa độ trên đường hợp lệ. Cần HTTP 200, mã `Ok` và ma trận có giá trị hữu hạn theo cả hai chiều. Sau đó chạy một job Optimizer qua NestJS và kiểm tra Directions cũng trả route geometry. HTTP 401 Invalid Token yêu cầu owner kiểm tra token đang hoạt động. Với 403, kiểm tra quyền tài khoản, scope và giới hạn URL phù hợp với request từ server. Chỉ ghi status và mã lỗi, che query string có access token. [Khắc phục lỗi token Mapbox](https://docs.mapbox.com/help/troubleshooting/token-errors/)

Lượt QA dùng token công khai đã được xác minh còn hợp lệ từ cấu hình Mobile, đưa vào riêng tiến trình Backend QA. Token dành riêng cho Backend production cần owner cung cấp và xác minh từ host production.

## Start Trip theo ngày thực hiện của chi nhánh

Planner lưu thời gian dự kiến dưới dạng `timestamptz`. Ngày thực hiện dùng ngày của `plannedStartTime` trong múi giờ chi nhánh quản lý chuyến. Chuyến cũ thiếu chi nhánh quản lý dùng Home Branch của xe, tương tự luồng lập kế hoạch. Thiếu múi giờ hợp lệ hoặc khoảng lịch sai trả `409 TRIP_START_SCHEDULE_INVALID` để điều phối kiểm tra.

Một Start mới chỉ được thực hiện với Driver PRIMARY/ASSIGNED, Trip DISPATCHED và version đúng. Backend dùng đồng hồ server, trong transaction và cùng thứ tự lock tài nguyên hiện hành. Cho phép sớm tối đa 30 phút nhưng luôn trong ngày thực hiện. Cho phép trễ cùng ngày nếu tài xế và xe không có chuyến đang chạy khác hoặc reservation của chuyến khác giữ tài nguyên vào lúc Start. Quy tắc này không thay lịch dự kiến, không đặt giới hạn độ trễ mới trong cùng ngày và không tự đổi assignment. Mã 409 phân biệt chưa đến ngày, quá sớm, đã qua ngày, tài nguyên đang chạy hoặc đang giữ lịch.

- Trip qua đêm có thể bắt đầu trong ngày của plannedStartTime và tiếp tục sau nửa đêm. Chuyến chưa khởi hành và đã sang ngày khác cần điều phối kiểm tra lịch, kể cả khi chưa qua plannedEndTime. Trip đang thực hiện tiếp tục ghi Arrival, Completion và GPS theo hợp đồng hiện tại.
- API sửa kế hoạch hiện chỉ hỗ trợ DRAFT/PLANNED. Chuyến DISPATCHED quá ngày cần xử lý qua quy trình điều phối được hỗ trợ trước khi phát hành lại. Đường Start không tự đổi lịch hoặc trạng thái. Giữ optimistic concurrency, `DRIVER_ALREADY_ON_TRIP` và transaction ordering.
- Backend dùng múi giờ đang lưu ở chi nhánh khi thực thi lệnh. Do lịch phát hành chưa lưu riêng múi giờ, điều phối cần rà soát các chuyến DISPATCHED trước khi đổi timezone của chi nhánh.
- START_TRIP cần kết nối mạng. Retry cùng actor/key/payload sẽ trả receipt đã commit sau khi kiểm quyền, trước khi kiểm cửa sổ Start. ARRIVE_STOP/COMPLETE_STOP dùng hàng đợi riêng và không chạy qua guard này. Mobile hiển thị lý do từ chối bằng mã lỗi Backend. Lifecycle GPS chỉ bắt đầu sau xác nhận Start.
