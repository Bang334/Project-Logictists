BEGIN;
-- Do not infer acceptance for historic assignments. Unknown statuses fail this
-- migration for review rather than being silently rewritten.
ALTER TABLE driver_assignments
  ADD COLUMN offered_at timestamptz(3),
  ADD COLUMN responded_at timestamptz(3),
  ADD COLUMN rejection_reason text,
  ADD COLUMN version integer NOT NULL DEFAULT 1;
UPDATE driver_assignments SET offered_at = "createdAt";
ALTER TABLE driver_assignments ALTER COLUMN offered_at SET NOT NULL,
  ALTER COLUMN offered_at SET DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT driver_assignment_status CHECK (status IN ('ASSIGNED','ACCEPTED','REJECTED')),
  ADD CONSTRAINT driver_assignment_version CHECK (version > 0),
  ADD CONSTRAINT driver_assignment_response CHECK (
    (status = 'ASSIGNED' AND responded_at IS NULL AND rejection_reason IS NULL) OR
    (status = 'ACCEPTED' AND responded_at IS NOT NULL AND rejection_reason IS NULL) OR
    (status = 'REJECTED' AND responded_at IS NOT NULL AND rejection_reason IS NOT NULL AND length(btrim(rejection_reason)) BETWEEN 1 AND 1000)
  );
CREATE INDEX driver_assignment_mobile_list ON driver_assignments ("driverId", status, "startTime", id);
INSERT INTO roles(id,code,name,"updatedAt") VALUES ('mobile-role-driver','DRIVER','DRIVER',now()) ON CONFLICT (code) DO NOTHING;
INSERT INTO permissions(id,code,description) VALUES
 ('mobile-driver-profile','driver.profile.read','Read own driver profile'),
 ('mobile-driver-list','driver.assignments.read','Read own published assignments'),
 ('mobile-driver-respond','driver.assignments.respond','Respond to own assignment') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions("roleId","permissionId")
 SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code='DRIVER' AND p.code IN ('driver.profile.read','driver.assignments.read','driver.assignments.respond') ON CONFLICT DO NOTHING;
-- Deliberately does not infer User scopes from the legacy User.role column.
COMMIT;
