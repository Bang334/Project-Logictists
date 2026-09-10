# Logistics / TMS Domain

Ngôn ngữ chung cho hệ thống quản lý vận tải tập trung. Các thuật ngữ dưới đây phân biệt yêu cầu thương mại, vật thể hàng hóa, kế hoạch vận tải và dữ liệu thực tế.

## Đơn hàng và hàng hóa

**Order**:
Yêu cầu vận chuyển của Customer, có các điểm lấy/giao và các dòng hàng thương mại.
_Avoid_: Shipment, Trip

**Order Item**:
Dòng mô tả một loại hàng trong Order; không đại diện cho một kiện vật lý riêng lẻ.
_Avoid_: Package

**Package**:
Kiện hàng vật lý có định danh, kích thước, khối lượng và trạng thái riêng để theo dõi xếp, dỡ và giao nhận.
_Avoid_: Order Item, cargo unit ảo

**Allocation**:
Việc phân một Package hoặc phần hàng tương thích cũ vào một Trip trên một chặng xác định.
_Avoid_: Driver Assignment

## Kế hoạch và thực thi vận tải

**Trip**:
Chuyến vận tải có vòng đời thực tế riêng; một Trip có thể có nhiều phiên bản Trip Plan nhưng chỉ một bản đang hiệu lực.
_Avoid_: Order, Journey

**Trip Plan**:
Một phiên bản bất biến của phương án chạy Trip, gồm xe, thời gian, thứ tự điểm dừng và thao tác dự kiến.
_Avoid_: Trip, route hiện tại có thể ghi đè

**Stop Task**:
Thao tác nghiệp vụ lấy hoặc giao Package tại một điểm dừng ổn định của Trip.
_Avoid_: Trip Stop

**Resource Reservation**:
Khoảng thời gian giữ xe hoặc tài xế cho một Trip Plan đã được chuẩn bị hoặc phát hành.
_Avoid_: trạng thái AVAILABLE đơn lẻ

**Load Plan**:
Phương án bố trí và chuỗi xếp/dỡ Package trên xe, được kiểm chứng độc lập theo từng bước.
_Avoid_: tổng thể tích trống

**Execution Event**:
Sự kiện thực tế bất biến do người dùng hoặc thiết bị ghi nhận trong quá trình thực hiện Trip.
_Avoid_: sửa dữ liệu planned thành actual

## Tài chính và vận hành nội bộ

**Cost Entry**:
Khoản chi phí vận tải dự toán hoặc thực tế có tiền tệ, căn cứ và trạng thái phê duyệt.
_Avoid_: Solver penalty, Invoice

**Invoice**:
Yêu cầu thanh toán gửi cho Customer cho các khoản cước của Order.
_Avoid_: Payment, Cost Entry

**Payment**:
Giao dịch thu hoặc chi đã được ghi nhận với đối tác; không phải sổ cái kế toán đầy đủ.
_Avoid_: Invoice

**Payroll Run**:
Lần tính và phê duyệt khoản phải trả cho nhân viên trong một Payroll Period theo dữ liệu vận hành và chính sách có phiên bản.
_Avoid_: trường lương hiện tại trên Driver

**Maintenance Work Order**:
Công việc bảo dưỡng hoặc sửa chữa cụ thể của một xe, có lịch, trạng thái, chi phí và kết quả thực hiện.
_Avoid_: Vehicle Unavailability
