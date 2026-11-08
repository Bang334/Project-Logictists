-- CreateTable
CREATE TABLE "delivery_planning_batches" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sourceJobId" TEXT NOT NULL,
    "candidateNumber" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OFFERING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "windowMinutes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "proposal" JSONB NOT NULL,
    "finalOptimizationJobId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_planning_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_appointments" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "respondedAt" TIMESTAMPTZ(3),
    "responseKey" TEXT,
    "responseHash" TEXT,
    "requestedStart" TIMESTAMPTZ(3),
    "requestedEnd" TIMESTAMPTZ(3),
    "responseNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_capacity_holds" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "routeIndex" INTEGER NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "orderIds" TEXT[],
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_capacity_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_planning_batches_finalOptimizationJobId_key" ON "delivery_planning_batches"("finalOptimizationJobId");

-- CreateIndex
CREATE INDEX "delivery_planning_batches_branchId_createdAt_idx" ON "delivery_planning_batches"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "delivery_planning_batches_status_expiresAt_idx" ON "delivery_planning_batches"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_planning_batches_createdById_idempotencyKey_key" ON "delivery_planning_batches"("createdById", "idempotencyKey");

-- CreateIndex
CREATE INDEX "delivery_appointments_customerId_createdAt_idx" ON "delivery_appointments"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "delivery_appointments_status_expiresAt_idx" ON "delivery_appointments"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_appointments_batchId_orderId_key" ON "delivery_appointments"("batchId", "orderId");

-- CreateIndex
CREATE INDEX "delivery_capacity_holds_vehicleId_startsAt_endsAt_idx" ON "delivery_capacity_holds"("vehicleId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "delivery_capacity_holds_driverId_startsAt_endsAt_idx" ON "delivery_capacity_holds"("driverId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_capacity_holds_batchId_routeIndex_key" ON "delivery_capacity_holds"("batchId", "routeIndex");

-- AddForeignKey
ALTER TABLE "delivery_planning_batches" ADD CONSTRAINT "delivery_planning_batches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_planning_batches" ADD CONSTRAINT "delivery_planning_batches_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "optimization_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_planning_batches" ADD CONSTRAINT "delivery_planning_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_appointments" ADD CONSTRAINT "delivery_appointments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "delivery_planning_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_appointments" ADD CONSTRAINT "delivery_appointments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_appointments" ADD CONSTRAINT "delivery_appointments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_capacity_holds" ADD CONSTRAINT "delivery_capacity_holds_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "delivery_planning_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_capacity_holds" ADD CONSTRAINT "delivery_capacity_holds_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_capacity_holds" ADD CONSTRAINT "delivery_capacity_holds_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE delivery_planning_batches ADD CONSTRAINT delivery_batch_policy_check CHECK ("windowMinutes" BETWEEN 1 AND 1440 AND version > 0 AND status IN ('OFFERING','APPLIED','CANCELLED'));
ALTER TABLE delivery_appointments ADD CONSTRAINT delivery_appointment_window_check CHECK ("windowStart" < "windowEnd" AND "expiresAt" < "windowStart" AND version > 0 AND status IN ('PENDING','CONFIRMED','DECLINED','CHANGE_REQUESTED','EXPIRED','SCHEDULED','CANCELLED'));
ALTER TABLE delivery_appointments ADD CONSTRAINT delivery_appointment_request_check CHECK (("requestedStart" IS NULL AND "requestedEnd" IS NULL) OR ("requestedStart" IS NOT NULL AND "requestedEnd" IS NOT NULL AND "requestedStart" < "requestedEnd"));
CREATE UNIQUE INDEX delivery_one_active_appointment_per_order ON delivery_appointments ("orderId") WHERE status IN ('PENDING','CONFIRMED');
ALTER TABLE delivery_capacity_holds ADD CONSTRAINT delivery_capacity_interval_check CHECK ("startsAt" < "endsAt" AND cardinality("orderIds") > 0 AND status IN ('HELD','RELEASED'));

-- Use the same resource lock namespaces as trip creation/publish. This also
-- protects writes made by another backend process or direct SQL.
CREATE FUNCTION guard_delivery_capacity() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'delivery_capacity_holds' AND NEW.status <> 'HELD' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'resource_reservations' AND NEW.status::text NOT IN ('HELD','ACTIVE','COMMITTED') THEN RETURN NEW; END IF;
  IF NEW."vehicleId" IS NOT NULL THEN PERFORM pg_advisory_xact_lock(4101, hashtext(NEW."vehicleId")); END IF;
  IF NEW."driverId" IS NOT NULL THEN PERFORM pg_advisory_xact_lock(4102, hashtext(NEW."driverId")); END IF;
  IF EXISTS (SELECT 1 FROM delivery_capacity_holds h WHERE h.status = 'HELD'
      AND (h."expiresAt" IS NULL OR h."expiresAt" > clock_timestamp())
      AND (TG_TABLE_NAME <> 'delivery_capacity_holds' OR h.id <> NEW.id)
      AND (h."vehicleId" = NEW."vehicleId" OR h."driverId" = NEW."driverId")
      AND h."startsAt" < NEW."endsAt" AND h."endsAt" > NEW."startsAt") THEN
    RAISE EXCEPTION 'DELIVERY_CAPACITY_CONFLICT' USING ERRCODE = '23P01';
  END IF;
  IF TG_TABLE_NAME = 'delivery_capacity_holds' AND EXISTS (
    SELECT 1 FROM resource_reservations r WHERE r.status::text IN ('HELD','ACTIVE','COMMITTED')
      AND (r."vehicleId" = NEW."vehicleId" OR r."driverId" = NEW."driverId")
      AND r."startsAt" < NEW."endsAt" AND r."endsAt" > NEW."startsAt"
  ) THEN RAISE EXCEPTION 'DELIVERY_CAPACITY_CONFLICT' USING ERRCODE = '23P01'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_capacity_guard BEFORE INSERT OR UPDATE ON delivery_capacity_holds FOR EACH ROW EXECUTE FUNCTION guard_delivery_capacity();
CREATE TRIGGER resource_delivery_capacity_guard BEFORE INSERT OR UPDATE ON resource_reservations FOR EACH ROW EXECUTE FUNCTION guard_delivery_capacity();
