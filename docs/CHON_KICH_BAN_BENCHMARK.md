# Chọn kịch bản và thuật toán để chạy benchmark

Phạm vi: công cụ benchmark 17 kịch bản, không phải bộ unit test `pytest`.

## 1. Chỉnh file chọn

Mở `optimizer/benchmarks/algorithm_comparison/test_selection.ini`:

- `[cases]`: `TESTCASE1`–`TESTCASE17`, tên fixture ghi ngay bên cạnh từng dòng.
- `[engines]`: bật/tắt Hybrid ALNS, ILS, HGS, GVNS-Pool, CASA-ILS độc lập.
- `1` là chạy, `0` là bỏ qua. Mục không khai báo cũng bị bỏ qua.
- Tên sai, giá trị khác `0/1`, khai báo trùng, fixture bị thiếu hoặc không chọn ca/engine nào đều báo lỗi trước khi chạy.

File mẫu bật 10 ca Hybrid LOSS theo bảng Vòng 4 ngày 01/11/2026, seed 0. Đây là lựa chọn thủ công dựa trên bảng cũ, **không tự cập nhật theo kết quả mới**.

Để chỉ chạy Đà Nẵng với Hybrid và ILS, có thể thay toàn bộ nội dung bằng:

```ini
[cases]
TESTCASE1=1

[engines]
Hybrid ALNS=1
ILS=1
```

Hoặc giữ đủ 17 dòng và đặt các ca còn lại bằng `0`. Bật tất cả ca/engine bằng `1` khi muốn chạy lại đầy đủ. Số TESTCASE cố định, không đổi theo thứ tự file trên đĩa.

## 2. Xem trước và chạy

Chạy trong PowerShell từ thư mục `E:\Projects\Coursework\Project-Logictists\optimizer`:

```powershell
# Xem danh sách và tổng lượt, không chạy solver hoặc ghi kết quả
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.run_daytime_benchmark --selection-file benchmarks/algorithm_comparison/test_selection.ini --seeds 0 --budget 2 --dry-run

# Chạy đúng các mục bật trong file
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.run_daytime_benchmark --selection-file benchmarks/algorithm_comparison/test_selection.ini --seeds 0 --budget 2
```

Tổng lượt = số ca bật × số engine bật × số seed. Một ca, hai engine, seed 0 chỉ có **2 lượt**. Budget là ngân sách search danh nghĩa mỗi lượt; dựng seed, repair và audit có thể làm thời gian thực dài hơn.

Mỗi lần chạy với `--selection-file` mặc định tạo JSON mới có thời gian UTC trong tên, tại `optimizer/benchmarks/algorithm_comparison/experiments/daytime_selected_*.json`; đường dẫn chính xác in ra trước khi chạy. Không dùng lại kết quả cũ khi bạn vừa sửa thuật toán.

Nếu cần nhiều seed, thay `--seeds 0` bằng `--seeds 0 1 2 3 4`. Các bộ lọc `--cases`/`--engines` nếu truyền thêm sẽ lấy giao với lựa chọn trong file. Không truyền `--selection-file` thì runner giữ cách chạy cũ.

## 3. Xem kết quả

Thay đường dẫn dưới đây bằng JSON được in khi chạy:

```powershell
.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.summarize_daytime benchmarks/algorithm_comparison/experiments/daytime_selected_<thoi_gian>.json
```

Muốn có bảng đối đầu cần bật Hybrid ALNS và ít nhất một đối thủ. Chỉ bật Hybrid vẫn chạy và audit được nhưng không có kết luận WIN/TIE/LOSS. Nếu chỉ bật vài đối thủ, kết luận chỉ áp dụng cho các đối thủ đó; muốn biết còn thua thuật toán nào trong nhóm 5 thì bật cả 5.

`--output <file>` hỗ trợ chỉ định đầu ra và resume. Runner kiểm tra fingerprint code, fixture, phiên bản runtime/dependency, budget, ca làm việc và objective trước khi ghi tiếp. File cũ thiếu fingerprint hoặc khác cấu hình sẽ bị từ chối; hãy dùng đầu ra mới sau mỗi lần sửa thuật toán. Trial đã có cùng case/engine/seed được bỏ qua, trial trùng trong file báo lỗi.

Dữ liệu mới dùng objective production đã chốt: giao đủ, grouping, số chuyến, rồi selection score. Bộ tổng hợp vẫn báo riêng kết quả operating cost để thấy các đánh đổi. File lịch sử thiếu profile giữ cách so sánh operating cũ; không trộn hai profile trong cùng bảng.

Chạy chọn lọc giúp thử nhanh, không thay thế toàn bộ kiểm thử hồi quy và benchmark nhiều seed khi nghiệm thu thay đổi optimizer.

Preset bổ sung `goal_production_losses.ini` chỉ bật TESTCASE13 và 5 engine, theo ca còn LOSS trong round17 (production, seed 0). Đây là mốc thủ công; round21 đã sửa ca này và đạt WIN trên 5 seed, nên không coi preset là danh sách thua tự cập nhật. Để thử nhanh chỉ với ILS, thêm `--engines 'Hybrid ALNS' ILS`; muốn nghiệm thu đối đầu cả nhóm thì giữ đủ 5 engine.

## 4. Kiểm chứng cơ chế chọn ngày 01/11/2026

- `python -X utf8 -m pytest -q tests/test_benchmark_selection.py tests/test_challenge_report.py`: **19 passed**.
- Dry-run file mẫu: đúng 10 ca × 5 engine × seed 0 = 50 lượt, không chạy solver.
- Chạy thật file tạm chỉ bật TESTCASE3 (Nha Trang), Hybrid ALNS và ILS, seed 0, budget 0.2 giây: đúng 2 lượt; cả hai giao đủ 2/2 đơn, spatial/schedule/manifest hợp lệ; JSON xuất thành công, bộ tổng hợp đọc được và cho TIE.
- Kết quả smoke: `optimizer/benchmarks/algorithm_comparison/experiments/daytime_selected_20261101T073240_207742Z.json`. Đây là kiểm chứng công cụ chọn; không phải benchmark cải tiến thuật toán hay chạy lại 17 ca.
