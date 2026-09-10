-- Additive migration for configurable transport costs and persisted optimization jobs.
ALTER TABLE "branches"
  ADD COLUMN "fuelPricePerLiter" DECIMAL(12,2) NOT NULL DEFAULT 23000,
  ADD COLUMN "monthlyWorkingMinutes" INTEGER NOT NULL DEFAULT 10560;

ALTER TABLE "vehicles"
  ADD COLUMN "fuelConsumptionLitersPer100Km" DECIMAL(8,3) NOT NULL DEFAULT 12,
  ADD COLUMN "fixedOperatingCostPerTrip" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "drivers"
  ADD COLUMN "fixedSalaryMonthly" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "tripBasePay" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "perKmPay" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "orders" ADD COLUMN "branchId" TEXT;
UPDATE "orders"
SET "branchId" = COALESCE(
  (SELECT "id" FROM "branches" WHERE "code" IN ('BRANCH-HAN', 'HN') LIMIT 1),
  (SELECT "id" FROM "branches" LIMIT 1)
)
WHERE "branchId" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "branchId" SET NOT NULL;
CREATE INDEX "orders_branchId_status_idx" ON "orders"("branchId", "status");
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "optimization_jobs" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "branchId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "requestSnapshot" JSONB NOT NULL,
  "result" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "optimization_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "optimization_jobs_branchId_createdAt_idx"
  ON "optimization_jobs"("branchId", "createdAt");
CREATE INDEX "optimization_jobs_status_createdAt_idx"
  ON "optimization_jobs"("status", "createdAt");

ALTER TABLE "optimization_jobs"
  ADD CONSTRAINT "optimization_jobs_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "optimization_jobs"
  ADD CONSTRAINT "optimization_jobs_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
