# Chạy lại mốc Hybrid ALNS trước sửa - 01/11/2026

Đây là chạy lại **mã hiện tại trước sửa**, không phải kết quả sau cải tiến. Không sửa code ứng dụng trong phiên lập kế hoạch này.

Cấu hình: 17 ca, 5 engine, seed 0, ngân sách tìm kiếm 2.0 giây, ca ngày 08:00–17:00. Mỗi fixture dùng ma trận lưu sẵn và normalization chung; không gọi Mapbox.

Kết quả: **3 WIN, 4 TIE, 10 LOSS**. 85/85 lượt không có lỗi thực thi, giao đủ đơn/kiện và đạt complete_manifest, unique_balanced_manifest, spatial_valid, basic_schedule_valid theo auditor hiện tại. Đây không phải kiểm chứng toàn bộ hệ thống production.

Xếp hạng: audit → đơn chưa phục vụ → extra order trips → số tuyến → chi phí vận hành audit. Đây là thước đo benchmark; objective production còn có lương lịch và penalty trễ.

## Bảng đối đầu chi tiết

Cột tuyến đếm slot xe-ngày hoạt động; cột xe vật lý đếm tài nguyên duy nhất. Đối thủ được chọn theo toàn bộ thứ tự ưu tiên, không chỉ chi phí thấp nhất.

| Kịch bản | Đơn | Tuyến H/ĐT | Xe vật lý H/ĐT | Hybrid (VND) | Đối thủ | Đối thủ (VND) | Chênh lệch (VND) | Tỷ lệ | KQ |
|---|---:|:---:|:---:|---:|---|---:|---:|---:|:---:|
| `day_db_danang_30_orders.json` | 30 | 15/14 | 3/2 | 31,934,305 | ILS | 29,105,513 | +2,828,792 | +9.72% | LOSS |
| `day_db_hanoi_16_orders.json` | 16 | 6/6 | 3/3 | 9,398,745 | ILS | 9,398,745 | +0 | +0.00% | TIE |
| `day_db_nhatrang_2_orders.json` | 2 | 1/1 | 1/1 | 535,486 | ILS | 535,486 | +0 | +0.00% | TIE |
| `day_db_songthan_4_orders.json` | 4 | 1/1 | 1/1 | 2,057,739 | ILS | 2,057,739 | +0 | +0.00% | TIE |
| `day_novel_1_mekong_hub_spoke.json` | 15 | 3/3 | 3/3 | 5,440,160 | ILS | 5,439,008 | +1,152 | +0.02% | LOSS |
| `day_novel_2_long_narrow_timber.json` | 12 | 2/2 | 2/2 | 2,268,655 | CASA-ILS | 2,107,642 | +161,013 | +7.64% | LOSS |
| `day_novel_3_three_shift_relay.json` | 18 | 2/2 | 1/1 | 2,006,159 | ILS | 1,929,045 | +77,114 | +4.00% | LOSS |
| `day_novel_4_3tier_asymmetric_fleet.json` | 16 | 2/2 | 2/2 | 2,987,424 | ILS | 2,972,295 | +15,129 | +0.51% | LOSS |
| `day_novel_5_rolling_3day_horizon.json` | 18 | 3/3 | 2/2 | 2,746,305 | ILS | 2,693,087 | +53,218 | +1.98% | LOSS |
| `day_scenario_1_multi_item.json` | 10 | 2/2 | 2/2 | 3,202,635 | ILS | 3,521,772 | -319,137 | -9.06% | WIN |
| `day_scenario_2_heavy_cargo.json` | 12 | 3/3 | 3/3 | 4,285,455 | HGS | 4,294,867 | -9,412 | -0.22% | WIN |
| `day_scenario_3_dispersed.json` | 14 | 5/5 | 5/5 | 10,473,341 | ILS | 10,003,006 | +470,335 | +4.70% | LOSS |
| `day_scenario_4_tight_windows.json` | 18 | 3/3 | 3/3 | 2,513,576 | ILS | 2,284,215 | +229,361 | +10.04% | LOSS |
| `day_scenario_5_heterogeneous_fleet.json` | 20 | 3/3 | 3/3 | 5,173,914 | ILS | 5,173,914 | +0 | +0.00% | TIE |
| `day_scenario_6_dynamic_reuse.json` | 14 | 2/2 | 2/2 | 2,105,002 | CASA-ILS | 2,164,183 | -59,181 | -2.73% | WIN |
| `day_scenario_7_multi_depot_overnight.json` | 18 | 8/6 | 6/5 | 15,859,192 | ILS | 12,597,413 | +3,261,779 | +25.89% | LOSS |
| `day_scenario_8_dense_fragmentation.json` | 16 | 2/2 | 2/2 | 3,987,375 | ILS | 3,527,614 | +459,761 | +13.03% | LOSS |

## Dao động so với bảng Vòng 4

Cùng seed và budget danh nghĩa vẫn có thể khác chi phí vì solver dừng theo thời gian. Bảng cũ không kèm manifest mã/máy đầy đủ nên không thể gán mọi chênh lệch cho nhiễu; chưa có thay đổi ứng dụng trong phiên này. Không diễn giải chênh lệch dưới đây là thành quả sửa thuật toán.

| Kịch bản có thay đổi chi phí Hybrid | Vòng 4 (VND) | Chạy lại (VND) | Chênh lệch (VND) |
|---|---:|---:|---:|
| `day_db_danang_30_orders.json` | 31,929,402 | 31,934,305 | +4,903 |
| `day_novel_1_mekong_hub_spoke.json` | 5,440,480 | 5,440,160 | -320 |
| `day_novel_3_three_shift_relay.json` | 2,092,499 | 2,006,159 | -86,340 |
| `day_novel_5_rolling_3day_horizon.json` | 2,869,179 | 2,746,305 | -122,874 |
| `day_scenario_4_tight_windows.json` | 2,471,744 | 2,513,576 | +41,832 |
| `day_scenario_6_dynamic_reuse.json` | 2,134,854 | 2,105,002 | -29,852 |

## Thời gian solve thực đo

Thời gian sau gồm đường solve của từng engine, có thể có khởi tạo/final repair/audit nội bộ. Chưa gồm lần audit độc lập mà runner thực hiện sau solve; không coi là toàn bộ wall time end-to-end. Ngân sách danh nghĩa 2 giây không phải trần solve.

| Engine | Tổng solve 17 ca (giây) | Solve lớn nhất (giây) |
|---|---:|---:|
| Hybrid ALNS | 118.606 | 20.597 |
| ILS | 66.882 | 13.746 |
| HGS | 43.430 | 6.314 |
| GVNS-Pool | 42.952 | 8.841 |
| CASA-ILS | 47.739 | 10.260 |

## Kiểm tra và tệp bằng chứng

- Lệnh benchmark: `.\.venv\Scripts\python.exe -X utf8 -m benchmarks.algorithm_comparison.run_daytime_benchmark --budget 2.0 --seeds 0 --output benchmarks/algorithm_comparison/experiments/daytime_replan_20261101_seed0.json`; exit 0.
- Lệnh test: `.\.venv\Scripts\python.exe -X utf8 -m pytest -q tests/test_benchmark_contract.py tests/test_challenge_report.py tests/test_audited_elite_retention.py`; **14 passed in 3.70s**. Đây là kiểm tra hiện trạng, không phải test hồi quy của bản sửa mới.
- Đã kiểm tra đủ 85 khóa trial duy nhất, đúng cấu hình, toàn bộ manifest kiện đầy đủ; hash của 58 tệp nguồn/fixture/requirements không đổi so với manifest thu trong lúc chạy.
- JSON thô: `optimizer/benchmarks/algorithm_comparison/experiments/daytime_replan_20261101_seed0.json`.
- Môi trường và SHA-256: `optimizer/benchmarks/algorithm_comparison/experiments/daytime_replan_20261101_manifest.json`.
- Kế hoạch: [KE_HOACH_SUA_HYBRID_ALNS_17_KICH_BAN.md](KE_HOACH_SUA_HYBRID_ALNS_17_KICH_BAN.md).

Chưa thực hiện: sửa thuật toán, benchmark sau sửa, kiểm tra nhiều seed, đo riêng từng pha, toàn bộ optimizer/tests, hoặc kiểm chứng API/job/frontend/Mapbox. Chờ quyền sửa mã theo AGENTS.md; không coi mục tiêu cải thiện thuật toán đã hoàn tất.
