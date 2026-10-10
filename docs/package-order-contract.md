# Hợp đồng Package / khung giờ sau merge

## Nguồn dữ liệu

Order là đơn B2B; OrderItem là dòng hàng; mỗi Package là một kiện vật lý có UUID ổn định. `items[].packages[]` là nguồn tải duy nhất cho đơn B2B có `packageDataStatus=COMPLETE`. `OrderItem.quantity` và tổng đơn là dữ liệu tổng hợp do server tính, không nhân thêm vào danh sách Package. Package bán lẻ dùng PackageItem là mô hình riêng, không tự chuyển thành kiện B2B.

DB và API Package: `lengthMm`, `widthMm`, `heightMm` là số nguyên mm dương; `weightG` là chuỗi số nguyên gram dương (BigInt). `null` ở dữ liệu cũ nghĩa là chưa rõ; không đổi thành 0. Mã kiện unique, ID giữ nguyên khi sửa. Pickup/delivery dùng `pickupStopId` và `deliveryStopId`, không dựa vào vị trí hiển thị.

OrderStop có `type=PICKUP|DELIVERY`, `windowStart`, `windowEnd` ISO8601 có timezone và `windowBasis=SERVICE_START`. Thời gian là mốc bắt đầu phục vụ; UI Asia/Ho_Chi_Minh, DB UTC timestamptz. Nháp có thể thiếu cả cặp thời gian; xác nhận cần đủ. Cho phép qua ngày và hai khoảng chồng nhau nếu vẫn có thể lấy trước giao. Thời lượng phục vụ từng stop độc lập.

## Điều phối và optimizer

- `GET /orders/available-for-dispatch?branchId=...` chỉ trả đơn B2B đã xác nhận, số đo/khung giờ đầy đủ và trong quyền.
- `GET /orders/:id` trả dòng và từng kiện. `POST /orders`, `PATCH /orders/:id`, `POST /orders/:id/confirm` dùng `Idempotency-Key`; sửa/xác nhận có `version`. Key cũ với payload khác hoặc version cũ trả 409.
- `packagesToCargoUnits` đổi mm ÷ 10 → cm, gram ÷ 1000 → kg cho Python; `CargoItem.id = Package.id`, `order_id = Order.id`, không sinh ID ảo theo quantity. `can_rotate=false`; không thêm quyền xoay/xếp chồng.
- Payload dùng `package_contract_version="1"`. Time window đổi thành giây từ `planningEpochIso` (UTC); đầu làm tròn lên, cuối làm tròn xuống nếu có millisecond, không mở rộng cửa sổ. `pickup_service_time_sec` và `delivery_service_time_sec` riêng.
- Snapshot và kết quả trả `items_loaded/items_unloaded`, placement `item_id` bằng UUID Package thật. Backend kiểm tra ID/stop/version rồi tạo một Allocation quantity=1 và hai StopTask mỗi kiện. Không tạo lại Package trong thao tác apply.
- `POST /trips/automatic-optimization` nhận branch + idempotencyKey, trả job. Poll `GET /trips/automatic-optimization/jobs/:id`, chọn phương án; `POST /trips/automatic-optimization/jobs/:id/apply` với `{ "candidateNumber": 1 }`. Apply dùng proposal đã ký lưu server và kiểm tra tài nguyên hiện tại trong transaction; không tự publish.
- `PATCH /trips/:id/publish` cần `{ "expectedVersion": n }`, quyền publish, planning snapshot và load plan hợp lệ. Mỗi LoadPlanStep bao phủ mọi task tại stop, placement tham chiếu kiện thật. Gateway phát thông báo để client tải snapshot được phân quyền.

## Ví dụ minh họa (không phải dữ liệu thật)

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "orderItemId": "22222222-2222-4222-8222-222222222222",
  "packageCode": "EXAMPLE-PACKAGE",
  "lengthMm": 401,
  "widthMm": 302,
  "heightMm": 203,
  "weightG": "10001",
  "pickupStopId": "33333333-3333-4333-8333-333333333333",
  "deliveryStopId": "44444444-4444-4444-8444-444444444444"
}
```

Kiện ví dụ sang Python thành 40.1 × 30.2 × 20.3 cm, 10.001 kg, cùng ID. N kiện tạo N CargoItem; tổng 4 kiện 10.001 + 20.002 + 30.003 + 40.004 = 100.010 kg. Snapshot xếp hàng giữ độ chính xác gram, tránh sai số số thực làm thay đổi chữ ký khi lưu JSONB.

Người 1 tiếp tục sở hữu solver và validator hình học. Các sửa sau merge chỉ bảo đảm mapping kiện, service window, khóa/apply và tương thích contract; không tuyên bố toàn bộ validator xếp/dỡ đã nghiệm thu.

## Bổ sung merge chia đơn ngày 07/10/2026

- Giữ chính sách chia đơn trong `KE_HOACH_TMS.md`: chia tập Package, không chia một kiện, áp dụng đủ mọi kiện hoặc rollback toàn bộ. Chỉ dùng các Package B2B đã đối soát; không suy diễn kiện từ quantity hoặc PackageItem bán lẻ.
- Mỗi phần gửi solver có ID dạng `<Order.id>::split:<n>`, `source_order_id` giữ Order gốc; mỗi điểm ảo giữ `source_location_id` bằng OrderStop thật. Khung giờ, timezone và thời lượng lấy/giao được giữ nguyên trên từng phần.
- Kết quả stop có `order_id` là Order thật, `order_stop_id` là OrderStop thật, `allocation_id` là ID phần hàng trong solver. **`allocation_id` này không phải khóa của bảng Allocation.** `location_id` có thể là ID điểm ảo của phần hàng. ID trong `items_loaded`, `items_unloaded` và placement vẫn là UUID Package thật, không thêm tiền tố `package:` hay hậu tố theo quantity.
- Backend kiểm tra tập kiện toàn Order, tập lấy/giao mỗi phần, trùng kiện giữa các tuyến, thời gian và version. Trong cùng transaction: mỗi Trip nhận đúng Allocation/StopTask của tập kiện riêng; LoadPlanStep liên kết tất cả task của điểm phục vụ tương ứng; chỉ sau khi mọi chuyến đã lưu thành công mới chuyển trạng thái các kiện và Order.
- Không có thay đổi schema/migration trong đợt merge chia đơn này. Vẫn cần hoàn tất nâng cấp database theo `MERGE_RECOVERY.md` nếu database chung chưa theo schema hợp nhất.
- Đã kiểm chứng HTTP → queue → FastAPI/OR-Tools → PostgreSQL với đơn nhiều khối lượng kiện khác nhau, cả nguyên đơn và chia hai xe; test PostgreSQL riêng kiểm tra tranh chấp apply và rollback khi snapshot của chuyến thứ hai không khớp kiện.

- Khi sửa kế hoạch một chuyến đã chia, backend chỉ đưa tập kiện của chuyến đó vào kiểm tra tải và LoadPlan; không thay đổi quantity của dòng hàng gốc. Placement tham chiếu kiện của chuyến khác bị từ chối và rollback. Đã kiểm tra sửa kế hoạch rồi phát hành cả hai chuyến trên PostgreSQL riêng.
