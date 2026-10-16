# Kết thúc chuyến có kiểm soát — đang triển khai

> **Cập nhật 16/10/2026:** Theo yêu cầu người dùng, mã nguồn app mobile và API thực thi riêng của Người 3 đã được gỡ, gồm phần chưa commit. Nội dung mobile bên dưới là tài liệu lịch sử/yêu cầu, không mô tả chức năng hiện có. Schema và migration được giữ để bảo toàn lịch sử dữ liệu.

Ngày 13/10/2026. Người dùng yêu cầu triển khai phần tổng kết và kết thúc chuyến trong chú thích 1. Giữ nguyên code delivery/POD và các thay đổi chưa commit từ mốc trước.

**Chưa hoàn tất.** Hiện có API/màn hình tổng kết và kiểm tra điều kiện, chưa có POST kết thúc chuyến hoặc nút xác nhận kết thúc. Không coi bản preview là tính năng kết thúc đã hoạt động.

## Quy tắc đã đủ rõ

- Tất cả điểm phải hoàn tất, đủ cặp LOAD/UNLOAD và bằng chứng theo snapshot cho từng Package.
- Phân biệt DELIVERED, FAILED, NOT_COLLECTED, ON_VEHICLE và UNLOADED. NOT_COLLECTED không phải giao thất bại/hàng trên xe.
- Chặn còn hàng trên xe hoặc đã dỡ nhưng chưa bàn giao. Phải có quy trình xử lý và bàn giao custody; không đổi status để làm mất trách nhiệm giữ hàng.
- POD đã gắn phải có recipientName, trạng thái xác minh và đúng scope; preview đọc lại bytes/checksum storage khi các điều kiện khác đã đủ.
- Không tự hoàn tất Order, sửa planned hoặc mặc định xe/tài xế về Home Branch. Dữ liệu GPS hiện hữu không bị thay bởi tọa độ điểm kế hoạch.

## Cần người dùng chốt

Đã hỏi: cho mốc này tài xế xác nhận **mình và xe cùng ở điểm dừng cuối đã hoàn tất**, lưu vị trí kết thúc với nguồn tài xế xác nhận (không phải GPS); chưa hỗ trợ nơi kết thúc khác hoặc nhiều tài xế/đổi ca. Hay cần kết thúc ở nơi khác/đổi ca ngay?

Chưa có câu trả lời tại thời điểm tài liệu này. Không lấy đề xuất làm policy đã duyệt. Nguồn hiện tại: THIET_KE_DATABASE.md phân biệt vị trí thực tế có timestamp với Home Branch; chưa có contract ghi vị trí cuối từ mobile. AGENTS.md yêu cầu hỏi khi nghiệp vụ chưa rõ. Đây là quyết định nghiệp vụ, không phải xin lại quyền triển khai.

## Đã triển khai độc lập

- `GET /driver/assignments/:id/completion`, permission driver.trips.execute, reauthorize User/Driver/assignment và khóa cùng thứ tự tài nguyên như execution.
- Response có assignment/trip version, tổng số kiện, đã giao, giao thất bại, chưa pickup, còn trên xe, đã dỡ chưa bàn giao, chi tiết kiện, blockers và canComplete. canComplete chỉ mô tả đủ điều kiện hàng/POD hiện tại, không phải lệnh cho phép ghi kết thúc hoặc thay thế kiểm tra lại trong transaction.
- Kiểm tra snapshot/schema/plan hash, trạng thái chuyến, các điểm và manifest, chứng cứ pickup/delivery/custody, POD đúng tài nguyên và nội dung lưu trữ. Chặn legacy thiếu chứng cứ, nhiều tài xế và trạng thái dữ liệu chưa đối soát.
- Mobile có nút **Xem tổng kết và điều kiện kết thúc chuyến** sau khi hoàn tất các điểm; tải API thật, hiện lý do chặn, lỗi/retry và chống phản hồi phiên cũ. Chưa đổi Trip.status hoặc giải phóng reservation.
- Migration mới `20261013090000_driver_trip_completion`: DriverAssignment.actualEndTime/completionEventId nullable, liên kết ExecutionEvent, unique TRIP_COMPLETED, bảo vệ lịch sử đã kết thúc. Status ACCEPTED vẫn là lịch sử nhận chuyến; dấu mốc thực thi tách riêng. Exclusion lịch chỉ loại assignment có bằng chứng kết thúc thực tế, không sửa startTime/endTime dự kiến. Constraint deferred yêu cầu Trip kết thúc có event và assignment liên kết.
- Migration đã áp trên DB thử có dữ liệu, giữ counts assignment/trip/event và không suy completion cũ. Chưa áp dữ liệu thật; migration đã áp thì mọi sửa tiếp phải là migration mới.

## Công việc còn lại sau quyết định

POST complete với version/idempotency, kiểm tra lại điều kiện và vị trí đã chốt, atomic actualEndTime + dấu mốc assignment + reservation release + event/audit/outbox/command; lưu và hiển thị vị trí cuối với nguồn/thời điểm. Confirmation mobile phản ánh đúng dữ liệu sẽ ghi. Kiểm thử cạnh tranh/replay/rollback/giải phóng tài nguyên và E2E kết thúc rồi reopen. Không có đường nhận thành công giả trong lúc chờ.

Người 2 review vòng đời Trip/assignment, reservation, migration, quyền/outbox/storage; Người 1 review giải phóng tài nguyên và consumer vị trí cuối. Chưa tự mở nghiệp vụ trả hàng/chuyển tải hoặc replan.

## Kiểm chứng phần hiện có

- Backend typecheck/build; Prisma generate; migration trên PostgreSQL thử local đã chạy. Không reset/truncate.
- Integration delivery/POD và preview: 17/17 trước ca POD hỏng/guard completion mới; đang chạy bổ sung, không coi là đã kiểm thử lệnh kết thúc.
- Mobile typecheck/lint và 7 suite/56 test đạt; camera/native tiếp tục là mock trong Jest, chưa nghiệm thu điện thoại.
- Lượt integration đầu chưa chạy do Docker/PostgreSQL thử đang tắt. Đã khởi động Docker và đúng container local ports 55439/56389 rồi chạy đạt. Prisma generate ban đầu gặp DLL lock từ tiến trình test lỗi; đã dừng đúng tiến trình test và generate lại đạt, không sửa assertion.

Không commit/push/deploy. Chưa có demo kết thúc hoặc production claim khi bước ghi cuối vẫn chưa triển khai.
