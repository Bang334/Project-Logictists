-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('COMPANY', 'BRANCH');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('DRAFT', 'READY', 'ALLOCATED', 'LOADED', 'DELIVERED', 'DAMAGED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TripPlanStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'ACTIVE', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoadValidationStatus" AS ENUM ('PENDING', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "FeasibilityStatus" AS ENUM ('FEASIBLE', 'PARTIAL', 'INFEASIBLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'UPLOADED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "MaintenanceWorkOrderStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'CALCULATED', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- AlterTable
ALTER TABLE "allocations" ADD COLUMN     "legNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "packageId" TEXT,
ADD COLUMN     "releasedAt" TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actorUserId" TEXT,
ADD COLUMN     "changeSummary" JSONB,
ADD COLUMN     "correlationId" TEXT,
ALTER COLUMN "timestamp" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "branches" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "driver_assignments" ADD COLUMN     "endStopId" TEXT,
ADD COLUMN     "startStopId" TEXT,
ADD COLUMN     "tripPlanId" TEXT,
ALTER COLUMN "startTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "endTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "driver_shifts" ADD COLUMN     "overtimeApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
ADD COLUMN     "workPolicyId" TEXT,
ALTER COLUMN "startTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "endTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "employeeId" TEXT,
ALTER COLUMN "licenseExpiry" SET DATA TYPE DATE,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "optimization_jobs" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "leaseUntil" TIMESTAMPTZ(3),
ADD COLUMN     "parameters" JSONB,
ADD COLUMN     "policyVersion" TEXT,
ADD COLUMN     "schemaVersion" TEXT NOT NULL DEFAULT '1',
ADD COLUMN     "solverVersion" TEXT,
ALTER COLUMN "startedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "order_items" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "order_stops" ALTER COLUMN "windowStart" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "windowEnd" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "orders" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "stop_tasks" ADD COLUMN     "orderStopId" TEXT,
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "trip_stops" ALTER COLUMN "plannedArrivalTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "plannedDepartureTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "actualArrivalTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "actualDepartureTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "activePlanId" TEXT,
ADD COLUMN     "managingBranchId" TEXT,
ALTER COLUMN "plannedStartTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "plannedEndTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "actualStartTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "actualEndTime" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "vehicleTypeId" TEXT,
ALTER COLUMN "lastLocationAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_role_scopes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "branchId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_role_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "contactRole" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_users" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "lengthMm" INTEGER NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "heightMm" INTEGER NOT NULL,
    "weightG" BIGINT NOT NULL,
    "allowedOrientations" JSONB NOT NULL,
    "measurementSource" TEXT NOT NULL,
    "measuredAt" TIMESTAMPTZ(3),
    "status" "PackageStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "actorUserId" TEXT,
    "commandId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiredLicenseCategory" TEXT,
    "handlingCapabilities" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_doors" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "doorCode" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "offsetMm" INTEGER NOT NULL,
    "sillHeightMm" INTEGER NOT NULL DEFAULT 0,
    "clearWidthMm" INTEGER NOT NULL,
    "clearHeightMm" INTEGER NOT NULL,
    "approachGeometry" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_doors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_obstacles" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "geometry" JSONB NOT NULL,
    "geometryVersion" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_obstacles_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "driver_leave" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "driver_leave_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "trip_plans" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "plannedStartTime" TIMESTAMPTZ(3) NOT NULL,
    "plannedEndTime" TIMESTAMPTZ(3) NOT NULL,
    "startLocationSnapshot" JSONB NOT NULL,
    "endLocationSnapshot" JSONB NOT NULL,
    "planningSnapshot" JSONB NOT NULL,
    "status" "TripPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_plan_stops" (
    "id" TEXT NOT NULL,
    "tripPlanId" TEXT NOT NULL,
    "tripStopId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "locationSnapshot" JSONB NOT NULL,
    "windowStart" TIMESTAMPTZ(3),
    "windowEnd" TIMESTAMPTZ(3),
    "plannedArrivalTime" TIMESTAMPTZ(3),
    "plannedServiceStart" TIMESTAMPTZ(3),
    "plannedDepartureTime" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_plan_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_plan_tasks" (
    "id" TEXT NOT NULL,
    "tripPlanId" TEXT NOT NULL,
    "stopTaskId" TEXT NOT NULL,
    "operationSequence" INTEGER NOT NULL,
    "plannedStartTime" TIMESTAMPTZ(3),
    "plannedEndTime" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_plan_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_reservations" (
    "id" TEXT NOT NULL,
    "tripPlanId" TEXT NOT NULL,
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
CREATE TABLE "load_plans" (
    "id" TEXT NOT NULL,
    "tripPlanId" TEXT NOT NULL,
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
CREATE TABLE "load_plan_steps" (
    "id" TEXT NOT NULL,
    "loadPlanId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "tripPlanTaskId" TEXT,
    "operationType" TEXT NOT NULL,
    "packageId" TEXT,
    "doorId" TEXT,
    "handlingPath" JSONB,
    "validationResult" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_plan_steps_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "load_observations" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "sourceLoadStepId" TEXT,
    "observedAt" TIMESTAMPTZ(3) NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actualLayoutSnapshot" JSONB NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "load_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_events" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "tripStopId" TEXT,
    "stopTaskId" TEXT,
    "sourcePlanId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "execution_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_devices" (
    "id" TEXT NOT NULL,
    "installationKey" TEXT NOT NULL,
    "userId" TEXT,
    "assignedVehicleId" TEXT,
    "sourceType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracking_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gps_events" (
    "id" TEXT NOT NULL,
    "trackingDeviceId" TEXT NOT NULL,
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
    "sourcePlanId" TEXT NOT NULL,
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
CREATE TABLE "delivery_results" (
    "id" TEXT NOT NULL,
    "deliveryAttemptId" TEXT NOT NULL,
    "stopTaskId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_results_pkey" PRIMARY KEY ("id")
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
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cost_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_allocations" (
    "id" TEXT NOT NULL,
    "costEntryId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "allocationMethod" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_charges" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "chargeType" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "sourceReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargo_transfers" (
    "id" TEXT NOT NULL,
    "fromTripId" TEXT NOT NULL,
    "toTripId" TEXT NOT NULL,
    "locationSnapshot" JSONB NOT NULL,
    "plannedAt" TIMESTAMPTZ(3) NOT NULL,
    "actualAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "releasedById" TEXT,
    "receivedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cargo_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cargo_transfer_packages" (
    "cargoTransferId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "fromAllocationId" TEXT NOT NULL,
    "toAllocationId" TEXT NOT NULL,
    "condition" TEXT,
    "receiptStatus" TEXT NOT NULL,

    CONSTRAINT "cargo_transfer_packages_pkey" PRIMARY KEY ("cargoTransferId","packageId")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "userId" TEXT,
    "branchId" TEXT NOT NULL,
    "departmentId" TEXT,
    "positionId" TEXT,
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
CREATE TABLE "employment_contracts" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "positionId" TEXT,
    "contractNumber" TEXT NOT NULL,
    "contractType" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "baseSalary" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "terms" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employment_contracts_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "compensation_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "calculationRules" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_policies_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "payrollItemId" TEXT NOT NULL,
    "costEntryId" TEXT,
    "adjustmentType" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_plans" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maintenanceType" TEXT NOT NULL,
    "intervalDays" INTEGER,
    "intervalKm" DECIMAL(12,1),
    "nextDueAt" TIMESTAMPTZ(3),
    "nextDueOdometerKm" DECIMAL(12,1),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_work_orders" (
    "id" TEXT NOT NULL,
    "workOrderNumber" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "maintenancePlanId" TEXT,
    "status" "MaintenanceWorkOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT NOT NULL,
    "scheduledStartAt" TIMESTAMPTZ(3),
    "scheduledEndAt" TIMESTAMPTZ(3),
    "actualStartAt" TIMESTAMPTZ(3),
    "actualEndAt" TIMESTAMPTZ(3),
    "odometerKm" DECIMAL(12,1),
    "vendorName" TEXT,
    "estimatedCost" DECIMAL(20,4),
    "actualCost" DECIMAL(20,4),
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" TEXT NOT NULL,
    "maintenanceWorkOrderId" TEXT NOT NULL,
    "serviceSummary" TEXT NOT NULL,
    "partsSummary" JSONB,
    "findings" JSONB,
    "warrantyUntil" DATE,
    "nextRecommendationAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odometer_readings" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "readingKm" DECIMAL(12,1) NOT NULL,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "commandId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odometer_readings_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedOn" DATE,
    "dueOn" DATE,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderChargeId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(20,4) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "customerId" TEXT,
    "counterpartyName" TEXT,
    "amount" DECIMAL(20,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "method" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "transactionRef" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "user_role_scopes_branchId_active_idx" ON "user_role_scopes"("branchId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_scopes_userId_roleId_scopeType_branchId_key" ON "user_role_scopes"("userId", "roleId", "scopeType", "branchId");

-- CreateIndex
CREATE INDEX "customer_contacts_customerId_active_idx" ON "customer_contacts"("customerId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "customer_users_customerId_userId_key" ON "customer_users"("customerId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_users_userId_key" ON "customer_users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "packages_packageCode_key" ON "packages"("packageCode");

-- CreateIndex
CREATE INDEX "packages_orderItemId_status_idx" ON "packages"("orderItemId", "status");

-- CreateIndex
CREATE INDEX "order_events_orderId_occurredAt_idx" ON "order_events"("orderId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_events_commandId_key" ON "order_events"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_code_key" ON "vehicle_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_doors_vehicleId_doorCode_key" ON "vehicle_doors"("vehicleId", "doorCode");

-- CreateIndex
CREATE INDEX "vehicle_obstacles_vehicleId_active_idx" ON "vehicle_obstacles"("vehicleId", "active");

-- CreateIndex
CREATE INDEX "vehicle_unavailability_vehicleId_startsAt_endsAt_idx" ON "vehicle_unavailability"("vehicleId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "driver_licenses_driverId_validUntil_idx" ON "driver_licenses"("driverId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "driver_licenses_driverId_licenseNumber_category_key" ON "driver_licenses"("driverId", "licenseNumber", "category");

-- CreateIndex
CREATE UNIQUE INDEX "work_policies_code_revision_key" ON "work_policies"("code", "revision");

-- CreateIndex
CREATE INDEX "driver_leave_driverId_startsAt_endsAt_idx" ON "driver_leave"("driverId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "driver_activity_events_driverId_occurredAt_idx" ON "driver_activity_events"("driverId", "occurredAt");

-- CreateIndex
CREATE INDEX "driver_activity_events_tripId_occurredAt_idx" ON "driver_activity_events"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "trip_plans_vehicleId_plannedStartTime_plannedEndTime_idx" ON "trip_plans"("vehicleId", "plannedStartTime", "plannedEndTime");

-- CreateIndex
CREATE INDEX "trip_plans_status_plannedStartTime_idx" ON "trip_plans"("status", "plannedStartTime");

-- CreateIndex
CREATE UNIQUE INDEX "trip_plans_tripId_revision_key" ON "trip_plans"("tripId", "revision");

-- CreateIndex
CREATE INDEX "trip_plan_stops_tripStopId_idx" ON "trip_plan_stops"("tripStopId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_plan_stops_tripPlanId_sequence_key" ON "trip_plan_stops"("tripPlanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "trip_plan_stops_tripPlanId_tripStopId_key" ON "trip_plan_stops"("tripPlanId", "tripStopId");

-- CreateIndex
CREATE INDEX "trip_plan_tasks_stopTaskId_idx" ON "trip_plan_tasks"("stopTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_plan_tasks_tripPlanId_stopTaskId_key" ON "trip_plan_tasks"("tripPlanId", "stopTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_plan_tasks_tripPlanId_operationSequence_key" ON "trip_plan_tasks"("tripPlanId", "operationSequence");

-- CreateIndex
CREATE INDEX "resource_reservations_tripPlanId_status_idx" ON "resource_reservations"("tripPlanId", "status");

-- CreateIndex
CREATE INDEX "resource_reservations_vehicleId_startsAt_endsAt_idx" ON "resource_reservations"("vehicleId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "resource_reservations_driverId_startsAt_endsAt_idx" ON "resource_reservations"("driverId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "load_plans_validationStatus_createdAt_idx" ON "load_plans"("validationStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "load_plans_tripPlanId_revision_key" ON "load_plans"("tripPlanId", "revision");

-- CreateIndex
CREATE INDEX "load_plan_steps_tripPlanTaskId_idx" ON "load_plan_steps"("tripPlanTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "load_plan_steps_loadPlanId_stepNumber_key" ON "load_plan_steps"("loadPlanId", "stepNumber");

-- CreateIndex
CREATE INDEX "load_placements_packageId_idx" ON "load_placements"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "load_placements_loadPlanStepId_packageId_key" ON "load_placements"("loadPlanStepId", "packageId");

-- CreateIndex
CREATE INDEX "load_observations_tripId_observedAt_idx" ON "load_observations"("tripId", "observedAt");

-- CreateIndex
CREATE INDEX "execution_events_tripId_occurredAt_idx" ON "execution_events"("tripId", "occurredAt");

-- CreateIndex
CREATE INDEX "execution_events_tripStopId_occurredAt_idx" ON "execution_events"("tripStopId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "execution_events_commandId_key" ON "execution_events"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_devices_installationKey_key" ON "tracking_devices"("installationKey");

-- CreateIndex
CREATE INDEX "tracking_devices_assignedVehicleId_active_idx" ON "tracking_devices"("assignedVehicleId", "active");

-- CreateIndex
CREATE INDEX "gps_events_tripId_measuredAt_idx" ON "gps_events"("tripId", "measuredAt");

-- CreateIndex
CREATE INDEX "gps_events_vehicleId_measuredAt_idx" ON "gps_events"("vehicleId", "measuredAt");

-- CreateIndex
CREATE INDEX "gps_events_driverId_measuredAt_idx" ON "gps_events"("driverId", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "gps_events_trackingDeviceId_deviceSessionId_sequence_key" ON "gps_events"("trackingDeviceId", "deviceSessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_commandId_key" ON "delivery_attempts"("commandId");

-- CreateIndex
CREATE INDEX "delivery_attempts_sourcePlanId_occurredAt_idx" ON "delivery_attempts"("sourcePlanId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_tripStopId_attemptNumber_key" ON "delivery_attempts"("tripStopId", "attemptNumber");

-- CreateIndex
CREATE INDEX "delivery_results_stopTaskId_idx" ON "delivery_results"("stopTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_results_deliveryAttemptId_packageId_key" ON "delivery_results"("deliveryAttemptId", "packageId");

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
CREATE INDEX "optimization_results_feasibilityStatus_createdAt_idx" ON "optimization_results"("feasibilityStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "optimization_results_optimizationJobId_candidateNumber_key" ON "optimization_results"("optimizationJobId", "candidateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventId_key" ON "outbox_events"("eventId");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

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
CREATE INDEX "cost_allocations_orderId_idx" ON "cost_allocations"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_allocations_costEntryId_orderId_key" ON "cost_allocations"("costEntryId", "orderId");

-- CreateIndex
CREATE INDEX "order_charges_orderId_status_idx" ON "order_charges"("orderId", "status");

-- CreateIndex
CREATE INDEX "cargo_transfers_fromTripId_plannedAt_idx" ON "cargo_transfers"("fromTripId", "plannedAt");

-- CreateIndex
CREATE INDEX "cargo_transfers_toTripId_plannedAt_idx" ON "cargo_transfers"("toTripId", "plannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_branchId_code_key" ON "departments"("branchId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "positions_departmentId_code_key" ON "positions"("departmentId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employeeCode_key" ON "employees"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "employees_userId_key" ON "employees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "employees_citizenId_key" ON "employees"("citizenId");

-- CreateIndex
CREATE INDEX "employees_branchId_employmentStatus_idx" ON "employees"("branchId", "employmentStatus");

-- CreateIndex
CREATE INDEX "employees_departmentId_positionId_idx" ON "employees"("departmentId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "employment_contracts_contractNumber_key" ON "employment_contracts"("contractNumber");

-- CreateIndex
CREATE INDEX "employment_contracts_employeeId_effectiveFrom_effectiveTo_idx" ON "employment_contracts"("employeeId", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "attendance_entries_workDate_approvalStatus_idx" ON "attendance_entries"("workDate", "approvalStatus");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_entries_employeeId_workDate_key" ON "attendance_entries"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "employee_leave_employeeId_startsAt_endsAt_idx" ON "employee_leave"("employeeId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_policies_code_revision_key" ON "compensation_policies"("code", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_branchId_code_key" ON "payroll_periods"("branchId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_branchId_startsOn_endsOn_key" ON "payroll_periods"("branchId", "startsOn", "endsOn");

-- CreateIndex
CREATE INDEX "payroll_runs_status_createdAt_idx" ON "payroll_runs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_payrollPeriodId_runNumber_key" ON "payroll_runs"("payrollPeriodId", "runNumber");

-- CreateIndex
CREATE INDEX "payroll_items_driverId_idx" ON "payroll_items"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_payrollRunId_employeeId_key" ON "payroll_items"("payrollRunId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_adjustments_payrollItemId_idx" ON "payroll_adjustments"("payrollItemId");

-- CreateIndex
CREATE INDEX "maintenance_plans_active_nextDueAt_idx" ON "maintenance_plans"("active", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plans_vehicleId_code_key" ON "maintenance_plans"("vehicleId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_work_orders_workOrderNumber_key" ON "maintenance_work_orders"("workOrderNumber");

-- CreateIndex
CREATE INDEX "maintenance_work_orders_vehicleId_status_scheduledStartAt_idx" ON "maintenance_work_orders"("vehicleId", "status", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "maintenance_work_orders_maintenancePlanId_idx" ON "maintenance_work_orders"("maintenancePlanId");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_records_maintenanceWorkOrderId_key" ON "maintenance_records"("maintenanceWorkOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "odometer_readings_commandId_key" ON "odometer_readings"("commandId");

-- CreateIndex
CREATE INDEX "odometer_readings_vehicleId_measuredAt_idx" ON "odometer_readings"("vehicleId", "measuredAt");

-- CreateIndex
CREATE INDEX "fuel_logs_vehicleId_filledAt_idx" ON "fuel_logs"("vehicleId", "filledAt");

-- CreateIndex
CREATE INDEX "fuel_logs_tripId_idx" ON "fuel_logs"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_customerId_status_dueOn_idx" ON "invoices"("customerId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "invoices_branchId_issuedOn_idx" ON "invoices"("branchId", "issuedOn");

-- CreateIndex
CREATE INDEX "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_items_orderId_idx" ON "invoice_items"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentNumber_key" ON "payments"("paymentNumber");

-- CreateIndex
CREATE INDEX "payments_customerId_status_paidAt_idx" ON "payments"("customerId", "status", "paidAt");

-- CreateIndex
CREATE INDEX "payments_transactionRef_idx" ON "payments"("transactionRef");

-- CreateIndex
CREATE INDEX "payment_allocations_invoiceId_idx" ON "payment_allocations"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_invoiceId_key" ON "payment_allocations"("paymentId", "invoiceId");

-- CreateIndex
CREATE INDEX "allocations_tripId_status_idx" ON "allocations"("tripId", "status");

-- CreateIndex
CREATE INDEX "allocations_orderItemId_idx" ON "allocations"("orderItemId");

-- CreateIndex
CREATE INDEX "allocations_packageId_status_idx" ON "allocations"("packageId", "status");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_timestamp_idx" ON "audit_logs"("entityType", "entityId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_timestamp_idx" ON "audit_logs"("actorUserId", "timestamp");

-- CreateIndex
CREATE INDEX "driver_assignments_driverId_startTime_endTime_idx" ON "driver_assignments"("driverId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "driver_assignments_tripPlanId_idx" ON "driver_assignments"("tripPlanId");

-- CreateIndex
CREATE INDEX "driver_shifts_driverId_startTime_endTime_idx" ON "driver_shifts"("driverId", "startTime", "endTime");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_employeeId_key" ON "drivers"("employeeId");

-- CreateIndex
CREATE INDEX "order_stops_orderId_type_idx" ON "order_stops"("orderId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "order_stops_orderId_sequence_key" ON "order_stops"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "stop_tasks_tripStopId_action_idx" ON "stop_tasks"("tripStopId", "action");

-- CreateIndex
CREATE INDEX "stop_tasks_allocationId_idx" ON "stop_tasks"("allocationId");

-- CreateIndex
CREATE INDEX "trip_stops_tripId_status_idx" ON "trip_stops"("tripId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trip_stops_tripId_sequence_key" ON "trip_stops"("tripId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "trips_activePlanId_key" ON "trips"("activePlanId");

-- CreateIndex
CREATE INDEX "trips_vehicleId_plannedStartTime_plannedEndTime_idx" ON "trips"("vehicleId", "plannedStartTime", "plannedEndTime");

-- CreateIndex
CREATE INDEX "trips_managingBranchId_status_plannedStartTime_idx" ON "trips"("managingBranchId", "status", "plannedStartTime");

-- CreateIndex
CREATE INDEX "vehicles_vehicleTypeId_idx" ON "vehicles"("vehicleTypeId");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_workPolicyId_fkey" FOREIGN KEY ("workPolicyId") REFERENCES "work_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_managingBranchId_fkey" FOREIGN KEY ("managingBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_activePlanId_fkey" FOREIGN KEY ("activePlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_orderStopId_fkey" FOREIGN KEY ("orderStopId") REFERENCES "order_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_tripPlanId_fkey" FOREIGN KEY ("tripPlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_startStopId_fkey" FOREIGN KEY ("startStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_endStopId_fkey" FOREIGN KEY ("endStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_users" ADD CONSTRAINT "customer_users_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_users" ADD CONSTRAINT "customer_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_doors" ADD CONSTRAINT "vehicle_doors_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_obstacles" ADD CONSTRAINT "vehicle_obstacles_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_leave" ADD CONSTRAINT "driver_leave_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_activity_events" ADD CONSTRAINT "driver_activity_events_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "driver_activity_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plans" ADD CONSTRAINT "trip_plans_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plans" ADD CONSTRAINT "trip_plans_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plans" ADD CONSTRAINT "trip_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plan_stops" ADD CONSTRAINT "trip_plan_stops_tripPlanId_fkey" FOREIGN KEY ("tripPlanId") REFERENCES "trip_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plan_stops" ADD CONSTRAINT "trip_plan_stops_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plan_tasks" ADD CONSTRAINT "trip_plan_tasks_tripPlanId_fkey" FOREIGN KEY ("tripPlanId") REFERENCES "trip_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_plan_tasks" ADD CONSTRAINT "trip_plan_tasks_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_tripPlanId_fkey" FOREIGN KEY ("tripPlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_reservations" ADD CONSTRAINT "resource_reservations_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plans" ADD CONSTRAINT "load_plans_tripPlanId_fkey" FOREIGN KEY ("tripPlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_loadPlanId_fkey" FOREIGN KEY ("loadPlanId") REFERENCES "load_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_tripPlanTaskId_fkey" FOREIGN KEY ("tripPlanTaskId") REFERENCES "trip_plan_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_plan_steps" ADD CONSTRAINT "load_plan_steps_doorId_fkey" FOREIGN KEY ("doorId") REFERENCES "vehicle_doors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_placements" ADD CONSTRAINT "load_placements_loadPlanStepId_fkey" FOREIGN KEY ("loadPlanStepId") REFERENCES "load_plan_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_placements" ADD CONSTRAINT "load_placements_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_observations" ADD CONSTRAINT "load_observations_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_observations" ADD CONSTRAINT "load_observations_sourceLoadStepId_fkey" FOREIGN KEY ("sourceLoadStepId") REFERENCES "load_plan_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "load_observations" ADD CONSTRAINT "load_observations_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_sourcePlanId_fkey" FOREIGN KEY ("sourcePlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_assignedVehicleId_fkey" FOREIGN KEY ("assignedVehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_trackingDeviceId_fkey" FOREIGN KEY ("trackingDeviceId") REFERENCES "tracking_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_tripStopId_fkey" FOREIGN KEY ("tripStopId") REFERENCES "trip_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_sourcePlanId_fkey" FOREIGN KEY ("sourcePlanId") REFERENCES "trip_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_deliveryAttemptId_fkey" FOREIGN KEY ("deliveryAttemptId") REFERENCES "delivery_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "optimization_results" ADD CONSTRAINT "optimization_results_optimizationJobId_fkey" FOREIGN KEY ("optimizationJobId") REFERENCES "optimization_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_commands" ADD CONSTRAINT "processed_commands_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_costEntryId_fkey" FOREIGN KEY ("costEntryId") REFERENCES "cost_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_allocations" ADD CONSTRAINT "cost_allocations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfers" ADD CONSTRAINT "cargo_transfers_fromTripId_fkey" FOREIGN KEY ("fromTripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfers" ADD CONSTRAINT "cargo_transfers_toTripId_fkey" FOREIGN KEY ("toTripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfers" ADD CONSTRAINT "cargo_transfers_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfers" ADD CONSTRAINT "cargo_transfers_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfer_packages" ADD CONSTRAINT "cargo_transfer_packages_cargoTransferId_fkey" FOREIGN KEY ("cargoTransferId") REFERENCES "cargo_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfer_packages" ADD CONSTRAINT "cargo_transfer_packages_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfer_packages" ADD CONSTRAINT "cargo_transfer_packages_fromAllocationId_fkey" FOREIGN KEY ("fromAllocationId") REFERENCES "allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_transfer_packages" ADD CONSTRAINT "cargo_transfer_packages_toAllocationId_fkey" FOREIGN KEY ("toAllocationId") REFERENCES "allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_contracts" ADD CONSTRAINT "employment_contracts_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_entries" ADD CONSTRAINT "attendance_entries_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_leave" ADD CONSTRAINT "employee_leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_compensationPolicyId_fkey" FOREIGN KEY ("compensationPolicyId") REFERENCES "compensation_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "payroll_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_costEntryId_fkey" FOREIGN KEY ("costEntryId") REFERENCES "cost_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_maintenancePlanId_fkey" FOREIGN KEY ("maintenancePlanId") REFERENCES "maintenance_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_maintenanceWorkOrderId_fkey" FOREIGN KEY ("maintenanceWorkOrderId") REFERENCES "maintenance_work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_orderChargeId_fkey" FOREIGN KEY ("orderChargeId") REFERENCES "order_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
