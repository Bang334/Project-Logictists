ALTER TABLE "optimization_jobs"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "leaseOwner" TEXT;

UPDATE "optimization_jobs"
SET "idempotencyKey" = 'legacy:' || "id"
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "optimization_jobs"
ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "optimization_jobs_createdById_idempotencyKey_key"
ON "optimization_jobs"("createdById", "idempotencyKey");
