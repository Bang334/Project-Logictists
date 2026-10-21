const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const url = process.env.FLEET_MIGRATION_TEST_URL;
if (!url) throw new Error('FLEET_MIGRATION_TEST_URL required');
const parsed = new URL(url);
if (!['127.0.0.1','localhost'].includes(parsed.hostname) || !parsed.pathname.startsWith('/tms_fleet_migration_')) throw new Error('Only isolated fleet migration database accepted');
const db = new PrismaClient({ datasources: { db: { url } } });
const quote = s => '"' + s.replaceAll('"','""') + '"';
async function digest(table, columns) {
  const rows = await db.$queryRawUnsafe(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(row_to_json(x)::text, '' ORDER BY row_to_json(x)::text),'')) AS hash FROM (SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}) x`);
  return rows[0];
}
(async () => { try {
  const tables = await db.$queryRawUnsafe("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  const before = [];
  for (const { table_name } of tables) {
    const c = await db.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", table_name);
    const columns = c.map(r => r.column_name); before.push({ table: table_name, columns, digest: await digest(table_name, columns) });
  }
  const r = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','db','execute','--file','prisma/migrations/20261017120000_fleet_schedules/migration.sql','--schema','prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr); throw new Error('Fleet migration failed on isolated copy'); }
  for (const item of before) assert.deepEqual(await digest(item.table, item.columns), item.digest, 'Existing data changed: ' + item.table);
  assert.equal(await db.driverShift.count(), 0, 'Migration must not invent shifts');
  const unknownActors = await db.vehicleUnavailability.count({ where: { recordedById: { not: null } } }); assert.equal(unknownActors, 0);
  console.log(JSON.stringify({ existingTablesPreserved: before.length, existingRowsPreserved: before.reduce((sum, r) => sum + r.digest.n, 0), noFakeShifts: true, migrationPassed: true }));
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await db.$disconnect(); } })();
