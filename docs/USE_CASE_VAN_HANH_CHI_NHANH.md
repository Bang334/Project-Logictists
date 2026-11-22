# Use case vận hành chi nhánh TMS

Ngày cập nhật 19/11/2026. Tài liệu mô tả bốn vai trò vận hành theo nghiệp vụ đã trao đổi. Các bước ghi **đề xuất** hoặc **cần chốt** là nội dung để duyệt. Nguồn quy tắc là [kế hoạch TMS](../KE_HOACH_TMS.md), đặc biệt hai mục về đặt, sửa, hủy đơn và lịch ca tuần.

## 1. Vai trò và các mốc vận hành

Mỗi chi nhánh tương ứng với một thành phố trên bản đồ Việt Nam. Trưởng chi nhánh và Trưởng điều phối là cùng một vai trò. Bốn vai trò làm việc trong phạm vi chi nhánh của mình. Khách hàng, tài xế và hệ thống xuất hiện ở các bước liên quan đến nhân viên.

| Vai trò | Công việc chính | Đầu ra bàn giao |
|---|---|---|
| Trưởng chi nhánh | Lập, chốt và duyệt lịch chuyến thường ngày mai. Xử lý thay đổi kế hoạch khi chuyến đang chạy. | Phiên bản kế hoạch đã duyệt để Điều phối vận tải phát hành. |
| Quản lý tài nguyên | Xếp ca tuần, nhóm chạy thường/trực hỏa tốc. Theo dõi tình trạng xe và tài xế. | Lịch khả dụng theo ngày và tình trạng các cặp tài xế–xe. |
| Điều phối vận tải | Phát hành kế hoạch đã duyệt, theo dõi thực hiện và kiểm tra khả năng phục vụ hỏa tốc. | Lịch đã phát hành, thông tin chuyến và sự cố cho bên liên quan. |
| Xử lý đơn | Tiếp nhận, rà soát đơn và khung giờ. Điểm tiếp nhận của tổng đài, quyền hủy và trách nhiệm liên hệ được mô tả dưới dạng đề xuất ở các use case tương ứng. | Đơn đủ dữ liệu để xếp chuyến hoặc yêu cầu cần phối hợp xử lý. |

| Mốc theo giờ Việt Nam | Sự kiện |
|---|---|
| 07:30 | Bắt đầu ca tài xế. Hệ thống gửi lịch chuyến thường đã phát hành. Nhóm hỏa tốc vào ca trực. |
| Sau 16:00 | Hệ thống ngừng nhận đơn hỏa tốc mới. |
| Trước 17:00 | Đơn thường đặt trong ngày và hẹn lấy ngày mai đủ điều kiện về mốc đặt để vào danh sách xếp chuyến ngày mai. |
| 17:00 | Kết thúc ca tài xế và tập kết xe về kho chi nhánh theo quy tắc vận hành đã chốt. |
| Sau 17:00 | Trưởng chi nhánh bắt đầu lập và chốt lịch ngày mai. Điều phối vận tải phát hành bản đã duyệt trong ngày trước ngày chạy để hệ thống gửi lúc 07:30. Giờ phát hành cụ thể trong buổi tối còn cần xác định. |

## 2. Trưởng chi nhánh

### CN-01 — Lập lịch chuyến thường ngày mai

- **Kích hoạt và điều kiện.** Sau 17:00, Trưởng chi nhánh mở danh sách xếp chuyến ngày mai. Đầu vào gồm các đơn đủ điều kiện, lịch ca do Quản lý tài nguyên lập, tình trạng xe và phần việc ngày mai của các chuyến nhiều ngày đang tiếp diễn.
- **Luồng chính.** Kiểm tra địa chỉ, khung lấy/giao, số kiện, loại hàng, kích thước và khối lượng. Chọn cặp tài xế–xe khả dụng thuộc nhóm chạy thường. Lập phương án thủ công hoặc dùng bộ tối ưu để đề xuất tuyến. Kiểm tra thứ tự lấy trước giao, tải từng chặng, xếp/dỡ không chồng và không cản cửa, lịch ca và thời gian di chuyển. Ghi nhận hàng qua đêm đang ở kho hay trên xe. Với hàng đông lạnh, dùng xe phù hợp và áp dụng quy tắc phân loại kiện đã chốt.
- **Ngoại lệ.** Đơn đến trước 17:00 vẫn có thể thiếu dữ liệu hoặc chưa có phương án khả thi. Giữ đơn trong danh sách cần xử lý, ghi lý do có căn cứ và chuyển Xử lý đơn phối hợp khi liên quan cam kết với khách. Nếu phương án phải chia kiện qua nhiều xe, kiểm tra đủ toàn bộ kiện trước khi phát hành.
- **Kết quả.** Có bản kế hoạch ngày mai để duyệt và danh sách đơn chưa xếp được.

### CN-02 — Chốt và duyệt phiên bản kế hoạch

- **Điều kiện.** Kế hoạch có phiên bản cụ thể và có tài nguyên được phân cho từng chuyến.
- **Luồng chính.** Rà soát chuyến, cặp tài xế–xe, danh sách kiện và khung giờ. Duyệt phiên bản hợp lệ trong phạm vi chi nhánh. Điều phối vận tải nhận bản đã duyệt để phát hành.
- **Ngoại lệ.** Nếu sửa kế hoạch, hệ thống tạo phiên bản mới và yêu cầu duyệt lại. Nếu xe, tài xế hoặc lịch đã thay đổi, cập nhật phương án hoặc giữ chuyến ở trạng thái cần xử lý.
- **Kết quả.** Phiên bản được duyệt có thể phát hành. Khi đơn nằm trong kế hoạch đã duyệt hoặc chuyến đã phát hành, khách bị khóa chỉnh sửa thông tin đơn.

### CN-03 — Duyệt thay đổi chuyến đang thực hiện

- **Kích hoạt.** Điều phối báo xe hỏng, tài xế nghỉ, điểm giao thất bại hoặc phát sinh cần đổi kế hoạch.
- **Luồng chính.** Xem phần đã thực hiện, vị trí xe và hàng, cam kết còn lại. Chọn phương án cho phần việc chưa thực hiện và kiểm tra lại tài nguyên. Nếu có đổi xe khi đã lấy hàng, giữ lịch sử và ghi bàn giao vật lý. Duyệt bản cập nhật để Điều phối vận tải phát hành và thông báo đúng người.
- **Ngoại lệ.** Đơn hỏa tốc đã lấy nhưng tài xế không giao kịp được đưa về kho để Trưởng chi nhánh xếp ngày giao lại. Phương án giao lại khác với phương án trả hàng do khách yêu cầu hủy.
- **Kết quả.** Có phương án cập nhật truy vết được và biết phần hàng đang ở đâu. Cơ chế cấp xe thay thế và quyền điều động giữa hai nhóm trong ngày còn cần chốt.

## 3. Nhân viên Quản lý tài nguyên

### TN-01 — Xếp ca tuần cho tài xế

- **Điều kiện.** Có danh sách tài xế, xe công ty do từng người phụ trách, lịch nghỉ và tình trạng xe của chi nhánh.
- **Luồng chính.** Xếp ngày đi làm/nghỉ, ca chuẩn 07:30–17:00 và nhóm chạy thường hoặc trực hỏa tốc cho từng ngày. Ví dụ, một ngày có 10 người thì có thể bố trí 7 chạy thường và 3 trực hỏa tốc. Kiểm tra trùng ca, thời gian nghỉ, khả dụng của xe và các phân công đang có. Công bố lịch ca để Trưởng chi nhánh dùng khi xếp chuyến.
- **Ngoại lệ.** Khi một ca xung đột với chuyến đã phát hành, ghi nhận ảnh hưởng và chuyển Điều phối vận tải phối hợp với Trưởng chi nhánh xử lý chuyến.
- **Kết quả.** Có lịch khả dụng từng ngày. Chuyến cụ thể được lập theo CN-01.

### TN-02 — Theo dõi xe cố định, bảo dưỡng và thay đổi khả dụng

- **Kích hoạt.** Tài xế báo xe hỏng, cần bảo dưỡng hoặc phát sinh nghỉ; Quản lý tài nguyên rà soát trước khi lập ca.
- **Luồng chính.** Đối chiếu cặp tài xế–xe cố định, ghi tình trạng và thời gian không khả dụng, xác định các ca/chuyến bị ảnh hưởng. Chuyển thông tin cho Điều phối vận tải và Trưởng chi nhánh nếu đụng lịch đã chốt hoặc hàng đã lên xe.
- **Ngoại lệ.** Nếu xe đang chở hàng, bàn giao theo phương án vận hành có truy vết. Chính sách ai được phê duyệt xe thay thế và thay ca trong ngày còn cần chốt.
- **Kết quả.** Dữ liệu khả dụng mới được phản ánh vào lịch và lần kiểm tra trước khi phát hành.

## 4. Nhân viên Điều phối vận tải

### DP-01 — Phát hành lịch chuyến thường

- **Điều kiện.** Trưởng chi nhánh đã duyệt đúng phiên bản và nhân viên có quyền phát hành trong chi nhánh.
- **Luồng chính.** Kiểm tra lại phiên bản, tài xế, xe, lịch giữ tài nguyên, tải và phương án xếp/dỡ theo tình trạng mới nhất. Phát hành bản hợp lệ. Hệ thống gửi lịch lúc 07:30, app hiển thị lịch của từng tài xế trong mục Hôm nay. Chuyến nhiều ngày hiển thị phần việc của ngày đó.
- **Ngoại lệ.** Chặn phát hành nếu phiên bản hết hiệu lực, tài nguyên không còn khả dụng hoặc lịch bị trùng. Chuyển lại Trưởng chi nhánh xử lý. Nếu tài xế mất mạng lúc gửi, app tải lịch khi kết nối lại. Việc phải bấm xác nhận hay chỉ ghi nhận đã xem còn cần chốt.
- **Kết quả.** Có bản lịch đang hiệu lực để tài xế thực hiện, kèm lịch sử phiên bản.

### DP-02 — Điều phối đơn hỏa tốc

- **Kích hoạt.** Khách tạo đơn hỏa tốc trong giờ nhận. Khách không chọn giờ gửi hoặc nhận.
- **Luồng chính.** Kiểm tra khả năng lấy và giao trong ngày trước 17:00, ưu tiên cặp xe–tài xế trực đủ điều kiện và có thể xuất phát ngay để lấy hàng khi đơn được xác nhận thực hiện. Hệ thống giữ cả hai tài nguyên trong 15 phút. Khách có 10 phút từ lúc đặt để thanh toán. Khi tài xế nhận thông báo, hệ thống tính 30 giây phản hồi từ thời điểm nhận.
- **Ngoại lệ.** Sau 16:00, hệ thống từ chối đơn hỏa tốc mới. Chưa thanh toán khi hết 10 phút thì hệ thống tự hủy đơn và giải phóng cả tài xế lẫn xe ngay. Tài xế bắt đầu với 10 điểm và bị trừ khi chủ động từ chối. Mức trừ, cách xử lý hết 30 giây hoặc từ chối, và thời điểm phát thông báo trong quan hệ với xác nhận thanh toán còn cần chốt.
- **Kết quả.** Hệ thống ghi tình trạng giữ tài nguyên, thanh toán, phản hồi và phân công theo đúng mốc. Điều phối theo dõi các trường hợp cần xử lý.

### DP-03 — Theo dõi chuyến, giao thất bại và hàng quay về kho

- **Điều kiện.** Chuyến đã phát hành hoặc có yêu cầu hủy, giao lại hay trả hàng ảnh hưởng đến vận chuyển.
- **Luồng chính.** Theo dõi lấy/giao, vị trí, giao thiếu và sự cố. Xác định phần hàng đang ở xe hay kho. Nếu cần thay tuyến hoặc đổi lịch, chuyển Trưởng chi nhánh duyệt phương án rồi phát hành bản cập nhật. Với yêu cầu hủy sau lấy đã được xử lý hợp lệ, điều phối tài xế đưa hàng về kho, ghi nhận bàn giao và chuyển thông tin cho Xử lý đơn.
- **Ngoại lệ.** Hỏa tốc đã lấy nhưng lần giao đầu thất bại có thể được thử lại trong ngày theo quy tắc đã chốt. Nếu người nhận không nhận đến hết giờ và đơn bị hủy, ghi nguyên nhân để áp dụng phí phát sinh cho người gửi theo chính sách. Nếu tài xế không giao kịp, đưa hàng về kho để Trưởng chi nhánh xếp giao lại.
- **Kết quả.** Có trạng thái từng phần hàng, lý do và bằng chứng. Hoàn tất chuyến vẫn phải đối chiếu kết quả của từng đơn.

## 5. Nhân viên Xử lý đơn

### XD-01 — Tiếp nhận đơn và kiểm tra lịch hẹn

- **Kích hoạt.** Có đơn khách gửi hoặc yêu cầu cần rà soát. Việc phân công cho nhân viên phụ trách đơn là mô tả nghiệp vụ, quyền thao tác cụ thể cần được xác nhận khi triển khai.
- **Luồng chính.** Kiểm tra thông tin người gửi/nhận, điểm lấy/giao, dữ liệu từng kiện, yêu cầu bảo quản và khung giờ. Với đơn thường đặt trước 17:00 và hẹn lấy ngày mai, đưa hồ sơ đủ dữ liệu vào danh sách Trưởng chi nhánh dùng sau 17:00. Với đơn hỏa tốc, hệ thống áp dụng mốc ngừng nhận đơn 16:00. Điều phối vận tải kiểm tra khả năng bố trí xe và tài xế theo DP-02.
- **Ngoại lệ.** Báo thiếu dữ liệu, khung giờ chưa bố trí được hoặc đơn chưa xếp được để khách biết và xử lý lịch hẹn. Mốc đặt trước 17:00 xác định danh sách xếp chuyến. Việc xác nhận được phục vụ phụ thuộc phương án khả thi. Cách hẹn đơn thường đặt từ 17:00 trở đi còn cần chốt nếu khách muốn lấy ngày mai.
- **Kết quả.** Hồ sơ đủ dữ liệu để lập kế hoạch hoặc có lý do đang chờ xử lý.

### XD-02 — Tiếp nhận đổi giờ gửi hoặc hủy trước khi lấy hàng

- **Điều kiện.** Xác định đúng đơn, người có quyền yêu cầu, thời điểm đặt, tình trạng lấy hàng và trạng thái kế hoạch/chuyến mới nhất.
- **Luồng chính.** Khách được sửa giờ gửi đơn thường khi đơn chưa nằm trong kế hoạch đã duyệt và chưa thuộc chuyến đã phát hành. Khách được tự hủy đơn thường trong vòng 24 giờ từ lúc đặt nếu tài xế chưa lấy hàng. Nếu đơn đã bị khóa sửa, hướng khách dùng luồng hủy phù hợp rồi đặt lại. Nếu việc hủy ảnh hưởng chuyến đã xếp, chuyển Điều phối vận tải kiểm tra ảnh hưởng; cách cập nhật chuyến phải giữ quy trình duyệt/phát hành.
- **Ngoại lệ.** Nếu đã lấy hàng ngay trong ngày đặt, hướng khách gọi tổng đài. Kênh tiếp nhận khi đã quá 24 giờ mà chưa lấy, điều kiện khách chủ động hủy hỏa tốc và thẩm quyền duyệt ngoại lệ còn cần chốt.
- **Kết quả.** Đơn được cập nhật theo trạng thái thực tế hoặc yêu cầu được chuyển đúng luồng, có lịch sử tra cứu.

### XD-03 — Tiếp nhận hủy sau lấy và theo dõi trả hàng

- **Kích hoạt.** Khách yêu cầu hủy khi hàng đã được lấy. Với đơn thường lấy ngay trong ngày đặt, khách gọi tổng đài.
- **Luồng đề xuất.** Xử lý đơn ghi yêu cầu tổng đài, kiểm tra hàng đang ở đâu và chuyển Điều phối vận tải tổ chức đưa về kho sau khi yêu cầu hủy được chấp thuận theo thẩm quyền. Khi kho nhận hàng, thông báo cho khách lựa chọn đến kho nhận hoặc giao trả tận nhà có phí dịch vụ. Theo dõi tới khi có kết quả bàn giao.
- **Ngoại lệ.** Nếu mới ghi nhận yêu cầu hoặc hàng còn trên xe, phản ánh đúng tình trạng. Cần chốt thẩm quyền chấp thuận, kênh hủy nếu lấy khác ngày đặt, biểu phí giao trả và chính sách hoàn tiền.
- **Kết quả.** Truy vết được yêu cầu hủy, vị trí hàng và phương thức giao trả khách chọn.

## 6. Có nên gộp Điều phối vận tải và Xử lý đơn?

**Đề xuất gộp cho MVP thành vai trò Nhân viên vận hành.** Cùng một nhân viên có thể kiểm tra thông tin đơn, phối hợp giờ lấy, theo dõi chuyến và xử lý yêu cầu khách. Ví dụ, khách gọi hủy sau khi đã lấy hàng, nhân viên tra được ngay xe đang chở và theo dõi việc đưa hàng về kho. Hai khu vực công việc **Đơn hàng** và **Chuyến vận tải** vẫn cần hiển thị rõ việc nào đang chờ xử lý.

| Nhóm nghiệp vụ | Nếu gộp vai trò |
|---|---|
| Tiếp nhận đơn và lịch hẹn | Nhân viên vận hành xử lý hồ sơ, theo dõi tình trạng và tiếp nhận yêu cầu theo quyền được giao. |
| Phát hành và theo dõi chuyến | Nhân viên vận hành phát hành đúng bản đã được Trưởng chi nhánh duyệt, theo dõi chuyến và phối hợp ngoại lệ. |
| Lập và duyệt kế hoạch ngày mai | Trưởng chi nhánh lập, chốt và duyệt. Sửa nội dung kế hoạch làm phát sinh phiên bản cần duyệt lại. |
| Xếp ca tuần và quản lý khả dụng | Quản lý tài nguyên phụ trách. |
| Hủy sau lấy, hoàn tiền, phí dịch vụ | Vai trò gộp tiếp nhận và phối hợp xử lý. Quyền phê duyệt và chính sách tiền cần được xác nhận riêng. |

- **Lợi ích.** Giảm số lần bàn giao khi tình trạng đơn và chuyến thay đổi cùng lúc. Phù hợp khi một nhóm nhỏ phục vụ chung một chi nhánh.
- **Hạn chế.** Công việc chăm sóc đơn có thể gián đoạn theo dõi chuyến, nhất là lúc nhiều sự cố hoặc nhiều yêu cầu hỏa tốc đồng thời. Có thể phân người trực theo hai hàng công việc trong cùng vai trò. Khi cần tách người theo nhiệm vụ thường xuyên, tách quyền nghiệp vụ theo nhóm.
- **Điều kiện phân quyền.** Khi gộp, dùng tài khoản cá nhân và quyền theo chi nhánh. Quyền xử lý đơn, phát hành chuyến và quyền duyệt kế hoạch được kiểm tra theo thao tác. Ghi người thực hiện các quyết định có ảnh hưởng đến đơn, chuyến hoặc tài nguyên. Ma trận quyền hiện hành có bốn vai trò; phương án ba vai trò ở đây đang chờ quyết định.

## 7. Kịch bản đối chiếu nghiệp vụ

| Kịch bản | Kết quả mong đợi |
|---|---|
| 16:20 có một đơn thường hẹn lấy ngày mai và một yêu cầu hỏa tốc mới | Đơn thường đủ điều kiện về mốc đặt để vào danh sách xếp ngày mai; từ chối tạo đơn hỏa tốc mới. |
| Quản lý tài nguyên xếp tuần theo nhóm mẫu 7/3 | Trưởng chi nhánh dùng lịch ca và xe khả dụng để xếp chuyến sau 17:00; lúc 07:30 hệ thống gửi lịch đúng tài xế và nhóm trực thấy trạng thái trực. |
| Xe hỏng sau khi kế hoạch được duyệt | Phát hành bị chặn nếu phương án hết hiệu lực. Bản điều chỉnh phải được duyệt trước khi phát hành. |
| Hỏa tốc chưa được thanh toán khi đủ 10 phút | Hệ thống tự hủy, nhả cả xe và tài xế ngay, dù thời lượng giữ là 15 phút. |
| Khách muốn sửa đơn đã duyệt hoặc hủy đơn thường đã lấy trong ngày đặt | Khóa sửa sau duyệt; hướng hủy theo điều kiện thực tế. Nếu đã lấy trong ngày đặt, khách gọi tổng đài. Khi hủy được chấp thuận, theo dõi hàng về kho và lần giao trả. |
