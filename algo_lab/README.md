# TMS ALGORITHM LAB (PHÒNG THỰC NGHIỆM THUẬT TOÁN ĐỘI XE)

Thư mục này được thiết kế độc lập, **chạy 100% trong Terminal (CLI)**, không cần frontend hay database, nhằm mục đích:
1. Nghiên cứu và thử nghiệm nhiều trường phái thuật toán khác nhau cho bài toán **VRP kết hợp Xếp dỡ thùng xe 2D (LIFO / Door Clearance)**.
2. Tìm ra thuật toán **vừa trả lời nhanh (thời gian tính toán thấp)**, **vừa tối ưu chi phí nhất (ít tốn tiền nhất, phục vụ 100% đơn hàng)**.
3. Giải quyết triệt để vấn đề "chi phí nhảy thất thường (lúc 7 triệu, lúc tăng vọt)" bằng cơ chế đánh giá công bằng, phạt đơn bị bỏ rơi, và tích hợp kiểm tra xếp dỡ trực tiếp.

---

## CẤU TRÚC THƯ MỤC

```text
algo_lab/
├── OVERVIEW.md                 # TỔNG QUAN: Mục tiêu folder, dữ liệu đầu vào, đầu ra & mục tiêu tối ưu
├── PROBLEM_SPECIFICATION.md    # Tài liệu kỹ thuật chi tiết bài toán, tham số, ràng buộc & chi phí
├── README.md                   # Hướng dẫn sử dụng phòng lab
├── datasets/                   # Dữ liệu thử nghiệm chuẩn hóa (JSON)
│   ├── hanoi_11_orders.json    # Kịch bản thực tế 11 đơn hàng tại Hà Nội & vùng lân cận
│   └── small_5_orders.json     # Kịch bản nhỏ 5 đơn hàng để debug nhanh
├── common/                     # Thư viện mô hình dữ liệu, tính toán chi phí & kiểm tra xếp hàng
│   ├── models.py               # Data classes (Vehicle, Order, Item, Stop, Route, Solution)
│   ├── data_loader.py          # Bộ đọc dữ liệu JSON
│   ├── cost_evaluator.py       # Bộ tính toán chi phí chuẩn (xăng, tài xế, holding, penalty)
│   └── packing_checker.py      # Bộ kiểm tra 2D Non-stackable Packing & Door Clearance (LIFO)
├── algorithms/                 # Các thuật toán độc lập được đưa vào đối đầu
│   ├── greedy_insertion.py     # Thuật toán tham lam chèn đơn (Cực nhanh, < 0.1s)
│   ├── ortools_adapter.py      # Google OR-Tools VRP với các chiến lược Guided Local Search
│   ├── alns_solver.py          # Adaptive Large Neighborhood Search (Phá hủy & Tái thiết lập)
│   └── genetic_solver.py       # Giải thuật Di truyền (Genetic Algorithm)
└── run_benchmark.py            # Script chạy so sánh toàn bộ thuật toán trong terminal
```

---

## HƯỚNG DẪN BẮT ĐẦU

### 1. Đọc tài liệu giải thích mục tiêu, đầu vào & đầu ra:
👉 Đọc file [OVERVIEW.md](file:///e:/Projects/Coursework/Project-Logictists/algo_lab/OVERVIEW.md)

### 2. Xem đặc tả bài toán chi tiết & giải mã nguyên nhân nhảy chi phí:
👉 Đọc file [PROBLEM_SPECIFICATION.md](file:///e:/Projects/Coursework/Project-Logictists/algo_lab/PROBLEM_SPECIFICATION.md)

### 2. Chạy so sánh (Benchmark) tất cả các thuật toán:
```powershell
python algo_lab/run_benchmark.py --dataset algo_lab/datasets/hanoi_11_orders.json
```

### 3. Chạy riêng từng thuật toán:
- Chạy thuật toán Tham lam (Greedy):
  ```powershell
  python algo_lab/algorithms/greedy_insertion.py
  ```
- Chạy thuật toán OR-Tools:
  ```powershell
  python algo_lab/algorithms/ortools_adapter.py
  ```
- Chạy thuật toán ALNS:
  ```powershell
  python algo_lab/algorithms/alns_solver.py
  ```

### 4. Benchmark song song 6 thuật toán × 12 dataset

Các metaheuristic bổ sung:

- `Packing-aware VNS`: thay đổi có hệ thống giữa worst/related/string/random removal và regret repair.
- `Packing-aware Tabu`: tìm kiếm relocate có tabu tenure và aspiration khi tạo được nghiệm tốt nhất mới.
- `Packing-aware ILS`: đào sâu bằng relocate tốt nhất rồi perturb để chuyển vùng nghiệm.
- `Packing-aware Late Acceptance`: chấp nhận theo lịch sử chi phí để thoát cực trị cục bộ mà không dùng nhiệt độ.

Cả hai dùng chung bộ tính chi phí, kiểm tra time window/tải và production `SpatialValidator`;
nghiệm không vượt audit không được tính thắng chi phí.

Năm dataset bổ sung tăng dần độ khó theo các trục khác nhau: time window chặt,
đội xe không đồng nhất, tái sử dụng vùng sàn sau khi giao, nhiều depot/chuyến qua
ngày và mật độ kiện cao gây phân mảnh đường xếp dỡ. Có thể tái tạo chúng theo
seed cố định bằng lệnh:

```powershell
python algo_lab/generate_complex_scenarios.py
```

```powershell
python algo_lab/run_parallel_benchmark.py --budget 2.0 --workers 3
```

Kết quả được ghi vào:

- `algo_lab/results/benchmark_6_algorithms_12_datasets.md`
