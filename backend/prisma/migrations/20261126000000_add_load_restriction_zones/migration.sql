-- CreateTable
CREATE TABLE "load_restriction_zones" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxPayloadKg" DOUBLE PRECISION NOT NULL,
    "polygon" JSONB NOT NULL,
    "curfewWindows" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "load_restriction_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "load_restriction_zones_branchId_active_idx" ON "load_restriction_zones"("branchId", "active");

-- AddForeignKey
ALTER TABLE "load_restriction_zones" ADD CONSTRAINT "load_restriction_zones_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
