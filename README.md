# Logistics TMS

## Gỡ phần mobile — 16/10/2026

Đã gỡ mã nguồn app `mobile/`, module backend `driver-mobile` (các endpoint `/driver/*`), adapter optimizer `/validate-execution-path` và test/seed/script riêng. Không còn lệnh `driver:*`, `test:driver*` hoặc `start:driver-demo`. Các tài liệu `MOBILE_DRIVER_*.md` chỉ giữ làm lịch sử thiết kế.

Trên workspace cục bộ, dependency/build cũ trong `mobile/node_modules` và `mobile/dist` có thể còn vì công cụ chặn xóa thư mục đệ quy; chúng không thuộc mã nguồn Git và không còn cấu hình app để chạy/build.

Giữ API quản lý tài xế `/drivers`, auth/quyền, điều phối/optimization, web, storage/outbox dùng chung và schema/migration. Outbox vẫn xử lý sự kiện tài xế đã lưu trước khi gỡ để tránh bỏ mất sự kiện đang chờ; không còn API tạo mới các sự kiện này. Không thay đổi database hoặc tệp POD đã lưu.

Hệ thống TMS gồm NestJS/PostgreSQL/Redis, React/Ant Design và Optimization Engine FastAPI + OR-Tools.

## Chạy cục bộ

Yêu cầu: Node.js 20+, Python 3.11+, PostgreSQL và Redis. `compose.yaml` hiện chỉ khởi tạo Redis; PostgreSQL phải được cung cấp qua `DATABASE_URL`.

1. Sao chép `backend/.env.example` thành `backend/.env` và điền database test/cục bộ, JWT, Mapbox. Không commit giá trị thật.
2. Sao chép `frontend/.env.example` thành `frontend/.env.local` và điền public Mapbox token.
3. Backend: `cd backend`, `npm ci`, `npm run prisma:generate`. Đọc [hướng dẫn nâng cấp sau merge](MERGE_RECOVERY.md) và hoàn tất đối chiếu lịch sử migration trước khi chạy ứng dụng bằng `npm run start:dev`. Không chạy thẳng `prisma migrate deploy`: repo đang hợp nhất hai lịch sử schema; database theo baseline mới cần migration bổ sung và reconciliation được review.
4. Optimizer: `cd optimizer`, tạo virtualenv, `pip install -r requirements.txt`, `uvicorn app.main:app --reload --port 8000`.
5. Frontend: `cd frontend`, `npm ci`, `npm run dev`.

Redis phải sẵn sàng trước khi tạo optimization job: `docker compose up -d redis`. PostgreSQL là nguồn dữ liệu nghiệp vụ; Redis chỉ giữ queue/cache.

## Kiểm tra

- Backend unit/contract: `cd backend && npm test`
- PostgreSQL concurrency: đặt `TEST_DATABASE_URL` trỏ tới database dùng một lần, rồi `npm run test:postgres`
- Backend lint/build: `npm run lint` và `npm run build`
- Frontend: `cd frontend && npm run lint && npm test && npm run build`
- Optimizer: `cd optimizer && python -m pytest -q`

Optimization job có idempotency key, outbox và worker lease. Trip Plan chỉ được publish sau khi backend kiểm tra lại version đơn, tài nguyên, reservation và load plan trong transaction. Socket.IO chỉ báo có thay đổi; client luôn tải lại snapshot từ API.

## Biến môi trường quan trọng

Backend cần `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, `MAPBOX_ACCESS_TOKEN`; frontend cần `VITE_API_URL`, `VITE_SOCKET_URL`, `VITE_MAPBOX_TOKEN`. Xem các file `.env.example` để biết đầy đủ tên biến.
