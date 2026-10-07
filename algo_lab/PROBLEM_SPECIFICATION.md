# ĐẶC TẢ BÀI TOÁN TỐI ƯU HÓA ĐỘI XE & TUYẾN ĐƯỜNG (TMS OPTIMIZATION LAB)

Tài liệu này tổng hợp toàn bộ các thông tin, tham số đầu vào, ràng buộc kỹ thuật - nghiệp vụ và hàm mục tiêu cần tối ưu hóa cho hệ thống Quản lý Vận tải (TMS), đồng thời ghi nhận các quy tắc nghiệp vụ đã chốt.

---

## 1. GIẢI MÃ NGUYÊN NHÂN: TẠI SAO CHI PHÍ LÚC 7 TRIỆU, LÚC LẠI NHẢY LÊN?

1. **OR-Tools đưa ra phương án 1 xe (khoảng 5.5 - 7 triệu đồng):**
   - OR-Tools chỉ tối ưu theo tổng tải trọng (kg). Khi không có kiểm tra kích thước 2D, solver nhét toàn bộ đơn hàng vào 1 xe duy nhất.
   - Khi đó, quãng đường chạy chỉ khoảng 500 - 600 km, tiền xăng và công tài xế tính ra chỉ khoảng 5.5 – 7 triệu VNĐ.
2. **Thực tế ngoài đời bị lỗi xếp dỡ:**
   - 1 xe không thể chứa hết hàng phẳng trên sàn, và các kiện dỡ sau chắn kín lối ra cửa xe.
   - Khi có bộ lọc kiểm tra xếp dỡ (`SpatialValidator`), hệ thống phát hiện không khả thi nên buộc phải loại đơn hoặc điều động thêm xe (14 - 15 xe), làm tổng chi phí thực tế nhảy lên 11.5 - 12.3 triệu VNĐ.

---

## 2. THÔNG TIN ĐẦU VÀO VÀ CÁC QUY TẮC NGHIỆP VỤ ĐÃ CHỐT

### 2.1. Đội xe (Fleet Vehicles)
- Kích thước lòng thùng: Dài ($L$), Rộng ($W$), Cao ($H$).
- Tải trọng tối đa: $Q$ kg.
- Điểm xuất phát và kết thúc: Depot.
- Tiêu hao nhiên liệu cơ bản (lít/100km) và phụ phí tải trọng nặng.
- Chi phí cố định mở xe lăn bánh (VNĐ/chuyến).

### 2.2. Tài xế (Drivers)
- Bằng lái xe tương ứng.
- Lương phân bổ theo phút làm việc.
- Phụ cấp theo km và phụ cấp chuyến.

### 2.3. Đơn hàng & Kiện hàng (Orders & Cargo Items)
- Cặp điểm Lấy (Pickup) và Giao (Delivery) kèm khung giờ và thời gian bốc/dỡ.
- Kích thước kiện hàng: Dài $\times$ Rộng $\times$ Cao, Khối lượng (kg).
- **QUY TẮC XOAY KIỆN HÀNG (ĐÃ CHỐT THEO YÊU CẦU NGƯỜI DÙNG):**
  > **Tất cả các kiện hàng đều được phép xoay 90 độ** (hoán đổi chiều Dài và chiều Rộng trên mặt phẳng sàn xe: $L \leftrightarrow W$) để tối ưu diện tích sàn và giữ thông lối ra cửa xe.

---

## 3. RÀNG BUỘC CẦN THỎA MÃN
1. **Pickup before Delivery:** Lấy hàng trước khi giao hàng trên cùng một xe.
2. **Tải trọng xe:** Không vượt quá tải trọng tại mọi thời điểm.
3. **Xếp dỡ 2D không chồng (Non-stackable):** Các kiện hàng đặt phẳng trên mặt sàn xe, không đè lên nhau.
4. **Lối ra cửa xe (LIFO Door Clearance):** Tại thời điểm dỡ hàng, kiện hàng cần dỡ phải có lối đi thông thoáng thẳng ra cửa đuôi xe, không bị hàng của đơn khác chắn đường.
5. **Cho phép xoay 90 độ:** Tận dụng tối đa mọi góc đặt hàng.

---

## 4. HÀM MỤC TIÊU CẦN TỐI ƯU
$$\min \quad \text{Tổng chi phí} = \text{Xăng} + \text{Khấu hao xe} + \text{Lương tài xế} + \text{Giữ hàng} + \text{Phạt trễ} + \text{Phạt bỏ đơn}$$
