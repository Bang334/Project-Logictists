const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const { transactionalDdl } = require('./sql-migration-statements.cjs');

async function main() {
  if (process.env.NODE_ENV !== 'development' && !process.env.TEST_DATABASE_URL) throw new Error('Use development or a disposable TEST_DATABASE_URL');
  const schemaName = 'tms_delivery_test_' + randomUUID().replaceAll('-', '');
  if (!/^tms_delivery_test_[a-f0-9]{32}$/.test(schemaName)) throw new Error('Invalid isolated schema');
  const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  const target = new URL(baseUrl);
  target.searchParams.set('schema', schemaName);
  const env = { ...process.env, DATABASE_URL: target.href, DIRECT_URL: target.href, DELIVERY_TEST_DATABASE_URL: target.href };
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-delivery-pg-'));
  const run = args => {
    const result = cp.spawnSync(process.execPath, args, { env, cwd: path.resolve(__dirname, '..'), windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Test command failed').replaceAll(target.href, '[isolated database]'));
    return result.stdout;
  };
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
  try {
    const sql = run(['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
    const migration = fs.readFileSync(path.resolve(__dirname, '../prisma/migrations/20261102090000_delivery_appointments/migration.sql'), 'utf8');
    fs.writeFileSync(path.join(folder, 'schema.sql'), sql + '\n' + migration.slice(migration.indexOf('ALTER TABLE delivery_planning_batches ADD CONSTRAINT')));
    const isolated = new PrismaClient({ datasources: { db: { url: target.href } } });
    try {
      console.log('Applying generated DDL to a newly-created isolated schema in one transaction');
      await isolated.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaName}"`);
        await tx.$executeRawUnsafe(transactionalDdl(fs.readFileSync(path.join(folder, 'schema.sql'), 'utf8')));
      }, { timeout: 60000 });
    } finally { await isolated.$disconnect(); }
    const tests = cp.spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--runInBand', '--testPathPattern=delivery-planning.postgres'], {
      env, cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit',
    });
    if (tests.error) throw tests.error;
    process.exitCode = tests.status || 0;
  } finally {
    // This exact schema was created by this invocation; never drop public or a shared test schema.
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.$disconnect();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
