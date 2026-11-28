ALTER TABLE "packages"
  ADD COLUMN IF NOT EXISTS "custodyLocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "returnedToHubAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "trip_stops"
  ADD COLUMN IF NOT EXISTS "hubLocationId" TEXT,
  ADD COLUMN IF NOT EXISTS "skipReason" TEXT;

ALTER TABLE "delivery_attempts"
  ADD COLUMN IF NOT EXISTS "failureCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "requestedRedeliveryAt" TIMESTAMPTZ(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'packages_custodyLocationId_fkey'
  ) THEN
    ALTER TABLE "packages"
      ADD CONSTRAINT "packages_custodyLocationId_fkey"
      FOREIGN KEY ("custodyLocationId") REFERENCES "locations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trip_stops_hubLocationId_fkey'
  ) THEN
    ALTER TABLE "trip_stops"
      ADD CONSTRAINT "trip_stops_hubLocationId_fkey"
      FOREIGN KEY ("hubLocationId") REFERENCES "locations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "packages_custodyLocationId_status_idx"
  ON "packages"("custodyLocationId", "status");

CREATE INDEX IF NOT EXISTS "trip_stops_hubLocationId_idx"
  ON "trip_stops"("hubLocationId");

CREATE UNIQUE INDEX IF NOT EXISTS "allocations_active_package_unique"
  ON "allocations"("packageId")
  WHERE "packageId" IS NOT NULL AND "releasedAt" IS NULL;

UPDATE "packages" p
SET "deliveryAttemptCount" = sub.cnt
FROM (
  SELECT dr."packageId", COUNT(*)::int AS cnt
  FROM "delivery_results" dr
  JOIN "delivery_attempts" da ON da.id = dr."deliveryAttemptId"
  WHERE da.result = 'FAILED'
  GROUP BY dr."packageId"
) sub
WHERE p.id = sub."packageId"
  AND p."deliveryAttemptCount" = 0;
