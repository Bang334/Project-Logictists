ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "dispatchPreparationMinutes" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_dispatch_preparation_minutes_check'
  ) THEN
    ALTER TABLE "system_settings"
      ADD CONSTRAINT "system_settings_dispatch_preparation_minutes_check"
      CHECK ("dispatchPreparationMinutes" BETWEEN 0 AND 240);
  END IF;
END $$;
