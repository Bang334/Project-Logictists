# Runbook hòa hợp e-POD và hoàn thành chuyến

**Trạng thái production: BLOCKED.** Chỉ thử trên PostgreSQL disposable. Cần bản schema dump đầy đủ, toàn bộ Prisma ledger, kiểm tra writer và kết quả khôi phục backup trước khi chọn đường nâng cấp.

## Preflight chỉ đọc

DBA xác minh project, branch và database qua kênh quản trị tin cậy. Sau đó chạy các truy vấn dưới đây trong phiên read-only trên đích đã xác minh. Chỉ chia sẻ kết quả đã bỏ thông tin nhạy cảm. Tên database có thể giống nhau giữa môi trường nên cần đối chiếu cả project và branch.

```sql
BEGIN READ ONLY;
SELECT current_database(), current_schema(), current_setting('server_version');
SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count
FROM public._prisma_migrations ORDER BY started_at, id;
SELECT count(*) AS pod_row_count FROM public.pod_files;
SELECT table_name, column_name, data_type, udt_schema, udt_name,
       is_nullable, column_default, datetime_precision
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('pod_files', 'driver_assignments', 'trips',
                     'execution_events', 'processed_commands', 'delivery_attempts')
ORDER BY table_name, ordinal_position;
SELECT e.enumsortorder, e.enumlabel
FROM pg_enum e WHERE e.enumtypid = to_regtype('public."PodEvidenceType"')
ORDER BY e.enumsortorder;
SELECT conrelid::regclass AS relation, conname, convalidated, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid IN (
  'public.pod_files'::regclass, 'public.driver_assignments'::regclass,
  'public.trips'::regclass, 'public.execution_events'::regclass,
  'public.delivery_attempts'::regclass, 'public.processed_commands'::regclass
) ORDER BY relation, conname;
SELECT tgrelid::regclass AS relation, tgname, tgenabled, pg_get_triggerdef(oid),
       pg_get_functiondef(tgfoid)
FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (
  'public.pod_files'::regclass, 'public.trips'::regclass,
  'public.driver_assignments'::regclass, 'public.execution_events'::regclass,
  'public.delivery_attempts'::regclass
) ORDER BY relation, tgname;
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('driver_assignments', 'execution_events', 'pod_files');
SELECT t.status AS trip_status, a.role, a.status AS assignment_status, count(*)
FROM public.driver_assignments a JOIN public.trips t ON t.id = a."tripId"
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT count(*) AS attempts_without_commands
FROM public.delivery_attempts d LEFT JOIN public.processed_commands c ON c.id = d."commandId"
WHERE d."commandId" IS NOT NULL AND c.id IS NULL;
SELECT count(*) AS events_without_commands
FROM public.execution_events e LEFT JOIN public.processed_commands c ON c.id = e."commandId"
WHERE e."commandId" IS NOT NULL AND c.id IS NULL;
ROLLBACK;
```

Nếu đã có cột hoàn thành assignment, đối chiếu thêm số dòng lệch pair, event khác Trip/actor/assignment, timestamp lệch và Trip còn chạy chưa khép lại. Kiểm tra bản ghi `ACCEPTED` lịch sử và reservation đang giữ lịch. Chỉ chạy truy vấn phụ sau khi xác minh cột tồn tại.

```sql
SELECT count(*) AS inconsistent_evidence
FROM public.driver_assignments a
JOIN public.trips t ON t.id = a."tripId"
JOIN public.drivers d ON d.id = a."driverId"
LEFT JOIN public.execution_events e ON e.id = a."completionEventId"
WHERE (a."actualEndTime" IS NOT NULL OR a."completionEventId" IS NOT NULL)
  AND (a."actualEndTime" IS NULL OR a."completionEventId" IS NULL
    OR e."tripId" IS DISTINCT FROM t.id OR e."actorUserId" IS DISTINCT FROM d."userId"
    OR e."eventType" IS DISTINCT FROM 'TRIP_COMPLETED'
    OR (e.payload->>'assignmentId') IS DISTINCT FROM a.id
    OR t.status <> 'COMPLETED'
    OR a."actualEndTime" IS DISTINCT FROM t."actualEndTime"
    OR a."actualEndTime" IS DISTINCT FROM e."occurredAt"
    OR t."actualStartTime" IS NULL OR t."actualStartTime" > a."actualEndTime");
```

## Trình tự đề xuất sau khi được duyệt

1. Lấy backup và thử restore trên database cô lập. Đối chiếu toàn bộ ledger với source, bao gồm migration Web đã áp dụng, checksum và mọi mục thất bại. Rehearsal hiện tại chỉ tái tạo những constraint đã biết. Chưa đủ căn cứ để duyệt các mục ledger không có trong nhánh.
2. Xác nhận tất cả writer của POD, Trip, Assignment và ExecutionEvent. Writer mới phải lưu đúng loại bằng chứng và kích thước file, reserve command trước quan hệ con, ghi đủ event và assignment khi hoàn thành. Duyệt cửa sổ bảo trì, dừng writer cũ và lập đường rollback ứng dụng tương thích schema.
3. Đếm lại `public.pod_files` trong cửa sổ bảo trì. Nếu có dòng, dừng để xác minh nguồn loại evidence và size từng file. Dừng nếu có khác biệt enum, cột, index, owner, grants, FK, trigger hoặc ledger chưa được giải thích.
4. Chọn đúng đường. Database sạch chạy nguyên migration chain. Với đích có `sizeBytes` và M3.5 pending, DBA áp dụng `backend/prisma/compat/reconcile-20261116090000-driver-epod.sql` trong phiên có `ON_ERROR_STOP`. Script khóa bảng, kiểm tra cấu trúc và chỉ chạy trên bảng rỗng.
5. So sánh toàn bộ hiệu ứng của M3.5 với chain sạch, bao gồm catalog và dữ liệu POD, rồi đối chiếu checksum migration nguyên vẹn. Chỉ sau khi owner xác nhận tương đương mới dùng `prisma migrate resolve --applied 20261116090000_driver_epod` theo quy trình ledger đã duyệt. Sau đó mới áp dụng migration completion theo chain đã rehearsal. Tránh chạy nguyên migration M3.5 trên đích drift trước bước này.
6. Đối soát cột, enum, index, FK, CHECK, trigger, dữ liệu lịch sử và ledger. Dùng Prisma Client sinh từ schema mới với Backend tương thích. Mở lại writer sau khi smoke test phiên bản mới.
7. Smoke test trước khi mở lưu lượng đầy đủ. Kiểm tra một lần giao sinh đúng một attempt có command hợp lệ, PHOTO/SIGNATURE đúng loại, thiếu PHOTO bị chặn, hoàn thành có event và đồng nhất timestamp, retry trả receipt cũ, Customer đọc đúng trạng thái, Activity không đếm trùng và lịch đã giải phóng.
8. Nếu bước SQL trong transaction lỗi, dừng và kiểm tra schema/ledger trước khi thử lại. Nếu lỗi sau DDL đã commit hoặc deploy Backend, giữ writer đã dừng. Đối chiếu schema và lịch sử để chọn hotfix tiến hoặc phương án restore/PITR đã diễn tập. Tránh đưa writer cũ trở lại khi cột bắt buộc hoặc completion guard chưa tương thích. DBA và Backend owner xác nhận lại trước khi mở lưu lượng.
