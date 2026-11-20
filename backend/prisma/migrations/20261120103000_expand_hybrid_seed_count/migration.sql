ALTER TABLE "system_settings"
  DROP CONSTRAINT "system_settings_hybrid_seed_count_check",
  ADD CONSTRAINT "system_settings_hybrid_seed_count_check"
    CHECK ("hybridSeedCount" BETWEEN 0 AND 20);
