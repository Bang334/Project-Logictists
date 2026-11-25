BEGIN;

-- On clean installations these columns are new. A target with completion DDL
-- already installed must have the same types, completion FK and unique key.
ALTER TABLE public.driver_assignments
  ADD COLUMN IF NOT EXISTS "actualEndTime" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "completionEventId" text;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'driver_assignments'
      AND is_nullable = 'YES' AND column_default IS NULL
      AND (
        (column_name = 'actualEndTime' AND data_type = 'timestamp with time zone' AND datetime_precision = 3)
        OR (column_name = 'completionEventId' AND data_type = 'text')
      )
  ) <> 2 THEN RAISE EXCEPTION 'Unexpected driver assignment completion column definitions'; END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.driver_assignments'::regclass
      AND conname = 'driver_assignments_completionEventId_fkey') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.driver_assignments'::regclass
        AND conname = 'driver_assignments_completionEventId_fkey'
        AND confrelid = 'public.execution_events'::regclass AND convalidated
        AND pg_get_constraintdef(oid) = 'FOREIGN KEY ("completionEventId") REFERENCES execution_events(id) ON DELETE RESTRICT') THEN
      RAISE EXCEPTION 'Unexpected completion event FK';
    END IF;
  ELSE
    ALTER TABLE public.driver_assignments
      ADD CONSTRAINT "driver_assignments_completionEventId_fkey"
      FOREIGN KEY ("completionEventId") REFERENCES public.execution_events(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "driver_assignments_completionEventId_key"
  ON public.driver_assignments ("completionEventId");
CREATE UNIQUE INDEX IF NOT EXISTS trip_completed_event_once
  ON public.execution_events ("tripId") WHERE "eventType" = 'TRIP_COMPLETED';

ALTER TABLE public.driver_assignments
  ADD CONSTRAINT driver_assignment_completion_pair_next CHECK (
    ("actualEndTime" IS NULL AND "completionEventId" IS NULL)
    OR (
      "actualEndTime" IS NOT NULL AND "completionEventId" IS NOT NULL
      AND (status = 'ACCEPTED' OR (status = 'ASSIGNED' AND role = 'PRIMARY'))
    )
  );
ALTER TABLE public.driver_assignments DROP CONSTRAINT IF EXISTS driver_assignment_completion_pair;
ALTER TABLE public.driver_assignments RENAME CONSTRAINT driver_assignment_completion_pair_next TO driver_assignment_completion_pair;

-- Preserve the planned window for assignments still open. A completed
-- assignment remains in history and no longer blocks the remainder.
ALTER TABLE public.driver_assignments
  DROP CONSTRAINT driver_assignments_no_overlap,
  ADD CONSTRAINT driver_assignments_no_overlap
    EXCLUDE USING gist ("driverId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&)
    WHERE (status IN ('ASSIGNED','ACCEPTED','ACTIVE') AND "actualEndTime" IS NULL);

CREATE OR REPLACE FUNCTION public.validate_assignment_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."completionEventId" IS NOT NULL THEN RAISE EXCEPTION 'Completed assignment history cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."completionEventId" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Completed assignment history is immutable';
  END IF;
  IF NEW."completionEventId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.execution_events e
    JOIN public.trips t ON t.id = e."tripId"
    JOIN public.drivers d ON d.id = NEW."driverId"
    WHERE e.id = NEW."completionEventId" AND e."tripId" = NEW."tripId"
      AND e."eventType" = 'TRIP_COMPLETED'
      AND e."actorUserId" = d."userId" AND e."occurredAt" = NEW."actualEndTime"
      AND e.payload->>'assignmentId' = NEW.id
      AND t.status = 'COMPLETED' AND t."actualEndTime" = NEW."actualEndTime"
      AND t."actualStartTime" IS NOT NULL AND t."actualStartTime" <= NEW."actualEndTime"
  ) THEN
    RAISE EXCEPTION 'Invalid assignment completion evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER driver_assignment_completion_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.driver_assignments
FOR EACH ROW EXECUTE FUNCTION public.validate_assignment_completion();

CREATE OR REPLACE FUNCTION public.validate_trip_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW.status <> 'COMPLETED' AND EXISTS (
    SELECT 1 FROM public.execution_events WHERE "tripId" = NEW.id AND "eventType" = 'TRIP_COMPLETED'
  ) THEN
    RAISE EXCEPTION 'Completed execution cannot be reopened';
  END IF;
  IF NEW.status = 'COMPLETED'
    AND (OLD.status <> 'COMPLETED' OR NEW."actualEndTime" IS DISTINCT FROM OLD."actualEndTime")
    AND NOT EXISTS (
      SELECT 1 FROM public.execution_events e
      JOIN public.driver_assignments a ON a."completionEventId" = e.id
      WHERE e."tripId" = NEW.id AND e."eventType" = 'TRIP_COMPLETED' AND a."tripId" = NEW.id
        AND NEW."actualEndTime" = e."occurredAt" AND a."actualEndTime" = NEW."actualEndTime"
    )
  THEN
    RAISE EXCEPTION 'Trip completion requires linked execution evidence';
  END IF;
  RETURN NEW;
END $$;

-- Constraint triggers cannot be replaced in place. Replace atomically under DDL lock.
DROP TRIGGER IF EXISTS trip_completion_evidence ON public.trips;
CREATE CONSTRAINT TRIGGER trip_completion_evidence AFTER UPDATE ON public.trips
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_trip_completion();

CREATE FUNCTION public.protect_trip_completion_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Trip completion evidence is immutable';
END $$;

CREATE TRIGGER immutable_trip_completion_event
BEFORE UPDATE OR DELETE ON public.execution_events FOR EACH ROW
WHEN (OLD."eventType" = 'TRIP_COMPLETED')
EXECUTE FUNCTION public.protect_trip_completion_event();

COMMIT;
