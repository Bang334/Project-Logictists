# Kế hoạch ưu tiên gom kiện cùng đơn và ghép hàng vào chỗ dư

Ngày 01/11/2026 · Trạng thái: kế hoạch bổ sung, chưa triển khai ứng dụng/database.

Liên quan: [Kế hoạch TMS](KE_HOACH_TMS.md), [Đặt hàng đa nguồn](KE_HOACH_DAT_HANG_DA_NGUON.md), [Hợp đồng kiện](docs/package-order-contract.md), [Quy tắc project](AGENTS.md).

## 1. Yêu cầu và kết luận khảo sát

Yêu cầu người dùng: ưu tiên đưa các kiện của cùng một đơn lên ít xe/chuyến; khi không thể đưa thêm kiện của đơn đó lên xe một cách hợp lệ thì tận dụng chỗ dư để ghép hàng khách khác. Không giữ độc quyền phần thùng trống. Tối ưu trên nhiều đơn, vẫn phải bảo vệ lịch, tải từng chặng, xếp/dỡ và việc giao đủ đơn.

**Kết luận: code hiện đáp ứng một phần, chưa đủ để nghiệm thu yêu cầu trên toàn bộ luồng.** Đã có chia đơn theo số xe tối thiểu tìm được dưới ràng buộc tải/diện tích tổng hợp, ưu tiên lấp xe đã mở và test 100 kiện không bị tách ra 100 xe. Chưa có mục tiêu gom đơn thống nhất từ tiền xử lý đến xếp hạng cuối; chưa chứng minh “không thể thêm kiện” bằng hình học và lịch; chưa có bộ nghiệm thu nhiều đơn ghép vùng dư xuyên suốt.

Đây là kết luận từ mã nguồn workspace đang có thay đổi, không phải trạng thái của database hay bản đã deploy. Không ghi đè các thay đổi đa nguồn đang được người dùng thực hiện.

## 2. Bằng chứng hiện trạng

| Nơi | Đã có | Giới hạn |
|---|---|---|
| `backend/src/trips/optimizer-payload.ts` — `packagesToCargoUnits` | Chuyển đổi kích thước mm→cm, g→kg và giữ UUID kiện | Đang gán cứng `can_rotate: false`; cần đồng bộ quy tắc xoay ngang 90° trên mặt sàn đã chốt ở `KE_HOACH_TMS.md` mục 6.5 |
| Cùng file — `allocateCargoToPhysicalVehicles` | Tăng dần giới hạn số xe từ cận dưới; ưu tiên bin đã mở; có quay lui và SEARCH_LIMIT | Dựa vào tải, từng kiện vừa thùng và tổng diện tích, chưa phải phép xếp/dỡ hình học |
| Cùng file — `splitOversizedOrdersAcrossFleet` | Giữ đơn nếu một xe đủ ràng buộc tổng hợp; tách kiện nguyên vẹn khi vượt; giữ source order và split group | Mỗi đơn được xử lý riêng; phần chia gắn sớm `allowed_source_vehicle_ids` vào một xe vật lý; đơn đủ diện tích tổng hợp nhưng bất khả thi hình học 2D chưa được tách |
| `backend/test/trips/optimizer-payload.spec.ts` | Test 100 kiện nhỏ, xe chứa 10 kiện: sinh 10 phần, mỗi phần 10 kiện | Chỉ là test tiền xử lý một đơn; không chứng minh ghép chỗ dư với đơn khác, lịch, hình học hoặc số lần nhận |
| `optimizer/app/hybrid_alns/solver.py` — `_plan_cost` | Có hướng dẫn giảm tổng số route, tiền phạt đơn chưa xếp và chi phí kinh tế | Tổng route không phải số chuyến phục vụ mỗi đơn; không có thành phần phân tán theo đơn gốc; mỗi `OrderPair` đang là nguyên tử |
| `optimizer/app/planning_objective.py` & `multi_start.py` | Objective chung tính chi phí vận hành, lương theo lịch và trễ vận hành; `select_ranked_candidates` chọn phương án | Chưa xếp hạng mức gom cùng đơn; `is_fully_served` và `_plan_signature` đang khóa cứng theo tập `allocation_id` của bước chia sơ bộ thay vì tập `Package` của đơn gốc |
| `optimizer/app/routing_solver.py` — split groups | Các phần split được chọn/bỏ cùng nhau | All-or-nothing không đồng nghĩa ít chuyến hoặc ít lần nhận |
| `backend/src/trips/trips.service.ts` | Đường auto gọi splitter sau dựng payload; đang bổ sung retail TransportRequest | Phải đối chiếu mapping retail mới đến adapter, solver và apply; không coi chỉ thêm bảng/request là hỗ trợ đầy đủ |

Tên `_best_route_split` trong ALNS chủ yếu di chuyển một optimizer order khỏi tuyến ghép sang tài nguyên rỗng. Không suy từ tên rằng hàm này đã tự phân chia/tái gom mọi kiện của cùng đơn gốc.

## 3. Định nghĩa đã chốt để triển khai đúng

- **Đơn gom (đã chốt):** tính theo từng `Order` khách đã đặt, bao gồm các `FulfillmentGroup`/`TransportRequest` nhiều nguồn của chính `Order` đó. Không tự gộp chung các `Order` khác nhau của cùng `customerId` vì chúng có thể khác địa chỉ, lịch và điều kiện giao. Trong báo cáo và diagnostics, tách bạch **số chuyến theo `Order` gốc** (số chuyến phục vụ đơn của khách) và **số chuyến theo từng `TransportRequest`/nguồn xuất** (để phân biệt đơn nhiều chuyến do lấy từ nhiều nguồn lệch giờ với đơn bị tách kiện tại cùng một nguồn).
- **Kiện và hướng xoay (đã chốt):** `Package` vật lý có UUID, số đo mm/g và nội dung đã xác nhận. Không tách một kiện, không sinh kiện từ quantity và không chuyển xe bằng sửa ID sau pickup. Kiện chữ nhật được phép xoay trên mặt sàn theo bội số 90° (`0°/90°/180°/270°`, `can_rotate = true` cho xoay ngang mặt sàn theo `KE_HOACH_TMS.md` mục 6.5); không lật kiện để đổi chiều cao và không xếp chồng.
- **Xe vật lý:** một phương tiện. **Chuyến/lượt:** một lần xe thực hiện kế hoạch; cùng xe quay lại ngày khác vẫn là lượt khác. Đếm xe vật lý thôi sẽ che việc khách nhận hàng nhiều lần.
- **Lần nhận (đã chốt):** mỗi chuyến xe đến giao cho đơn được tính là một lần nhận (`delivery visit`) riêng biệt. Không tự suy từ số xe vật lý và không tự gộp hai chuyến giao khác giờ tại cùng địa chỉ thành một đợt nhận.
- **Chỗ dư:** vùng hình học thực còn trống ở đúng bước lấy hàng, kèm tải còn cho phép; phải vào cửa được và không cản thao tác sau. Không phải tổng diện tích hay thể tích rỗng.

Ví dụ: sàn 50 × 100, 5 kiện A kích thước 50 × 40 (hoặc 40 × 50 khi xoay 90° vẫn chỉ xếp tối đa 2 kiện trên sàn 50 × 100), không chồng, tải và lịch đủ. Mỗi xe chỉ chứa 2 kiện A: cần ít nhất 3 xe trong bộ xe đồng nhất này. Hai xe có vùng dư 50 × 20, xe cuối còn 50 × 60. Có thể ghép B vào các vùng đó nếu đường lấy/giao và xếp/dỡ hợp lệ. Tỷ lệ fill thấp ở xe cuối không tự chứng minh nghiệm kém vì A còn một kiện.

## 4. Quy tắc tối ưu

### 4.1. Điều kiện bắt buộc

Giữ toàn bộ hard constraints hiện hành: quyền, readiness, pickup trước delivery, tải từng thao tác, không chồng/va chạm, cửa và đường thao tác, ca/nghỉ có policy, tài nguyên và phần kế hoạch khóa, thời gian đến nhận việc, version. Chia đơn áp dụng đủ mọi kiện hoặc không áp dụng đơn đó; không đổi planned thành actual hay tự nới ràng buộc để gom.

Không mở xe mới cho một kiện chỉ vì cách đặt hiện tại bất lợi khi có thể điều chỉnh vị trí hoặc xoay ngang 90° trên mặt sàn **trong kế hoạch chưa thực thi** để xếp được. Khi xe đã chạy, giữ nguyên phần đã thực hiện; không giả định được dịch kiện trên xe hoặc dỡ tạm hàng khác.

### 4.2. Thứ tự mục tiêu phân cấp (đã chốt)

Sử dụng so sánh phân cấp (lexicographic comparator), không cộng số tiền tùy ý để “mua” thêm sự phân tán:

1. Phục vụ tập đơn theo policy đã chốt, đủ kiện và thỏa mọi điều kiện bắt buộc.
2. Giảm tổng lượt/chuyến bổ sung của các đơn: `sum(max(0, distinct_trip_count(order) - 1))`.
3. Với cùng mức gom, giảm tổng chuyến hoạt động; ghi riêng số xe vật lý.
4. Với cùng các mức trên, giảm objective kinh tế hiện hành và các soft constraints đã duyệt.

Giảm mức tách từng đơn có thể tăng tổng xe/chi phí; phải trình bày rõ các chỉ số này trên candidate và benchmark. Nếu sau này cần thêm trần số lượt tối đa cho một đơn hoặc giới hạn theo điều kiện khách thì cấu hình bằng policy riêng, không tự đặt con số ngầm.

Không đánh đổi đơn chưa phục vụ để điểm gom đẹp hơn. Không tự thay penalty trễ hiện hành bằng mục tiêu số xe; giữ nguyên ngữ nghĩa hard/soft time windows hiện có.

### 4.3. “Không thể xếp thêm” và tìm kiếm chung

- Dựng seed ưu tiên đặt thêm kiện cùng đơn vào xe đang phục vụ đơn đó; thử vị trí/xoay ngang 90°/xe trong nhóm hiện tại trước khi mở thêm lượt.
- Kiểm tra **tập kiện và thứ tự thao tác**, không chỉ từng kiện. Thêm kiện A không được làm hỏng pickup/delivery của A hoặc B trên toàn tuyến.
- Phần dư được dùng cho đơn khác, không gắn “sở hữu độc quyền” theo khách. Có thể thử A/B cùng lúc hoặc quay lui để thoát nghiệm tham lam, miễn giữ mục tiêu gom đơn.
- Cho phép move/swap nhiều kiện giữa xe trong cùng ngân sách tìm kiếm, merge các phần cùng đơn và đổi tuyến, nguồn pickup giữ nguyên. Không khóa vĩnh viễn cách chia aggregate từ backend trước khi kiểm tra hình học.
- Nếu mô hình tổng hợp nói vừa một xe nhưng validator hình học loại (kịch bản GK05), Python preprocessor/solver phải có cơ chế tách `OrderPair` theo `Package` để thử bố trí nhiều xe có kiểm chứng; không kết luận đơn không chở được chỉ vì bước tiền xử lý ở backend giữ nguyên đơn.
- Nếu hết ngân sách, chỉ ghi “chưa tìm được cách gom tốt hơn”; không ghi “không thể thêm kiện” hoặc “ít xe nhất” nếu chưa có chứng minh. Cận dưới tải/diện tích chỉ là cận dưới, không phải nghiệm hình học.

## 5. Thay đổi contract và kiến trúc

| Lớp | Việc cần làm |
|---|---|
| Backend adapter | Giữ UUID Package, Order gốc, request/group/nguồn thật; đưa B2B và retail về mapping truy vết chung; đồng bộ `can_rotate: true` cho phép xoay ngang 90° trên mặt sàn; không dùng ID phần split làm khóa gom cuối |
| Splitter | Giữ làm cận dưới/seed có chẩn đoán; tách ràng buộc xe bắt buộc nghiệp vụ khỏi việc gắn xe chỉ để tạo seed. Cho solver sửa partition chưa thực thi |
| Python contract | Thêm trường grouping/policy có version khi cần; contract cũ đọc được, không đổi nghĩa `source_order_id`, `split_group_id` hoặc `allocation_id` âm thầm |
| Solver | Thêm state/metric tập chuyến theo Order gốc; operators hợp nhất/chuyển nhóm kiện và tách `OrderPair` theo `Package` khi tổng diện tích đủ 1 xe nhưng hình học 2D không vừa; ghép chỗ dư qua validator từng bước |
| Objective chung & `multi_start` | Một comparator phân cấp dùng ở construction, repair, local search, elite, `select_ranked_candidates` và fallback. Cập nhật `is_fully_served` và `_plan_signature` trong `multi_start.py` kiểm tra độ phủ 100% theo tập UUID `Package` (`items_loaded`/`items_unloaded`) của từng `source_order_id` thay vì khớp cứng tập `allocation_id` tĩnh ban đầu |
| Validator độc lập | Kiểm tra đủ kiện, đúng nguồn, không trùng, metrics số lượt/xe theo manifest thật (tách rõ theo `Order` gốc và theo `TransportRequest`), hình học/lịch. Mức tối ưu không chứng minh bằng validator feasibility |
| Apply/publish | Dùng manifest toàn Order, khóa/version và tài nguyên; áp dụng đồng bộ các Trip cần thiết, snapshot cũ bị vô hiệu khi kiện/policy đổi |
| Web | Hiển thị mỗi đơn trên bao nhiêu chuyến/xe và các lần giao dự kiến (`delivery visit`); tải có sẵn bản vẽ xếp theo bước, lý do chia và giới hạn chứng minh |

Đường production dùng Hybrid ALNS, fallback OR-Tools và chọn candidate trong main phải cùng hiểu mục tiêu. Kiểm tra cả engine legacy/nhánh portfolio được gọi thực tế; không sửa riêng một solver rồi để đường khác xếp hạng theo chi phí cũ. Tái sử dụng stack, không thay engine/provider.

Không bắt buộc migration cho chỉ số tính lại từ kết quả. Nếu cần lưu policy/metrics mới để audit, thiết kế additive migration và kiểm tra dữ liệu cũ trước; không sửa lịch sử đã áp dụng. Đối chiếu thay đổi đa nguồn hiện có ngay trước triển khai.

## 6. Trình tự triển khai

| Mốc | Đầu ra | Điều kiện nghiệm thu |
|---|---|---|
| G0 — Chốt nghĩa và baseline | Quyết định nhóm theo Order, mục tiêu, cách đếm lượt/visit; đọc lại call graph production và benchmark cũ | Tách rõ yêu cầu đã chốt/đề xuất; không nhận “tối ưu” từ số xe đơn thuần |
| G1 — Mapping và metrics | Adapter giữ parent order, package, request; tính metrics độc lập; diagnostics | Đơn đa nguồn không thành nhiều nhóm giả; cùng xe nhiều ngày vẫn đếm đúng chuyến |
| G2 — Gom đơn và hình học | Seed/splitter sửa được partition; operators merge/swap; kiểm tra vùng dư/đường dỡ | Qua GK01–GK08; không khóa xe sớm làm mất cách chia khả thi |
| G3 — Objective xuyên suốt | Comparator chung ở production/fallback và candidate ranking | Nghiệm giảm chi phí nhưng làm tăng phân tán không thắng trái policy đã duyệt |
| G4 — Apply/UI/kiểm thử thật | Manifest, atomic publish, hiển thị số chuyến/lý do; E2E, regression đa nguồn/B2B | Không mất/nhân đôi kiện, race rollback; khách/dispatcher thấy đúng mức chia |
| G5 — Benchmark và bàn giao | Baseline, runtime, số lượt, tổng xe/chuyến, chi phí và diagnostics; tài liệu vận hành | Bộ nghiệm thu đạt, giới hạn còn lại ghi rõ; không tuyên bố tối ưu toàn cục từ heuristic |

Không cần làm lại toàn bộ kế hoạch đặt hàng đa nguồn. Các đường retail mapping/chuẩn bị/apply chưa hoàn chỉnh là phụ thuộc cần hoàn tất khi nghiệm thu retail; có thể kiểm thử phần solver bằng fixture chuẩn và B2B trước, nhưng không gọi đó là hoàn tất tích hợp bán lẻ.

## 7. Bộ nghiệm thu

| Mã | Dữ liệu và kết quả cần kiểm tra |
|---|---|
| GK01 | Giữ regression 100 kiện nhỏ, mỗi xe chứa 10: tiền xử lý tạo 10 phần; bổ sung solver + validator và candidate ranking, không chỉ test splitter |
| GK02 | Ví dụ 50×100/5 kiện 50×40: 3 xe, thêm B vừa vùng 50×20 và 50×60 không tăng xe nếu lịch/tải cho phép; UUID kiện duy nhất |
| GK03 | B vừa chỗ nhưng chắn A cần dỡ trước: loại hoặc đổi bố trí/route rồi validate, không báo fill hợp lệ giả |
| GK04 | B vượt vùng dư dù tổng diện tích rời rạc đủ: không xếp; không chồng/lật kiện trái policy |
| GK05 | Tổng diện tích đủ một xe nhưng không bố trí được: thử partition nhiều xe và trả nghiệm thật; không xem aggregate là chứng minh |
| GK06 | Hai cách chia cùng số xe: cách đầu khóa xe không ghép B được, cách khác ghép được; tìm kiếm được quay lui/tái chia |
| GK07 | Khách có nhiều Order khác nơi giao/lịch: không gom sai; một Order có hai nguồn vẫn có một nhóm đánh giá phân tán |
| GK08 | Một xe vật lý chạy nhiều ngày/lượt: số xe có thể 1 nhưng số chuyến/visit lớn hơn 1; không che nhiều lần nhận |
| GK09 | Hai phương án cùng tập đơn phục vụ, khác mức gom và chi phí: ranking đúng policy ở mọi engine/chọn kết quả cuối |
| GK10 | Hàng lẻ B ghép vào xe A vẫn thỏa time windows, thời gian tiếp cận, tải từng thao tác; không dùng chỗ của kiện chưa dỡ |
| GK11 | Đủ mọi kiện hoặc rollback apply/publish cả đơn; tranh tài nguyên, snapshot/version stale và retry không tạo side effect trùng |
| GK12 | T21–T27 hiện hành: giao A/lấy C vào chỗ A, B còn trên xe; C chắn B phải bị loại; cùng stop đúng thứ tự |
| GK13 | Timeout/SEARCH_LIMIT: phân biệt best-found, chưa tìm thấy, bất khả thi có bằng chứng; không báo tối thiểu xe sai |
| GK14 | Nhiều khách, 100 SKU không đồng nghĩa 100 kiện; kiện nhiều dòng vẫn bảo toàn quantity, nguồn, khối lượng và ID |

Kiểm tra backend theo manifest: `npm test -- --runInBand --runTestsByPath test/trips/optimizer-payload.spec.ts`; mở rộng các suite split-order planning/application hiện hữu. PostgreSQL concurrency cần database dùng một lần và lệnh `npm run test:postgres`; không dùng mock để chứng minh transaction.

Optimizer dùng environment hiện tại: `python -m pytest -q`; mở rộng test planning objective, contract, spatial validator và test production portfolio. Frontend chạy typecheck/test/build khi thay hiển thị. E2E cần HTTP → queue → Python → PostgreSQL thật; matrix fixture phải đánh dấu và có kiểm tra provider thật riêng khi cần.

Benchmark cùng dữ liệu/seed/budget: số đơn phục vụ, số đơn bị chia, tổng lượt bổ sung, số lượt lớn nhất của một đơn, tổng xe vật lý/chuyến, delivery visits, chi phí hiện hành, thời gian giải và hard violations. Không lấy giảm phân tán làm lý do bỏ đơn, giao trễ bắt buộc hoặc nới an toàn.

## 8. Điều kiện hoàn thành và các quyết định đã chốt

Chỉ hoàn thành khi seed, solver, objective cuối, validator, apply và UI cùng phản ánh nhóm đơn gốc; có test ghép vùng dư nhiều đơn, geometry động, lượt giao và retry; B2B/retail liên quan không mất lịch sử. Mọi hard constraint vẫn được bảo vệ.

**Các quyết định người dùng đã chốt (01/11/2026):**
1. **Đơn vị ưu tiên gom:** gom theo từng `Order` khách đặt (bao gồm các phần đa nguồn của chính `Order` đó); không tự gộp chung các `Order` khác nhau của cùng khách.
2. **Thứ tự mục tiêu phân cấp:** (1) Phục vụ đủ tập đơn và thỏa mọi ràng buộc cứng → (2) Giảm tổng chuyến bị tách bổ sung trên từng đơn `sum(max(0, distinct_trip_count(order) - 1))` → (3) Giảm tổng chuyến hoạt động của đội xe → (4) Giảm chi phí kinh tế và soft constraints đã duyệt.
3. **Cách đếm lần nhận:** tính mỗi chuyến xe đến giao là một lần nhận (`delivery visit`) riêng biệt; không tự gộp các xe giao khác giờ thành một lần nhận.
4. **Quy tắc xoay kiện:** cho phép xoay ngang 90° trên mặt sàn (`can_rotate = true` cho bội số 90° trên mặt sàn, không lật chiều cao, không xếp chồng) khớp với `KE_HOACH_TMS.md` mục 6.5.

Phạm vi hiện tại là hoàn thiện kế hoạch và quy tắc nghiệm thu; chỉ bắt đầu sửa code ứng dụng/database khi có lệnh triển khai theo `AGENTS.md`.
