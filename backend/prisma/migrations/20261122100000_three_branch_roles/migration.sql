BEGIN;
-- Stop old API/workers before applying. Serialize with login and account edits.
LOCK TABLE users, roles, permissions, role_permissions, user_role_scopes, auth_sessions
  IN SHARE ROW EXCLUSIVE MODE;

-- Never guess a branch or combine a scheduler with another operational identity.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_role_scopes s JOIN roles r ON r.id = s."roleId"
    JOIN users u ON u.id = s."userId"
    LEFT JOIN branches b ON b.id = s."branchId"
    WHERE r.code = 'ORDER_SCHEDULER' AND s.active AND (
      NOT r.active OR s."scopeType"::text <> 'BRANCH' OR s."branchId" IS NULL OR s."locationId" IS NOT NULL
      OR b.active IS DISTINCT FROM true OR u.role::text NOT IN ('DISPATCHER', 'STAFF')
      OR EXISTS (
        SELECT 1 FROM user_role_scopes other JOIN roles other_role ON other_role.id = other."roleId"
        WHERE other."userId" = s."userId" AND other.active AND other.id <> s.id
          AND NOT (other_role.code = 'TRANSPORT_DISPATCHER' AND other."scopeType"::text = 'BRANCH'
            AND other."branchId" = s."branchId" AND other."locationId" IS NULL)
      )
      OR EXISTS (
        SELECT 1 FROM user_role_scopes target_scope JOIN roles target_role ON target_role.id = target_scope."roleId"
        WHERE target_scope."userId" = s."userId" AND target_role.code = 'TRANSPORT_DISPATCHER'
          AND target_scope."scopeType"::text = 'BRANCH' AND target_scope."branchId" = s."branchId"
          AND target_scope."locationId" IS NOT NULL
      )
    )
  ) THEN RAISE EXCEPTION 'THREE_ROLES_RECONCILIATION_REQUIRED: review legacy scheduler scopes before migration';
  END IF;
END $$;

CREATE TEMP TABLE three_roles_affected ON COMMIT DROP AS
SELECT DISTINCT s."userId" FROM user_role_scopes s JOIN roles r ON r.id = s."roleId"
WHERE s.active AND r.code IN ('ORDER_SCHEDULER', 'BRANCH_DISPATCH_LEAD', 'RESOURCE_MANAGER', 'TRANSPORT_DISPATCHER');

INSERT INTO roles (id, code, name, "updatedAt") VALUES
  (gen_random_uuid()::text, 'BRANCH_DISPATCH_LEAD', 'Trưởng chi nhánh (Trưởng điều phối)', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'RESOURCE_MANAGER', 'Nhân viên quản lý tài nguyên', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TRANSPORT_DISPATCHER', 'Điều phối viên vận tải', CURRENT_TIMESTAMP)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = CURRENT_TIMESTAMP;
-- Preserve an intentionally inactive target role; require administrator reconciliation.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE code IN ('BRANCH_DISPATCH_LEAD','RESOURCE_MANAGER','TRANSPORT_DISPATCHER') AND NOT active)
  THEN RAISE EXCEPTION 'THREE_ROLES_TARGET_INACTIVE'; END IF;
END $$;

CREATE TEMP TABLE three_roles_policy (role_code text, permission_code text) ON COMMIT DROP;
INSERT INTO three_roles_policy
SELECT policy.role_code, unnest(policy.codes) FROM (VALUES
  ('BRANCH_DISPATCH_LEAD', ARRAY['branches.read','vehicles.read','drivers.read','customers.read','orders.read','trips.read','trips.plan','trips.approve','settings.read']),
  ('RESOURCE_MANAGER', ARRAY['branches.read','vehicles.read','vehicles.manage','drivers.read','drivers.manage','trips.read']),
  ('TRANSPORT_DISPATCHER', ARRAY['branches.read','vehicles.read','drivers.read','customers.read','orders.read','orders.write','trips.read','trips.publish'])
) AS policy(role_code, codes);
INSERT INTO permissions (id, code, description)
SELECT gen_random_uuid()::text, permission_code, permission_code
FROM (SELECT DISTINCT permission_code FROM three_roles_policy) codes
ON CONFLICT (code) DO NOTHING;
-- Only the three branch roles are reconciled. ADMIN/DRIVER/CUSTOMER are untouched.
DELETE FROM role_permissions rp USING roles r WHERE rp."roleId" = r.id
  AND r.code IN ('BRANCH_DISPATCH_LEAD','RESOURCE_MANAGER','TRANSPORT_DISPATCHER');
INSERT INTO role_permissions ("roleId", "permissionId")
SELECT r.id, p.id FROM three_roles_policy policy
JOIN roles r ON r.code = policy.role_code JOIN permissions p ON p.code = policy.permission_code;

INSERT INTO audit_logs (id, "entityType", "entityId", action, "performedBy", "changeSummary")
SELECT gen_random_uuid()::text, 'User', s."userId", 'BRANCH_ROLE_MIGRATED', 'migration:20261122100000',
  jsonb_build_object('fromRole', 'ORDER_SCHEDULER', 'toRole', 'TRANSPORT_DISPATCHER',
    'branchId', s."branchId", 'previousScopeId', s.id, 'sessionsRevoked', true)
FROM user_role_scopes s JOIN roles r ON r.id = s."roleId" WHERE r.code = 'ORDER_SCHEDULER' AND s.active;
INSERT INTO user_role_scopes (id, "userId", "roleId", "scopeType", "branchId", active, "updatedAt")
SELECT gen_random_uuid()::text, s."userId", target.id, s."scopeType", s."branchId", true, CURRENT_TIMESTAMP
FROM user_role_scopes s JOIN roles old ON old.id = s."roleId"
JOIN roles target ON target.code = 'TRANSPORT_DISPATCHER'
WHERE old.code = 'ORDER_SCHEDULER' AND s.active
ON CONFLICT ("userId", "roleId", "scopeType", "branchId")
DO UPDATE SET active = true, "updatedAt" = CURRENT_TIMESTAMP;
UPDATE user_role_scopes s SET active = false, "updatedAt" = CURRENT_TIMESTAMP FROM roles r
WHERE r.id = s."roleId" AND r.code = 'ORDER_SCHEDULER' AND s.active;
UPDATE roles SET active = false, "updatedAt" = CURRENT_TIMESTAMP WHERE code = 'ORDER_SCHEDULER';
UPDATE auth_sessions SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "userId" IN (SELECT "userId" FROM three_roles_affected) AND "revokedAt" IS NULL;
UPDATE users SET "updatedAt" = GREATEST(CURRENT_TIMESTAMP, "updatedAt" + interval '1 millisecond')
WHERE id IN (SELECT "userId" FROM three_roles_affected);
COMMIT;
