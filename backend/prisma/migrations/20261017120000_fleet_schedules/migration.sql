BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- Abort on existing equivalent plates; never merge identities or rewrite history.
CREATE UNIQUE INDEX vehicles_normalized_plate_key ON vehicles ((regexp_replace(upper("plateNumber"), '[[:space:].-]', '', 'g')));
ALTER TABLE employee_leave ADD COLUMN version integer NOT NULL DEFAULT 1,
 ADD COLUMN "recordedById" text REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE vehicle_unavailability ADD COLUMN kind text NOT NULL DEFAULT 'LEGACY',
 ADD COLUMN version integer NOT NULL DEFAULT 1,
 ADD COLUMN "recordedById" text REFERENCES users(id) ON DELETE RESTRICT;
CREATE TABLE driver_shifts (
 id text PRIMARY KEY, "driverId" text NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
 "startsAt" timestamptz(3) NOT NULL, "endsAt" timestamptz(3) NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE', reason text NOT NULL, version integer NOT NULL DEFAULT 1,
 "recordedById" text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamptz(3) NOT NULL,
 CONSTRAINT driver_shifts_interval CHECK ("endsAt" > "startsAt"),
 CONSTRAINT driver_shifts_status CHECK (status IN ('ACTIVE','CANCELLED')),
 CONSTRAINT driver_shifts_overlap EXCLUDE USING gist ("driverId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE (status='ACTIVE')
);
CREATE INDEX driver_shifts_resource_time ON driver_shifts("driverId","startsAt","endsAt");
-- NOT VALID preserves unknown legacy records; all future writes must satisfy these checks.
ALTER TABLE employee_leave ADD CONSTRAINT fleet_leave_interval CHECK ("endsAt">"startsAt") NOT VALID;
ALTER TABLE vehicle_unavailability ADD CONSTRAINT fleet_vehicle_interval CHECK ("endsAt" IS NULL OR "endsAt">"startsAt") NOT VALID;
ALTER TABLE employee_leave ADD CONSTRAINT fleet_leave_overlap EXCLUDE USING gist ("employeeId" WITH =, "leaveType" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE ("approvalStatus"='APPROVED');
ALTER TABLE vehicle_unavailability ADD CONSTRAINT fleet_vehicle_overlap EXCLUDE USING gist ("vehicleId" WITH =, kind WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE (status='ACTIVE');

-- These functions guard the shared reservation boundary. They do not implement routing,
-- geometry, driving/rest policy, or silently modify any Trip.
CREATE FUNCTION fleet_driver_window_ok(resource_id text, start_at timestamptz, end_at timestamptz) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE((SELECT range_agg(tstzrange(s."startsAt",s."endsAt",'[)')) @> tstzrange(start_at,end_at,'[)') FROM driver_shifts s WHERE s."driverId"=resource_id AND s.status='ACTIVE'),false)
 AND NOT EXISTS (SELECT 1 FROM employee_leave l JOIN drivers d ON d."employeeId"=l."employeeId" WHERE d.id=resource_id AND l."approvalStatus"='APPROVED' AND tstzrange(l."startsAt",l."endsAt",'[)') && tstzrange(start_at,end_at,'[)'))
 AND EXISTS (SELECT 1 FROM drivers d JOIN employees e ON e.id=d."employeeId" WHERE d.id=resource_id AND e."employmentStatus"='ACTIVE' AND e."branchId"=d."homeBranchId" AND end_at <= ((d."licenseExpiry" + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'));
$$;
CREATE FUNCTION fleet_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status::text NOT IN ('HELD','ACTIVE') THEN RETURN NEW; END IF;
 IF NEW."vehicleId" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(4101,hashtext(NEW."vehicleId"));
  IF EXISTS (SELECT 1 FROM vehicle_unavailability u WHERE u."vehicleId"=NEW."vehicleId" AND u.status='ACTIVE' AND tstzrange(u."startsAt",u."endsAt",'[)') && tstzrange(NEW."startsAt",NEW."endsAt",'[)')) THEN RAISE EXCEPTION 'FLEET_VEHICLE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW."driverId" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(4102,hashtext(NEW."driverId"));
  IF NOT fleet_driver_window_ok(NEW."driverId",NEW."startsAt",NEW."endsAt") THEN RAISE EXCEPTION 'FLEET_DRIVER_SCHEDULE_OR_LICENSE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservation_guard BEFORE INSERT OR UPDATE OF status,"startsAt","endsAt","driverId","vehicleId" ON resource_reservations FOR EACH ROW EXECUTE FUNCTION fleet_reservation_guard();

CREATE FUNCTION fleet_schedule_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource_id text;
BEGIN
 IF TG_TABLE_NAME='vehicle_unavailability' THEN
  IF TG_OP='UPDATE' AND NEW."vehicleId"<>OLD."vehicleId" THEN RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE='23514'; END IF;
  resource_id:=NEW."vehicleId"; PERFORM pg_advisory_xact_lock(4101,hashtext(resource_id));
 ELSE
  IF TG_TABLE_NAME='driver_shifts' THEN
   IF TG_OP='UPDATE' AND NEW."driverId"<>OLD."driverId" THEN RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE='23514'; END IF;
   resource_id:=NEW."driverId";
  ELSE
   IF TG_OP='UPDATE' AND NEW."employeeId"<>OLD."employeeId" THEN RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE='23514'; END IF;
   SELECT id INTO resource_id FROM drivers WHERE "employeeId"=NEW."employeeId";
  END IF;
  IF resource_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(4102,hashtext(resource_id)); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_shift_lock BEFORE INSERT OR UPDATE ON driver_shifts FOR EACH ROW EXECUTE FUNCTION fleet_schedule_lock();
CREATE TRIGGER fleet_leave_lock BEFORE INSERT OR UPDATE ON employee_leave FOR EACH ROW EXECUTE FUNCTION fleet_schedule_lock();
CREATE TRIGGER fleet_vehicle_lock BEFORE INSERT OR UPDATE ON vehicle_unavailability FOR EACH ROW EXECUTE FUNCTION fleet_schedule_lock();

CREATE FUNCTION fleet_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource_id text;
BEGIN
 IF TG_TABLE_NAME='vehicle_unavailability' THEN
  IF NEW.status='ACTIVE' AND NEW.kind<>'BREAKDOWN' AND (
   EXISTS (SELECT 1 FROM resource_reservations r WHERE r."vehicleId"=NEW."vehicleId" AND r.status::text IN ('HELD','ACTIVE') AND tstzrange(r."startsAt",r."endsAt",'[)') && tstzrange(NEW."startsAt",NEW."endsAt",'[)')) OR
   EXISTS (SELECT 1 FROM trips t WHERE t."vehicleId"=NEW."vehicleId" AND t.status::text IN ('PLANNED','DISPATCHED','IN_PROGRESS') AND tstzrange(t."plannedStartTime",t."plannedEndTime",'[)') && tstzrange(NEW."startsAt",NEW."endsAt",'[)'))
  ) THEN RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_TABLE_NAME='driver_shifts' THEN resource_id:=NEW."driverId";
  ELSE
   SELECT id INTO resource_id FROM drivers WHERE "employeeId"=NEW."employeeId";
   IF NEW."approvalStatus"<>'APPROVED' THEN RETURN NEW; END IF;
  END IF;
  -- Check only affected intervals, so unrelated historical unverified trips do not
  -- prevent recording future shifts. Removal also checks the previous interval.
  IF EXISTS (SELECT 1 FROM resource_reservations r WHERE r."driverId"=resource_id AND r.status::text IN ('HELD','ACTIVE')
   AND (tstzrange(r."startsAt",r."endsAt",'[)') && tstzrange(NEW."startsAt",NEW."endsAt",'[)') OR (TG_OP='UPDATE' AND tstzrange(r."startsAt",r."endsAt",'[)') && tstzrange(OLD."startsAt",OLD."endsAt",'[)')))
   AND NOT fleet_driver_window_ok(resource_id,r."startsAt",r."endsAt"))
   OR EXISTS (SELECT 1 FROM driver_assignments a JOIN trips t ON t.id=a."tripId" WHERE a."driverId"=resource_id AND t.status::text IN ('PLANNED','DISPATCHED','IN_PROGRESS')
   AND (tstzrange(a."startTime",a."endTime",'[)') && tstzrange(NEW."startsAt",NEW."endsAt",'[)') OR (TG_OP='UPDATE' AND tstzrange(a."startTime",a."endTime",'[)') && tstzrange(OLD."startsAt",OLD."endsAt",'[)')))
   AND NOT fleet_driver_window_ok(resource_id,a."startTime",a."endTime"))
  THEN RAISE EXCEPTION 'FLEET_SCHEDULE_CONFLICT' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_shift_guard AFTER INSERT OR UPDATE ON driver_shifts FOR EACH ROW EXECUTE FUNCTION fleet_schedule_guard();
CREATE TRIGGER fleet_leave_guard AFTER INSERT OR UPDATE ON employee_leave FOR EACH ROW EXECUTE FUNCTION fleet_schedule_guard();
CREATE TRIGGER fleet_vehicle_guard AFTER INSERT OR UPDATE ON vehicle_unavailability FOR EACH ROW EXECUTE FUNCTION fleet_schedule_guard();
COMMIT;
