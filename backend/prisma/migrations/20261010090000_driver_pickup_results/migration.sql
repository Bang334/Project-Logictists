BEGIN;
-- No inferred pickup for existing tasks, packages or execution history.
CREATE TABLE pickup_results (
 id text PRIMARY KEY,
 "stopTaskId" text NOT NULL UNIQUE REFERENCES stop_tasks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "eventId" text NOT NULL UNIQUE REFERENCES execution_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "packageId" text NOT NULL REFERENCES packages(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "allocationId" text NOT NULL REFERENCES allocations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 outcome text NOT NULL CHECK (outcome IN ('LOADED','NOT_COLLECTED')),
 reason text,
 CHECK ((outcome='LOADED' AND reason IS NULL) OR
        (outcome='NOT_COLLECTED' AND length(btrim(reason)) BETWEEN 1 AND 1000 AND reason IS NOT NULL))
);
CREATE INDEX "pickup_results_packageId_outcome_idx" ON pickup_results("packageId",outcome);
-- This milestone has no unload/reload or transfer. A later milestone must replace
-- this guard with a custody-leg model before it can introduce those transitions.
CREATE UNIQUE INDEX pickup_package_loaded_once ON pickup_results("packageId") WHERE outcome='LOADED';
CREATE UNIQUE INDEX pickup_stop_completed_once ON execution_events("tripStopId") WHERE "eventType"='PICKUP_STOP_COMPLETED';
CREATE FUNCTION validate_pickup_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM stop_tasks t JOIN trip_stops s ON s.id=t."tripStopId"
   JOIN allocations a ON a.id=t."allocationId" JOIN packages p ON p.id=a."packageId"
   JOIN execution_events e ON e.id=NEW."eventId"
   WHERE t.id=NEW."stopTaskId" AND t.action::text='LOAD' AND t."plannedQuantity"=1
   AND a.id=NEW."allocationId" AND p.id=NEW."packageId" AND a."allocatedQuantity"=1
   AND a."tripId"=s."tripId" AND p."orderItemId"=a."orderItemId"
   AND e."stopTaskId"=t.id AND e."tripStopId"=s.id AND e."tripId"=s."tripId"
   AND e."sourceSnapshotId" IS NOT NULL
   AND e."eventType"=CASE WHEN NEW.outcome='LOADED' THEN 'PACKAGE_LOADED' ELSE 'PACKAGE_NOT_COLLECTED' END
 ) THEN RAISE EXCEPTION 'Pickup task, package, allocation and execution event must agree'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pickup_result_consistency BEFORE INSERT ON pickup_results FOR EACH ROW EXECUTE FUNCTION validate_pickup_result();
CREATE TRIGGER immutable_pickup_result BEFORE UPDATE OR DELETE ON pickup_results FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
ALTER TABLE execution_events ADD CONSTRAINT pickup_source_required CHECK (
 "eventType" NOT IN ('PACKAGE_LOADED','PACKAGE_NOT_COLLECTED','PICKUP_STOP_COMPLETED') OR "sourceSnapshotId" IS NOT NULL
);
COMMIT;
