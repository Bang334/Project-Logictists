# Sửa chính sách giao trễ — 02/11/2026

Khách không chọn hạn giao cứng. Đơn vẫn được phép giao sau khoảng miễn phạt;
penalty tăng theo thời gian chờ vượt ngưỡng, tính từ ngày đặt gốc. Ca tài nguyên,
thứ tự lấy–giao, bảo toàn kiện và kiểm tra hình học vẫn bắt buộc.

## Thay đổi

- Backend không dùng cửa sổ giao legacy để loại đơn hoặc từ chối áp dụng phương
  án. Tạo/xác nhận đơn không cần nhập cửa sổ giao; báo giá bán hàng không nhận
  lựa chọn này. Form đơn và phần xem chi tiết được sửa tương ứng.
- Payload lập kế hoạch giữ `ordered_at_sec` âm nếu ngày đặt trước mốc kế hoạch;
  không reset tuổi đơn về 0. Phạm vi 7 ngày là lịch tài nguyên được khảo sát,
  không phải hạn của khách. Không lấy/giao trước lúc đặt đơn.
- Adapter Hybrid giữ ngày đặt và số ngày miễn phạt. Chi phí nội bộ dùng chung
  công thức với chi phí production. Một đơn khách có nhiều phần/yêu cầu vận
  chuyển chỉ tính phạt một lần theo lần giao cuối cùng trong phương án.
- Bỏ hook `prestart:dev` dời lịch. Script cũ chỉ còn là công cụ reset demo thủ
  công, không phải xử lý đơn trễ. Đã tắt quyền reset từ xa trong `.env` cục bộ.
- Hoàn lại ngày đặt và các mốc của 53 đơn đã bị dời trong phiên này, chỉ khi
  trạng thái/version/cửa sổ vẫn đúng sau lần dời và chưa có allocation; đã kiểm
  chứng khớp bản trước dời. Version tăng bằng cập nhật bù, không quay lùi.
- Người dùng giao quyền chọn mức phạt dev. Hà Nội giữ miễn phạt 2 ngày, dùng
  `FIXED_PER_DAY=50000` VND/đơn/ngày trễ. Tính tỷ lệ theo số giây, làm tròn VND.
  Không dùng % vì giá trị của 14 đơn demo hiện bằng 0. Không đổi các chi nhánh khác.

## Tái hiện và kiểm chứng

Trước sửa, snapshot job trên giao diện có 14 yêu cầu/262 kiện, cửa sổ giao 0–0
giây và xe bắt đầu từ 08:00. Replay Hybrid trực tiếp trả 0 tuyến/14 đơn chưa
xếp trong 0,629 giây. Test hồi quy backend cũng bắt được việc mất tuổi đơn,
cửa sổ 0–0 và bước áp dụng phương án từ chối giao sau lịch legacy.

Sau sửa, dùng `TripsService.buildOptimizerOrders` từ backend đã build để tạo
lại payload từ các đơn DB đã khôi phục ngày gốc. Giữ thứ tự node, manifest và
ma trận Mapbox đã lưu của job lỗi; không gọi lại Mapbox hoặc phát hành chuyến.
Chạy qua FastAPI `POST /optimize-fleet/candidates` bằng TestClient, với chính
ngân sách thích ứng 82 giây (2 seed, 41 giây/seed):

| Kết quả | Giá trị |
|---|---:|
| Thời gian thực qua endpoint và audit | 116,148 giây |
| Phương án lộ trình khác nhau | 2 |
| Phục vụ mỗi phương án | 14/14 yêu cầu, 262/262 kiện |
| Tuyến / xe vật lý | 4 / 2 |
| Ngày tài nguyên dùng | 0, 1, 2 |
| Complete/unique manifest, spatial, basic schedule | Đạt cả hai phương án |
| Penalty phương án hạng 1 | 5.150.556 VND |

Đây là phép kiểm chứng optimizer và payload backend với ma trận đã lưu, không
phải thao tác trực tiếp trên trình duyệt hoặc kiểm chứng publish vào DB. Kết
quả vẫn là best-found trong ngân sách, không chứng minh tối ưu toàn cục.

## Kiểm tra mã

- Backend: typecheck, build và lint các file source đã sửa đạt. Chạy trực tiếp
  Jest với pattern `trips|sales-orders|shopping`: **99 passed, 3 skipped**.
  Các test PostgreSQL bị skip theo cấu hình hiện có, không nhận là đã pass.
- Frontend: typecheck/build đạt; 48 test hiện có đạt và test form mới đạt riêng
  (không có trường hạn giao, vẫn có thời lượng phục vụ). Lint các file đã sửa
  không có error, còn 3 warning hooks có sẵn. Playwright orders được cập nhật
  cho contract không có cửa sổ; chưa chạy lại full browser/API suite này.
- Optimizer: `python -X utf8 -m pytest -q --tb=short`: **206 passed, 4 failed**.
  Cả 4 lỗi đã tái hiện trong bản sao mã HEAD trước sửa, xác minh import đúng
  thư mục baseline: ba lỗi budget 0,05 giây nhỏ hơn post-audit reserve 0,15 giây,
  một lỗi test kỳ vọng pha search 2,4 giây trong khi mã hiện có cấp 2,35 giây.
  Không sửa/tắt assertion hoặc loại các test này để làm suite xanh.
- Một lần chạy full Jest trước sửa còn lỗi có sẵn của
  `retail-e2e-flow.spec.ts`: kỳ vọng 90 model nhưng schema có 91 model. Nhiệm vụ
  không sửa schema hay test này; bộ test liên quan nêu trên đã đạt.
- `git diff --check` đạt; Graphify được cập nhật bằng AST cục bộ, không API/LLM.

Khởi động lại backend/optimizer/frontend rồi tạo job tối ưu mới để dùng mã và
cấu hình mới. Không tái sử dụng kết quả/snapshot lỗi đã lưu trước sửa.
