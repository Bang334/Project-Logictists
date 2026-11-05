BEGIN;
-- Serialize scope writes with account activation. Otherwise activation could miss
-- an uncommitted scope while branch deactivation still observes a locked account.
CREATE OR REPLACE FUNCTION tms_branch_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  branch_id := to_jsonb(NEW)->>TG_ARGV[0];
  IF TG_TABLE_NAME = 'vehicles' AND to_jsonb(NEW)->>'status' = 'DECOMMISSIONED' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'user_role_scopes' THEN
    IF to_jsonb(NEW)->>'active' = 'false' THEN RETURN NEW; END IF;
    PERFORM id FROM users WHERE id = to_jsonb(NEW)->>'userId' FOR SHARE;
  END IF;
  IF TG_TABLE_NAME = 'orders' AND to_jsonb(NEW)->>'status' IN ('COMPLETED','CANCELLED') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'trips' AND to_jsonb(NEW)->>'status' IN ('COMPLETED','CANCELLED')
    AND NOT EXISTS (SELECT 1 FROM resource_reservations WHERE "tripId" = to_jsonb(NEW)->>'id' AND status IN ('HELD','ACTIVE'))
    THEN RETURN NEW; END IF;
  PERFORM tms_require_active_branch(branch_id);
  RETURN NEW;
END $$;

-- Keep the trip's managing branch stable until the reservation commits.
CREATE OR REPLACE FUNCTION tms_reservation_branch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_id text;
BEGIN
  IF NEW.status NOT IN ('HELD','ACTIVE') THEN RETURN NEW; END IF;
  SELECT "managingBranchId" INTO branch_id FROM trips WHERE id=NEW."tripId" FOR SHARE;
  PERFORM tms_require_active_branch(branch_id);
  RETURN NEW;
END $$;
COMMIT;
