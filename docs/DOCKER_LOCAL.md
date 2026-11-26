# Docker cục bộ — bản chính

Ngày gom cấu hình: 22/11/2026. Người dùng chọn **bản chính dùng backend/.env**, không chọn bản test ba vai trò.

## Chạy hằng ngày

Mở Docker Desktop, rồi nhấp đúp `start_tms.bat` ở thư mục gốc. Script gọi `start_tms.ps1` và dùng duy nhất `compose.yaml` với `--env-file backend/.env`. Không cần chọn từng container. Sau lần build đầu, có thể bật/tắt cả nhóm `project-logictists` trong Docker Desktop.

Nhóm mặc định có bốn dịch vụ:

| Service | Host | Kết nối nội bộ |
|---|---|---|
| frontend | localhost:5173 | Gọi API/socket public tại localhost:4000 |
| backend | localhost:4000 | Dùng PostgreSQL trong .env, Redis và optimizer trong nhóm |
| optimizer | localhost:8000 | Python/FastAPI/OR-Tools hiện có |
| redis | localhost:6379 | Giữ volume project-logictists_tms_redis_data hiện hữu |

Backend chạy trực tiếp `dist/src/main.js`, không chạy hook `start:dev`, migration, seed hay reset ngày đơn. Database vận hành và upload bind mount được giữ. `NODE_ENV` theo backend/.env; không tự đổi chính sách demo trong app. Ba file `.dockerignore` chỉ giới hạn build context, không phải file khởi động; đặc biệt loại .env khỏi image. Frontend chỉ nhận ba biến public VITE_API_URL/VITE_SOCKET_URL/VITE_MAPBOX_TOKEN qua build args, không nhận JWT hoặc DATABASE_URL. Các thư viện optimizer được cố định bằng `optimizer/docker-constraints.txt` lấy từ venv hiện tại; không đổi requirements hoặc logic solver.

Nếu cần xem log hoặc dừng:

```powershell
docker compose --env-file backend/.env ps
docker compose --env-file backend/.env logs --tail 100 backend frontend
.\start_tms.ps1 -Stop
```

Không dùng `down -v` để dừng vì lệnh đó có thể xóa dữ liệu volume. Đổi public token/địa chỉ API thì chạy launcher để build lại frontend. Các biến public hiện được bổ sung trong cùng backend/.env; các giá trị backend đã có không bị thay. Launcher không còn quét rồi kill hàng loạt Node/Python. Khi cổng bị chiếm, dừng bản source cũ đang chạy trong terminal của nó.

## Dữ liệu test cũ đã lưu trữ

Các mục trong ảnh người dùng gửi là container, không phải nhiều file Docker. Trước khi gỡ container rời đã lưu đầy đủ docker inspect và chụp volume khi PostgreSQL/Redis đang dừng, sau đó kiểm tra đọc được từng file tar gzip:

| Container cũ | Cách giữ dữ liệu |
|---|---|
| tms-three-roles-test-20261122 | Giữ volume PostgreSQL 16; cấu hình profile roles-test dùng lại đúng volume này |
| tms-three-roles-redis-20261122 | Giữ volume Redis test; profile roles-test dùng lại |
| tms-shift-rehearsal-20261114 | Giữ volume PostgreSQL 17 và snapshot; không chạy mặc định |
| tms-chinh-check-1792143615343 | Giữ volume PostgreSQL 17, snapshot, cấu hình bind /backup cũ; không chạy mặc định |

Container được gỡ bằng docker rm **không có -v**. Các volume vẫn tồn tại. Nơi sao lưu cục bộ được ghi trong `.git/docker-consolidation-path.txt`; thư mục đích chứa file `.inspect.json` và `.tgz` tương ứng, cùng bản compose/launcher/.env trước khi thay đổi. Những file inspect/.env có thể chứa credential nên giữ trong .git, không đưa vào Git hoặc gửi công khai.

Hai database PostgreSQL 17 có thể được tạo lại container từ thông tin Image, Mounts, Env, Cmd và PortBindings trong inspect JSON, gắn lại đúng volume còn giữ. Nếu phải phục hồi snapshot, giải nén vào một volume mới trống, dùng đúng major PostgreSQL và đối soát trước khi chuyển kết nối; không ghi đè volume hiện có. Bind backup của tms-chinh-check vẫn ở vị trí cũ, không bị xóa.

## Chạy lại test ba vai trò khi thực sự cần

Đây là lựa chọn phụ trong **cùng compose.yaml**, không phải cấu hình chính. Hai biến TMS_ROLES_PG_VOLUME/TMS_ROLES_REDIS_VOLUME trong backend/.env trỏ tới volume test đã giữ trên máy này.

```powershell
docker compose --env-file backend/.env --profile roles-test up -d roles-postgres roles-redis
```

Lệnh chọn đích danh hai service test nên không đổi cấu hình database của backend chính. Sau đó chạy bộ test theo `PHAN_QUYEN_BA_VAI_TRO.md`; test API dùng port 4022 và frontend test 5182 để không đụng bản chính 4000/5173. Các tài khoản roles_test_* chỉ ở database test.

Khi xong, dừng và gỡ hai container test để Docker Desktop chỉ hiện nhóm chính, giữ lại external volume:

```powershell
docker compose --env-file backend/.env --profile roles-test stop roles-postgres roles-redis
docker compose --env-file backend/.env --profile roles-test rm -f roles-postgres roles-redis
```

Đường dẫn volume test là cấu hình cục bộ của máy này. Trên máy mới, cần chuẩn bị DB test trống theo hướng dẫn nghiệm thu hoặc phục hồi snapshot; không trỏ profile test vào database vận hành.

## Kiểm chứng đã thực hiện

- Compose config hợp lệ; launcher PowerShell parse và chạy thành công từ đầu đến healthcheck. Build thật cả backend, frontend và optimizer trên Linux.
- Sau gom: Docker chỉ còn bốn container, cùng project project-logictists, tất cả healthy. Các container rời cũ đã gỡ, volume vẫn tồn tại; bốn snapshot tar gzip đã được kiểm tra đọc thành công.
- Web `/` và URL trực tiếp `/orders` trả HTTP 200; trình duyệt Playwright tải được form đăng nhập thật và chụp ảnh `.git/docker-main-login.png`.
- Backend `/health/ready` trả 200, database CONNECTED; CORS chấp nhận origin http://localhost:5173.
- Redis trả PONG; backend gọi được optimizer bằng hostname nội bộ `optimizer` và nhận HTTP 200.
- Optimizer `/health` trả 200, `/demo/cases` trả 21 kịch bản. Image chứa các file cases cần cho demo; không chỉ có API health.
- Test `tests/test_demo_endpoints.py` chạy trong chính image optimizer, không có mạng: 8/8 đạt, 17,49 giây. Phiên bản FastAPI 0.142.2, NumPy 2.2.6, SciPy 1.15.3 khớp constraints lấy từ venv.
- Byte gốc của backend/.env được giữ nguyên, chỉ nối thêm phần Compose/public frontend; không đưa file này vào image hoặc Git. `git diff --check` đạt.

Đã sửa lỗi EACCES ở cache cấu hình Vite khi chạy image bằng user node, rồi build/chạy lại đủ healthcheck. Bản chính đang được để chạy để người dùng mở web. Không chạy migration, seed tài khoản hoặc nghiệm thu lại toàn bộ nghiệp vụ/Mapbox bằng dữ liệu vận hành trong nhiệm vụ gom Docker.
