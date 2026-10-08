BEGIN;
-- Accepting is not releasing the driver's reserved interval. Keep this
-- protection even when planning uses its independent resource reservations.
ALTER TABLE driver_assignments DROP CONSTRAINT driver_assignments_no_overlap;
ALTER TABLE driver_assignments ADD CONSTRAINT driver_assignments_no_overlap
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&)
  WHERE (status IN ('ASSIGNED', 'ACCEPTED', 'ACTIVE'));
COMMIT;
