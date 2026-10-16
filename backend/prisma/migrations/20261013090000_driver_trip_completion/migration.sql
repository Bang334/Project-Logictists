BEGIN;
-- Additive: no completion inferred for historical trips or assignments.
ALTER TABLE driver_assignments
 ADD COLUMN "actualEndTime" timestamptz(3),
 ADD COLUMN "completionEventId" text UNIQUE REFERENCES execution_events(id) ON DELETE RESTRICT,
 ADD CONSTRAINT driver_assignment_completion_pair CHECK (
  ("actualEndTime" IS NULL AND "completionEventId" IS NULL) OR
  ("actualEndTime" IS NOT NULL AND "completionEventId" IS NOT NULL AND status='ACCEPTED')
 );
CREATE UNIQUE INDEX trip_completed_event_once ON execution_events("tripId") WHERE "eventType"='TRIP_COMPLETED';
-- Keep original scheduled times as history; a verified completion ends occupancy.
ALTER TABLE driver_assignments DROP CONSTRAINT driver_assignments_no_overlap;
ALTER TABLE driver_assignments ADD CONSTRAINT driver_assignments_no_overlap
 EXCLUDE USING gist ("driverId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&)
 WHERE (status IN ('ASSIGNED','ACCEPTED','ACTIVE') AND "actualEndTime" IS NULL);
CREATE FUNCTION validate_assignment_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."completionEventId" IS NOT NULL THEN RAISE EXCEPTION 'Completed assignment history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD."completionEventId" IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Completed assignment history is immutable';
 END IF;
 IF NEW."completionEventId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM execution_events e JOIN trips t ON t.id=e."tripId" JOIN drivers d ON d.id=NEW."driverId"
  WHERE e.id=NEW."completionEventId" AND e."tripId"=NEW."tripId" AND e."eventType"='TRIP_COMPLETED'
   AND e."actorUserId"=d."userId" AND e."occurredAt"=NEW."actualEndTime"
   AND e.payload->>'assignmentId'=NEW.id
   AND t.status::text='COMPLETED' AND t."actualEndTime"=NEW."actualEndTime"
   AND t."actualStartTime" IS NOT NULL AND t."actualStartTime"<=NEW."actualEndTime"
 ) THEN RAISE EXCEPTION 'Invalid assignment completion evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_assignment_completion_guard BEFORE INSERT OR UPDATE OR DELETE ON driver_assignments
 FOR EACH ROW EXECUTE FUNCTION validate_assignment_completion();
CREATE FUNCTION validate_trip_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status::text='COMPLETED' AND NEW.status::text<>'COMPLETED' AND EXISTS (
  SELECT 1 FROM execution_events WHERE "tripId"=NEW.id AND "eventType"='TRIP_COMPLETED'
 ) THEN RAISE EXCEPTION 'Completed execution cannot be reopened'; END IF;
 IF NEW.status::text='COMPLETED' AND (OLD.status::text<>'COMPLETED' OR NEW."actualEndTime" IS DISTINCT FROM OLD."actualEndTime") THEN
  IF NOT EXISTS (SELECT 1 FROM execution_events e JOIN driver_assignments a ON a."completionEventId"=e.id
   WHERE e."tripId"=NEW.id AND e."eventType"='TRIP_COMPLETED' AND a."tripId"=NEW.id
    AND NEW."actualEndTime"=e."occurredAt" AND a."actualEndTime"=NEW."actualEndTime")
   THEN RAISE EXCEPTION 'Trip completion requires linked execution evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER trip_completion_evidence AFTER UPDATE ON trips
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_trip_completion();
COMMIT;
