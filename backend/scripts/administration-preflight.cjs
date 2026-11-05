// Read-only: never changes accounts, grants, schemas or migration history.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const db = new PrismaClient();
(async () => {
  const administrators = await db.user.findMany({ where: { active: true, roleScopes: { some: { active: true, scopeType: 'COMPANY', branchId: null, role: { code: 'ADMIN', active: true } } } }, select: { username: true } });
  const administratorAccounts = await db.user.findMany({ where: { OR: [{ role: 'ADMIN' }, { roleScopes: { some: { role: { code: 'ADMIN' } } } }] }, select: { username: true, active: true, roleScopes: { where: { role: { code: 'ADMIN' } }, select: { active: true, scopeType: true, branchId: true, role: { select: { active: true, permissions: { select: { permission: { select: { code: true } } } } } } } } } });
  const adminChecks = administratorAccounts.map(account => ({ username: account.username, active: account.active,
    missingPermissions: ['users.read', 'users.create', 'users.lock', 'branches.manage'].filter(permission => !account.roleScopes.some(scope => scope.active && scope.scopeType === 'COMPANY' && scope.branchId === null && scope.role.active && scope.role.permissions.some(grant => grant.permission.code === permission))) }));
  const duplicateBranchCodes = await db.$queryRaw`SELECT upper(btrim(code)) AS code, count(*)::int AS count FROM branches GROUP BY upper(btrim(code)) HAVING count(*) > 1`;
  const accountRoles = await db.accessRole.findMany({ where: { code: { in: ['ADMIN', 'DISPATCHER', 'DRIVER'] } }, select: { code: true, active: true } });
  const applied = await db.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`;
  const local = readdirSync('prisma/migrations', { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name);
  const drift = applied.filter(row => row.finished_at && !row.rolled_back_at).flatMap(row => {
    const file = join('prisma/migrations', row.migration_name, 'migration.sql');
    return !existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== row.checksum ? [row.migration_name] : [];
  });
  console.log(JSON.stringify({ administrators, administratorAccounts: adminChecks, accountRoles, duplicateBranchCodes, historicalChecksumDifferences: drift, pending: local.filter(name => !applied.some(row => row.migration_name === name && row.finished_at && !row.rolled_back_at)) }, null, 2));
})().catch(() => { console.error('Preflight không hoàn tất; chưa thay đổi dữ liệu. Kiểm tra kết nối/quyền đọc.'); process.exitCode = 1; }).finally(() => db.$disconnect());
