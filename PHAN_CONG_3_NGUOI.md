# PHÂN CÔNG XÂY DỰNG TMS CHO 3 NGƯỜI

Phiên bản 0.1 · Ngày 09/09/2026 · Đề xuất để thay tên và điều chỉnh theo năng lực thực tế.

Đọc cùng [Kế hoạch TMS](KE_HOACH_TMS.md), [Thiết kế database](THIET_KE_DATABASE.md) và [Rule AI](AGENTS.md).

> Đây là phân công dự kiến cho ba thành viên, không phải yêu cầu khởi chạy ba AI/subagent. Chưa triển khai code hoặc migration cho đến khi người dùng xác nhận **“OK, bắt đầu triển khai”**.

## 1. Nguyên tắc phân công

- Mỗi đầu việc có một người chịu trách nhiệm chính và một người review; người phụ trách vẫn chịu trách nhiệm tới khi tích hợp thành công.
- Chia theo năng lực kỹ thuật nhưng bàn giao theo luồng nghiệp vụ chạy được, không chỉ số màn hình/endpoint.
- Cả ba cùng dùng stack đã chốt: React/TypeScript/Ant Design, Mapbox, Node.js + NestJS/Express, PostgreSQL, Redis, Socket.IO, Python/FastAPI/OR-Tools, React Native/Expo.
- Không ai tự đổi nghiệp vụ chưa chốt hoặc bỏ kiểm tra xếp/dỡ để giảm tải công việc.
- Chưa biết năng lực và thời gian rảnh nên chưa gán tên/thời hạn cố định. Nếu một thành viên ít kinh nghiệm Python/hình học, phải điều chỉnh nhân lực hoặc tiến độ trước khi nhận scope tối ưu.
- Khi bàn giao đã thấy `backend`, `frontend` và schema Prisma trong workspace. Các task dưới đây là trách nhiệm mục tiêu, không khẳng định toàn bộ đều chưa làm; trước khi nhận việc phải kiểm tra phần hiện có và phân loại tái sử dụng/sửa/bổ sung. Không scaffold lại hoặc ghi đè mã đang có.

## 2. Ba vai trò chính

| Thành viên | Vai trò chính | Phạm vi chịu trách nhiệm | Người review chính |
|---|---|---|---|
| **Người 1** | Backend, database và tích hợp hệ thống | API nghiệp vụ, schema/migration, quyền, transaction, publish kế hoạch, Redis/Socket.IO, vận hành backend | Người 3 về logic/tính nhất quán; Người 2 về contract client |
| **Người 2** | Web và mobile | Web điều phối/quản trị bằng Ant Design; app tài xế Expo; Mapbox UI; trạng thái offline/POD/GPS; trải nghiệm đầu cuối | Người 1 về API/quyền; Người 3 về hiển thị bố trí |
| **Người 3** | Optimization và kiểm chứng xếp/dỡ | Python/FastAPI/OR-Tools, routing + bố trí không chồng, vùng trống động, validator, benchmark; hợp đồng hình học | Người 1 về contract/job/lịch; Người 2 về khả năng thực hiện và hiển thị |

Người 2 có hai nền tảng nên phát triển theo thứ tự: web điều phối cốt lõi trước, mobile thực thi sau, rồi hoàn thiện web theo dõi/tối ưu. Không giao toàn bộ web lẫn mobile phải xong cùng lúc. Người 3 cần thử nghiệm thuật toán sớm; không đợi toàn bộ backend/mobile hoàn tất mới bắt đầu nghiên cứu.

## 3. Đầu việc chi tiết của Người 1 — Backend và database

| Mã | Đầu việc / đầu ra | Phụ thuộc | Tiêu chí bàn giao | Review |
|---|---|---|---|---|
| B01 | Chốt cấu trúc backend, schema và OpenAPI; bộ lỗi, version và idempotency | Quyết định P0 | Contract có ví dụ hợp lệ/lỗi, đơn vị/timezone thống nhất | Người 2 + 3 |
| B02 | Auth, vai trò/phạm vi, chi nhánh | B01; phương thức auth | API chặn tài nguyên ngoài quyền; socket/tệp theo cùng phạm vi | Người 2 |
| B03 | Customer, Order, stop, dòng hàng và kiện | B01; mức kiện được chốt | Nhập/lưu/đọc lại được; validation số đo/địa chỉ và sửa có version | Người 2 + 3 |
| B04 | Xe/cửa/chướng ngại, tài xế/bằng, ca/nghỉ | B01; policy đủ rõ | Availability xét giờ và địa điểm; không mặc định ca giống nhau | Người 3 |
| B05 | Trip/plans/stops/tasks/allocation và publish | B03–B04 | Đặt nhiều kiện lên xe; chống trùng tài nguyên/kiện bằng transaction; giữ lịch sử revision | Người 3 |
| B06 | Lệnh thực thi, POD metadata/upload, giao thiếu và sự cố | B05; contract E02 | Retry không trùng; kiện chưa giao có trạng thái; không nhầm upload local với server | Người 2 |
| B07 | GPS ingest, outbox, Socket.IO, notification và reconnect API | B02/B05; E03 | GPS sai thứ tự không ghi đè mới; client có thể phục hồi snapshot | Người 2 |
| B08 | Job gateway Node–Python, snapshot, import kết quả, publish có validator | B05; O01/O05; E04 | Không áp dụng snapshot cũ; backend là nơi duy nhất ghi kế hoạch hiệu lực | Người 3 |
| B09 | CI, cấu hình môi trường, log/metrics và backup/restore | B01; mở rộng theo phase | Môi trường có hướng dẫn chạy; kiểm thử tích hợp và restore có bằng chứng | Người 3 |
| B10 | API Journey/chuyển tải/backhaul và chi phí theo phase đã duyệt | MVP; quyết định P4/P5 | Bảo toàn kiện khi bàn giao; chi phí phân bổ truy vết được | Người 3 + 2 |

Người 1 điều phối thứ tự migration. Người khác có thể góp thay đổi schema qua review nhưng không tạo hai migration cạnh tranh cho cùng bảng mà không thống nhất.

## 4. Đầu việc chi tiết của Người 2 — Web và mobile

| Mã | Đầu việc / đầu ra | Phụ thuộc | Tiêu chí bàn giao | Review |
|---|---|---|---|---|
| U01 | Khung web, đăng nhập, navigation, API client và trạng thái lỗi | B01/E01 | Loading/empty/error/quyền hoạt động; không chỉ có menu tĩnh | Người 1 |
| U02 | Màn hình Order/kiện, xe/cửa, tài xế/ca và chi nhánh | Contract B02–B04 | Form lưu thật, reload còn dữ liệu; hiển thị đúng đơn vị/validation | Người 1 |
| U03 | Bàn điều phối thủ công, Mapbox, Trip và timeline | B05 | Phân xe/sắp stop/validate/publish được; xử lý conflict/version | Người 1 |
| U04 | App Expo: đăng nhập, xem/nhận chuyến, stop actions | B05–B06/E02 | Tài xế chạy luồng chuyến thật; không thao tác ngoài phân công | Người 1 |
| U05 | POD, GPS và hàng đợi offline mobile | B06–B07/E02–E03 | Thử thiết bị thật, mất mạng/retry/upload lại; hiển thị pending và stale | Người 1 |
| U06 | Web theo dõi, cảnh báo và sự cố | B07 | Reconnect tải lại đúng trạng thái, không tin socket là dữ liệu duy nhất | Người 1 |
| U07 | UI job tối ưu, chọn phương án, xem hàng chưa xếp | B08/O05 | Phân biệt timeout/không có nghiệm/nháp/hợp lệ; không tự publish | Người 1 + 3 |
| U08 | Xem bố trí hàng theo từng thao tác, cửa và vùng trống | O02–O04/E05 | A dỡ → C vào chỗ A hiển thị đúng; chỗ trống/tọa độ không chỉ minh họa giả | Người 3 |
| U09 | Trải nghiệm liên ngày/bàn giao và báo cáo chi phí | B10; P4/P5 được duyệt | Thông tin đủ để tài xế/điều phối hiểu quyết định và trạng thái | Người 1 + 3 |
| U10 | Kiểm thử UI/mobile và hướng dẫn người dùng | Theo từng feature | Có kịch bản thao tác/reload/error/offline; ghi thiết bị/build đã thử | Người 1 |

Mock theo contract được phép để phát triển song song, nhưng U02–U08 chỉ hoàn tất sau tích hợp API thật. Không coi screenshot hoặc nút toast thành công là bằng chứng nghiệp vụ hoạt động.

## 5. Đầu việc chi tiết của Người 3 — Optimization và xếp/dỡ

| Mã | Đầu việc / đầu ra | Phụ thuộc | Tiêu chí bàn giao | Review |
|---|---|---|---|---|
| O01 | Contract FastAPI/job, bộ fixture và baseline | E01/E04; dữ liệu kiện/lịch đủ rõ | Input/output có version, đơn vị, lỗi và trạng thái timeout/cancel | Người 1 |
| O02 | Mô hình hình học kiện/thùng/cửa, tọa độ và thao tác | E05; hướng xoay/khoảng hở được chốt | Mô tả đủ để web và validator tái hiện cùng bố trí | Người 1 + 2 |
| O03 | Packing không chồng và validator đường xếp/dỡ | O02 | Không giao nhau; không qua cửa/lối bị chắn; cấm đặt kiện lên kiện khác | Người 1 |
| O04 | Trạng thái hàng động và tái sử dụng chỗ trống | O03 | Dỡ A rồi nhận C giữ nguyên B; C chắn B tương lai thì bị loại; đạt T21–T27 | Người 1 + 2 |
| O05 | OR-Tools routing + tích hợp packing/validator | O01/O04; matrix hợp lệ | Tính pickup–delivery/time windows/tải cùng khả năng xếp/dỡ; trả đơn chưa phục vụ | Người 1 |
| O06 | Worker, giới hạn CPU/thời gian, retry/cancel và diagnostics | O01/O05; B08 | Không chạy solver dài trong request; phân biệt lỗi, timeout và bất khả thi | Người 1 |
| O07 | Benchmark, bộ validator độc lập và hồi quy | O03–O06 | Báo khả thi/tỷ lệ phục vụ/chi phí/thời gian; không chỉ số km | Người 1 |
| O08 | Ca/nghỉ nhiều ngày, backhaul và tái tối ưu phần chưa đi | P4; policy và B10 | Không thay phần đã thực hiện; không reset giờ lái qua đêm | Người 1 |
| O09 | Cải thiện hiệu năng bố trí và mục tiêu chi phí | P5; số liệu benchmark | Không đánh đổi hard constraints để lấy nghiệm đẹp | Người 1 + 2 |

Người 3 sở hữu logic thuật toán, không tự ghi bảng chuyến đang có hiệu lực. Người 1 quản lý lưu/áp dụng kết quả. Người 2 hiển thị bố trí do engine trả về, không tự tạo bố trí khác chỉ để đẹp mắt.

**Điểm chặn kỹ thuật cần thử sớm:** phát hiện đường đưa kiện qua cửa và tránh chắn lần giao sau khó hơn cộng tải hoặc xếp hình chữ nhật tĩnh. O02–O04 cần có thử nghiệm khả thi trước khi chốt thời hạn P3. Không dời các yêu cầu này sang P5 vì đã được người dùng chốt là phần của tối ưu chuyến.

## 6. Hợp đồng tích hợp phải thống nhất sớm

| Mã | Hợp đồng | Người soạn / người cùng duyệt | Nội dung phải có |
|---|---|---|---|
| E01 | Nghiệp vụ/API chung | Người 1 / Người 2 + 3 | ID, trạng thái, đơn vị, timezone, pagination, lỗi, quyền, version và ví dụ dữ liệu |
| E02 | Thực thi/offline/POD | Người 2 + 1 / Người 3 review logic | command ID, kế hoạch nguồn, timestamp, retry, upload status, conflict và correction |
| E03 | GPS/realtime | Người 1 + 2 / Người 3 review dữ liệu | measured/received time, nguồn, session/sequence, cursor và snapshot reconnect |
| E04 | Node–FastAPI | Người 3 + 1 / Người 2 review UI needs | snapshot, hash, trạng thái job, result candidate, đơn chưa xếp, validator và cancel |
| E05 | Bố trí xếp/dỡ | Người 3 / Người 1 + 2 | tọa độ, package ID, kích thước, orientation, door, handling path, trước/sau thao tác, initial state |

Mapbox: Người 1 chịu trách nhiệm lớp gọi API server, quota/cache và dữ liệu matrix trả về; Người 2 chịu trách nhiệm bản đồ trên client; Người 3 định nghĩa matrix/profile cần cho optimizer và kiểm tra dữ liệu thiếu. Không ba người tự viết ba cách gọi matrix khác nhau.

Mỗi hợp đồng có version và fixture chung. Khi đổi trường/ngữ nghĩa, người sửa cập nhật producer/consumer/tests liên quan hoặc duy trì tương thích rõ ràng. Không báo xong nếu chỉ service mình chạy được.

## 7. Ma trận triển khai theo phase

| Phase / mốc tích hợp | Người 1 | Người 2 | Người 3 | Điều kiện qua mốc |
|---|---|---|---|---|
| P0 — Thiết kế, chưa code | Rà schema/quyền/transaction | Rà luồng web/mobile | Rà hình học/optimizer | Chốt điểm chặn; E01–E05 đủ để bắt đầu; có phép triển khai |
| P1 — Điều phối thủ công | B01–B05, nền B09 | U01–U03 | O01–O02 và thử nghiệm O03 khi được phép | Tạo đơn/kiện, xe/tài xế, Trip và publish có kiểm tra tài nguyên |
| P2 — Thực thi | B06–B07 | U04–U06/U10 | O03–O04/O07 | Chạy chuyến, POD/offline/GPS thật; đồng thời chứng minh khả thi xếp/dỡ |
| P3 — Tối ưu đầy đủ theo scope MVP | B08 | U07–U08 | O05–O07 | Tuyến và bố trí đạt validator/T21–T27, không dùng mock để bàn giao |
| P4 — Nâng cao | B10 phần hành trình/bàn giao | U09 phần vận hành | O08 | Kịch bản nhiều ngày, thay người/chuyển tải nếu duyệt |
| P5 — Hiệu năng và chi phí | B10 phần chi phí | U09 báo cáo | O09 | Chi phí truy vết được, hiệu năng cải thiện không phá rule |
| P6 — Pilot | Restore/metrics/API | Thiết bị/UAT/tài liệu | Benchmark/diagnostics | Cả ba cùng xác nhận checklist và giới hạn thực tế |

P1/P2 có thể demo thao tác thủ công để phát triển, nhưng chưa gọi là hệ thống tối ưu chuyến hoàn chỉnh. MVP theo kế hoạch gồm P1–P3; không hoàn tất MVP khi thiếu xếp/dỡ động.

## 8. Gói việc đầu tiên sau khi được phép triển khai

| Người | Gói khởi đầu | Đầu ra review được |
|---|---|---|
| 1 | Đối chiếu backend/schema hiện có, hoàn thiện database test và luồng tạo–đọc Order/kiện | API lưu thật, migration bổ sung nếu cần và được phép, test input và quyền cơ bản |
| 2 | Đối chiếu frontend hiện có, hoàn thiện màn hình nhập/xem Order/kiện theo E01 | Form, loading/error, tích hợp API Người 1, reload giữ dữ liệu |
| 3 | Thiết lập FastAPI/test fixtures và bài toán A/B/C không chồng | Bộ kiểm tra bố trí ban đầu với trường hợp hợp lệ, chồng, chắn cửa và chắn B |

Ba gói chỉ bắt đầu khi phần hợp đồng tương ứng đủ rõ; nếu chưa chốt hình học/hướng xoay, Người 3 tiếp tục đặc tả và bộ ca kiểm chứng, không giả định điều kiện thao tác để nhận O03 đã xong.

## 9. Review, kiểm thử và chia tải

- Người viết tự test trước khi nhờ review; reviewer kiểm tra nghiệp vụ và bằng chứng, không chỉ format.
- Người 1 dẫn kiểm thử transaction/concurrency; Người 2 dẫn E2E và thiết bị; Người 3 dẫn validator/benchmark. Đây là người điều phối kiểm thử, không có nghĩa người khác không viết test.
- T21–T27: Người 3 tạo fixture và kiểm tra thuật toán, Người 1 kiểm tra lưu/publish cùng version, Người 2 kiểm tra hiển thị/thực thi theo từng bước.
- T01–T02: Người 1 chứng minh chống đặt trùng/snapshot cũ; Người 2 kiểm tra UX conflict; Người 3 kiểm tra kết quả gắn snapshot đúng.
- T11–T12/T16: Người 2 thử offline/reconnect trên thiết bị; Người 1 kiểm tra idempotency, dữ liệu và bản kế hoạch nguồn.
- Thay đổi chạm contract hoặc rule quan trọng cần reviewer từ thành phần nhận dữ liệu. Không dùng một người tự duyệt toàn bộ thay đổi quan trọng của mình.

Nếu Người 2 quá tải web/mobile: Người 1 nhận thêm màn hình quản trị đơn giản sau khi API nền ổn định, hoặc dời polish không bắt buộc; không bỏ offline/POD bắt buộc. Nếu Người 3 quá tải hình học: Người 1 hỗ trợ validator/data pipeline sau B05, đồng thời điều chỉnh tiến độ P3; không thay geometry bằng tổng thể tích. Mọi chuyển giao phải chỉ rõ task và người chịu trách nhiệm mới.

## 10. Quản lý nhánh, tiến độ và bàn giao

- Mỗi task có mã như B05/U08/O04, scope nhỏ và tiêu chí nghiệm thu rõ.
- Nhánh/PR gắn task; không sửa chồng file migration/contract mà không phối hợp. Người 1 điều phối migration, không là người duy nhất được review mọi thứ.
- Trạng thái công việc: chưa bắt đầu → đang làm → chờ tích hợp/review → hoàn tất; bị chặn ghi riêng nguyên nhân và người cần cung cấp đầu vào.
- Cập nhật tiến độ bằng đầu ra đã chạy/đã kiểm chứng, không bằng phần trăm ước lượng không có căn cứ.
- Nếu phụ thuộc API chưa xong, phát triển bằng fixture contract có đánh dấu; trạng thái vẫn chờ tích hợp.
- Theo từng mốc, demo một luồng thật: Order → Trip → nhận chuyến → pickup/delivery → POD; ở P3 thêm optimizer và bố trí A/B/C.
- Bàn giao task gồm file/module chính, contract/schema đổi, lệnh test và kết quả, giới hạn còn lại, cách tái hiện.
- Không tự deploy, push hoặc sử dụng dữ liệu thật ngoài quyền được cấp. Phân công này không thay thế yêu cầu quyền trong AGENTS.md.

## 11. Ước lượng và quyết định cần phản hồi

Chưa ấn định lịch theo ngày vì chưa biết tên, năng lực, số giờ/tuần và deadline của ba người. Thời lượng cũ trong kế hoạch là tham khảo; riêng P3 cần ước lượng lại sau O02–O04. Không cộng máy móc mọi phase nếu có việc song song, cũng không chia tổng thời gian cho ba vì có phụ thuộc và tải không đều.

Đề xuất chốt theo thứ tự:

1. Điền tên vào Người 1–3 theo năng lực và quỹ thời gian.
2. Chốt các điểm chặn nghiệp vụ/schema ở tài liệu database.
3. Duyệt mục tiêu MVP và bộ fixture xếp/dỡ động bắt buộc.
4. Sau phép triển khai, thực hiện gói đầu tiên và thử nghiệm hình học; dùng kết quả để ước lượng phần còn lại.
5. Chốt lịch mốc tích hợp và tiêu chí pilot bằng năng lực thực tế, không bỏ bớt ràng buộc để giữ một mốc chưa được kiểm chứng.

**Không có ai được giao phần “làm cho có”.** Cả backend, web/mobile và optimizer chỉ hoàn thành khi hợp đồng khớp, dữ liệu thật chạy được và các tiêu chí liên quan trong AGENTS.md đã đạt.
