# TMS ALGORITHM LAB (PHÒNG THỰC NGHIỆM THUẬT TOÁN ĐỘI XE)

Thư mục này được thiết kế độc lập, **chạy 100% trong Terminal (CLI)**, không cần frontend hay database, nhằm mục đích:
1. Nghiên cứu và thử nghiệm nhiều trường phái thuật toán khác nhau cho bài toán **VRP kết hợp Xếp dỡ thùng xe 2D (LIFO / Door Clearance)**.
2. Tuyển chọn một metaheuristic đủ tin cậy để tiếp tục tối ưu và đưa vào project: ưu tiên nghiệm hợp lệ, phục vụ đủ đơn, ổn định qua nhiều seed, sau đó mới so chi phí và thời gian.
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
│   ├── alns_solver.py          # Adaptive Large Neighborhood Search (Phá hủy & Tái thiết lập)
│   ├── genetic_solver.py       # Giải thuật Di truyền (Genetic Algorithm)
│   ├── hybrid_alns.py          # Hybrid ALNS packing-aware
│   └── advanced_metaheuristics.py # VNS, Tabu, ILS, LAHC, SA, GRASP, Memetic
├── run_parallel_benchmark.py   # Benchmark tuyển chọn rộng 10 metaheuristic
└── run_alns_selection_benchmark.py # Hybrid/Standard ALNS vs 4 đối thủ + manifest case yếu
```

---

## HƯỚNG DẪN BẮT ĐẦU

### 1. Đọc tài liệu giải thích mục tiêu, đầu vào & đầu ra:
👉 Đọc file [OVERVIEW.md](file:///e:/Projects/Coursework/Project-Logictists/algo_lab/OVERVIEW.md)

### 2. Xem đặc tả bài toán chi tiết & giải mã nguyên nhân nhảy chi phí:
👉 Đọc file [PROBLEM_SPECIFICATION.md](file:///e:/Projects/Coursework/Project-Logictists/algo_lab/PROBLEM_SPECIFICATION.md)

### 3. Chạy benchmark tuyển chọn chính:
```powershell
python algo_lab/run_parallel_benchmark.py --budget 10 --seeds 0,1,2 --workers 3
```

Greedy và OR-Tools không nằm trong bảng xếp hạng này. Greedy vẫn được tái sử dụng như heuristic dựng nghiệm ban đầu của một số thuật toán; đó không phải một ứng viên production độc lập. `run_benchmark.py`, `run_fast_comparison.py` và `run_full_system_comparison.py` là công cụ chẩn đoán cũ, không dùng để kết luận thuật toán thắng.

### 4. Tối ưu tiếp Hybrid ALNS trên đúng các case còn yếu

Sau khi đã chọn Hybrid ALNS, chạy benchmark tập trung với Standard ALNS, VNS,
Simulated Annealing, GRASP và Memetic Search:

```powershell
python algo_lab/run_alns_selection_benchmark.py --budget 10 --seeds 0,1,2 --workers 3
```

Lượt đầu sinh `algo_lab/results/alns_weak_cases.json`. Sau mỗi thay đổi Hybrid,
chỉ chạy lại chính xác các cặp dataset/seed trong manifest đó:

```powershell
python algo_lab/run_alns_selection_benchmark.py --budget 10 --workers 3 --weak-from algo_lab/results/alns_weak_cases.json
```

Kết quả tập trung nằm ở `alns_selection.md/json`; lượt kiểm tra lại nằm ở
`alns_weak_recheck.md/json`. Mỗi case yếu có trường `focus` để phân biệt lỗi
validator/repair, thừa hoặc chọn sai xe, và thứ tự/ghép tuyến chưa tốt.

### 5. Danh sách 10 metaheuristic được tuyển chọn

Các ứng viên:

- `Standard ALNS` và `Hybrid ALNS`.
- `Genetic Algorithm`.
- `Packing-aware VNS`: thay đổi có hệ thống giữa worst/related/string/random removal và regret repair.
- `Packing-aware Tabu`: tìm kiếm relocate có tabu tenure và aspiration khi tạo được nghiệm tốt nhất mới.
- `Packing-aware ILS`: đào sâu bằng relocate tốt nhất rồi perturb để chuyển vùng nghiệm.
- `Packing-aware Late Acceptance`: chấp nhận theo lịch sử chi phí để thoát cực trị cục bộ mà không dùng nhiệt độ.
- `Packing-aware Simulated Annealing`: chấp nhận nghiệm xấu có kiểm soát và reheating khi đình trệ.
- `Packing-aware GRASP`: dựng nhiều nghiệm ngẫu nhiên có giới hạn rồi local search.
- `Packing-aware Memetic Search`: lai ghép quần thể kết hợp local search packing-aware.

Tất cả dùng chung bộ tính chi phí, kiểm tra time window/tải và production `SpatialValidator`;
nghiệm không vượt audit không được tính thắng chi phí.

Năm dataset bổ sung tăng dần độ khó theo các trục khác nhau: time window chặt,
đội xe không đồng nhất, tái sử dụng vùng sàn sau khi giao, nhiều depot/chuyến qua
ngày và mật độ kiện cao gây phân mảnh đường xếp dỡ. Có thể tái tạo chúng theo
seed cố định bằng lệnh:

```powershell
python algo_lab/generate_complex_scenarios.py
```

```powershell
python algo_lab/run_parallel_benchmark.py --budget 10 --seeds 0,1,2 --workers 3
```

Kết quả được ghi vào:

- `algo_lab/results/benchmark_10_metaheuristics_12_datasets.md`
- `algo_lab/results/benchmark_10_metaheuristics_12_datasets.json`
- `algo_lab/results/benchmark_10_metaheuristics_12_datasets.csv`

Chỉ thuật toán PASS và phục vụ đủ đơn ở mọi dataset/seed mới được đề xuất làm ứng viên tối ưu tiếp. Kết quả vẫn là best-found theo ngân sách, không phải bằng chứng tối ưu toàn cục.
