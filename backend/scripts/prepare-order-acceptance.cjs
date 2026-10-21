// Fresh isolated test schema only. Never reset an existing DB or read .env.
const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_order_acceptance_20261018') throw new Error('Isolated database required');
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
const db = new PrismaClient();
function prisma(args) {
  const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { env: process.env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Test schema preparation failed; inspect isolated schema');
}
(async () => { try {
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname='tms_order_acceptance_20261018'`;
  if (!exists.length) await admin.$executeRawUnsafe('CREATE DATABASE tms_order_acceptance_20261018');
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  if (!tables.length) {
    fs.mkdirSync('node_modules/.cache', { recursive: true });
    prisma(['migrate','diff','--from-empty','--to-schema-datamodel','prisma/schema.prisma','--script','--output','node_modules/.cache/order-acceptance-schema.sql']);
    prisma(['db','execute','--file','node_modules/.cache/order-acceptance-schema.sql','--schema','prisma/schema.prisma']);
    // Prisma datamodel omits SQL checks/partial indexes. Reuse their exact migration definitions.
    const sql = fs.readFileSync('prisma/migrations/20261002140000_order_packages_windows/migration.sql','utf8').replace(/--[^\n]*/g,'');
    const statements = sql.split(';').filter(s => /ADD CONSTRAINT|CREATE UNIQUE INDEX/.test(s) && !s.includes('packages_id_orderItemId_key'));
    fs.writeFileSync('node_modules/.cache/order-acceptance-constraints.sql', 'BEGIN;\n' + statements.join(';') + ';\nCOMMIT;');
    prisma(['db','execute','--file','node_modules/.cache/order-acceptance-constraints.sql','--schema','prisma/schema.prisma']);
  }
  const constraints = await db.$queryRaw`SELECT conname FROM pg_constraint WHERE conname IN ('package_positive_measurements','allocation_package_item_fk','allocation_one_package','order_window_range','order_window_basis','orders_package_data_status')`;
  if (constraints.length !== 6) throw new Error('Existing test schema needs inspection; refusing reset or repair');
  console.log('Isolated acceptance schema and 6 domain constraints verified; existing data retained.');
} catch (error) { console.error(error.message); process.exitCode = 1; } finally { await admin.$disconnect(); await db.$disconnect(); } })();
