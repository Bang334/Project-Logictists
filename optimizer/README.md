# TMS Optimization Engine

FastAPI service dùng Google OR-Tools cho routing và validator riêng cho tải từng chặng, pickup trước delivery và bố trí kiện không chồng/lối thao tác.

## Chạy

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Chạy kiểm tra bằng `python -m pytest -q`. Solver phân biệt `TIMEOUT` với `INFEASIBLE` từ trạng thái OR-Tools; kết quả vẫn phải qua validator trước khi backend lưu hoặc áp dụng.

Ma trận khoảng cách/thời gian phải đến từ provider đã kiểm chứng. Script debug có hệ số Haversine chỉ phục vụ dữ liệu thử nghiệm, không phải tuyến thật và không được dùng làm kết quả vận hành.

Benchmark lặp lại được: `python benchmark.py --sizes 50 200 500 --time-limit 5`. Dữ liệu và matrix do script sinh là synthetic, chỉ dùng đo hồi quy hiệu năng; không đại diện KPI vận hành hay chất lượng tuyến Mapbox.
