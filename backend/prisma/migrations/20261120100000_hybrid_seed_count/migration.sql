ALTER TABLE "system_settings"
  ADD COLUMN "hybridSeedCount" INTEGER,
  ADD CONSTRAINT "system_settings_hybrid_seed_count_check"
    CHECK ("hybridSeedCount" BETWEEN 0 AND 3);
