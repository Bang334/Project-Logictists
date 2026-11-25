# Kết quả xử lý ba blocker Backend Driver

Đã triển khai trên `feat/phase-1-core-tms`, từ checkpoint `a6e1f2089b4258fbee2436aff466ff712c4211b6`. **Ba blocker RESOLVED trong phạm vi hai rehearsal PostgreSQL. GO cho QA tích hợp local. NO-GO cho triển khai production.** [Runbook production](driver-db-blockers-production-runbook.md)

## Nguyên nhân và thay đổi

| Blocker | Bằng chứng trước sửa | Thay đổi và bằng chứng sau sửa |
| --- | --- | --- |
| **1. e-POD trùng cột** | Rehearsal đích đã có `sizeBytes` tái hiện `42701 duplicate_column` khi chạy M3.5 nguyên trạng. | Chain sạch chạy migration gốc. Đích drift đã chạy script hòa hợp trước khi xử lý mục M3.5 pending. Hai đích có cùng enum `PHOTO/SIGNATURE` và cùng cấu hình `evidenceType`, `sizeBytes` bắt buộc, không có default. Trigger POD đã có được giữ nguyên. Script từ chối bảng có dữ liệu, số dòng và trigger giữ nguyên sau lần từ chối. |
| **2. FK command ordering** | COMPLETE_STOP và Complete Trip bị `23503` khi quan hệ con tham chiếu command chưa được tạo. | Xác thực actor và phân công, giữ idempotency theo actor/type/key và khóa theo Trip. Cùng transaction reserve `PROCESSING`, ghi mutation/attempt/event rồi lưu receipt ở `COMPLETED`. Cả hai DB có test retry, khác payload, cùng key đồng thời, stale version và rollback khi deferred trigger lỗi. Trên đích tái tạo, FK tới command vẫn có hiệu lực. Incident dùng cùng thứ tự reserve/hoàn tất để bảo vệ tham chiếu event. |
| **3. Complete Trip với ASSIGNED** | Rehearsal trước đã reserve command nhưng vấp `23514` ở CHECK yêu cầu `ACCEPTED`. | Start giữ `ASSIGNED`. Complete giữ `PRIMARY/ASSIGNED`, ghi `TRIP_COMPLETED` chứa `assignmentId`, liên kết `completionEventId` và dùng cùng timestamp cho Trip, event và assignment. DB từ chối thiếu evidence hoặc timestamp sai. Guard PHOTO của service được giữ. CHECK vẫn hợp lệ với completion `ACCEPTED` lịch sử. Activity đọc cả event cũ/mới, ưu tiên event mới có liên kết và không đếm hai lần cùng Trip. |

Migration `20261116090000_driver_epod` giữ nguyên SHA-256 `9f693458cf59b1def7e364f6fb5dd5dd9c6986b3843a66d74ce8da3a47d845fe`. Chain sạch đã áp dụng bằng Prisma. Môi trường tái tạo chỉ ghi ledger M3.5 **trong database disposable**, sau khi so sánh toàn bộ phần cột và enum do M3.5 tạo trên bảng rỗng và đối chiếu trigger POD trước/sau. Chưa đọc lại ledger môi trường dùng chung hay production trong lượt này.

## Phân lịch

Start và Complete lấy advisory lock tài nguyên theo thứ tự xe rồi tài xế, cùng namespace Planner. Hai Start đồng thời trên hai Trip cùng tài xế chỉ có một lần thành công. Test E2E xác nhận DB chặn assignment chồng lịch khi chuyến đang chạy, cho phép đặt lại cùng khoảng sau khi ghi xong completion, và cả hai reservation của Trip chuyển `RELEASED`. Thời gian dự kiến, trạng thái assignment và evidence của chuyến cũ được giữ lại.

Chưa chạy một bài stress test trộn nhiều publish/start/complete đồng thời. Lượt này chỉ bảo đảm luồng hoàn thành của PRIMARY. Lịch của RELIEF chưa kết thúc, phân công lịch sử thiếu evidence, ca làm, thời gian nghỉ và thời gian di chuyển cần được xử lý theo policy riêng.

## E2E và regression

E2E chạy trên NestJS, Prisma và PostgreSQL thật. Customer tạo DRAFT, Admin xác nhận qua HTTP, Planner dùng proposal đã ký của fixture qua apply/publish thật, Driver Start/Arrive/Complete, gửi multipart PHOTO và SIGNATURE, kết thúc chuyến, Customer đọc Order `COMPLETED` và Driver đọc Activity. Test đối chiếu command và attempt/event, retry receipt, thời điểm hoàn thành, reservation và kết quả KPI khi có thêm event cũ từ actor khác. Suite còn có ca thiếu PHOTO trả `POD_REQUIRED`, sai actor/RELIEF, lỗi deferred khiến rollback và thử lại thành công, cùng regression upload/retry/replacement và history.

Cloudinary được thay bằng mock và kết quả solver dùng proposal fixture. Không chạy camera, Android hai Pixel hay nhà cung cấp ngoài. Đường lập Trip thủ công hiện có thể tạo StopTask tổng hợp thiếu `packageId`; Driver Execution từ chối task thiếu mapping. E2E chạy đường Planner tự động tạo task gắn Package. Không mở rộng sửa Planner trong lượt này.

| Kiểm tra | Kết quả |
| --- | --- |
| Prisma validate/generate và migrate trên hai database disposable | PASS |
| Backend Jest ngoài PostgreSQL | 297/297 PASS |
| PostgreSQL sạch, 14 suite | 198/198 PASS |
| PostgreSQL tái tạo đích, Driver Execution + POD | 39/39 PASS |
| Nest build và Backend ESLint | PASS |
| Mobile Jest | 461/461 PASS |
| Mobile TypeScript và ESLint | PASS |
| Expo Android JS export | PASS |
| Android hai Pixel và Cloudinary thật | NOT RUN |

Regression G1 giữ nguyên source trong Git. Harness chỉ đổi đích cố định trong bản sao tạm của test đó sang disposable. Đích B dựng lại tập DDL đã biết liên quan POD/history, command FK và completion. Chưa có schema dump/ledger đầy đủ để xác minh phần Web và các dependency production khác. Các ca isolated rollback và schema comparison áp dụng trên PostgreSQL 16 cục bộ. Không dùng DB QA chung.

## Files theo đề xuất commit

1. Ghi command trước mutation. Tách hunk wrapper trong `driver-trip-execution.service.ts`, `driver-trip-execution.service.spec.ts`; đi cùng `backend/src/trips/driver-incidents.service.ts`, `backend/test/trips/driver-incidents.service.spec.ts` và fixture `backend/test/trips/driver-pod.postgres.spec.ts`. Giữ test PostgreSQL tổng hợp cho commit 2 vì cần schema và completion đã hợp nhất.
2. Completion và lịch. Commit schema và migration mới cùng phần completion, locking và Activity. Gồm `backend/prisma/schema.prisma`, `backend/prisma/migrations/20261124090000_driver_assigned_completion/migration.sql`, các hunk còn lại của `backend/src/trips/driver-trip-execution.service.ts` và `backend/test/trips/driver-trip-execution.service.spec.ts`, `backend/src/trips/driver-trip-execution.constants.ts`, `backend/src/drivers/driver-activity.query.ts`, `backend/test/trips/driver-trip-execution.postgres.spec.ts`, `backend/test/trips/driver-trips.postgres.spec.ts`. Nếu việc chia hunk làm một commit không còn tự chạy, gộp 1 và 2, kiểm thử cả snapshot trước commit.
3. Đường hòa hợp e-POD. Gồm `backend/prisma/compat/reconcile-20261116090000-driver-epod.sql`, báo cáo này và `docs/03-technical/driver-db-blockers-production-runbook.md`. Thứ tự commit Git độc lập thứ tự triển khai. Trên đích drift, hòa hợp POD phải đi trước xử lý migration pending và deploy migration completion.

Tổng cộng 10 file tracked được sửa và 4 file mới. `git diff --check` sạch, 32 file local giữ lại khớp SHA-256 với manifest, index rỗng. Chưa stage, commit hay push.

## Điều kiện rollout

DBA và Backend owner cần đối chiếu toàn bộ schema/ledger, backup đã thử restore, kiểm writer cũ/mới, đếm lại POD và kiểm tra Trip/assignment đang chạy. Nếu đích có POD chưa xác minh hoặc DDL/ledger khác dự kiến, dừng ở preflight. Kết quả rehearsal đủ mở QA local trên hai Pixel với Backend/API thật và PostgreSQL disposable. Kết quả đó không đủ để áp dụng migration Supabase. [Runbook production](driver-db-blockers-production-runbook.md)
