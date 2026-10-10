BEGIN;
-- This migration requires the reconciled pre-Package-UI schema, not an empty DB.
-- No legacy measurements, timestamps, allocations or package IDs are inferred.
ALTER TABLE orders ADD COLUMN "packageDataStatus" TEXT NOT NULL DEFAULT 'LEGACY_REVIEW';
ALTER TABLE orders ADD CONSTRAINT orders_package_data_status CHECK ("packageDataStatus" IN ('LEGACY_REVIEW', 'COMPLETE'));
ALTER TABLE order_stops ADD COLUMN "windowBasis" TEXT;
ALTER TABLE order_stops ADD CONSTRAINT order_window_basis CHECK ("windowBasis" IS NULL OR "windowBasis" = 'SERVICE_START');
ALTER TABLE order_stops ADD CONSTRAINT order_window_range CHECK (
  "windowBasis" IS NULL OR (("windowStart" IS NULL) = ("windowEnd" IS NULL)
  AND ("windowStart" IS NULL OR "windowEnd" >= "windowStart"))
);
CREATE UNIQUE INDEX order_service_stop_type ON order_stops ("orderId", type) WHERE "windowBasis" = 'SERVICE_START';
ALTER TABLE order_items ALTER COLUMN "lengthCm" DROP NOT NULL,
  ALTER COLUMN "widthCm" DROP NOT NULL, ALTER COLUMN "heightCm" DROP NOT NULL;
ALTER TABLE packages ALTER COLUMN "allowedOrientations" DROP NOT NULL;
-- NOT VALID leaves legacy violations available for reporting, while protecting new writes.
ALTER TABLE packages ADD CONSTRAINT package_positive_measurements CHECK (
  "lengthMm" > 0 AND "widthMm" > 0 AND "heightMm" > 0 AND "weightG" > 0
) NOT VALID;
CREATE UNIQUE INDEX packages_id_orderItemId_key ON packages (id, "orderItemId");
ALTER TABLE allocations ADD CONSTRAINT allocation_package_item_fk FOREIGN KEY ("packageId", "orderItemId")
  REFERENCES packages (id, "orderItemId") ON DELETE RESTRICT NOT VALID;
ALTER TABLE allocations ADD CONSTRAINT allocation_one_package CHECK ("packageId" IS NULL OR "allocatedQuantity" = 1) NOT VALID;
-- If existing active package assignments conflict, abort; never delete history to make this pass.
CREATE UNIQUE INDEX allocations_active_package ON allocations ("packageId")
  WHERE "packageId" IS NOT NULL AND status IN ('ACTIVE', 'ALLOCATED');
COMMIT;
