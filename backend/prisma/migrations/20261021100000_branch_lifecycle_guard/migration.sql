BEGIN;
-- Fail for review if legacy codes collide after normalization; never rewrite them.
CREATE UNIQUE INDEX branches_normalized_code_unique ON branches (upper(btrim(code)));

CREATE FUNCTION tms_require_active_branch(branch_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE available boolean;
BEGIN
  IF branch_id IS NULL THEN RETURN; END IF;
  SELECT active INTO available FROM branches WHERE id = branch_id FOR SHARE;
  IF available IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BRANCH_INACTIVE' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION tms_branch_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  branch_id := to_jsonb(NEW)->>TG_ARGV[0];
  IF TG_TABLE_NAME = 'vehicles' AND to_jsonb(NEW)->>'status' = 'DECOMMISSIONED' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'user_role_scopes' AND to_jsonb(NEW)->>'active' = 'false' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME IN ('trips','orders') AND to_jsonb(NEW)->>'status' IN ('COMPLETED','CANCELLED') THEN RETURN NEW; END IF;
  PERFORM tms_require_active_branch(branch_id);
  RETURN NEW;
END $$;
CREATE TRIGGER branch_driver_link BEFORE INSERT OR UPDATE OF "homeBranchId" ON drivers FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('homeBranchId');
CREATE TRIGGER branch_vehicle_link BEFORE INSERT OR UPDATE OF "homeBranchId", status ON vehicles FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('homeBranchId');
CREATE TRIGGER branch_scope_link BEFORE INSERT OR UPDATE OF "branchId", active ON user_role_scopes FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('branchId');
CREATE TRIGGER branch_customer_link BEFORE INSERT OR UPDATE OF "branchId" ON customer_branches FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('branchId');
CREATE TRIGGER branch_trip_link BEFORE INSERT OR UPDATE OF "managingBranchId", status ON trips FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('managingBranchId');
CREATE TRIGGER branch_order_link BEFORE INSERT OR UPDATE OF "branchId", status ON orders FOR EACH ROW EXECUTE FUNCTION tms_branch_link_guard('branchId');

CREATE FUNCTION tms_branch_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  IF NOT NEW.active THEN RETURN NEW; END IF;
    FOR branch_id IN SELECT DISTINCT s."branchId" FROM user_role_scopes s WHERE s."userId" = NEW.id AND s.active AND s."branchId" IS NOT NULL ORDER BY s."branchId" LOOP
      PERFORM tms_require_active_branch(branch_id);
    END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER branch_user_activation BEFORE UPDATE OF active ON users FOR EACH ROW EXECUTE FUNCTION tms_branch_activation_guard();

CREATE FUNCTION tms_branch_deactivation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active OR NOT OLD.active THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM drivers WHERE "homeBranchId" = NEW.id)
    OR EXISTS (SELECT 1 FROM vehicles WHERE "homeBranchId" = NEW.id AND status <> 'DECOMMISSIONED')
    OR EXISTS (SELECT 1 FROM user_role_scopes s JOIN users u ON u.id=s."userId" WHERE s."branchId"=NEW.id AND s.active AND u.active)
    OR EXISTS (SELECT 1 FROM customer_branches b WHERE b."branchId"=NEW.id)
    OR EXISTS (SELECT 1 FROM trips WHERE "managingBranchId"=NEW.id AND status NOT IN ('COMPLETED','CANCELLED'))
    OR EXISTS (SELECT 1 FROM orders WHERE "branchId"=NEW.id AND status NOT IN ('COMPLETED','CANCELLED'))
    OR EXISTS (SELECT 1 FROM resource_reservations r JOIN trips t ON t.id=r."tripId" WHERE t."managingBranchId"=NEW.id AND r.status IN ('HELD','ACTIVE'))
  THEN RAISE EXCEPTION 'BRANCH_IN_USE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER branch_deactivation BEFORE UPDATE OF active ON branches FOR EACH ROW EXECUTE FUNCTION tms_branch_deactivation_guard();

CREATE FUNCTION tms_reservation_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  IF NEW.status NOT IN ('HELD','ACTIVE') THEN RETURN NEW; END IF;
  SELECT "managingBranchId" INTO branch_id FROM trips WHERE id=NEW."tripId";
  PERFORM tms_require_active_branch(branch_id);
  RETURN NEW;
END $$;
CREATE TRIGGER branch_reservation BEFORE INSERT OR UPDATE OF status, "tripId" ON resource_reservations FOR EACH ROW EXECUTE FUNCTION tms_reservation_branch_guard();
COMMIT;
