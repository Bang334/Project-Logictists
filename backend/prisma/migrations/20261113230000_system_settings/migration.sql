BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StackingOwnerMode') THEN
    CREATE TYPE "StackingOwnerMode" AS ENUM ('SAME_CUSTOMER', 'ANY_CUSTOMER');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "system_settings" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
  "scopeType" "ScopeType" NOT NULL,
  "branchId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,

  "overrideStacking" BOOLEAN NOT NULL DEFAULT false,
  "stackingEnabled" BOOLEAN,
  "stackingOwnerMode" "StackingOwnerMode",
  "stackingMaxTiers" INTEGER,
  "stackingLiftClearanceMm" INTEGER,

  "overrideOptimization" BOOLEAN NOT NULL DEFAULT false,
  "defaultSearchBudgetSeconds" INTEGER,
  "maxOptimizationTimeSeconds" INTEGER,
  "unassignedOrderPenaltyVnd" BIGINT,
  "maxRoutesPerDay" INTEGER,
  "demoAllowOverride" BOOLEAN,

  "overrideCostPenalty" BOOLEAN NOT NULL DEFAULT false,
  "fuelPricePerLiter" DECIMAL(12, 2),
  "monthlyWorkingMinutes" INTEGER,
  "cargoHoldingCostVndPerTonHour" DECIMAL(14, 2),
  "workStartTime" TEXT,
  "workEndTime" TEXT,
  "deliveryGraceDays" INTEGER,
  "lateDeliveryPenaltyMode" "LateDeliveryPenaltyMode",
  "lateDeliveryPenaltyValue" DECIMAL(14, 4),

  "updatedById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "system_settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "system_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "system_settings_scope_check" CHECK (
    ("scopeType" = 'COMPANY' AND "branchId" IS NULL AND NOT "overrideStacking" AND NOT "overrideOptimization" AND NOT "overrideCostPenalty")
    OR ("scopeType" = 'BRANCH' AND "branchId" IS NOT NULL)
  ),
  CONSTRAINT "system_settings_values_check" CHECK (
    ("stackingMaxTiers" IS NULL OR ("stackingMaxTiers" BETWEEN 2 AND 20))
    AND ("stackingLiftClearanceMm" IS NULL OR ("stackingLiftClearanceMm" > 0 AND "stackingLiftClearanceMm" <= 5000))
    AND ("defaultSearchBudgetSeconds" IS NULL OR ("defaultSearchBudgetSeconds" BETWEEN 1 AND 120))
    AND ("maxOptimizationTimeSeconds" IS NULL OR ("maxOptimizationTimeSeconds" BETWEEN 5 AND 600))
    AND ("defaultSearchBudgetSeconds" IS NULL OR "maxOptimizationTimeSeconds" IS NULL OR "defaultSearchBudgetSeconds" <= "maxOptimizationTimeSeconds")
    AND ("unassignedOrderPenaltyVnd" IS NULL OR "unassignedOrderPenaltyVnd" > 0)
    AND ("maxRoutesPerDay" IS NULL OR ("maxRoutesPerDay" BETWEEN 1 AND 500))
    AND ("fuelPricePerLiter" IS NULL OR "fuelPricePerLiter" > 0)
    AND ("monthlyWorkingMinutes" IS NULL OR ("monthlyWorkingMinutes" BETWEEN 60 AND 44640))
    AND ("cargoHoldingCostVndPerTonHour" IS NULL OR "cargoHoldingCostVndPerTonHour" >= 0)
    AND ("deliveryGraceDays" IS NULL OR ("deliveryGraceDays" BETWEEN 0 AND 365))
    AND ("lateDeliveryPenaltyValue" IS NULL OR "lateDeliveryPenaltyValue" >= 0)
    AND ("lateDeliveryPenaltyMode" IS DISTINCT FROM 'PERCENT_ORDER_VALUE_PER_DAY' OR "lateDeliveryPenaltyValue" IS NULL OR "lateDeliveryPenaltyValue" <= 100)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_settings_company_key"
  ON "system_settings" ("scopeType")
  WHERE "scopeType" = 'COMPANY';

CREATE UNIQUE INDEX IF NOT EXISTS "system_settings_branchId_key"
  ON "system_settings" ("branchId");

INSERT INTO "system_settings" (
  "scopeType",
  "branchId",
  "version",
  "stackingEnabled",
  "stackingOwnerMode",
  "stackingMaxTiers",
  "stackingLiftClearanceMm",
  "defaultSearchBudgetSeconds",
  "maxOptimizationTimeSeconds",
  "unassignedOrderPenaltyVnd",
  "maxRoutesPerDay",
  "demoAllowOverride",
  "fuelPricePerLiter",
  "monthlyWorkingMinutes",
  "cargoHoldingCostVndPerTonHour",
  "workStartTime",
  "workEndTime",
  "deliveryGraceDays",
  "lateDeliveryPenaltyMode",
  "lateDeliveryPenaltyValue"
)
SELECT
  'COMPANY',
  NULL,
  1,
  false,
  'SAME_CUSTOMER',
  2,
  50,
  10,
  120,
  1000000000,
  NULL,
  true,
  23500,
  10560,
  0,
  '08:00',
  '17:00',
  2,
  'NONE',
  0
WHERE NOT EXISTS (
  SELECT 1 FROM "system_settings" WHERE "scopeType" = 'COMPANY'
);

-- Bao toan gia tri chi phi / phat tre hien huu cua tung chi nhanh khi khoi tao
INSERT INTO "system_settings" (
  "scopeType",
  "branchId",
  "version",
  "overrideCostPenalty",
  "fuelPricePerLiter",
  "monthlyWorkingMinutes",
  "cargoHoldingCostVndPerTonHour",
  "workStartTime",
  "workEndTime",
  "deliveryGraceDays",
  "lateDeliveryPenaltyMode",
  "lateDeliveryPenaltyValue"
)
SELECT
  'BRANCH',
  b."id",
  1,
  true,
  b."fuelPricePerLiter",
  b."monthlyWorkingMinutes",
  b."cargoHoldingCostVndPerTonHour",
  b."workStartTime",
  b."workEndTime",
  b."deliveryGraceDays",
  b."lateDeliveryPenaltyMode",
  b."lateDeliveryPenaltyValue"
FROM "branches" b
WHERE (
  b."fuelPricePerLiter" <> 23500
  OR b."monthlyWorkingMinutes" <> 10560
  OR b."cargoHoldingCostVndPerTonHour" <> 0
  OR b."workStartTime" <> '08:00'
  OR b."workEndTime" <> '17:00'
  OR b."deliveryGraceDays" <> 2
  OR b."lateDeliveryPenaltyMode" <> 'NONE'
  OR b."lateDeliveryPenaltyValue" <> 0
)
ON CONFLICT ("branchId") DO NOTHING;

INSERT INTO "permissions" ("id", "code", "description")
VALUES
  (gen_random_uuid()::text, 'settings.read', 'Xem cau hinh chung va chinh sach van hanh'),
  (gen_random_uuid()::text, 'settings.manage', 'Quan ly va chinh sua cau hinh chung')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('settings.read', 'settings.manage')
WHERE r."code" = 'ADMIN'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'settings.read'
WHERE r."code" = 'DISPATCHER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
