ALTER TABLE "system_settings"
    ADD COLUMN "enforceWeightBalance" BOOLEAN,
    ADD COLUMN "weightBalancePenaltyVndPerPercent" INTEGER,
    ADD COLUMN "maxLateralImbalancePercent" DOUBLE PRECISION,
    ADD COLUMN "maxLongitudinalImbalancePercent" DOUBLE PRECISION;
