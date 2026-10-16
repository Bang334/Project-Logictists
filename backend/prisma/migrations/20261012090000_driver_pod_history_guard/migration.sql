BEGIN;
-- Follow-up: the first delivery migration is already applied to the test DB.
-- Preserve legacy POD rows (no owner) while preventing an owned POD losing scope.
ALTER TABLE pod_files ADD CONSTRAINT driver_pod_size_required
 CHECK ("ownerUserId" IS NULL OR "sizeBytes" IS NOT NULL) NOT VALID;
CREATE FUNCTION protect_driver_pod_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."deliveryAttemptId" IS NOT NULL THEN RAISE EXCEPTION 'Attached POD evidence cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF OLD."ownerUserId" IS NOT NULL AND NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" THEN
  RAISE EXCEPTION 'Driver POD owner cannot be removed or reassigned';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER driver_pod_history_guard BEFORE UPDATE OR DELETE ON pod_files
 FOR EACH ROW EXECUTE FUNCTION protect_driver_pod_history();
COMMIT;
