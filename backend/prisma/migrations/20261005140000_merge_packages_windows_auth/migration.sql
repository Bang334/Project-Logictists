-- Upgrade only from the incoming 66-table baseline plus its migrations through 20261003210000.
-- See MERGE_RECOVERY.md before applying: older divergent auth/package migrations must be reconciled.
-- No package backfill and no reconstruction of windows already removed by the incoming migration.
BEGIN;
-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- DropForeignKey
ALTER TABLE "order_status_events" DROP CONSTRAINT "order_status_events_actorUserId_fkey";

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "vehicleTypeId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "packageDataStatus" TEXT NOT NULL DEFAULT 'LEGACY_REVIEW';

-- AlterTable
ALTER TABLE "order_stops" ADD COLUMN     "windowBasis" TEXT,
ADD COLUMN     "windowEnd" TIMESTAMPTZ(3),
ADD COLUMN     "windowStart" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "order_items" ALTER COLUMN "lengthCm" DROP NOT NULL,
ALTER COLUMN "widthCm" DROP NOT NULL,
ALTER COLUMN "heightCm" DROP NOT NULL;

-- AlterTable
ALTER TABLE "stop_tasks" ADD COLUMN     "allocationId" TEXT;

-- AlterTable
ALTER TABLE "packages" ADD COLUMN     "orderItemId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL,
ALTER COLUMN "allowedOrientations" DROP NOT NULL;

-- AlterTable
ALTER TABLE "gps_events" ADD COLUMN     "trackingDeviceId" TEXT;

-- CreateTable
CREATE TABLE "driver_shifts" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "workPolicyId" TEXT,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "overtimeApproved" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "packageId" TEXT,
    "tripId" TEXT NOT NULL,
    "allocatedQuantity" INTEGER NOT NULL,
    "legNumber" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ALLOCATED',
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

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
    "locationId" TEXT,

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

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_login_limits" (
    "key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_login_limits_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "_LoadPlanStepTasks" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "driver_shifts_driverId_startTime_endTime_idx" ON "driver_shifts"("driverId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "allocations_tripId_status_idx" ON "allocations"("tripId", "status");

-- CreateIndex
CREATE INDEX "allocations_orderItemId_idx" ON "allocations"("orderItemId");

-- CreateIndex
CREATE INDEX "allocations_packageId_status_idx" ON "allocations"("packageId", "status");

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
CREATE UNIQUE INDEX "vehicle_types_code_key" ON "vehicle_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_doors_vehicleId_doorCode_key" ON "vehicle_doors"("vehicleId", "doorCode");

-- CreateIndex
CREATE INDEX "driver_leave_driverId_startsAt_endsAt_idx" ON "driver_leave"("driverId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_devices_installationKey_key" ON "tracking_devices"("installationKey");

-- CreateIndex
CREATE INDEX "tracking_devices_assignedVehicleId_active_idx" ON "tracking_devices"("assignedVehicleId", "active");

-- CreateIndex
CREATE INDEX "delivery_results_stopTaskId_idx" ON "delivery_results"("stopTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_results_deliveryAttemptId_packageId_key" ON "delivery_results"("deliveryAttemptId", "packageId");

-- CreateIndex
CREATE INDEX "order_charges_orderId_status_idx" ON "order_charges"("orderId", "status");

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
CREATE INDEX "auth_sessions_userId_expiresAt_idx" ON "auth_sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "auth_login_limits_expiresAt_idx" ON "auth_login_limits"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "_LoadPlanStepTasks_AB_unique" ON "_LoadPlanStepTasks"("A", "B");

-- CreateIndex
CREATE INDEX "_LoadPlanStepTasks_B_index" ON "_LoadPlanStepTasks"("B");

-- CreateIndex
CREATE INDEX "vehicles_vehicleTypeId_idx" ON "vehicles"("vehicleTypeId");

-- CreateIndex
CREATE INDEX "stop_tasks_allocationId_idx" ON "stop_tasks"("allocationId");

-- CreateIndex
CREATE INDEX "packages_orderItemId_status_idx" ON "packages"("orderItemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "packages_id_orderItemId_key" ON "packages"("id", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "gps_events_trackingDeviceId_deviceSessionId_sequence_key" ON "gps_events"("trackingDeviceId", "deviceSessionId", "sequence");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicleTypeId_fkey" FOREIGN KEY ("vehicleTypeId") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_workPolicyId_fkey" FOREIGN KEY ("workPolicyId") REFERENCES "work_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stop_tasks" ADD CONSTRAINT "stop_tasks_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "allocations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_users" ADD CONSTRAINT "customer_users_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_users" ADD CONSTRAINT "customer_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_doors" ADD CONSTRAINT "vehicle_doors_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_leave" ADD CONSTRAINT "driver_leave_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_assignedVehicleId_fkey" FOREIGN KEY ("assignedVehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_events" ADD CONSTRAINT "gps_events_trackingDeviceId_fkey" FOREIGN KEY ("trackingDeviceId") REFERENCES "tracking_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_deliveryAttemptId_fkey" FOREIGN KEY ("deliveryAttemptId") REFERENCES "delivery_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_stopTaskId_fkey" FOREIGN KEY ("stopTaskId") REFERENCES "stop_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_results" ADD CONSTRAINT "delivery_results_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_charges" ADD CONSTRAINT "order_charges_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LoadPlanStepTasks" ADD CONSTRAINT "_LoadPlanStepTasks_A_fkey" FOREIGN KEY ("A") REFERENCES "load_plan_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LoadPlanStepTasks" ADD CONSTRAINT "_LoadPlanStepTasks_B_fkey" FOREIGN KEY ("B") REFERENCES "stop_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE orders ADD CONSTRAINT orders_package_data_status CHECK ("packageDataStatus" IN ('LEGACY_REVIEW', 'COMPLETE'));
ALTER TABLE order_stops ADD CONSTRAINT order_window_basis CHECK ("windowBasis" IS NULL OR "windowBasis" = 'SERVICE_START');
ALTER TABLE order_stops ADD CONSTRAINT order_window_range CHECK ("windowBasis" IS NULL OR (("windowStart" IS NULL) = ("windowEnd" IS NULL) AND ("windowStart" IS NULL OR "windowEnd" >= "windowStart")));
CREATE UNIQUE INDEX order_service_stop_type ON order_stops ("orderId", type) WHERE "windowBasis" = 'SERVICE_START';
ALTER TABLE packages ADD CONSTRAINT package_positive_measurements CHECK ("lengthMm" > 0 AND "widthMm" > 0 AND "heightMm" > 0 AND "weightG" > 0) NOT VALID;
ALTER TABLE allocations ADD CONSTRAINT allocation_package_item_fk FOREIGN KEY ("packageId", "orderItemId") REFERENCES packages (id, "orderItemId") ON DELETE RESTRICT NOT VALID;
ALTER TABLE allocations ADD CONSTRAINT allocation_one_package CHECK ("packageId" IS NULL OR "allocatedQuantity" = 1) NOT VALID;
CREATE UNIQUE INDEX allocations_active_package ON allocations ("packageId") WHERE "packageId" IS NOT NULL AND status IN ('ACTIVE', 'ALLOCATED');
ALTER TABLE user_role_scopes ADD CONSTRAINT user_role_scopes_shape_check CHECK (("scopeType" = 'COMPANY' AND "branchId" IS NULL) OR ("scopeType" = 'BRANCH' AND "branchId" IS NOT NULL));
CREATE UNIQUE INDEX user_role_scopes_company_unique ON user_role_scopes ("userId", "roleId") WHERE "scopeType" = 'COMPANY';
CREATE UNIQUE INDEX user_role_scopes_branch_unique ON user_role_scopes ("userId", "roleId", "branchId") WHERE "scopeType" = 'BRANCH';
ALTER TABLE auth_login_limits ADD CONSTRAINT auth_login_limits_attempts_check CHECK (attempts > 0);

-- Carry forward the existing branch's authoritative User role/branch access.
-- No CUSTOMER/STAFF account receives TMS grants; inactive users remain inactive.
INSERT INTO roles(id,code,name,"updatedAt") VALUES ('merge-role-admin','ADMIN','ADMIN',now()), ('merge-role-dispatcher','DISPATCHER','DISPATCHER',now());
INSERT INTO permissions(id,code,description) VALUES ('merge-perm-branches.read','branches.read','branches.read'),('merge-perm-branches.manage','branches.manage','branches.manage'),('merge-perm-vehicles.read','vehicles.read','vehicles.read'),('merge-perm-vehicles.manage','vehicles.manage','vehicles.manage'),('merge-perm-drivers.read','drivers.read','drivers.read'),('merge-perm-drivers.manage','drivers.manage','drivers.manage'),('merge-perm-customers.read','customers.read','customers.read'),('merge-perm-orders.read','orders.read','orders.read'),('merge-perm-orders.write','orders.write','orders.write'),('merge-perm-trips.read','trips.read','trips.read'),('merge-perm-trips.plan','trips.plan','trips.plan'),('merge-perm-trips.publish','trips.publish','trips.publish'),('merge-perm-users.read','users.read','users.read'),('merge-perm-users.create','users.create','users.create'),('merge-perm-users.lock','users.lock','users.lock');
INSERT INTO role_permissions("roleId","permissionId") SELECT 'merge-role-admin',id FROM permissions;
INSERT INTO role_permissions("roleId","permissionId") SELECT 'merge-role-dispatcher',id FROM permissions WHERE code NOT LIKE 'users.%' AND code NOT LIKE '%.manage';
INSERT INTO user_role_scopes(id,"userId","roleId","scopeType","branchId","updatedAt")
 SELECT 'merge-scope-' || id, id, 'merge-role-admin', 'COMPANY', NULL, now() FROM users WHERE role = 'ADMIN';
INSERT INTO user_role_scopes(id,"userId","roleId","scopeType","branchId","updatedAt")
 SELECT 'merge-scope-' || id, id, 'merge-role-dispatcher', 'BRANCH', "branchId", now() FROM users WHERE role = 'DISPATCHER' AND "branchId" IS NOT NULL;

COMMIT;
