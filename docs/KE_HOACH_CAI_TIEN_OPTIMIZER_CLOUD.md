# Kế hoạch cải tiến optimizer trên dữ liệu điều phối cloud

**Đề xuất ngày 22/11/2026.** Giữ bản trước hai thay đổi tối ưu thứ tự ghé điểm làm đối chứng. Chỉ đề nghị chọn biến thể mới khi chứng minh được lợi ích trên cả job đầy đủ và nghiệm đã kiểm chứng. Ưu tiên đầu tiên là xác định nơi hai bản bắt đầu cho kết quả khác nhau.

## 1. Mốc xuất phát

Hai snapshot thành công ngày 21/11/2026 dùng cùng cấu hình 5 seed, search_time_seconds 48, max_time_seconds 180 và early_stop_patience 30. Bảng ghi phương án hạng 1. Điểm điều phối càng thấp càng tốt khi các tiêu chí ưu tiên cao hơn bằng nhau.

| Snapshot | Nguồn kết quả | Chuyến | Km | Chi phí vận hành (đ) | Điểm điều phối |
|---|---|---:|---:|---:|---:|
| Nha Trang · 100 đơn, 452 kiện | Đã lưu trên cloud | 12 | 2.180,05 | 21.211.632 | 24.133.660 |
| | Chạy lại bản trước | 12 | 2.247,08 | 21.674.557 | 24.515.197 |
| | Chạy lại bản mới | 12 | 2.249,57 | 21.705.714 | 24.530.597 |
| Đà Nẵng · 150 đơn, 1.290 kiện | Đã lưu trên cloud | 39 | 11.116,99 | 67.539.664 | 80.099.726 |
| | Chạy lại bản trước | 33 | 10.074,67 | 60.517.551 | 74.503.456 |
| | Chạy lại bản mới | 33 | 10.109,20 | 60.676.493 | 74.635.316 |

Cả bốn lượt chạy lại giao đủ, kiểm tra xếp/dỡ đạt và số chuyến tăng thêm do tách đơn bằng 0. Nha Trang ghi nhận 7 kết quả chạy ở bản trước và 6 ở bản mới dù cùng cấu hình 5 seed. Cần truy vết nguồn từng ứng viên và thời điểm nhận kết quả. Một lượt mỗi bản chưa đủ để quy phần tăng chi phí cho thuật toán mới. Điểm đã lưu là mốc lịch sử, cần kiểm tra lại bằng cùng bộ tính điểm trước khi dùng để nghiệm thu.

## 2. Thử nghiệm theo thứ tự

| Bước | Việc thực hiện | Bằng chứng và quyết định |
|---|---|---|
| 1. Đo độ dao động | Cố định phiên bản mã, dependency, hash payload, policy, seed, số worker và máy. Chạy nối tiếp ít nhất 5 cặp cho mỗi thành phố, luân phiên thứ tự trước–sau. Một cặp là hai job đầy đủ. Lưu số liệu tổng hợp cùng trạng thái hết giờ của từng worker. | Bảng từng cặp, số thắng/hòa/thua, trung vị, lượt tệ nhất và thời gian thực. Nếu chiều thay đổi không ổn định, tăng số cặp trước khi quyết định. |
| 2. Tìm nơi mất nghiệm tốt | Với cùng một kế hoạch khả thi đầu vào, chạy riêng bước cải thiện tuyến. Ghi điểm lúc có nghiệm đầy đủ đầu tiên, trước/sau đổi thứ tự, sau kiểm tra xếp/dỡ, khi worker trả kết quả và khi chọn hạng 1. Ghi cả thành phần ưu tiên, chữ ký tuyến và nguyên nhân loại. | Nếu cùng đầu vào mà đầu ra tệ hơn, sửa chỗ so điểm hoặc giữ nghiệm. Nếu bước cải thiện giữ được điểm nhưng job đầy đủ thua, kiểm tra chi phí thời gian, seed hết hạn và cách tập hợp ứng viên. Nếu hai bản khác nhau từ nghiệm đầu, điều tra phần dựng nghiệm trước. |
| 3. Thử hai thay đổi riêng | So bốn biến thể trên cùng đầu vào: bản đối chứng, chỉ thêm tìm thứ tự trong đoạn, chỉ đổi cách chia thời gian sinh ứng viên, và bật cả hai. Các điều kiện bảo toàn kiện, lịch và kiểm tra xếp/dỡ áp dụng cho mọi bản. | Chỉ giữ thành phần mang lại lợi ích lặp lại. Khi bước tìm trong đoạn thường hết giờ hoặc đề xuất bị loại nhiều, thử giới hạn công sức theo thời gian còn lại và tỷ lệ ứng viên qua kiểm tra. Dùng chung quy tắc cho mọi chi nhánh. |
| 4. Sửa và đo destroy–repair | Sửa riêng lỗi string destroy lặp ID khi số đơn muốn gỡ vượt số đơn khác nhau trên tuyến. Kiểm tra tuyến rỗng, tuyến 1–2 đơn, đoạn vòng qua cuối tuyến và nhiều tuyến. Đo số đơn thực gỡ, thời gian chèn lại, tỷ lệ giao đủ và số lần cải thiện nghiệm sau kiểm tra theo từng cặp destroy–repair. | Với tuyến A–B và yêu cầu gỡ 4, danh sách trả về có đúng 2 ID khác nhau, mỗi ID mất cả pickup và delivery trên tuyến và chỉ vào hàng chờ sửa một lần. Chỉ thử đổi trọng số hoặc thêm toán tử khi số liệu chỉ ra cặp đang tiêu tốn thời gian hoặc thường xuyên bỏ sót cơ hội. |
| 5. Kiểm tra khả năng áp dụng rộng | Chạy lại ca 4–7 đơn có nghiệm độc lập, ca Nha Trang 2 đơn có xung đột giữa chi phí và điểm điều phối, T21–T27, trường hợp nhiều chuyến chung xe/ngày và các snapshot nhiều xe. Giữ riêng ít nhất một snapshot khác ngày để kiểm tra sau khi chọn biến thể. | Báo riêng từng quy mô. Nếu chưa có snapshot độc lập, ghi rõ giới hạn về khả năng khái quát. |

Khi so sánh biến thể, chấm tất cả ứng viên bằng đúng bộ xếp hạng dùng ở đường chạy thực tế, kể cả chính sách so sánh lịch nhiều ngày. Ghi ngày hoàn tất, số chuyến, số lần tách đơn, điểm điều phối, chi phí và km để giải thích lựa chọn. Giữ ứng viên khả thi tốt nhất của chính lượt chạy đến khi hoàn thành kiểm tra ứng viên thay thế. Nếu thử dùng phương án lịch sử làm nghiệm khởi đầu, phải kiểm tra lại snapshot, tài nguyên, policy và chạy nó như một biến thể riêng ở cả hai phía.

## 3. Tiêu chí đề xuất để nhận bản mới

- **Hợp lệ:** mọi phương án đem so phải giao đủ đúng từng kiện, có tài xế hợp lệ, giữ thứ tự lấy–giao, lịch và chứng chỉ xếp/dỡ. Ghi mọi timeout hoặc lượt thiếu nghiệm vào kết quả. Không loại các lượt đó khỏi thống kê.
- **Chất lượng:** với cùng nghiệm đầu vào, bước cải thiện phải giữ được phương án tốt nhất theo thứ tự ưu tiên thực tế. Ở cấp job, yêu cầu trung vị theo thứ tự xếp hạng đạt ít nhất mức của bản đối chứng ở từng thành phố, có cải thiện lặp lại ở ít nhất một bộ, và tỷ lệ có nghiệm đầy đủ không giảm. Rà riêng từng lượt thua; nếu lượt tệ nhất giảm chất lượng đáng kể mà chưa giải thích được, giữ bản đối chứng làm lựa chọn mặc định.
- **Thời gian:** dùng cùng ngân sách và báo cả thời gian thực, gồm dựng dữ liệu, tìm kiếm và kiểm tra. Lượt trước mất khoảng 197 giây ở Nha Trang và 208 giây ở Đà Nẵng. Chỉ nhận cải tiến cần thêm thời gian khi đã nêu rõ mức đánh đổi và được chấp thuận.
- **Bàn giao:** kèm cấu hình tái hiện, số liệu từng lượt và các test hồi quy. Mốc Nha Trang 12 chuyến, điểm 24.133.660 là mục tiêu tái lập bổ sung. Kết quả Đà Nẵng cần đồng thời đối chiếu với bản trước ở 33 chuyến.

## 4. Vị trí triển khai và phạm vi

- [Điều phối seed và chọn ứng viên](../optimizer/app/multi_start.py)
- [Dựng nghiệm, kiểm tra và cải thiện tuyến](../optimizer/app/hybrid_alns_engine.py)
- [Sinh thứ tự điểm trong đoạn](../optimizer/app/hybrid_alns/stop_moves.py)
- [Destroy, repair và cập nhật trọng số](../optimizer/app/hybrid_alns/solver.py)
- [Test cải thiện tuyến sau kiểm tra](../optimizer/tests/test_hybrid_post_audit_search.py)

Dùng bản sao snapshot chỉ đọc để chạy cục bộ. Báo cáo benchmark lưu hash và số liệu tổng hợp. Phạm vi triển khai đề xuất là optimizer và hạ tầng benchmark liên quan. Tám lỗi đã tái hiện từ trước của suite cần được theo dõi riêng để phân biệt với hồi quy do từng biến thể.

## 5. Nhật ký triển khai 22/11/2026

- Đã sửa string destroy ở solver Hybrid ALNS và nhánh legacy. Đoạn gỡ có thể vòng qua cuối tuyến và trả mỗi ID một lần. Tám ca hồi quy bao phủ tuyến rỗng, một đơn, gỡ vượt số lượng và vòng qua cuối tuyến.
- Đã sửa bước giữ ứng viên theo seed/ngày. Trước đây bước này ưu tiên số chuyến trong khi vòng xếp hạng cuối của job nhiều ngày ưu tiên điểm điều phối. Test tái hiện bản cũ giữ điểm 90 và bản sửa giữ điểm 65 trên cùng nhóm seed/ngày. Chính sách xếp hạng cuối hiện dùng chung cho cả hai bước.
- Đã thử bốn cấu hình trên sáu phương án khả thi từng lưu trên cloud. 24/24 lượt giữ đủ đơn và kiện theo kiểm tra phục vụ của optimizer. Không lượt nào đổi điểm. Kết quả này giới hạn ở sáu đầu vào và ngân sách cải thiện tuyến 0,28 giây.
- Hồ sơ thời gian của hai phương án hạng 1 cho thấy sinh thứ tự bằng quy hoạch động dùng khoảng 0,16–0,17 giây mỗi lần trong hai lượt đo. Các biến thể có thể vượt ngân sách 0,28 giây của bước cải thiện trong lần đối chứng riêng. Cần đo tiếp theo từng giai đoạn trước khi kết luận việc chia thời gian gây chênh lệch ở cấp job.
- Cặp Nha Trang đầu tiên trong chuỗi đo mới giữ 12 chuyến và thực hiện đủ 452 kiện ở cả hai bản. Điểm bản trước là 23.104.719 và bản hiện tại trước hai bản sửa lỗi là 24.515.197. Cả hai có checkpoint nhưng báo seed 3 và 4 hết thời gian ở lượt tìm sâu. Chưa có kết luận nguyên nhân của phần chênh lệch.
- Chạy kiểm tra cục bộ có 40 ca đạt ở nhóm toán tử, cải thiện tuyến, T21–T27 và benchmark tham chiếu. Nhóm điều phối và deadline có 18 ca đạt. Chưa dùng kết quả này để chọn biến thể chạy mặc định.

- Chạy lại 320 phép thử bảo toàn tập đơn với tám toán tử destroy. Tất cả đạt, và danh sách gỡ không còn ID trùng.
- Cặp Đà Nẵng đầu tiên đều giao đủ 1.290 kiện trên 33 chuyến. Điểm bản trước là 74.635.306 và bản hiện tại trước hai sửa lỗi là 74.646.566.
- Lượt bản hiện tại của cặp Nha Trang thứ hai đạt 23.091.210, thấp hơn mốc cặp đầu và điểm lịch sử 24.133.660. Cần ghép với lượt bản trước của cùng cặp. Các số liệu này cho thấy độ dao động giữa những lần chạy theo deadline, ngay cả khi cố định seed và payload.
- Chuỗi chạy nối tiếp ghi số liệu sau mỗi lượt vào paired-results.jsonl trong thư mục thử nghiệm cục bộ. Sau 20 lượt chính, hàng đợi tiếp tục với các cấu hình riêng, đo destroy–repair và hai snapshot lưu từ ngày trước. Dữ liệu đơn hàng tải xuống chỉ dùng làm đầu vào cục bộ.

### Kiểm tra giới hạn thời gian của bước cải thiện tuyến

Test đồng hồ giả tái hiện việc validator được cấp 0,35 giây khi toàn pha chỉ còn 0,28 giây. Khi kiểm tra ứng viên thay thế, solver hiện truyền hạn tuyệt đối đến từng tuyến, giới hạn thời gian cấp cho validator và trả lại nghiệm đã kiểm tra nếu hết hạn. Trên một lượt đo trước sửa, riêng bước dựng và kiểm tra phương án mất 3,162 giây ở phương án Nha Trang hạng hai.

Đo lại cục bộ trên cùng sáu phương án cloud với ngân sách 0,28 giây cho mỗi phương án. Ba lượt Nha Trang mất 0,296 / 0,347 / 0,297 giây và ba lượt Đà Nẵng mất 0,310 / 0,295 / 0,324 giây. Cả sáu giữ nguyên điểm, số chuyến và phục vụ đủ kiện. Thời gian thực vẫn vượt 15–67 ms. Đây là số đo riêng bước cải thiện tuyến, chưa xác minh tác động đến chất lượng toàn job.
