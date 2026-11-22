ALTER TABLE "trips"
  ADD COLUMN "approvedPlanVersion" INTEGER,
  ADD COLUMN "approvedPlanById" TEXT,
  ADD COLUMN "approvedPlanAt" TIMESTAMPTZ(3);

INSERT INTO "roles" ("id", "code", "name", "updatedAt") VALUES
  (gen_random_uuid()::text, 'BRANCH_DISPATCH_LEAD', 'Trưởng điều phối chi nhánh', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'RESOURCE_MANAGER', 'Nhân viên quản lý tài nguyên', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TRANSPORT_DISPATCHER', 'Điều phối viên vận tải', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ORDER_SCHEDULER', 'Nhân viên xử lý đơn và lịch hẹn', CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "permissions" ("id", "code", "description")
SELECT gen_random_uuid()::text, code, code
FROM unnest(ARRAY['branches.read','vehicles.read','vehicles.manage','drivers.read','drivers.manage','orders.read','orders.write','customers.read','trips.read','trips.plan','trips.approve','trips.publish']) AS codes(code)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM (VALUES
  ('BRANCH_DISPATCH_LEAD', ARRAY['branches.read','vehicles.read','drivers.read','orders.read','customers.read','trips.read','trips.plan','trips.approve']),
  ('RESOURCE_MANAGER', ARRAY['branches.read','vehicles.read','vehicles.manage','drivers.read','drivers.manage']),
  ('TRANSPORT_DISPATCHER', ARRAY['branches.read','orders.read','trips.read','trips.publish']),
  ('ORDER_SCHEDULER', ARRAY['branches.read','orders.read','orders.write','customers.read'])
) AS policy(role_code, permissions)
JOIN "roles" r ON r."code" = policy.role_code
JOIN "permissions" p ON p."code" = ANY(policy.permissions)
ON CONFLICT DO NOTHING;
