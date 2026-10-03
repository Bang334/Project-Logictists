-- Kho đỗ của xe: điểm xuất phát khi lập lịch (quyết định nghiệp vụ 2026-10-03).
ALTER TABLE "vehicles" ADD COLUMN "homeDepotLocationId" TEXT;

CREATE INDEX "vehicles_homeDepotLocationId_idx" ON "vehicles"("homeDepotLocationId");

ALTER TABLE "vehicles"
ADD CONSTRAINT "vehicles_homeDepotLocationId_fkey"
FOREIGN KEY ("homeDepotLocationId") REFERENCES "locations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Chi nhánh Nha Trang chưa có kho; người dùng xác nhận kho đặt tại địa chỉ chi nhánh.
-- Không chèn gì nếu môi trường không có BRANCH-NTR hoặc mã kho đã tồn tại.
INSERT INTO "locations" (
  "id", "code", "name", "type", "managingBranchId", "address", "city",
  "latitude", "longitude", "timezone", "active", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, 'WH-NTR-01', 'Kho Vận Nha Trang - 23/10', 'CENTRAL_WAREHOUSE',
  b."id", b."address", 'Nha Trang', b."latitude", b."longitude", b."timezone",
  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "branches" b
WHERE b."code" = 'BRANCH-NTR'
ON CONFLICT ("code") DO NOTHING;

-- Gán kho đỗ mặc định: kho trung tâm đang hoạt động của chi nhánh gốc, mã nhỏ nhất.
-- Xe thuộc chi nhánh chưa có kho giữ NULL và sẽ bị từ chối khi lập lịch.
UPDATE "vehicles" v
SET "homeDepotLocationId" = (
  SELECT l."id"
  FROM "locations" l
  WHERE l."managingBranchId" = v."homeBranchId"
    AND l."type" = 'CENTRAL_WAREHOUSE'
    AND l."active" = true
  ORDER BY l."code" ASC
  LIMIT 1
)
WHERE v."homeDepotLocationId" IS NULL;
