-- Inter-provincial warehouse-to-warehouse transport schema extensions (additive & idempotent)

DO $enum_cargo_temp$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CargoTemperature') THEN
    CREATE TYPE "CargoTemperature" AS ENUM ('DRY', 'CHILLED', 'FROZEN');
  END IF;
END
$enum_cargo_temp$;

DO $enum_temp_mode$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TemperatureMode') THEN
    CREATE TYPE "TemperatureMode" AS ENUM ('DRY', 'CHILLED', 'FROZEN', 'ISOTHERMAL');
  END IF;
END
$enum_temp_mode$;

DO $enum_wh_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WarehouseRole') THEN
    CREATE TYPE "WarehouseRole" AS ENUM ('HUB', 'WAREHOUSE', 'TRANSIT');
  END IF;
END
$enum_wh_role$;

ALTER TABLE "locations"
  ADD COLUMN IF NOT EXISTS "provinceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "provinceName" TEXT,
  ADD COLUMN IF NOT EXISTS "warehouseRole" "WarehouseRole",
  ADD COLUMN IF NOT EXISTS "dockingTimeSec" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxVehiclePayloadKg" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "maxVehicleLengthCm" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "hasForklift" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "operatingWindows" JSONB,
  ADD COLUMN IF NOT EXISTS "handlingSecPerTon" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "handlingSecPerPackage" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "locations_provinceCode_idx" ON "locations"("provinceCode");

DO $chk_locations$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'locations_interprovincial_checks') THEN
    ALTER TABLE "locations"
      ADD CONSTRAINT "locations_interprovincial_checks" CHECK (
        "dockingTimeSec" >= 0
        AND "handlingSecPerTon" >= 0
        AND "handlingSecPerPackage" >= 0
        AND ("maxVehiclePayloadKg" IS NULL OR "maxVehiclePayloadKg" > 0)
        AND ("maxVehicleLengthCm" IS NULL OR "maxVehicleLengthCm" > 0)
      );
  END IF;
END
$chk_locations$;

ALTER TABLE "vehicle_types"
  ADD COLUMN IF NOT EXISTS "temperatureMode" "TemperatureMode" NOT NULL DEFAULT 'DRY',
  ADD COLUMN IF NOT EXISTS "hasTailLift" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "tollFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

DO $chk_vehicle_types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_types_toll_factor_positive') THEN
    ALTER TABLE "vehicle_types"
      ADD CONSTRAINT "vehicle_types_toll_factor_positive" CHECK ("tollFactor" > 0);
  END IF;
END
$chk_vehicle_types$;

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "returnToDepot" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "endDepotLocationId" TEXT;

CREATE INDEX IF NOT EXISTS "vehicles_endDepotLocationId_idx" ON "vehicles"("endDepotLocationId");

DO $fk_vehicles_end_depot$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_endDepotLocationId_fkey') THEN
    ALTER TABLE "vehicles"
      ADD CONSTRAINT "vehicles_endDepotLocationId_fkey"
      FOREIGN KEY ("endDepotLocationId") REFERENCES "locations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$fk_vehicles_end_depot$;

ALTER TABLE "drivers"
  ADD COLUMN IF NOT EXISTS "homeLocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "homeProvinceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "strictHomeLocation" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "drivers_homeLocationId_idx" ON "drivers"("homeLocationId");

DO $fk_drivers_home_loc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_homeLocationId_fkey') THEN
    ALTER TABLE "drivers"
      ADD CONSTRAINT "drivers_homeLocationId_fkey"
      FOREIGN KEY ("homeLocationId") REFERENCES "locations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$fk_drivers_home_loc$;

ALTER TABLE "order_stops"
  ADD COLUMN IF NOT EXISTS "locationId" TEXT;

CREATE INDEX IF NOT EXISTS "order_stops_locationId_idx" ON "order_stops"("locationId");

DO $fk_order_stops_loc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_stops_locationId_fkey') THEN
    ALTER TABLE "order_stops"
      ADD CONSTRAINT "order_stops_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "locations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$fk_order_stops_loc$;

ALTER TABLE "packages"
  ADD COLUMN IF NOT EXISTS "requiredTemperature" "CargoTemperature",
  ADD COLUMN IF NOT EXISTS "cargoGroup" TEXT,
  ADD COLUMN IF NOT EXISTS "incompatibleCargoGroups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "requiresLiftEquipment" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "toll_corridors" (
  "id" TEXT NOT NULL,
  "fromProvinceCode" TEXT NOT NULL,
  "toProvinceCode" TEXT NOT NULL,
  "highwayName" TEXT,
  "baseTollVnd" INTEGER NOT NULL DEFAULT 0,
  "distanceHintKm" DOUBLE PRECISION,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "toll_corridors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "toll_corridors_fromProvinceCode_toProvinceCode_key"
  ON "toll_corridors"("fromProvinceCode", "toProvinceCode");

CREATE INDEX IF NOT EXISTS "toll_corridors_active_idx"
  ON "toll_corridors"("active");

DO $chk_toll_corridors$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'toll_corridors_nonnegative_check') THEN
    ALTER TABLE "toll_corridors"
      ADD CONSTRAINT "toll_corridors_nonnegative_check" CHECK (
        "baseTollVnd" >= 0
        AND ("distanceHintKm" IS NULL OR "distanceHintKm" >= 0)
      );
  END IF;
END
$chk_toll_corridors$;
