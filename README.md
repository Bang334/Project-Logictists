# Logistics TMS

Hệ thống TMS gồm NestJS/PostgreSQL/Redis, React/Ant Design và Optimization Engine FastAPI + OR-Tools.

## Chạy cục bộ

Yêu cầu: Node.js 20+, Python 3.11+, PostgreSQL và Redis. `compose.yaml` hiện chỉ khởi tạo Redis; PostgreSQL phải được cung cấp qua `DATABASE_URL`.

1. Sao chép `backend/.env.example` thành `backend/.env` và điền database test/cục bộ, JWT, Mapbox. Không commit giá trị thật.
2. Sao chép `frontend/.env.example` thành `frontend/.env.local` và điền public Mapbox token.
3. Backend: `cd backend`, `npm ci`, `npm run prisma:generate`, `npx prisma migrate deploy`, `npm run start:dev`.
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
