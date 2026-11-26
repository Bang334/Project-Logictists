// Explicit URL required. This script never changes roles, sessions or migration history.
const { PrismaClient } = require('@prisma/client');
async function preflight(url) {
  if (!url) throw new Error('ROLE_MIGRATION_DATABASE_URL is required');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    return await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const roles = await tx.accessRole.findMany({ where: { code: { in: ['DISPATCHER','ORDER_SCHEDULER','BRANCH_DISPATCH_LEAD','RESOURCE_MANAGER','TRANSPORT_DISPATCHER'] } }, select: { code: true, active: true, _count: { select: { userScopes: true } } } });
      const scopes = await tx.userRoleScope.findMany({ where: { active: true, role: { code: 'ORDER_SCHEDULER' } }, select: { id: true, userId: true, branchId: true, scopeType: true, locationId: true, role: { select: { active: true } }, branch: { select: { active: true } }, user: { select: { role: true, roleScopes: { select: { id: true, active: true, branchId: true, scopeType: true, locationId: true, role: { select: { code: true } } } } } } } });
      const legacy = scopes.map(scope => {
        const reasons = [];
        if (!scope.role.active) reasons.push('LEGACY_ROLE_INACTIVE');
        if (scope.scopeType !== 'BRANCH' || !scope.branchId || scope.locationId) reasons.push('INVALID_SCOPE');
        if (!scope.branch?.active) reasons.push('BRANCH_INACTIVE');
        if (!['DISPATCHER','STAFF'].includes(scope.user.role)) reasons.push('ACCOUNT_TYPE_CONFLICT');
        if (scope.user.roleScopes.some(other => other.active && other.id !== scope.id && !(other.role.code === 'TRANSPORT_DISPATCHER' && other.scopeType === 'BRANCH' && other.branchId === scope.branchId && !other.locationId))) reasons.push('OTHER_ACTIVE_SCOPE');
        if (scope.user.roleScopes.some(other => other.role.code === 'TRANSPORT_DISPATCHER' && other.scopeType === 'BRANCH' && other.branchId === scope.branchId && other.locationId)) reasons.push('TARGET_LOCATION_CONFLICT');
        return { userId: scope.userId, branchId: scope.branchId, scopeId: scope.id, reasons };
      });
      const history = await tx.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations')::text AS name");
      const migrationApplied = history[0].name ? (await tx.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE migration_name = '20261122100000_three_branch_roles' AND finished_at IS NOT NULL"))[0].count : 0;
      return { migrationHistoryPresent: !!history[0].name, roles, legacyDispatcherAccounts: await tx.user.count({ where: { active: true, role: 'DISPATCHER' } }), legacyActiveScopes: legacy.length, blockedScopes: legacy.filter(scope => scope.reasons.length),
        affectedSessions: await tx.authSession.count({ where: { revokedAt: null, user: { roleScopes: { some: { active: true, role: { code: { in: ['ORDER_SCHEDULER','BRANCH_DISPATCH_LEAD','RESOURCE_MANAGER','TRANSPORT_DISPATCHER'] } } } } } } }),
        migrationApplied };
    }, { timeout: 15000 });
  } finally { await db.$disconnect(); }
}
module.exports = { preflight };
if (require.main === module) preflight(process.env.ROLE_MIGRATION_DATABASE_URL).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error.code || error.name || 'Preflight failed'); process.exitCode = 1;
});
