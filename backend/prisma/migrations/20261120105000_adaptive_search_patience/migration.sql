ALTER TABLE "system_settings"
  ADD COLUMN "earlyStopPatience" INTEGER,
  ADD CONSTRAINT "system_settings_early_stop_patience_check"
    CHECK ("earlyStopPatience" BETWEEN 0 AND 1000),
  DROP CONSTRAINT "system_settings_values_check",
  ADD CONSTRAINT "system_settings_values_check" CHECK (
    ("stackingMaxTiers" IS NULL OR ("stackingMaxTiers" BETWEEN 2 AND 20))
    AND ("stackingLiftClearanceMm" IS NULL OR ("stackingLiftClearanceMm" > 0 AND "stackingLiftClearanceMm" <= 5000))
    AND ("defaultSearchBudgetSeconds" IS NULL OR ("defaultSearchBudgetSeconds" BETWEEN 1 AND 1000))
    AND ("maxOptimizationTimeSeconds" IS NULL OR ("maxOptimizationTimeSeconds" BETWEEN 5 AND 1000))
    AND ("defaultSearchBudgetSeconds" IS NULL OR "maxOptimizationTimeSeconds" IS NULL OR "defaultSearchBudgetSeconds" <= "maxOptimizationTimeSeconds")
    AND ("unassignedOrderPenaltyVnd" IS NULL OR "unassignedOrderPenaltyVnd" > 0)
    AND ("maxRoutesPerDay" IS NULL OR ("maxRoutesPerDay" BETWEEN 1 AND 500))
    AND ("fuelPricePerLiter" IS NULL OR "fuelPricePerLiter" > 0)
    AND ("monthlyWorkingMinutes" IS NULL OR ("monthlyWorkingMinutes" BETWEEN 60 AND 44640))
    AND ("cargoHoldingCostVndPerTonHour" IS NULL OR "cargoHoldingCostVndPerTonHour" >= 0)
    AND ("deliveryGraceDays" IS NULL OR ("deliveryGraceDays" BETWEEN 0 AND 365))
    AND ("lateDeliveryPenaltyValue" IS NULL OR "lateDeliveryPenaltyValue" >= 0)
    AND ("lateDeliveryPenaltyMode" IS DISTINCT FROM 'PERCENT_ORDER_VALUE_PER_DAY' OR "lateDeliveryPenaltyValue" IS NULL OR "lateDeliveryPenaltyValue" <= 100)
  );
