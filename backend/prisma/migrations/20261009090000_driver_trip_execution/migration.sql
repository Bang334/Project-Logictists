BEGIN;
CREATE TABLE trip_execution_snapshots (
 id text PRIMARY KEY, "tripId" text NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
 "sourceTripVersion" integer NOT NULL CHECK ("sourceTripVersion" > 0),
 "planHash" text NOT NULL, plan jsonb NOT NULL,
 "createdAt" timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(id,"tripId")
);
ALTER TABLE execution_events ADD COLUMN "sourceSnapshotId" text,
 ADD COLUMN "eventSequence" integer NOT NULL DEFAULT 0 CHECK ("eventSequence" >= 0),
 ADD CONSTRAINT execution_command_fk FOREIGN KEY ("commandId") REFERENCES processed_commands(id) ON DELETE RESTRICT,
 ADD CONSTRAINT execution_snapshot_trip_fk FOREIGN KEY ("sourceSnapshotId","tripId") REFERENCES trip_execution_snapshots(id,"tripId") ON DELETE RESTRICT,
 ADD CONSTRAINT execution_source_required CHECK ("eventType" NOT IN ('TRIP_STARTED','STOP_ARRIVED') OR "sourceSnapshotId" IS NOT NULL);
DROP INDEX "execution_events_commandId_key";
CREATE UNIQUE INDEX "execution_events_commandId_eventSequence_key" ON execution_events("commandId","eventSequence");
CREATE UNIQUE INDEX execution_start_once ON execution_events("tripId") WHERE "eventType"='TRIP_STARTED';
CREATE UNIQUE INDEX execution_arrival_once ON execution_events("tripStopId") WHERE "eventType"='STOP_ARRIVED';
ALTER TABLE trip_stops ADD CONSTRAINT trip_stop_id_trip_unique UNIQUE(id,"tripId");
ALTER TABLE execution_events ADD CONSTRAINT execution_stop_trip_fk FOREIGN KEY ("tripStopId","tripId") REFERENCES trip_stops(id,"tripId") ON DELETE RESTRICT;
CREATE FUNCTION protect_execution_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Execution history is immutable'; END $$;
CREATE TRIGGER immutable_execution_snapshot BEFORE UPDATE OR DELETE ON trip_execution_snapshots FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
CREATE TRIGGER immutable_driver_execution BEFORE UPDATE OR DELETE ON execution_events FOR EACH ROW WHEN (OLD."sourceSnapshotId" IS NOT NULL) EXECUTE FUNCTION protect_execution_history();
INSERT INTO permissions(id,code,description) VALUES ('mobile-driver-execute','driver.trips.execute','Start own accepted trip and confirm arrival') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions("roleId","permissionId") SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='DRIVER' AND p.code='driver.trips.execute' ON CONFLICT DO NOTHING;
COMMIT;
