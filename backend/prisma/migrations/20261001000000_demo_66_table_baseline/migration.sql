-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'STAFF', 'DISPATCHER', 'DRIVER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('STORE', 'CENTRAL_WAREHOUSE', 'PICKUP_POINT');

-- CreateEnum
CREATE TYPE "StorageCondition" AS ENUM ('AMBIENT', 'COOL', 'CHILLED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "LedgerSourceType" AS ENUM ('RECEIPT', 'ORDER_COMMIT', 'ORDER_RELEASE', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'ACTIVE', 'COMMITTED', 'RELEASED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('DAMAGE', 'LOSS', 'COUNT_DISCREPANCY', 'EXPIRY', 'CORRECTION');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'APPROVED', 'SHIPPED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'MAINTENANCE', 'ON_TRIP', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('AVAILABLE', 'ON_DUTY', 'ON_LEAVE', 'RESTING');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ASSIGNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('PICKUP', 'DELIVERY', 'DEPOT_START', 'DEPOT_END');

-- CreateEnum
CREATE TYPE "TaskAction" AS ENUM ('LOAD', 'UNLOAD');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('DRAFT', 'PLANNED', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('COMPANY', 'BRANCH', 'LOCATION');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('DRAFT', 'READY', 'ALLOCATED', 'LOADED', 'DELIVERED', 'DAMAGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('RATING', 'COMPLAINT', 'SUPPORT_REQUEST', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FeedbackPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('RETAIL_PICKUP', 'RETAIL_DELIVERY', 'B2B_TRANSPORT');

-- CreateEnum
CREATE TYPE "PaymentTransactionType" AS ENUM ('PAYMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "PackageEventType" AS ENUM ('PACKED', 'HANDED_OVER', 'DEPARTED', 'ARRIVED_PICKUP_POINT', 'COLLECTED', 'DELIVERY_ATTEMPTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "FeasibilityStatus" AS ENUM ('FEASIBLE', 'PARTIAL', 'INFEASIBLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LoadValidationStatus" AS ENUM ('PENDING', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STAFF',
    "phone" TEXT,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT,
    "locationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "workStartTime" TEXT NOT NULL DEFAULT '08:00',
    "workEndTime" TEXT NOT NULL DEFAULT '17:00',
    "fuelPricePerLiter" DECIMAL(12,2) NOT NULL DEFAULT 23000,
    "monthlyWorkingMinutes" INTEGER NOT NULL DEFAULT 10560,
    "cargoHoldingCostVndPerTonHour" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "homeBranchId" TEXT NOT NULL,
    "payloadCapacityKg" DOUBLE PRECISION NOT NULL,
    "volumeCapacityM3" DOUBLE PRECISION NOT NULL,
    "lengthCm" DOUBLE PRECISION NOT NULL,
    "widthCm" DOUBLE PRECISION NOT NULL,
    "heightCm" DOUBLE PRECISION NOT NULL,
    "fuelConsumptionLitersPer100Km" DECIMAL(8,3) NOT NULL DEFAULT 12,
    "loadFuelSurchargePercentAtFullPayload" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "fixedOperatingCostPerTrip" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "currentLatitude" DOUBLE PRECISION,
    "currentLongitude" DOUBLE PRECISION,
    "lastLocationAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "employeeId" TEXT,
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "licenseClass" TEXT NOT NULL,
    "licenseExpiry" DATE NOT NULL,
    "homeBranchId" TEXT NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'AVAILABLE',
    "fixedSalaryMonthly" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tripBasePay" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "perKmPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "taxCode" TEXT,
    "address" TEXT,
    "contactPerson" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "orderType" "OrderType" NOT NULL DEFAULT 'B2B_TRANSPORT',
    "customerId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "selectedPickupPointId" TEXT,
    "allocatedSourceId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT NOT NULL DEFAULT 'MANUAL_PENDING',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "shippingFee" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "totalWeightKg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalVolumeM3" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPackages" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_stops" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "StopType" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3),
    "windowEnd" TIMESTAMPTZ(3),
    "serviceDurationMinutes" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "skuId" TEXT,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "packageType" TEXT NOT NULL DEFAULT 'CARTON',
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "weightKg" DOUBLE PRECISION NOT NULL,
    "lengthCm" DOUBLE PRECISION NOT NULL,
    "widthCm" DOUBLE PRECISION NOT NULL,
    "heightCm" DOUBLE PRECISION NOT NULL,
    "volumeM3" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" TEXT NOT NULL,
    "tripNumber" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "managingBranchId" TEXT,
    "status" "TripStatus" NOT NULL DEFAULT 'DRAFT',
    "plannedStartTime" TIMESTAMPTZ(3) NOT NULL,
    "plannedEndTime" TIMESTAMPTZ(3) NOT NULL,
    "actualStartTime" TIMESTAMPTZ(3),
    "actualEndTime" TIMESTAMPTZ(3),
    "totalDistanceKm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDurationMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "routeGeometry" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_stops" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stopType" "StopType" NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "plannedArrivalTime" TIMESTAMPTZ(3),
    "plannedDepartureTime" TIMESTAMPTZ(3),
    "actualArrivalTime" TIMESTAMPTZ(3),
    "actualDepartureTime" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stop_tasks" (
    "id" TEXT NOT NULL,
    "tripStopId" TEXT NOT NULL,
    "orderId" TEXT,
    "packageId" TEXT,
    "orderStopId" TEXT,
    "action" "TaskAction" NOT NULL,
    "plannedQuantity" INTEGER NOT NULL,
    "actualQuantity" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stop_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_assignments" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "startStopId" TEXT,
    "endStopId" TEXT,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PRIMARY',
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "performedBy" TEXT NOT NULL,
    "details" TEXT,
    "actorUserId" TEXT,
    "correlationId" TEXT,
    "changeSummary" JSONB,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_jobs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "branchId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "policyVersion" TEXT,
    "solverVersion" TEXT,
    "parameters" JSONB,
    "result" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "optimization_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_location_scopes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "branchId" TEXT,
    "locationId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_location_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL DEFAULT 'STORE',
    "managingBranchId" TEXT,
    "address" TEXT NOT NULL,
    "ward" TEXT,
    "district" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "workStartTime" TEXT NOT NULL DEFAULT '08:00',
    "workEndTime" TEXT NOT NULL DEFAULT '17:00',
    "capabilities" JSONB,
    "totalHoldingSlots" INTEGER NOT NULL DEFAULT 0,
    "availableHoldingSlots" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "imageUrl" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'GOI',
    "salePrice" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "weightGrams" INTEGER NOT NULL DEFAULT 0,
    "lengthMm" INTEGER NOT NULL DEFAULT 0,
    "widthMm" INTEGER NOT NULL DEFAULT 0,
    "heightMm" INTEGER NOT NULL DEFAULT 0,
    "volumeMm3" BIGINT NOT NULL DEFAULT 0,
    "storageCondition" "StorageCondition" NOT NULL DEFAULT 'AMBIENT',
    "isSellable" BOOLEAN NOT NULL DEFAULT true,
    "allowPickup" BOOLEAN NOT NULL DEFAULT true,
    "status" "SkuStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "safetyBuffer" INTEGER NOT NULL DEFAULT 2,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "inTransit" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger_entries" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "sourceType" "LedgerSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "commandKey" TEXT,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" TEXT NOT NULL,
    "reservationNumber" TEXT NOT NULL,
    "orderId" TEXT,
    "skuId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "committedAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supplierName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "receivedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" TEXT NOT NULL,
    "adjustmentNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reason" "AdjustmentReason" NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment_lines" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "deltaQuantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_shipments" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "sourceLocationId" TEXT NOT NULL,
    "destinationPickupPointId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "transferFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "promisedCollectionWindowStart" TIMESTAMPTZ(3),
    "promisedCollectionWindowEnd" TIMESTAMPTZ(3),
    "shippedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transfer_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_tokens" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "otpCode" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "lengthMm" INTEGER NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "heightMm" INTEGER NOT NULL,
    "weightG" BIGINT NOT NULL,
    "allowedOrientations" JSONB NOT NULL,
    "measurementSource" TEXT NOT NULL,
    "measuredAt" TIMESTAMPTZ(3),
    "status" "PackageStatus" NOT NULL DEFAULT 'DRAFT',
    "holdingSlot" TEXT,
    "arrivedAtPickupPointAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorUserId" TEXT,
    "commandId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_licenses" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "driver_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "jurisdiction" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "approvalReference" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_activity_events" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "tripId" TEXT,
    "activityType" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "correctionOfId" TEXT,
    "payload" JSONB,

    CONSTRAINT "driver_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_events" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "tripStopId" TEXT,
    "stopTaskId" TEXT,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gps_events" (
    "id" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL,
    "deviceSessionId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "tripId" TEXT,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "longitude" DECIMAL(10,7) NOT NULL,
    "latitude" DECIMAL(9,7) NOT NULL,
    "accuracyM" DECIMAL(8,2),
    "speedKph" DECIMAL(8,2),
    "headingDegrees" DECIMAL(6,2),

    CONSTRAINT "gps_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" TEXT NOT NULL,
    "tripStopId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "recipientName" TEXT,
    "result" TEXT NOT NULL,
    "failureReason" TEXT,
    "commandId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pod_files" (
    "id" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "capturedAt" TIMESTAMPTZ(3),
    "uploadedAt" TIMESTAMPTZ(3),
    "supersedesId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pod_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "reporterId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_orders" (
    "incidentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "incident_orders_pkey" PRIMARY KEY ("incidentId","orderId")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tripId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedAt" TIMESTAMPTZ(3),
    "lockedBy" TEXT,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "deadLetteredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_commands" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "processed_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_entries" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "basis" TEXT NOT NULL,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceReference" TEXT,
    "receiptImageUrl" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cost_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_entries" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "clockInAt" TIMESTAMPTZ(3),
    "clockOutAt" TIMESTAMPTZ(3),
    "workedMinutes" INTEGER,
    "overtimeMinutes" INTEGER,
    "source" TEXT NOT NULL,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_leave" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveType" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "userId" TEXT,
    "branchId" TEXT NOT NULL,
    "departmentName" TEXT,
    "positionName" TEXT,
    "baseSalary" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "citizenId" TEXT,
    "joinedOn" DATE NOT NULL,
    "leftOn" DATE,
    "employmentStatus" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_logs" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tripId" TEXT,
    "liters" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(20,4) NOT NULL,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "odometerKm" DECIMAL(12,1),
    "filledAt" TIMESTAMPTZ(3) NOT NULL,
    "sourceReference" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_placements" (
    "id" TEXT NOT NULL,
    "loadPlanStepId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "xMm" INTEGER NOT NULL,
    "yMm" INTEGER NOT NULL,
    "zMm" INTEGER NOT NULL DEFAULT 0,
    "orientation" TEXT NOT NULL,
    "effectiveLengthMm" INTEGER NOT NULL,
    "effectiveWidthMm" INTEGER NOT NULL,
    "effectiveHeightMm" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_plan_steps" (
    "id" TEXT NOT NULL,
    "loadPlanId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "stopTaskId" TEXT,
    "operationType" TEXT NOT NULL,
    "packageId" TEXT,
    "handlingPath" JSONB,
    "validationResult" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_plan_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "load_plans" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "initialStateSnapshot" JSONB NOT NULL,
    "geometrySnapshot" JSONB NOT NULL,
    "validationStatus" "LoadValidationStatus" NOT NULL DEFAULT 'PENDING',
    "validatorVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "servicedAt" TIMESTAMPTZ(3) NOT NULL,
    "odometerKm" INTEGER,
    "serviceSummary" TEXT NOT NULL,
    "partsSummary" JSONB,
    "findings" JSONB,
    "costAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "warrantyUntil" DATE,
    "nextRecommendationAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_results" (
    "id" TEXT NOT NULL,
    "optimizationJobId" TEXT NOT NULL,
    "candidateNumber" INTEGER NOT NULL,
    "resultSnapshot" JSONB NOT NULL,
    "feasibilityStatus" "FeasibilityStatus" NOT NULL,
    "objectiveBreakdown" JSONB NOT NULL,
    "diagnostics" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "optimization_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "driverId" TEXT,
    "compensationPolicyId" TEXT,
    "baseAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tripAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "allowanceAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "overtimeAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "deductionAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "calculationSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "payDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "payrollPeriodId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "grossAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "deductionAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_reservations" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_unavailability" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_unavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "recipientName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "ward" TEXT,
    "district" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_cases" (
    "id" TEXT NOT NULL,
    "caseNumber" TEXT NOT NULL,
    "type" "FeedbackType" NOT NULL,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "FeedbackPriority" NOT NULL DEFAULT 'NORMAL',
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "packageId" TEXT,
    "locationId" TEXT,
    "assignedToUserId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rating" INTEGER,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feedback_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_messages" (
    "id" TEXT NOT NULL,
    "feedbackCaseId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorCustomerId" TEXT,
    "message" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "buyerName" TEXT NOT NULL,
    "buyerPhone" TEXT,
    "buyerTaxCode" TEXT,
    "buyerAddress" TEXT,
    "subtotal" DECIMAL(20,4) NOT NULL,
    "taxAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "providerRef" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "voidedAt" TIMESTAMPTZ(3),
    "issuedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" TEXT NOT NULL,
    "salesInvoiceId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "skuCode" TEXT NOT NULL,
    "skuName" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(20,4) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_transfer_shipments" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "transferShipmentId" TEXT NOT NULL,
    "pickupStopId" TEXT,
    "deliveryStopId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_transfer_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "PaymentTransactionType" NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "method" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "transactionRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_items" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_events" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "eventType" "PackageEventType" NOT NULL,
    "locationId" TEXT,
    "actorUserId" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plateNumber_key" ON "vehicles"("plateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_employeeId_key" ON "drivers"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_userId_key" ON "drivers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_citizenId_key" ON "drivers"("citizenId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_licenseNumber_key" ON "drivers"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_userId_key" ON "customers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE INDEX "orders_branchId_status_idx" ON "orders"("branchId", "status");

-- CreateIndex
CREATE INDEX "orders_selectedPickupPointId_status_idx" ON "orders"("selectedPickupPointId", "status");

-- CreateIndex
CREATE INDEX "order_stops_orderId_type_idx" ON "order_stops"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "order_stops_orderId_sequence_key" ON "order_stops"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_skuId_idx" ON "order_items"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "trips_tripNumber_key" ON "trips"("tripNumber");

-- CreateIndex
CREATE INDEX "trips_vehicleId_plannedStartTime_plannedEndTime_idx" ON "trips"("vehicleId", "plannedStartTime", "plannedEndTime");

-- CreateIndex
CREATE INDEX "trips_managingBranchId_status_plannedStartTime_idx" ON "trips"("managingBranchId", "status", "plannedStartTime");

-- CreateIndex
CREATE INDEX "trip_stops_tripId_status_idx" ON "trip_stops"("tripId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_tripId_sequence_key" ON "trip_stops"("tripId", "sequence");

-- CreateIndex
CREATE INDEX "stop_tasks_tripStopId_action_idx" ON "stop_tasks"("tripStopId", "action");

-- CreateIndex
CREATE INDEX "stop_tasks_orderId_idx" ON "stop_tasks"("orderId");

-- CreateIndex
CREATE INDEX "stop_tasks_packageId_idx" ON "stop_tasks"("packageId");

-- CreateIndex
CREATE INDEX "driver_assignments_driverId_startTime_endTime_idx" ON "driver_assignments"("driverId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "driver_assignments_tripId_status_idx" ON "driver_assignments"("tripId", "status");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_timestamp_idx" ON "audit_logs"("entityType", "entityId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_timestamp_idx" ON "audit_logs"("actorUserId", "timestamp");

-- CreateIndex
CREATE INDEX "optimization_jobs_branchId_createdAt_idx" ON "optimization_jobs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "optimization_jobs_status_createdAt_idx" ON "optimization_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "user_location_scopes_branchId_active_idx" ON "user_location_scopes"("branchId", "active");

-- CreateIndex
CREATE INDEX "user_location_scopes_locationId_active_idx" ON "user_location_scopes"("locationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_scopes_identity_key" ON "user_location_scopes"("userId", "role", "scopeType", "branchId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "locations_type_active_idx" ON "locations"("type", "active");

-- CreateIndex
CREATE INDEX "locations_managingBranchId_idx" ON "locations"("managingBranchId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");

-- CreateIndex
CREATE INDEX "categories_parentId_active_idx" ON "categories"("parentId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_categoryId_status_idx" ON "products"("categoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "skus_skuCode_key" ON "skus"("skuCode");

-- CreateIndex
CREATE UNIQUE INDEX "skus_barcode_key" ON "skus"("barcode");

-- CreateIndex
CREATE INDEX "skus_productId_status_idx" ON "skus"("productId", "status");

-- CreateIndex
CREATE INDEX "skus_storageCondition_isSellable_idx" ON "skus"("storageCondition", "isSellable");

-- CreateIndex
CREATE INDEX "stock_balances_locationId_idx" ON "stock_balances"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_skuId_locationId_key" ON "stock_balances"("skuId", "locationId");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_skuId_locationId_createdAt_idx" ON "stock_ledger_entries"("skuId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_ledger_entries_sourceType_sourceId_idx" ON "stock_ledger_entries"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_reservationNumber_key" ON "inventory_reservations"("reservationNumber");

-- CreateIndex
CREATE INDEX "inventory_reservations_skuId_locationId_status_idx" ON "inventory_reservations"("skuId", "locationId", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_status_expiresAt_idx" ON "inventory_reservations"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_receipts_receiptNumber_key" ON "stock_receipts"("receiptNumber");

-- CreateIndex
CREATE INDEX "stock_receipts_locationId_createdAt_idx" ON "stock_receipts"("locationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_adjustmentNumber_key" ON "stock_adjustments"("adjustmentNumber");

-- CreateIndex
CREATE INDEX "stock_adjustments_locationId_reason_idx" ON "stock_adjustments"("locationId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_shipments_shipmentNumber_key" ON "transfer_shipments"("shipmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_shipments_packageId_key" ON "transfer_shipments"("packageId");

-- CreateIndex
CREATE INDEX "transfer_shipments_sourceLocationId_idx" ON "transfer_shipments"("sourceLocationId");

-- CreateIndex
CREATE INDEX "transfer_shipments_destinationPickupPointId_status_idx" ON "transfer_shipments"("destinationPickupPointId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "collection_tokens_orderId_key" ON "collection_tokens"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_tokens_qrToken_key" ON "collection_tokens"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "packages_packageCode_key" ON "packages"("packageCode");

-- CreateIndex
CREATE INDEX "packages_orderId_status_idx" ON "packages"("orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_status_events_commandId_key" ON "order_status_events"("commandId");

-- CreateIndex
CREATE INDEX "order_status_events_orderId_occurredAt_idx" ON "order_status_events"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "driver_licenses_driverId_validUntil_idx" ON "driver_licenses"("driverId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "driver_licenses_driverId_licenseNumber_category_key" ON "driver_licenses"("driverId", "licenseNumber", "category");

-- CreateIndex
CREATE UNIQUE INDEX "work_policies_code_revision_key" ON "work_policies"("code", "revision");

-- CreateIndex
CREATE INDEX "driver_activity_events_driverId_occurredAt_idx" ON "driver_activity_events"("driverId", "occurredAt");

-- CreateIndex
CREATE INDEX "driver_activity_events_tripId_occurredAt_idx" ON "driver_activity_events"("tripId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "execution_events_commandId_key" ON "execution_events"("commandId");

-- CreateIndex
CREATE INDEX "execution_events_tripId_occurredAt_idx" ON "execution_events"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "execution_events_tripStopId_occurredAt_idx" ON "execution_events"("tripStopId", "occurredAt");

-- CreateIndex
CREATE INDEX "gps_events_tripId_measuredAt_idx" ON "gps_events"("tripId", "measuredAt");

-- CreateIndex
CREATE INDEX "gps_events_vehicleId_measuredAt_idx" ON "gps_events"("vehicleId", "measuredAt");

-- CreateIndex
CREATE INDEX "gps_events_driverId_measuredAt_idx" ON "gps_events"("driverId", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "gps_events_deviceCode_deviceSessionId_sequence_key" ON "gps_events"("deviceCode", "deviceSessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_commandId_key" ON "delivery_attempts"("commandId");

-- CreateIndex
CREATE INDEX "delivery_attempts_occurredAt_idx" ON "delivery_attempts"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_tripStopId_attemptNumber_key" ON "delivery_attempts"("tripStopId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "pod_files_storageKey_key" ON "pod_files"("storageKey");

-- CreateIndex
CREATE INDEX "pod_files_deliveryAttemptId_uploadStatus_idx" ON "pod_files"("deliveryAttemptId", "uploadStatus");

-- CreateIndex
CREATE INDEX "incidents_tripId_occurredAt_idx" ON "incidents"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "incidents_status_severity_idx" ON "incidents"("status", "severity");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_deadLetteredAt_nextAttemptAt_createdA" ON "outbox_events"("publishedAt", "deadLetteredAt", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_lockedAt_idx" ON "outbox_events"("lockedAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_aggregateVersion_idx" ON "outbox_events"("aggregateType", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE INDEX "processed_commands_status_createdAt_idx" ON "processed_commands"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "processed_commands_actorUserId_commandType_idempotencyKey_key" ON "processed_commands"("actorUserId", "commandType", "idempotencyKey");

-- CreateIndex
CREATE INDEX "cost_entries_tripId_occurredAt_idx" ON "cost_entries"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "cost_entries_approvalStatus_occurredAt_idx" ON "cost_entries"("approvalStatus", "occurredAt");

-- CreateIndex
CREATE INDEX "attendance_entries_workDate_approvalStatus_idx" ON "attendance_entries"("workDate", "approvalStatus");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_entries_employeeId_workDate_key" ON "attendance_entries"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "employee_leave_employeeId_startsAt_endsAt_idx" ON "employee_leave"("employeeId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeCode_key" ON "employees"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "employees_userId_key" ON "employees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_citizenId_key" ON "employees"("citizenId");

-- CreateIndex
CREATE INDEX "employees_branchId_employmentStatus_idx" ON "employees"("branchId", "employmentStatus");

-- CreateIndex
CREATE INDEX "fuel_logs_vehicleId_filledAt_idx" ON "fuel_logs"("vehicleId", "filledAt");

-- CreateIndex
CREATE INDEX "fuel_logs_tripId_idx" ON "fuel_logs"("tripId");

-- CreateIndex
CREATE INDEX "load_placements_packageId_idx" ON "load_placements"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "load_placements_loadPlanStepId_packageId_key" ON "load_placements"("loadPlanStepId", "packageId");

-- CreateIndex
CREATE INDEX "load_plan_steps_stopTaskId_idx" ON "load_plan_steps"("stopTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "load_plan_steps_loadPlanId_stepNumber_key" ON "load_plan_steps"("loadPlanId", "stepNumber");

-- CreateIndex
CREATE INDEX "load_plans_validationStatus_createdAt_idx" ON "load_plans"("validationStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "load_plans_tripId_revision_key" ON "load_plans"("tripId", "revision");

-- CreateIndex
CREATE INDEX "maintenance_records_vehicleId_servicedAt_idx" ON "maintenance_records"("vehicleId", "servicedAt");

-- CreateIndex
CREATE INDEX "optimization_results_feasibilityStatus_createdAt_idx" ON "optimization_results"("feasibilityStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "optimization_results_optimizationJobId_candidateNumber_key" ON "optimization_results"("optimizationJobId", "candidateNumber");

-- CreateIndex
CREATE INDEX "payroll_items_driverId_idx" ON "payroll_items"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_payrollRunId_employeeId_key" ON "payroll_items"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_branchId_code_key" ON "payroll_periods"("branchId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_branchId_startsOn_endsOn_key" ON "payroll_periods"("branchId", "startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "payroll_runs_status_createdAt_idx" ON "payroll_runs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_payrollPeriodId_runNumber_key" ON "payroll_runs"("payrollPeriodId", "runNumber");

-- CreateIndex
CREATE INDEX "resource_reservations_tripId_status_idx" ON "resource_reservations"("tripId", "status");

-- CreateIndex
CREATE INDEX "resource_reservations_vehicleId_startsAt_endsAt_idx" ON "resource_reservations"("vehicleId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "resource_reservations_driverId_startsAt_endsAt_idx" ON "resource_reservations"("driverId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "vehicle_unavailability_vehicleId_startsAt_endsAt_idx" ON "vehicle_unavailability"("vehicleId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "customer_addresses_customerId_active_idx" ON "customer_addresses"("customerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_cases_caseNumber_key" ON "feedback_cases"("caseNumber");

-- CreateIndex
CREATE INDEX "feedback_cases_customerId_status_createdAt_idx" ON "feedback_cases"("customerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "feedback_cases_assignedToUserId_status_priority_idx" ON "feedback_cases"("assignedToUserId", "status", "priority");

-- CreateIndex
CREATE INDEX "feedback_cases_locationId_status_idx" ON "feedback_cases"("locationId", "status");

-- CreateIndex
CREATE INDEX "feedback_messages_feedbackCaseId_createdAt_idx" ON "feedback_messages"("feedbackCaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_invoiceNumber_key" ON "sales_invoices"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_orderId_key" ON "sales_invoices"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_providerRef_key" ON "sales_invoices"("providerRef");

-- CreateIndex
CREATE INDEX "sales_invoices_locationId_status_issuedAt_idx" ON "sales_invoices"("locationId", "status", "issuedAt");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_salesInvoiceId_idx" ON "sales_invoice_lines"("salesInvoiceId");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_orderItemId_idx" ON "sales_invoice_lines"("orderItemId");

-- CreateIndex
CREATE INDEX "trip_transfer_shipments_tripId_status_idx" ON "trip_transfer_shipments"("tripId", "status");

-- CreateIndex
CREATE INDEX "trip_transfer_shipments_transferShipmentId_status_idx" ON "trip_transfer_shipments"("transferShipmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_transactionRef_key" ON "payment_transactions"("transactionRef");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_idempotencyKey_key" ON "payment_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payment_transactions_orderId_type_createdAt_idx" ON "payment_transactions"("orderId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "package_items_orderItemId_idx" ON "package_items"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "package_items_packageId_orderItemId_key" ON "package_items"("packageId", "orderItemId");

-- CreateIndex
CREATE INDEX "package_events_packageId_occurredAt_idx" ON "package_events"("packageId", "occurredAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_homeBranchId_fkey" FOREIGN KEY ("homeBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_homeBranchId_fkey" FOREIGN KEY ("homeBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_selectedPickupPointId_fkey" FOREIGN KEY ("selectedPickupPointId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_allocatedSourceId_fkey" FOREIGN KEY ("allocatedSourceId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_stops" ADD CONSTRAINT "order_stops_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_managingBranchId_fkey" FOREIGN KEY ("managingBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_orderStopId_fkey" FOREIGN KEY ("orderStopId") REFERENCES "order_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_startStopId_fkey" FOREIGN KEY ("startStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_endStopId_fkey" FOREIGN KEY ("endStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_jobs" ADD CONSTRAINT "optimization_jobs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_jobs" ADD CONSTRAINT "optimization_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_scopes" ADD CONSTRAINT "user_location_scopes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_scopes" ADD CONSTRAINT "user_location_scopes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location_scopes" ADD CONSTRAINT "user_location_scopes_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_managingBranchId_fkey" FOREIGN KEY ("managingBranchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger_entries" ADD CONSTRAINT "stock_ledger_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "stock_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "stock_adjustments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_shipments" ADD CONSTRAINT "transfer_shipments_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_shipments" ADD CONSTRAINT "transfer_shipments_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_shipments" ADD CONSTRAINT "transfer_shipments_destinationPickupPointId_fkey" FOREIGN KEY ("destinationPickupPointId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_tokens" ADD CONSTRAINT "collection_tokens_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_tokens" ADD CONSTRAINT "collection_tokens_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "driver_activity_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_files" ADD CONSTRAINT "pod_files_deliveryAttemptId_fkey" FOREIGN KEY ("deliveryAttemptId") REFERENCES "delivery_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pod_files" ADD CONSTRAINT "pod_files_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "pod_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_orders" ADD CONSTRAINT "incident_orders_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_orders" ADD CONSTRAINT "incident_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_commands" ADD CONSTRAINT "processed_commands_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_leave" ADD CONSTRAINT "employee_leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_placements" ADD CONSTRAINT "load_placements_loadPlanStepId_fkey" FOREIGN KEY ("loadPlanStepId") REFERENCES "load_plan_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_placements" ADD CONSTRAINT "load_placements_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_loadPlanId_fkey" FOREIGN KEY ("loadPlanId") REFERENCES "load_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_results" ADD CONSTRAINT "optimization_results_optimizationJobId_fkey" FOREIGN KEY ("optimizationJobId") REFERENCES "optimization_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_feedbackCaseId_fkey" FOREIGN KEY ("feedbackCaseId") REFERENCES "feedback_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_authorCustomerId_fkey" FOREIGN KEY ("authorCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_salesInvoiceId_fkey" FOREIGN KEY ("salesInvoiceId") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_transfer_shipments" ADD CONSTRAINT "trip_transfer_shipments_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_transfer_shipments" ADD CONSTRAINT "trip_transfer_shipments_transferShipmentId_fkey" FOREIGN KEY ("transferShipmentId") REFERENCES "transfer_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_transfer_shipments" ADD CONSTRAINT "trip_transfer_shipments_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_transfer_shipments" ADD CONSTRAINT "trip_transfer_shipments_deliveryStopId_fkey" FOREIGN KEY ("deliveryStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_events" ADD CONSTRAINT "package_events_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_events" ADD CONSTRAINT "package_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Demo baseline invariants. Existing data is intentionally reset before this baseline.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "branches" ADD CONSTRAINT "branches_daytime_hours_check"
  CHECK ("workStartTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "workEndTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "workStartTime" < "workEndTime");
ALTER TABLE "locations" ADD CONSTRAINT "locations_daytime_hours_check"
  CHECK ("workStartTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "workEndTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "workStartTime" < "workEndTime");
ALTER TABLE "locations" ADD CONSTRAINT "locations_capacity_check"
  CHECK ("totalHoldingSlots" >= 0 AND "availableHoldingSlots" >= 0 AND "availableHoldingSlots" <= "totalHoldingSlots");
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_nonnegative_check"
  CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "damaged" >= 0 AND "inTransit" >= 0 AND "reserved" <= "onHand");
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_values_check"
  CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0 AND "weightKg" >= 0 AND "lengthCm" >= 0 AND "widthCm" >= 0 AND "heightCm" >= 0 AND "volumeM3" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_totals_check"
  CHECK ("subtotal" >= 0 AND "discountAmount" >= 0 AND "shippingFee" >= 0 AND "totalAmount" >= 0 AND "totalWeightKg" >= 0 AND "totalVolumeM3" >= 0 AND "totalPackages" >= 0);
ALTER TABLE "packages" ADD CONSTRAINT "packages_dimensions_check"
  CHECK ("lengthMm" > 0 AND "widthMm" > 0 AND "heightMm" > 0 AND "weightG" > 0);
ALTER TABLE "package_items" ADD CONSTRAINT "package_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amount_check" CHECK ("amount" > 0);
ALTER TABLE "collection_tokens" ADD CONSTRAINT "collection_tokens_attempt_count_check" CHECK ("attemptCount" >= 0);
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_one_author_check"
  CHECK (("authorUserId" IS NOT NULL)::int + ("authorCustomerId" IS NOT NULL)::int = 1);
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_totals_check"
  CHECK ("subtotal" >= 0 AND "taxAmount" >= 0 AND "totalAmount" >= 0);
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_values_check"
  CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "taxRate" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_values_check"
  CHECK (("odometerKm" IS NULL OR "odometerKm" >= 0) AND "costAmount" >= 0);
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_time_check"
  CHECK ("clockOutAt" IS NULL OR "clockInAt" IS NULL OR "clockOutAt" > "clockInAt");
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_time_check" CHECK ("endsAt" > "startsAt");
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_time_check" CHECK ("endTime" > "startTime");
ALTER TABLE "trips" ADD CONSTRAINT "trips_planned_time_check" CHECK ("plannedEndTime" > "plannedStartTime");

ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_vehicle_no_overlap"
  EXCLUDE USING gist ("vehicleId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("vehicleId" IS NOT NULL AND "status" IN ('HELD', 'ACTIVE'));
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_driver_no_overlap"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("driverId" IS NOT NULL AND "status" IN ('HELD', 'ACTIVE'));
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_no_overlap"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&)
  WHERE ("status" IN ('ASSIGNED', 'ACTIVE'));

CREATE UNIQUE INDEX "trip_transfer_shipments_one_active_assignment"
  ON "trip_transfer_shipments"("transferShipmentId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "customer_addresses_one_active_default"
  ON "customer_addresses"("customerId") WHERE "isDefault" = true AND "active" = true;

