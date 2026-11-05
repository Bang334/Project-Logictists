BEGIN;
-- A retired vehicle alone does not block a branch, but its still-live reservation does.
CREATE OR REPLACE FUNCTION tms_branch_deactivation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM drivers WHERE "homeBranchId" = NEW.id)
    OR EXISTS (SELECT 1 FROM vehicles WHERE "homeBranchId" = NEW.id AND status <> 'DECOMMISSIONED')
    OR EXISTS (SELECT 1 FROM user_role_scopes s JOIN users u ON u.id=s."userId" WHERE s."branchId"=NEW.id AND s.active AND u.active)
    OR EXISTS (SELECT 1 FROM customer_branches b WHERE b."branchId"=NEW.id)
    OR EXISTS (SELECT 1 FROM trips WHERE "managingBranchId"=NEW.id AND status NOT IN ('COMPLETED','CANCELLED'))
    OR EXISTS (SELECT 1 FROM orders WHERE "branchId"=NEW.id AND status NOT IN ('COMPLETED','CANCELLED'))
    OR EXISTS (SELECT 1 FROM resource_reservations r JOIN trips t ON t.id=r."tripId"
      LEFT JOIN vehicles v ON v.id=r."vehicleId" LEFT JOIN drivers d ON d.id=r."driverId"
      WHERE r.status IN ('HELD','ACTIVE') AND (t."managingBranchId"=NEW.id OR v."homeBranchId"=NEW.id OR d."homeBranchId"=NEW.id))
  THEN RAISE EXCEPTION 'BRANCH_IN_USE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tms_branch_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  branch_id := to_jsonb(NEW)->>TG_ARGV[0];
  IF TG_TABLE_NAME = 'vehicles' AND to_jsonb(NEW)->>'status' = 'DECOMMISSIONED'
    AND NOT EXISTS (SELECT 1 FROM resource_reservations WHERE "vehicleId"=to_jsonb(NEW)->>'id' AND status IN ('HELD','ACTIVE')) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'user_role_scopes' THEN
    IF to_jsonb(NEW)->>'active' = 'false' THEN RETURN NEW; END IF;
    PERFORM id FROM users WHERE id = to_jsonb(NEW)->>'userId' FOR SHARE;
  END IF;
  IF TG_TABLE_NAME = 'orders' AND to_jsonb(NEW)->>'status' IN ('COMPLETED','CANCELLED') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'trips' AND to_jsonb(NEW)->>'status' IN ('COMPLETED','CANCELLED')
    AND NOT EXISTS (SELECT 1 FROM resource_reservations WHERE "tripId"=to_jsonb(NEW)->>'id' AND status IN ('HELD','ACTIVE')) THEN RETURN NEW; END IF;
  PERFORM tms_require_active_branch(branch_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tms_reservation_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE trip_branch text; vehicle_branch text; driver_branch text; branch_id text;
BEGIN
  IF NEW.status NOT IN ('HELD','ACTIVE') THEN RETURN NEW; END IF;
  SELECT "managingBranchId" INTO trip_branch FROM trips WHERE id=NEW."tripId" FOR SHARE;
  SELECT "homeBranchId" INTO vehicle_branch FROM vehicles WHERE id=NEW."vehicleId" FOR SHARE;
  SELECT "homeBranchId" INTO driver_branch FROM drivers WHERE id=NEW."driverId" FOR SHARE;
  FOR branch_id IN SELECT DISTINCT b FROM unnest(ARRAY[trip_branch, vehicle_branch, driver_branch]) AS b WHERE b IS NOT NULL ORDER BY b LOOP
    PERFORM tms_require_active_branch(branch_id);
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER branch_reservation ON resource_reservations;
CREATE TRIGGER branch_reservation BEFORE INSERT OR UPDATE OF status, "tripId", "vehicleId", "driverId" ON resource_reservations FOR EACH ROW EXECUTE FUNCTION tms_reservation_branch_guard();
COMMIT;
