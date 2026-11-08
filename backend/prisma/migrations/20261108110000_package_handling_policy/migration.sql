BEGIN;

CREATE TYPE "CargoKind" AS ENUM ('UNCLASSIFIED', 'STANDARD', 'FRAGILE');

ALTER TABLE "packages"
  ADD COLUMN "cargoKind" "CargoKind" NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "allowUpperTier" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "noTopLoadRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maxTopLoadG" INTEGER,
  ADD CONSTRAINT "packages_handling_policy_check" CHECK (
    (NOT "allowUpperTier" OR "cargoKind" = 'STANDARD')
    AND (NOT "noTopLoadRequested" OR "cargoKind" = 'STANDARD')
    AND ("maxTopLoadG" IS NULL OR ("maxTopLoadG" > 0 AND "cargoKind" = 'STANDARD'))
  );

CREATE UNIQUE INDEX "order_charges_top_load_protection_key"
  ON "order_charges" ("orderId") WHERE "chargeType" = 'TOP_LOAD_PROTECTION';

COMMIT;
