# PHÂN CÔNG XÂY DỰNG TMS — 3 NGƯỜI

Phiên bản 0.3 · Ngày 10/09/2026

Đọc cùng [Kế hoạch TMS](KE_HOACH_TMS.md) và [quy tắc dự án](AGENTS.md).

## 1. Phân công chính

| Thành viên | Phạm vi chịu trách nhiệm chính |
|---|---|
| **Người 1 — Optimization** | Làm trọn phần tối ưu: Python/FastAPI/OR-Tools, routing, chi phí, xếp/dỡ, validator; đồng thời tự viết backend NestJS, database/job/API và giao diện web liên quan đến chạy, xem và áp dụng phương án tối ưu. |
| **Người 2 — Mobile** | Làm trọn phần mobile **khách hàng** và **tài xế** bằng React Native/Expo; đồng thời tự viết backend, database/API cho chuyến đi, pickup/delivery, POD, GPS, thông báo, offline và đồng bộ. |
| **Người 3 — Quản trị vận hành & AI** | Làm nền tảng và các phần còn lại: auth/quyền, chi nhánh, Order/Trip nền, điều phối thủ công, nhân sự, xe cộ, bảo dưỡng, thanh toán, lương, chi phí, báo cáo, web quản trị, Redis/Socket.IO, Mapbox và AI ngoài Optimization khi đã được duyệt. |

Phân công theo **tính năng xuyên suốt**, không chia cứng frontend/backend. Mỗi người tự làm các lớp cần thiết cho phần mình; khi chạm dữ liệu hoặc module dùng chung thì phối hợp theo contract.

## 2. Ranh giới để tránh chồng việc

- Người 1 sở hữu API/job/snapshot/validator và luồng đề nghị áp dụng phương án; thay đổi Trip dùng chung phải được Người 3 review transaction, quyền và version.
- Người 2 sở hữu API mobile của phần mình, bảo đảm idempotency và phân biệt dữ liệu trên máy với dữ liệu server đã xác nhận; phần auth/realtime dùng chung phối hợp với Người 3.
- Người 3 sở hữu kiến trúc và dịch vụ dùng chung, không mặc định nhận làm backend thay cho Người 1 hoặc Người 2.
- Nhân sự, thanh toán và lương của Người 3 phục vụ vận hành TMS; chưa mặc định là hệ HRM, ERP hoặc kế toán đầy đủ nếu chưa có yêu cầu được duyệt.
- **Optimization thuộc Người 1.** “AI” của Người 3 chỉ là các tính năng AI khác được duyệt sau này; không bao gồm routing, packing hoặc solver.
- Mỗi người tự tạo migration trong phạm vi mình; migration hoặc contract dùng chung phải báo cả nhóm và có review chéo.
- Người sửa contract phải cập nhật producer, consumer và test liên quan.

## 3. Cách phối hợp

Luồng chung: **chốt yêu cầu → chốt contract → triển khai → tự test → review chéo → tích hợp**.

- Người 1 chủ trì contract job/snapshot/kết quả/publish của optimizer; Người 3 review phần chạm Trip và dữ liệu dùng chung.
- Người 2 chủ trì API mobile, idempotency, offline, POD và GPS; Người 3 review auth, quyền và realtime dùng chung.
- Người 1 review dữ liệu tải/bố trí trên web; Người 2 review khả năng sử dụng API và luồng thực tế; Người 3 review tích hợp, dữ liệu và bảo mật.
- AI chỉ hỗ trợ viết, phân tích và review; kết quả vẫn phải có người phụ trách xác nhận và kiểm thử.

## 4. Điều kiện hoàn thành

Một phần việc chỉ hoàn thành khi:

- Đã nối với API/dữ liệu thật trong phạm vi liên quan, không dừng ở giao diện hoặc mock.
- Có validation, quyền, xử lý lỗi, concurrency/idempotency khi cần.
- Không còn TODO/placeholder trên đường chạy bắt buộc.
- Test, typecheck và build phù hợp đã chạy đạt; giới hạn chưa kiểm chứng được ghi rõ.

Không commit, push, deploy hoặc thay đổi dữ liệu thật ngoài quyền đã được cấp.
