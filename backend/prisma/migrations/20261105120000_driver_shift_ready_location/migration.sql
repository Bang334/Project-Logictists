BEGIN;
-- Preserve legacy shifts as unknown; no inferred position or backfill.
ALTER TABLE driver_shifts
  ADD COLUMN "readyAt" timestamptz(3),
  ADD COLUMN "readyAddress" text,
  ADD COLUMN "readyLatitude" double precision,
  ADD COLUMN "readyLongitude" double precision;
ALTER TABLE driver_shifts ADD CONSTRAINT driver_shift_ready_location CHECK (
  ("readyAt" IS NULL AND "readyAddress" IS NULL AND "readyLatitude" IS NULL AND "readyLongitude" IS NULL)
  OR ("readyAt" IS NOT NULL AND "readyAddress" IS NOT NULL AND length(trim("readyAddress")) > 0
    AND "readyLatitude" IS NOT NULL AND "readyLatitude" BETWEEN -90 AND 90
    AND "readyLongitude" IS NOT NULL AND "readyLongitude" BETWEEN -180 AND 180
    AND "readyAt" >= "startsAt" AND "readyAt" < "endsAt")
);
COMMIT;
