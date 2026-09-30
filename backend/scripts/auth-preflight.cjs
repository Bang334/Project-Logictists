// Read-only schema/history inventory. Never prints credentials or user records.
require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } });
async function main() {
  const schema = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  const columns = await db.$queryRaw`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = ${schema}`;
  const names = ['User','Branch','AccessRole','Permission','RolePermission','UserRoleScope','AuthSession','AuthLoginLimit','Vehicle','Driver','Customer','Order','Trip'];
  const missing = [];
  for (const model of Prisma.dmmf.datamodel.models.filter(m => names.includes(m.name))) {
    const table = model.dbName || model.name;
    const actual = columns.filter(c => c.table_name === table);
    const absent = model.fields.filter(f => f.kind !== 'object' && !actual.some(c => c.column_name === (f.dbName || f.name))).map(f => f.dbName || f.name);
    console.log(table, actual.length ? 'present' : 'MISSING', absent.length ? { missingColumns: absent } : 'columns match');
    if (absent.length) missing.push(table);
  }
  if (columns.some(c => c.table_name === '_prisma_migrations')) {
    const history = await db.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at`;
    console.log('Migration history:', history.map(row => {
      const file = 'prisma/migrations/' + row.migration_name + '/migration.sql';
      return { name: row.migration_name, finished: !!row.finished_at, rolledBack: !!row.rolled_back_at, repositoryChecksumMatches: fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === row.checksum : null };
    }));
  } else console.log('Migration history MISSING: do not run broad migrate deploy or mark old migrations applied.');
  console.log('Driver employee link:', columns.some(c => c.table_name === 'drivers' && c.column_name === 'employeeId') ? 'PRESENT: reconcile Employee ownership before deployment' : 'absent; current Prisma uses Driver.homeBranchId');
  if (!missing.includes('user_role_scopes')) {
    console.log('Scope shape violations:', await db.$queryRaw`SELECT count(*)::int AS count FROM user_role_scopes WHERE NOT (("scopeType" = 'COMPANY' AND "branchId" IS NULL) OR ("scopeType" = 'BRANCH' AND "branchId" IS NOT NULL))`);
    console.log('Duplicate scope groups:', await db.$queryRaw`SELECT count(*)::int AS count FROM (SELECT 1 FROM user_role_scopes GROUP BY "userId", "roleId", "scopeType", "branchId" HAVING count(*) > 1) duplicates`);
    console.log('Users without active scope:', await db.$queryRaw`SELECT count(*)::int AS count FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_role_scopes s JOIN roles r ON r.id=s."roleId" WHERE s."userId"=u.id AND s.active AND r.active)`);
  }
  console.log('Constraints:', await db.$queryRaw`SELECT c.conname, pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${schema} AND t.relname IN ('user_role_scopes','role_permissions')`);
  console.log('Missing tables/columns:', missing);
}
main().catch(e => { console.error('Preflight failed:', e.code || e.name, 'Check network, database URL and database availability. No changes made.'); process.exitCode = 1; }).finally(() => db.$disconnect());
