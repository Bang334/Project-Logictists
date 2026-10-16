BEGIN;
ALTER TABLE delivery_attempts ADD COLUMN "sourceSnapshotId" text REFERENCES trip_execution_snapshots(id) ON DELETE RESTRICT;
-- Enforce all new writes; legacy command references need a separate inventory.
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempt_command_fk FOREIGN KEY ("commandId") REFERENCES processed_commands(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE delivery_results ADD COLUMN "executionEventId" text REFERENCES execution_events(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX delivery_task_executed_once ON delivery_results("stopTaskId") WHERE "executionEventId" IS NOT NULL;
CREATE UNIQUE INDEX delivery_package_delivered_once ON delivery_results("packageId") WHERE "executionEventId" IS NOT NULL AND result='DELIVERED';
CREATE TABLE driver_delivery_states (
 "stopTaskId" text PRIMARY KEY REFERENCES stop_tasks(id) ON DELETE RESTRICT,
 "pickupResultId" text NOT NULL REFERENCES pickup_results(id) ON DELETE RESTRICT,
 "lastEventId" text NOT NULL UNIQUE REFERENCES execution_events(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK(state IN ('UNLOADED','ON_VEHICLE','DELIVERED','FAILED'))
);
ALTER TABLE pod_files ALTER COLUMN "deliveryAttemptId" DROP NOT NULL;
ALTER TABLE pod_files ADD COLUMN "ownerUserId" text REFERENCES users(id) ON DELETE RESTRICT,
 ADD COLUMN "assignmentId" text REFERENCES driver_assignments(id) ON DELETE RESTRICT,
 ADD COLUMN "tripStopId" text REFERENCES trip_stops(id) ON DELETE RESTRICT,
 ADD COLUMN "sourceSnapshotId" text REFERENCES trip_execution_snapshots(id) ON DELETE RESTRICT,
 ADD COLUMN "sizeBytes" integer,
 ADD COLUMN "expiresAt" timestamptz(3),
 ADD COLUMN "discardedAt" timestamptz(3);
ALTER TABLE pod_files ADD CONSTRAINT driver_pod_scope_complete CHECK (
 "ownerUserId" IS NULL OR ("assignmentId" IS NOT NULL AND "tripStopId" IS NOT NULL AND "sourceSnapshotId" IS NOT NULL AND "sizeBytes">0 AND "expiresAt" IS NOT NULL)
);
CREATE INDEX driver_pod_pending_cleanup ON pod_files("expiresAt") WHERE "ownerUserId" IS NOT NULL AND "deliveryAttemptId" IS NULL;
CREATE UNIQUE INDEX delivery_stop_completed_once ON execution_events("tripStopId") WHERE "eventType"='DELIVERY_STOP_COMPLETED';
CREATE FUNCTION validate_driver_delivery_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.state NOT IN ('UNLOADED','FAILED') THEN RAISE EXCEPTION 'Invalid initial delivery state'; END IF;
 IF TG_OP='UPDATE' AND (NEW."pickupResultId"<>OLD."pickupResultId" OR NEW."stopTaskId"<>OLD."stopTaskId" OR NEW."lastEventId"=OLD."lastEventId" OR NOT (
  (OLD.state='UNLOADED' AND NEW.state IN ('ON_VEHICLE','DELIVERED')) OR
  (OLD.state='ON_VEHICLE' AND NEW.state IN ('UNLOADED','FAILED'))
 )) THEN RAISE EXCEPTION 'Invalid delivery custody transition'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM stop_tasks t JOIN trip_stops s ON s.id=t."tripStopId"
  JOIN allocations a ON a.id=t."allocationId" JOIN pickup_results p ON p.id=NEW."pickupResultId"
  JOIN execution_events e ON e.id=NEW."lastEventId" JOIN execution_events pe ON pe.id=p."eventId"
  WHERE t.id=NEW."stopTaskId" AND t.action::text='UNLOAD' AND p.outcome='LOADED'
  AND p."allocationId"=a.id AND p."packageId"=a."packageId" AND a."tripId"=s."tripId"
  AND e."stopTaskId"=t.id AND e."tripStopId"=s.id AND e."tripId"=s."tripId"
  AND e."sourceSnapshotId"=pe."sourceSnapshotId" AND pe."tripId"=s."tripId"
  AND e."eventType"=CASE NEW.state WHEN 'UNLOADED' THEN 'PACKAGE_UNLOADED' WHEN 'ON_VEHICLE' THEN 'PACKAGE_RELOADED' WHEN 'DELIVERED' THEN 'PACKAGE_DELIVERED' ELSE 'PACKAGE_DELIVERY_FAILED' END
 ) THEN RAISE EXCEPTION 'Invalid delivery custody linkage'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_delivery_state_consistency BEFORE INSERT OR UPDATE ON driver_delivery_states FOR EACH ROW EXECUTE FUNCTION validate_driver_delivery_state();
CREATE TRIGGER immutable_delivery_state_identity BEFORE DELETE ON driver_delivery_states FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
CREATE FUNCTION validate_driver_delivery_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."executionEventId" IS NULL THEN RETURN NEW; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM delivery_attempts d JOIN stop_tasks t ON t.id=NEW."stopTaskId"
  JOIN allocations a ON a.id=t."allocationId" JOIN trip_stops s ON s.id=t."tripStopId"
  JOIN execution_events e ON e.id=NEW."executionEventId"
  WHERE d.id=NEW."deliveryAttemptId" AND d."tripStopId"=s.id AND a."packageId"=NEW."packageId"
  AND t.action::text='UNLOAD' AND a."tripId"=s."tripId" AND e."stopTaskId"=t.id
  AND e."sourceSnapshotId"=d."sourceSnapshotId" AND d."commandId"=e."commandId"
  AND e."eventType"=CASE NEW.result WHEN 'DELIVERED' THEN 'PACKAGE_DELIVERED' WHEN 'FAILED' THEN 'PACKAGE_DELIVERY_FAILED' WHEN 'NOT_COLLECTED' THEN 'DELIVERY_NOT_COLLECTED' ELSE '' END
 ) THEN RAISE EXCEPTION 'Invalid delivery result linkage'; END IF;
 IF NEW.result IN ('FAILED','NOT_COLLECTED') AND (NEW.reason IS NULL OR length(btrim(NEW.reason)) NOT BETWEEN 1 AND 1000) THEN RAISE EXCEPTION 'Missing delivery reason'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_delivery_result_consistency BEFORE INSERT ON delivery_results FOR EACH ROW EXECUTE FUNCTION validate_driver_delivery_result();
CREATE TRIGGER immutable_delivery_result BEFORE UPDATE OR DELETE ON delivery_results FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
CREATE TRIGGER immutable_delivery_attempt BEFORE UPDATE OR DELETE ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
CREATE FUNCTION validate_driver_pod_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."ownerUserId" IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (OLD."deliveryAttemptId" IS NOT NULL OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."assignmentId" IS DISTINCT FROM OLD."assignmentId" OR NEW."tripStopId" IS DISTINCT FROM OLD."tripStopId" OR NEW."sourceSnapshotId" IS DISTINCT FROM OLD."sourceSnapshotId" OR NEW."storageKey"<>OLD."storageKey" OR NEW."sizeBytes"<>OLD."sizeBytes" OR NEW."mediaType"<>OLD."mediaType") THEN RAISE EXCEPTION 'POD identity or attached evidence is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM driver_assignments a JOIN drivers d ON d.id=a."driverId" JOIN trip_stops s ON s."tripId"=a."tripId" JOIN trip_execution_snapshots x ON x."tripId"=s."tripId" WHERE a.id=NEW."assignmentId" AND d."userId"=NEW."ownerUserId" AND s.id=NEW."tripStopId" AND x.id=NEW."sourceSnapshotId") THEN RAISE EXCEPTION 'POD scope mismatch'; END IF;
 IF NEW."deliveryAttemptId" IS NOT NULL AND (NEW."uploadStatus"::text<>'UPLOADED' OR NEW."discardedAt" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM delivery_attempts d JOIN processed_commands c ON c.id=d."commandId" WHERE d.id=NEW."deliveryAttemptId" AND d."tripStopId"=NEW."tripStopId" AND d."sourceSnapshotId"=NEW."sourceSnapshotId" AND c."actorUserId"=NEW."ownerUserId")) THEN RAISE EXCEPTION 'POD cannot attach to this attempt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_pod_scope BEFORE INSERT OR UPDATE ON pod_files FOR EACH ROW EXECUTE FUNCTION validate_driver_pod_scope();
COMMIT;
