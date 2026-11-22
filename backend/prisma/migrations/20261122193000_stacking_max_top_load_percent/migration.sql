ALTER TABLE "system_settings"
ADD COLUMN IF NOT EXISTS "stackingMaxTopLoadPercent" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'system_settings_stackingMaxTopLoadPercent_check'
  ) THEN
    ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_stackingMaxTopLoadPercent_check"
    CHECK ("stackingMaxTopLoadPercent" IS NULL OR ("stackingMaxTopLoadPercent" >= 1 AND "stackingMaxTopLoadPercent" <= 100));
  END IF;
END $$;
