# Hybrid ALNS benchmark

- `cases/`: 12 input đã giữ lại từ phòng thử nghiệm thuật toán.
- `best_known_results.json`: mốc lịch sử; có thể do Hybrid ALNS hoặc thuật toán khác tạo ra.
- `hybrid_integration_results.json`: lần chạy production Hybrid ALNS ngày 2026-10-09 trên sáu case mà Hybrid ALNS từng giữ mốc tốt nhất.

Chạy từ thư mục `optimizer`:

```powershell
python benchmark_hybrid_regression.py
```

Kết quả production phải giao đủ đơn và qua validator. Hybrid production cho mọi kiện đổi hướng 0°/90° trên mặt sàn như loader cũ, nhưng vẫn bảo toàn availability, service-day, driver-day và giới hạn xe theo đơn. Solver dùng giới hạn wall-clock nên số vòng lặp và chi phí best-found có thể dao động theo tải máy dù seed giống nhau.

Lần đo được lưu hiện tại giao đủ và hợp lệ trên 6/6 case Hybrid lịch sử. Cả 5/5 case có contract chi phí tương đương nằm trong 5% mốc cũ. Case Hà Nội được đánh dấu `cost_comparable_to_production=false`: loader legacy bỏ qua `service_day_index` và availability của 21 slot xe-ngày, nên mốc 3 tuyến cũ không phải nghiệm hợp lệ theo contract production; runner hiển thị `N/A` thay vì PASS/REGRESSION cho phép so sánh này.
