BEGIN;

-- 1. Drop external FKs from active tables pointing to retired trip_execution_snapshots
ALTER TABLE "delivery_attempts" DROP CONSTRAINT IF EXISTS "delivery_attempts_sourceSnapshotId_fkey";
ALTER TABLE "execution_events" DROP CONSTRAINT IF EXISTS "execution_snapshot_trip_fk";
ALTER TABLE "pod_files" DROP CONSTRAINT IF EXISTS "pod_files_sourceSnapshotId_fkey";

-- 2. Rewrite trigger functions so active tables no longer reference driver_shifts or trip_execution_snapshots
CREATE OR REPLACE FUNCTION public.fleet_driver_window_ok(
  resource_id text,
  start_at timestamp with time zone,
  end_at timestamp with time zone
)
RETURNS boolean
LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "public"."drivers" d
    WHERE d.id = resource_id
      AND end_at <= ((d."licenseExpiry" + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "public"."employee_leave" l
    JOIN "public"."drivers" d ON d."employeeId" = l."employeeId"
    WHERE d.id = resource_id
      AND l."approvalStatus" = 'APPROVED'
      AND tstzrange(l."startsAt", l."endsAt", '[)') && tstzrange(start_at, end_at, '[)')
  );
$function$;

CREATE OR REPLACE FUNCTION public.fleet_schedule_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE resource_id text;
BEGIN
  IF TG_TABLE_NAME = 'vehicle_unavailability' THEN
    IF NEW.status = 'ACTIVE' AND NEW.kind <> 'BREAKDOWN' AND (
      EXISTS (
        SELECT 1 FROM "public"."resource_reservations" r
        WHERE r."vehicleId" = NEW."vehicleId"
          AND r.status::text IN ('HELD', 'ACTIVE')
          AND tstzrange(r."startsAt", r."endsAt", '[)') && tstzrange(NEW."startsAt", NEW."endsAt", '[)')
      ) OR EXISTS (
        SELECT 1 FROM "public"."trips" t
        WHERE t."vehicleId" = NEW."vehicleId"
          AND t.status::text IN ('PLANNED', 'DISPATCHED', 'IN_PROGRESS')
          AND tstzrange(t."plannedStartTime", t."plannedEndTime", '[)') && tstzrange(NEW."startsAt", NEW."endsAt", '[)')
      )
    ) THEN
      RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT id INTO resource_id FROM "public"."drivers" WHERE "employeeId" = NEW."employeeId";
    IF NEW."approvalStatus" <> 'APPROVED' THEN
      RETURN NEW;
    END IF;
    IF EXISTS (
      SELECT 1 FROM "public"."resource_reservations" r
      WHERE r."driverId" = resource_id
        AND r.status::text IN ('HELD', 'ACTIVE')
        AND (
          tstzrange(r."startsAt", r."endsAt", '[)') && tstzrange(NEW."startsAt", NEW."endsAt", '[)')
          OR (TG_OP = 'UPDATE' AND tstzrange(r."startsAt", r."endsAt", '[)') && tstzrange(OLD."startsAt", OLD."endsAt", '[)'))
        )
        AND NOT fleet_driver_window_ok(resource_id, r."startsAt", r."endsAt")
    ) OR EXISTS (
      SELECT 1 FROM "public"."driver_assignments" a
      JOIN "public"."trips" t ON t.id = a."tripId"
      WHERE a."driverId" = resource_id
        AND t.status::text IN ('PLANNED', 'DISPATCHED', 'IN_PROGRESS')
        AND (
          tstzrange(a."startTime", a."endTime", '[)') && tstzrange(NEW."startsAt", NEW."endsAt", '[)')
          OR (TG_OP = 'UPDATE' AND tstzrange(a."startTime", a."endTime", '[)') && tstzrange(OLD."startsAt", OLD."endsAt", '[)'))
        )
        AND NOT fleet_driver_window_ok(resource_id, a."startTime", a."endTime")
    ) THEN
      RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fleet_schedule_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE resource_id text;
BEGIN
  IF TG_TABLE_NAME = 'vehicle_unavailability' THEN
    IF TG_OP = 'UPDATE' AND NEW."vehicleId" <> OLD."vehicleId" THEN
      RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE = '23514';
    END IF;
    resource_id := NEW."vehicleId";
    PERFORM pg_advisory_xact_lock(4101, hashtext(resource_id));
  ELSE
    IF TG_OP = 'UPDATE' AND NEW."employeeId" <> OLD."employeeId" THEN
      RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE = '23514';
    END IF;
    SELECT id INTO resource_id FROM "public"."drivers" WHERE "employeeId" = NEW."employeeId";
    IF resource_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(4102, hashtext(resource_id));
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.validate_driver_pod_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."ownerUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."deliveryAttemptId" IS NOT NULL
    OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
    OR NEW."assignmentId" IS DISTINCT FROM OLD."assignmentId"
    OR NEW."tripStopId" IS DISTINCT FROM OLD."tripStopId"
    OR NEW."sourceSnapshotId" IS DISTINCT FROM OLD."sourceSnapshotId"
    OR NEW."storageKey" <> OLD."storageKey"
    OR NEW."sizeBytes" <> OLD."sizeBytes"
    OR NEW."mediaType" <> OLD."mediaType"
  ) THEN
    RAISE EXCEPTION 'POD identity or attached evidence is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "public"."driver_assignments" a
    JOIN "public"."drivers" d ON d.id = a."driverId"
    JOIN "public"."trip_stops" s ON s."tripId" = a."tripId"
    WHERE a.id = NEW."assignmentId"
      AND d."userId" = NEW."ownerUserId"
      AND s.id = NEW."tripStopId"
  ) THEN
    RAISE EXCEPTION 'POD scope mismatch';
  END IF;
  IF NEW."deliveryAttemptId" IS NOT NULL AND (
    NEW."uploadStatus"::text <> 'UPLOADED'
    OR NEW."discardedAt" IS NOT NULL
    OR NOT EXISTS (
      SELECT 1
      FROM "public"."delivery_attempts" d
      JOIN "public"."processed_commands" c ON c.id = d."commandId"
      WHERE d.id = NEW."deliveryAttemptId"
        AND d."tripStopId" = NEW."tripStopId"
        AND c."actorUserId" = NEW."ownerUserId"
    )
  ) THEN
    RAISE EXCEPTION 'POD cannot attach to this attempt';
  END IF;
  RETURN NEW;
END
$function$;

-- 3. Drop remaining 5 legacy orphan tables outside schema.prisma
DROP TABLE IF EXISTS
  "driver_delivery_states",
  "pickup_results",
  "trip_execution_snapshots",
  "driver_shifts",
  "customer_branches";

-- 4. Drop helper functions only belonging to dropped execution/pickup tables
DROP FUNCTION IF EXISTS public.validate_driver_delivery_state();
DROP FUNCTION IF EXISTS public.validate_pickup_result();

COMMIT;
