const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { migrationStatements } = require('./sql-migration-statements.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

// Repair only the missing approval schema and its current role policy, without
// deploying unrelated pending migrations or rewriting existing migration files.
async function main() {
  if (process.env.NODE_ENV !== 'development' || !process.argv.includes('--confirm-development')) {
    throw new Error('Requires development environment and --confirm-development; stop API/workers first');
  }
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Database URL missing');
  const schema = new URL(url).searchParams.get('schema') || 'public';
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(schema)) throw new Error('Unsupported schema');
  const migrations = ['20261114153000_trip_plan_approval', '20261122100000_three_branch_roles'].map(name => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../prisma/migrations', name, 'migration.sql'), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const applied = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(4106, hashtext('trip-approval-repair'))");
      // Keep the pre-change role snapshot stable until both migrations commit.
      await tx.$executeRawUnsafe('LOCK TABLE trips, users, roles, permissions, role_permissions, user_role_scopes, auth_sessions IN SHARE ROW EXCLUSIVE MODE');
      const snapshot = {
        recordedAt: new Date().toISOString(), schema,
        columns: await tx.$queryRawUnsafe("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'trips' AND column_name LIKE 'approvedPlan%'"),
        tripCount: await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM trips'),
        roles: await tx.accessRole.findMany(),
        rolePermissions: await tx.rolePermission.findMany(),
        scopes: await tx.userRoleScope.findMany(),
        migrationHistory: await tx.$queryRawUnsafe('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations'),
      };
      // No passwords, connection strings or session tokens in this local backup.
      const backup = path.resolve(__dirname, '../../.git', `trip-approval-before-${Date.now()}.json`);
      fs.writeFileSync(backup, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
      const changed = [];
      for (const migration of migrations) {
        const history = await tx.$queryRaw`SELECT checksum, finished_at FROM _prisma_migrations WHERE migration_name = ${migration.name} AND rolled_back_at IS NULL`;
        if (history.length) {
          if (history.length !== 1 || !history[0].finished_at || history[0].checksum !== migration.checksum) {
            throw new Error(`Migration history conflicts: ${migration.name}`);
          }
          continue;
        }
        for (const statement of migrationStatements(migration.sql)) {
          if (!/^(BEGIN|COMMIT);?$/i.test(statement)) await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES (${randomUUID()}, ${migration.checksum}, ${migration.name}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`;
        changed.push(migration.name);
      }
      // Also verifies an idempotent rerun against the Prisma client schema.
      await tx.trip.findMany({ take: 1 });
      return changed;
    }, { timeout: 60000, maxWait: 10000 });
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already applied; matching checksums and Trip schema verified');
  } finally { await db.$disconnect(); }
}
main().catch(error => {
  console.error(error.code || error.message || 'Migration failed');
  process.exitCode = 1;
});
