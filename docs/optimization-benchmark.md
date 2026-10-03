# Optimization benchmark — 2026-10-03

Lệnh đã chạy trên máy phát triển Windows/Python 3.8:

```powershell
cd optimizer
python benchmark.py --sizes 50 200 500 --time-limit 2 --wall-timeout 15
```

| Đơn | Xe ứng viên | Thời gian | Trạng thái | Đơn phục vụ |
|---:|---:|---:|---|---:|
| 50 | 2 | 2.079 giây | PARTIAL | 21/50 |
| 200 | 8 | 9.182 giây | PARTIAL | 17/200 |
| 500 | 20 (theo generator) | 15 giây | PROCESS_TIMEOUT | Chưa xác định |

Dữ liệu và ma trận là synthetic, không phải dữ liệu Mapbox hay bộ dữ liệu vận hành đại diện. Kết quả này chỉ là baseline hồi quy: với cấu hình thử nghiệm rất ngắn, quy mô 500 đơn chưa đạt giới hạn tiến trình 15 giây và không được diễn giải là `INFEASIBLE`. Cần profiling/benchmark trên dữ liệu đại diện trước khi chốt SLO hoặc năng lực production.
