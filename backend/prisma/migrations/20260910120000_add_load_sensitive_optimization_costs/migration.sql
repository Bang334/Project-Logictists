-- Additive, disabled-by-default policy fields for load-sensitive route economics.
-- Existing environments keep their current routing behavior until calibrated
-- values are configured for a branch and its vehicles.
ALTER TABLE "branches"
  ADD COLUMN "cargoHoldingCostVndPerTonHour" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "branches_cargo_holding_cost_nonnegative"
    CHECK ("cargoHoldingCostVndPerTonHour" >= 0);

ALTER TABLE "vehicles"
  ADD COLUMN "loadFuelSurchargePercentAtFullPayload" DECIMAL(6,3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "vehicles_load_fuel_surcharge_nonnegative"
    CHECK ("loadFuelSurchargePercentAtFullPayload" >= 0);
