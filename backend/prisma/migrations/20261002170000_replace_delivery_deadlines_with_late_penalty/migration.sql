CREATE TYPE "LateDeliveryPenaltyMode" AS ENUM (
  'NONE',
  'FIXED_PER_DAY',
  'PERCENT_ORDER_VALUE_PER_DAY'
);

ALTER TABLE "branches"
  ADD COLUMN "deliveryGraceDays" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "lateDeliveryPenaltyMode" "LateDeliveryPenaltyMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "lateDeliveryPenaltyValue" DECIMAL(14, 4) NOT NULL DEFAULT 0;

ALTER TABLE "orders"
  ADD COLUMN "orderedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "orders"
SET "orderedAt" = "createdAt";

ALTER TABLE "order_stops"
  DROP COLUMN "windowStart",
  DROP COLUMN "windowEnd";

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_deliveryGraceDays_check"
    CHECK ("deliveryGraceDays" >= 0),
  ADD CONSTRAINT "branches_lateDeliveryPenaltyValue_check"
    CHECK ("lateDeliveryPenaltyValue" >= 0),
  ADD CONSTRAINT "branches_lateDeliveryPenaltyPercent_check"
    CHECK (
      "lateDeliveryPenaltyMode" <> 'PERCENT_ORDER_VALUE_PER_DAY'
      OR "lateDeliveryPenaltyValue" <= 100
    );

CREATE INDEX "orders_branchId_orderedAt_idx"
  ON "orders"("branchId", "orderedAt");
