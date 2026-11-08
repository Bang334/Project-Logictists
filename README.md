# Logistics TMS

Hệ thống TMS gồm NestJS/PostgreSQL/Redis, React/Ant Design và Optimization Engine FastAPI + OR-Tools.

## Chuyển về TMS thuần vận tải

Web và API hiện dùng luồng đơn vận chuyển tại `/orders`. Khách đăng nhập để xem hoặc phản hồi lịch hẹn ở `/delivery-appointments`. Catalog, giỏ hàng, tồn kho và xử lý bán lẻ đã được gỡ khỏi ứng dụng và dữ liệu seed.

Migration [`20261108100000_remove_retail_sales`](backend/prisma/migrations/20261108100000_remove_retail_sales/migration.sql) xóa 25 bảng bán lẻ. Bảng dùng chung giữ lịch sử đơn, kiện, phân công và chuyến. `Order.orderType` giúp nhận diện đơn bán lẻ cũ và loại chúng khỏi điều phối mới. Một số mã tham chiếu cũ trên bảng dùng chung vẫn được lưu để đối soát với bản sao lưu.

Trước khi áp dụng lên môi trường đang dùng, chốt hoặc xử lý hết đơn bán lẻ đã xác nhận, đã phân công hoặc đang vận chuyển bằng phiên bản cũ. Dừng API và worker cũ, sao lưu đầy đủ PostgreSQL, rồi thử phục hồi và chạy migration trên bản sao có cùng lịch sử schema. Migration tự rollback nếu còn đơn bán lẻ ở các trạng thái trên hoặc gặp phụ thuộc schema ngoài dự kiến. Nếu cần khôi phục sau khi migration đã commit, dùng bản sao lưu và đối soát các ghi phát sinh. Xem [MERGE_RECOVERY.md](MERGE_RECOVERY.md) về việc đối chiếu lịch sử migration trước khi nâng cấp.

## Phân loại kiện và xếp chồng demo

Áp dụng migration [`20261108110000_package_handling_policy`](backend/prisma/migrations/20261108110000_package_handling_policy/migration.sql) sau khi đối chiếu lịch sử schema. Kiện cũ nhận loại `UNCLASSIFIED` và tiếp tục đặt sàn. Form `/orders` lưu loại kiện, khả năng đặt ở tầng trên, tải tối đa bao bì chịu ở phía trên (gram) và lựa chọn không đặt hàng lên trên.

Để bật mô hình nâng demo, đặt `TMS_DEMO_STACK_MAX_TIERS` và `TMS_DEMO_STACK_CLEARANCE_MM` trong cấu hình backend. Ví dụ thử nghiệm có thể dùng 3 tầng và 50 mm khoảng hở. `TMS_DEMO_STACK_OWNER_MODE=SAME_CUSTOMER` (mặc định) chỉ ghép kiện của cùng khách hàng, kể cả khác đơn. `ANY_CUSTOMER` cho phép ghép kiện của khách khác. Cả hai chế độ vẫn chặn đè kiện dễ vỡ, kiện chưa phân loại và kiện có yêu cầu không đặt hàng lên trên.

Mô hình giả định cửa sau cao bằng lòng thùng, thiết bị nâng chuyển được kiện tại cao độ thao tác và cùng một mặt đáy xuyên suốt chồng. Kiện đỡ phải có trên xe trước khi đặt kiện trên và được dỡ sau. Mỗi đế phải chịu được tổng tải phía trên và tổng này phải nhỏ hơn 30% khối lượng đế. Điều phối thủ công kiểm tra điều kiện này trên thứ tự điểm dừng đã chọn. Điều phối tự động thử bố trí chồng khác đơn trên các tuyến đã tìm được, rồi giữ bố trí cũ nếu kiểm tra đường nâng/dỡ thất bại. Cấu hình backend chặn bật mô hình demo ở môi trường production.

`TMS_TOP_LOAD_PROTECTION_FEE_VND` tùy chọn là phụ phí cố định mỗi đơn demo. Có phí khi ít nhất một kiện thường đã khai báo sức chịu tải và khách chọn không đặt hàng lên trên. Mức phí được lưu trên đơn nháp, hiển thị trước xác nhận và chỉ chốt khi điều phối ghi nhận khách đồng ý. Để biến này chưa cấu hình nếu chỉ cần thử quy tắc bảo vệ kiện.

Ở **Điều phối tự động → Demo**, chọn **So sánh chi phí xếp chồng ba tầng**. Chạy một lượt tắt và một lượt bật **Cho phép xếp chồng demo** với cùng ngân sách tìm kiếm để xem chi phí, số xe và quãng đường cạnh nhau. Ma trận đường và chi phí của kịch bản là dữ liệu giả lập. Trong sơ đồ chuyến, chọn điểm giao và bấm **Dỡ kiện tiếp theo** để xem kiện biến mất theo thứ tự đã kiểm tra.

Kịch bản **Xếp chồng cùng khách và khác khách** cho thấy kiện của khách thứ hai nằm trên kiện của khách thứ nhất khi chọn **Cho phép kiện khác khách hàng**. Chọn **Chỉ kiện cùng khách hàng** để xem hai kiện nằm riêng trên sàn trong cùng tuyến.

## Chạy cục bộ

Yêu cầu: Node.js 20+, Python 3.11+, PostgreSQL và Redis. `compose.yaml` hiện chỉ khởi tạo Redis; PostgreSQL phải được cung cấp qua `DATABASE_URL`.

1. Sao chép `backend/.env.example` thành `backend/.env` và điền database test/cục bộ, JWT, Mapbox. Không commit giá trị thật.
2. Sao chép `frontend/.env.example` thành `frontend/.env.local` và điền public Mapbox token.
3. Backend: `cd backend`, `npm ci`, `npm run prisma:generate`. Đọc [hướng dẫn nâng cấp sau merge](MERGE_RECOVERY.md) và hoàn tất đối chiếu lịch sử migration trước khi chạy ứng dụng bằng `npm run start:dev`. Không chạy thẳng `prisma migrate deploy`: repo đang hợp nhất hai lịch sử schema; database theo baseline mới cần migration bổ sung và reconciliation được review.
4. Optimizer trên Windows: từ root, tạo venv bằng `py -3.12 -m venv optimizer/.venv` và cài bằng `optimizer/.venv/Scripts/python.exe -m pip install -r optimizer/requirements.txt`. Chạy `powershell -NoProfile -ExecutionPolicy Bypass -File .\start_optimizer.ps1`. `start_tms.bat` cũng dùng Python trong venv này.
5. Frontend: `cd frontend`, `npm ci`, `npm run dev`.

Redis phải sẵn sàng trước khi tạo optimization job: `docker compose up -d redis`. PostgreSQL là nguồn dữ liệu nghiệp vụ; Redis chỉ giữ queue/cache.

## Kiểm tra

- Backend unit/contract: `cd backend && npm test`
- PostgreSQL concurrency: đặt `TEST_DATABASE_URL` trỏ tới database dùng một lần, rồi `npm run test:postgres`
- Backend lint/build: `npm run lint` và `npm run build`
- Frontend: `cd frontend && npm run lint && npm test && npm run build`
- Optimizer trên Windows: `cd optimizer` rồi chạy `.\.venv\Scripts\python.exe -m pytest -q`.

Optimization job có idempotency key, outbox và worker lease. Trip Plan chỉ được publish sau khi backend kiểm tra lại version đơn, tài nguyên, reservation và load plan trong transaction. Socket.IO chỉ báo có thay đổi; client luôn tải lại snapshot từ API.

## Thời gian giao và penalty trễ

Khách không chọn hạn giao cứng. Đơn được miễn phạt trong `deliveryGraceDays`
tính từ `orderedAt` gốc; giao sau đó vẫn được phép và penalty tăng tuyến tính
theo thời gian trễ, dùng mode/mức phạt đang cấu hình ở chi nhánh. `NONE` không
thu phạt tài chính; objective vẫn có penalty vận hành riêng, không là khoản thu.
Không tự đổi số ngày miễn phạt hoặc mức phạt khi lập kế hoạch.

Chi nhánh dev Hà Nội hiện dùng miễn phạt 2 ngày, sau đó 50.000 VND/đơn/ngày trễ,
tính tỷ lệ theo thời gian thực và làm tròn VND; có thể chỉnh ở cấu hình chi nhánh.

Ca xe/tài xế và các kiểm tra an toàn vẫn bắt buộc. Phạm vi lập kế hoạch 7 ngày
chỉ là phạm vi tài nguyên được đưa vào một lượt tối ưu, không phải hạn của đơn.
Chuyển ngày lập kế hoạch giữ nguyên tuổi đơn, kể cả khi `orderedAt` trước mốc
lập kế hoạch. Các cửa sổ giao legacy không được dùng để loại đơn bán hàng.

`npm run start:dev` và `start_tms` tự dời ngày cho đơn seed demo quá hạn,
chưa phân công, chưa có lịch hẹn giao và có đủ khung giờ. Hook giữ giờ và
khoảng cách giữa các mốc lịch. PostgreSQL từ xa chỉ chạy hook khi
`ALLOW_TEST_DATA_MUTATION=true`. Production bỏ qua hook.

Trong thư mục `backend`, chạy `npm run test-data:orders-today:preview` để xem
trước hoặc `npm run test-data:orders-today` để reset demo thủ công. Sau khi dời
lịch, chạy tối ưu mới để lấy snapshot mới. Tuổi đơn ngoài bộ seed demo vẫn
tính từ ngày đặt gốc.

## Biến môi trường quan trọng

Backend cần `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, `MAPBOX_ACCESS_TOKEN`; frontend cần `VITE_API_URL`, `VITE_SOCKET_URL`, `VITE_MAPBOX_TOKEN`. Xem các file `.env.example` để biết đầy đủ tên biến.
