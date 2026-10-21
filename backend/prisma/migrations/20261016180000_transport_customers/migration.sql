BEGIN;
ALTER TABLE customers ADD COLUMN version integer NOT NULL DEFAULT 1,
 ADD COLUMN "retailPhoneKey" text,
 ADD CONSTRAINT customers_version_positive CHECK (version > 0);
-- Keep the historical retail identity; transport phone is contact data, not identity.
UPDATE customers SET "retailPhoneKey" = phone;
CREATE UNIQUE INDEX "customers_retailPhoneKey_key" ON customers("retailPhoneKey");
DROP INDEX "customers_phone_key";

CREATE TABLE customer_branches (
 "customerId" text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "branchId" text NOT NULL REFERENCES branches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT customer_branches_pkey PRIMARY KEY ("customerId", "branchId")
);
CREATE INDEX "customer_branches_branchId_customerId_idx" ON customer_branches("branchId", "customerId");
-- Approved service scope, not ownership. Retail orders do not grant transport access.
INSERT INTO customer_branches("customerId", "branchId")
 SELECT DISTINCT "customerId", "branchId" FROM orders WHERE "orderType" = 'B2B_TRANSPORT';
-- Customers without transport orders remain unassigned and visible only to company ADMIN.
INSERT INTO permissions(id, code, description) VALUES
 ('transport-customers-write', 'customers.write', 'Create and edit transport customer profiles within granted scope'),
 ('transport-customers-manage', 'customers.manage', 'Manage customer branch service scope')
 ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions("roleId", "permissionId")
 SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE (r.code IN ('ADMIN', 'DISPATCHER') AND p.code='customers.write')
 OR (r.code='ADMIN' AND p.code='customers.manage')
 ON CONFLICT DO NOTHING;
COMMIT;
