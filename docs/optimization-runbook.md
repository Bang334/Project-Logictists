# Optimization & Worker Operations Runbook

Tài liệu hướng dẫn vận hành hệ thống Optimization Engine (FastAPI + OR-Tools), Background Worker (BullMQ/NestJS) và cơ chế tự phục hồi sự cố.

---

## 1. Kiến trúc hệ thống & Nguồn sự thật

1. **PostgreSQL:** Là nguồn sự thật duy nhất (Single Source of Truth) cho trạng thái của `OptimizationJob`, `OptimizationResult`, `LoadPlan`, `Trip` và sự kiện `Outbox`.
2. **Redis & BullMQ:** Sử dụng làm hàng đợi điều phối tác vụ nền (`optimization-queue`). Nếu Redis bị restart hoặc flush, `OptimizationRecoveryService` trong NestJS sẽ tự động quét PostgreSQL và nạp lại các job đang dở dang (`PENDING`, `RETRYING`, `RUNNING` hết hạn lease).
3. **Python FastAPI Solver:** Microservice độc lập chạy trên cổng 8000, nhận payload snapshot đã được xác thực, giải bài toán VRP và kiểm tra ràng buộc xếp dỡ 3D sàn xe.

Luồng tự động gọi `POST /optimize-fleet/candidates` đúng một lần cho mỗi lần xử lý job. Optimizer loại trước slot xe-ngày chắc chắn không giao với time window. Snapshot 1–3 đơn và tối đa 2 xe vật lý dùng một lượt vét cạn; snapshot lớn hơn chọn 2–6 chiến lược OR-Tools độc lập và chạy song song. Job rất nhỏ dùng ngân sách 3 giây; các job khác dùng `ceil(5 + 1,30 × complexity)`, với trần cứng 120 giây. `solver_run_count` bằng `1` cho nhánh vét cạn và phản ánh số lượt OR-Tools thực sự hoàn tất cho nhánh multi-start.

Tỷ lệ routing/validator/gom tuyến tăng theo quy mô: `60/25/15%` cho ngân sách ≤3 giây, `65/20/15%` cho 4–20 giây, `72/18/10%` cho 21–60 giây và `78/14/8%` cho 61–120 giây. Stagnation của hai tầng lớn được tính theo 20%/25% ngân sách routing thay vì một hằng số chung.

Policy và ngân sách thực được ghi trong `diagnostics` của batch. Với vét cạn, diagnostics tách trạng thái duyệt routing, ghép xe và tìm bố trí; chỉ khi cả ba hoàn tất mới có bằng chứng tối ưu trong mô hình. Validator tải, thời gian và bố trí/xếp dỡ vẫn là điều kiện bắt buộc trước khi backend lưu phương án.

---

### Chia đơn nhiều kiện qua nhiều xe

- Backend chỉ tách một Order khi Order có nhiều Package và toàn bộ hàng không vừa một xe; Package luôn bất khả phân.
- Bộ chia thử từ cận dưới số xe và chỉ tăng số xe khi không thể xếp hết, đồng thời ưu tiên lấp xe đã mở. Đây là tìm kiếm có quay lui, không phải chia đều hoặc mở một xe cho mỗi kiện.
- Mỗi phần được khóa vào một xe vật lý khác nhau trước khi gửi solver. Solver vẫn phải kiểm tra tải, lịch, pickup trước delivery và bố trí/đường xếp dỡ cho từng xe.
- Phần tải và diện tích sàn còn dư trên xe đã nhận một phần của Order không bị giữ riêng. Solver được ghép thêm Order khác vào xe đó nếu tải từng chặng, time window và validator bố trí/xếp dỡ đều đạt; ví dụ kiện 1.000 kg trên xe 1.900 kg có thể dùng tối đa 900 kg tải dư cho hàng khác, không đồng nghĩa chắc chắn xếp vừa về hình học.
- Các phần của cùng Order là nhóm toàn bộ-hoặc-không. Nếu solver hoặc spatial validator không xếp được một phần, không phần nào của Order được áp dụng.
- Khi dispatcher áp dụng phương án, backend khóa Order/xe/tài xế, chuyển đúng các Package từ `READY` sang `ALLOCATED`, tạo `StopTask` theo Package và chỉ sau đó chuyển Order sang `ASSIGNED` trong cùng transaction.
- Một Package không vừa bất kỳ xe phù hợp nào được giữ trong danh sách chưa phân công; hệ thống không giảm khối lượng/kích thước hoặc cắt Package để tạo nghiệm.

---

## 2. Vòng đời Job & Cơ chế Khóa Lease

```text
[Dispatcher tạo Job]
        ↓
    (PENDING) ─── [Worker claim job + cấp Lease 5 phút]
        ↓
    (RUNNING) ─── [Gửi Snapshot sang FastAPI Solver]
        ↓
        ├─→ Solver thành công (SUCCESS) ──→ (SUCCEEDED) → Lưu OptimizationResult & LoadPlan
        ├─→ Solver thiếu thời gian ───────→ (TIMED_OUT) → Trả danh sách đơn chưa xếp
        ├─→ Người dùng bấm Hủy ──────────→ (CANCELLED) → Thu hồi tài nguyên
        └─→ Lỗi hệ thống / Crash ─────────→ (RETRYING) → Tối đa 3 lần → (FAILED)
```

- **Lease Heartbeat:** Trong khi job đang chạy, worker định kỳ gửi heartbeat gia hạn `leaseUntil` thêm 5 phút mỗi 60 giây.
- **Worker Crash Recovery:** Nếu tiến trình worker bị sập đột ngột, sau khi `leaseUntil` quá hạn, `OptimizationRecoveryService` (chạy nền mỗi 5 giây) sẽ phát hiện job mồ côi và tự động chuyển về `RETRYING` để worker khác nhận xử lý.

---

## 3. Giám sát & Metrics Vận hành

Quản trị viên (`ADMIN`) có thể theo dõi tình trạng hàng đợi và sức khỏe worker thông qua API:

```http
GET /admin/optimization-jobs/metrics
Authorization: Bearer <ADMIN_JWT_TOKEN>
```

**Mẫu phản hồi:**
```json
{
  "generatedAt": "2026-10-03T22:15:00.000Z",
  "statusCounts": {
    "SUCCEEDED": 42,
    "FAILED": 1,
    "PENDING": 0
  },
  "oldestWaitingJobAgeSeconds": null,
  "expiredLeaseRunningJobs": 0,
  "recentJobs": {
    "sampleSize": 43,
    "averageQueueLagSeconds": 0.45,
    "averageDurationSeconds": 14.2,
    "timedOutCount": 0,
    "partialCount": 2,
    "infeasibleCount": 0,
    "failedCount": 1
  }
}
```

- `expiredLeaseRunningJobs > 0`: Cảnh báo có worker bị crash hoặc lag mạng làm job bị kẹt. Hệ thống tự phục hồi sau 5s.
- `averageQueueLagSeconds`: Thời gian từ lúc tạo job đến lúc worker bắt đầu xử lý (đo độ nghẽn hàng đợi).

---

## 4. Xử lý Sự cố & Dead Letter Queue (DLQ)

### 4.1. Sự cố Solver Timeout hoặc quá tải
- **Triệu chứng:** Job chuyển sang `TIMED_OUT` hoặc `FAILED` với mã lỗi `OPTIMIZATION_FAILED`.
- **Nguyên nhân:** Snapshot phức tạp vượt ngân sách thích ứng tối đa 120 giây, validator bố trí không hoàn tất, hoặc ma trận khoảng cách Mapbox phản hồi chậm.
- **Biện pháp:** 
  1. Kiểm tra log cấu trúc `optimization_job_finished` và diagnostics để biết ngân sách/số chiến lược đã chọn.
  2. Kiểm tra `averageQueueLagSeconds` để tách thời gian chờ worker khỏi thời gian solver.
  3. Với batch lớn, lọc bớt phạm vi bán kính hoặc điều phối theo cụm chi nhánh; không tự nới hard constraint.

### 4.2. Xử lý Outbox Dead Letter
Khi các sự kiện xuất bản hoặc cập nhật trạng thái không thể gửi tới các consumer sau nhiều lần thử lại, bản ghi sẽ chuyển thành `DEAD_LETTER`.

1. **Xem danh sách sự kiện thất bại:**
   ```http
   GET /admin/outbox/failures?page=1&limit=20
   ```
2. **Kích hoạt gửi lại (Retry với audit log):**
   ```http
   POST /admin/outbox/:id/retry
   ```

---

## 5. Quy trình Khởi động & Bảo trì

1. **Khởi động Redis & PostgreSQL:**
   ```powershell
   docker compose up -d redis
   ```
2. **Khởi động Python Optimizer:**
   ```powershell
   cd optimizer
   .\.venv\Scripts\Activate.ps1
   uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```
3. **Khởi động NestJS Backend:**
   ```powershell
   cd backend
   npm run start:dev
   ```
