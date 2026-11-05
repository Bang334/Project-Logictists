-- Migration: 20261101000000_multi_source_retail_tms
-- Thêm các model phục vụ đặt hàng đa nguồn, chuẩn bị theo nhóm, đo kiện và vận tải gom hàng

-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE "FulfillmentGroupStatus" AS ENUM ('PENDING', 'PREPARING', 'PACKED', 'HANDED_OVER', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "TransportRequestStatus" AS ENUM ('PENDING', 'READY_FOR_ROUTING', 'ASSIGNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Alter existing tables
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "maxDeliveryDistanceKm" INTEGER DEFAULT 100;

ALTER TABLE "orders" 
    ADD COLUMN IF NOT EXISTS "maxSourcesAllowed" INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS "maxDistanceBetweenSourcesKm" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    ADD COLUMN IF NOT EXISTS "serviceZoneSnapshotId" TEXT;

-- 3. Create Service Zones tables
CREATE TABLE IF NOT EXISTS "service_zones" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "maxSourcesAllowed" INTEGER NOT NULL DEFAULT 2,
    "maxDistanceBetweenSourcesKm" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_zones_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_zones_code_key" ON "service_zones"("code");

CREATE TABLE IF NOT EXISTS "service_zone_provinces" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "provinceCode" TEXT NOT NULL,
    "provinceName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_zone_provinces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_zone_provinces_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "service_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_zone_provinces_zoneId_provinceCode_key" ON "service_zone_provinces"("zoneId", "provinceCode");
CREATE INDEX IF NOT EXISTS "service_zone_provinces_provinceCode_idx" ON "service_zone_provinces"("provinceCode");

CREATE TABLE IF NOT EXISTS "store_service_zones" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "maxDeliveryDistanceKm" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_service_zones_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_service_zones_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "store_service_zones_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "service_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_service_zones_locationId_zoneId_key" ON "store_service_zones"("locationId", "zoneId");

-- 4. Create Fulfillment Groups and Lines
CREATE TABLE IF NOT EXISTS "fulfillment_groups" (
    "id" TEXT NOT NULL,
    "groupNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceLocationId" TEXT NOT NULL,
    "sourceBranchId" TEXT,
    "pickupStopId" TEXT,
    "status" "FulfillmentGroupStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "readyAt" TIMESTAMPTZ(3),
    "packedAt" TIMESTAMPTZ(3),
    "handedOverAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fulfillment_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fulfillment_groups_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fulfillment_groups_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fulfillment_groups_sourceBranchId_fkey" FOREIGN KEY ("sourceBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fulfillment_groups_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "order_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_groups_groupNumber_key" ON "fulfillment_groups"("groupNumber");
CREATE INDEX IF NOT EXISTS "fulfillment_groups_orderId_status_idx" ON "fulfillment_groups"("orderId", "status");
CREATE INDEX IF NOT EXISTS "fulfillment_groups_sourceLocationId_status_idx" ON "fulfillment_groups"("sourceLocationId", "status");

CREATE TABLE IF NOT EXISTS "fulfillment_lines" (
    "id" TEXT NOT NULL,
    "fulfillmentGroupId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "requestedQuantity" INTEGER NOT NULL,
    "reservedQuantity" INTEGER NOT NULL DEFAULT 0,
    "packedQuantity" INTEGER NOT NULL DEFAULT 0,
    "rejectedQuantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fulfillment_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fulfillment_lines_fulfillmentGroupId_fkey" FOREIGN KEY ("fulfillmentGroupId") REFERENCES "fulfillment_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fulfillment_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "fulfillment_lines_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "fulfillment_lines_fulfillmentGroupId_idx" ON "fulfillment_lines"("fulfillmentGroupId");
CREATE INDEX IF NOT EXISTS "fulfillment_lines_orderItemId_idx" ON "fulfillment_lines"("orderItemId");
CREATE INDEX IF NOT EXISTS "fulfillment_lines_skuId_idx" ON "fulfillment_lines"("skuId");

-- 5. Alter packages and inventory_reservations for fulfillment relation
ALTER TABLE "packages" 
    ADD COLUMN IF NOT EXISTS "fulfillmentGroupId" TEXT,
    ADD COLUMN IF NOT EXISTS "measuredByUserId" TEXT;

DO $$ BEGIN
    ALTER TABLE "packages" ADD CONSTRAINT "packages_fulfillmentGroupId_fkey" FOREIGN KEY ("fulfillmentGroupId") REFERENCES "fulfillment_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "packages" ADD CONSTRAINT "packages_measuredByUserId_fkey" FOREIGN KEY ("measuredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "packages_fulfillmentGroupId_status_idx" ON "packages"("fulfillmentGroupId", "status");

ALTER TABLE "inventory_reservations" ADD COLUMN IF NOT EXISTS "fulfillmentLineId" TEXT;
DO $$ BEGIN
    ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_fulfillmentLineId_fkey" FOREIGN KEY ("fulfillmentLineId") REFERENCES "fulfillment_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
CREATE INDEX IF NOT EXISTS "inventory_reservations_fulfillmentLineId_idx" ON "inventory_reservations"("fulfillmentLineId");

-- 6. Create Transport Requests
CREATE TABLE IF NOT EXISTS "transport_requests" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentGroupId" TEXT NOT NULL,
    "sourceLocationId" TEXT NOT NULL,
    "pickupStopId" TEXT,
    "deliveryStopId" TEXT,
    "status" "TransportRequestStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transport_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transport_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transport_requests_fulfillmentGroupId_fkey" FOREIGN KEY ("fulfillmentGroupId") REFERENCES "fulfillment_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transport_requests_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "transport_requests_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "order_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "transport_requests_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "order_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "transport_requests_requestNumber_key" ON "transport_requests"("requestNumber");
CREATE INDEX IF NOT EXISTS "transport_requests_orderId_status_idx" ON "transport_requests"("orderId", "status");
CREATE INDEX IF NOT EXISTS "transport_requests_fulfillmentGroupId_status_idx" ON "transport_requests"("fulfillmentGroupId", "status");

CREATE TABLE IF NOT EXISTS "transport_request_packages" (
    "id" TEXT NOT NULL,
    "transportRequestId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transport_request_packages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transport_request_packages_transportRequestId_fkey" FOREIGN KEY ("transportRequestId") REFERENCES "transport_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transport_request_packages_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "transport_request_packages_transportRequestId_packageId_key" ON "transport_request_packages"("transportRequestId", "packageId");
CREATE INDEX IF NOT EXISTS "transport_request_packages_packageId_idx" ON "transport_request_packages"("packageId");

-- 7. Create Retail Quotes (Durable Quotes in PostgreSQL)
CREATE TABLE IF NOT EXISTS "retail_quotes" (
    "id" TEXT NOT NULL,
    "quoteVersion" INTEGER NOT NULL DEFAULT 1,
    "serviceZoneId" TEXT,
    "serviceZoneVersion" INTEGER NOT NULL DEFAULT 1,
    "provinceCode" TEXT NOT NULL,
    "deliveryAddress" TEXT NOT NULL,
    "deliveryLatitude" DOUBLE PRECISION NOT NULL,
    "deliveryLongitude" DOUBLE PRECISION NOT NULL,
    "deliveryWindowStart" TIMESTAMPTZ(3),
    "deliveryWindowEnd" TIMESTAMPTZ(3),
    "subtotal" DECIMAL(20,4) NOT NULL,
    "shippingFee" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "sourceStoreCount" INTEGER NOT NULL,
    "maxDistanceBetweenSourcesKm" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "retail_quotes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "retail_quotes_serviceZoneId_fkey" FOREIGN KEY ("serviceZoneId") REFERENCES "service_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "retail_quotes_expiresAt_idx" ON "retail_quotes"("expiresAt");
CREATE INDEX IF NOT EXISTS "retail_quotes_serviceZoneId_idx" ON "retail_quotes"("serviceZoneId");
