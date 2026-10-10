-- Auth slice only. Does not infer roles or branch ownership for existing users.
-- Requires existing users/branches. Creates only missing RBAC tables, never the broad domain migration.
-- Existing incompatible RBAC layouts or invalid/duplicate scopes cause rollback; run preflight first.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "ScopeType" AS ENUM ('COMPANY', 'BRANCH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS "roles" (
  "id" TEXT PRIMARY KEY, "code" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
  "description" TEXT, "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS "permissions" (
  "id" TEXT PRIMARY KEY, "code" TEXT NOT NULL UNIQUE, "description" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "permissionId" TEXT NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("roleId", "permissionId")
);
CREATE TABLE IF NOT EXISTS "user_role_scopes" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "roleId" TEXT NOT NULL REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "scopeType" "ScopeType" NOT NULL, "branchId" TEXT REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "user_role_scopes_branchId_active_idx" ON "user_role_scopes" ("branchId", "active");
CREATE UNIQUE INDEX IF NOT EXISTS "user_role_scopes_userId_roleId_scopeType_branchId_key"
  ON "user_role_scopes" ("userId", "roleId", "scopeType", "branchId");
ALTER TABLE "user_role_scopes" ADD CONSTRAINT "user_role_scopes_shape_check"
  CHECK (("scopeType" = 'COMPANY' AND "branchId" IS NULL)
      OR ("scopeType" = 'BRANCH' AND "branchId" IS NOT NULL));
CREATE UNIQUE INDEX "user_role_scopes_company_unique" ON "user_role_scopes" ("userId", "roleId") WHERE "scopeType" = 'COMPANY';
CREATE UNIQUE INDEX "user_role_scopes_branch_unique" ON "user_role_scopes" ("userId", "roleId", "branchId") WHERE "scopeType" = 'BRANCH';
CREATE TABLE "auth_sessions" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL, "revokedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "auth_sessions_userId_expiresAt_idx" ON "auth_sessions" ("userId", "expiresAt");
CREATE TABLE "auth_login_limits" (
  "key" TEXT PRIMARY KEY, "attempts" INTEGER NOT NULL CHECK ("attempts" > 0), "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "auth_login_limits_expiresAt_idx" ON "auth_login_limits" ("expiresAt");
COMMIT;
