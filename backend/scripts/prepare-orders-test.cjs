// Dedicated local DB; never resets a DB and never migrates DATABASE_URL from .env.
const fs = require('fs'), cp = require('child_process'), path = require('path');
const { PrismaClient } = require('@prisma/client');
const config = require('dotenv').parse(fs.readFileSync('.env'));
const source = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(source.hostname) || source.pathname !== '/tms_auth_test') throw new Error('Refusing non-isolated PostgreSQL');
const target = new URL(source); target.pathname = '/tms_orders_test_v2';
const admin = new PrismaClient({ datasources: { db: { url: source.href } } });
const db = new PrismaClient({ datasources: { db: { url: target.href } } });
const cache = path.resolve('node_modules/.cache/orders-test'); fs.mkdirSync(cache, { recursive: true });
const env = { ...process.env, ...config, DATABASE_URL: target.href, DIRECT_URL: target.href };
function prisma(args) {
  const r = cp.spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { encoding: 'utf8', env });
  if (r.status) throw new Error('Test Prisma command failed: ' + r.stderr);
  return r.stdout;
}
(async () => {
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname = 'tms_orders_test_v2'`;
  if (!exists.length) await admin.$executeRawUnsafe('CREATE DATABASE tms_orders_test_v2');
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  if (tables.length) {
    const ready = await db.$queryRaw`SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='packageDataStatus'`;
    const constraints = await db.$queryRaw`SELECT conname FROM pg_constraint WHERE conname IN ('user_role_scopes_shape_check', 'package_positive_measurements', 'allocation_package_item_fk')`;
    if (!ready.length || constraints.length !== 3) throw new Error('Existing test database requires inspection; refusing overwrite');
    console.log('Dedicated orders test DB already prepared; no reset or migration rerun.'); return;
  }
  // Reproducible test-only pre-change snapshot; not a recovered production baseline.
  let before = fs.readFileSync('prisma/schema.prisma', 'utf8')
    .replace(/^  authSessions.*\r?\n/m, '')
    .replace(/model AuthSession \{[\s\S]*?\n\}/, '')
    .replace(/model AuthLoginLimit \{[\s\S]*?\n\}/, '')
    .replace(/^  packageDataStatus.*\r?\n/m, '').replace(/^  windowBasis.*\r?\n/m, '')
    .replace('allowedOrientations Json?', 'allowedOrientations Json')
    .replace(/^  @@unique\(\[id, orderItemId\]\)\r?\n/m, '');
  before = before.replace(/model OrderItem \{[\s\S]*?\n\}/, block => block.replace(/(lengthCm|widthCm|heightCm)(\s+)Float\?/g, '$1$2Float'));
  fs.writeFileSync(path.join(cache, 'before.prisma'), before);
  fs.writeFileSync(path.join(cache, 'baseline.sql'), prisma(['migrate', 'diff', '--from-empty', '--to-schema-datamodel', path.join(cache, 'before.prisma'), '--script']));
  prisma(['db', 'execute', '--file', path.join(cache, 'baseline.sql'), '--schema', 'prisma/schema.prisma']);
  prisma(['db', 'execute', '--file', 'prisma/migrations/20260926090000_auth_sessions_scope_constraints/migration.sql', '--schema', 'prisma/schema.prisma']);
  // Unknown per-package weights and an existing historical allocation must remain untouched.
  await db.$executeRawUnsafe(`INSERT INTO branches(id,code,name,address,latitude,longitude,"updatedAt") VALUES ('legacy-branch','LEGACY-TEST','[TEST] legacy','test',21,105,now())`);
  await db.$executeRawUnsafe(`INSERT INTO customers(id,code,name,address,"contactPerson",phone,"updatedAt") VALUES ('legacy-customer','LEGACY-TEST','[TEST] legacy','test','test','000',now())`);
  await db.$executeRawUnsafe(`INSERT INTO orders(id,"orderNumber","customerId","branchId","totalWeightKg","totalPackages","updatedAt") VALUES ('legacy-order','LEGACY-TEST','legacy-customer','legacy-branch',37,3,now())`);
  await db.$executeRawUnsafe(`INSERT INTO order_items(id,"orderId",description,quantity,"weightKg","lengthCm","widthCm","heightCm","volumeM3") VALUES ('legacy-item','legacy-order','Unknown per-package weight',3,37,40,30,20,0.072)`);
  await db.$executeRawUnsafe(`INSERT INTO order_stops(id,"orderId",type,sequence,address,latitude,longitude,"contactName","contactPhone","windowStart","windowEnd") VALUES ('legacy-stop','legacy-order','PICKUP',1,'test',21,105,'test','000','2026-10-02T23:00:00+07:00','2026-10-03T01:00:00+07:00')`);
  await db.$executeRawUnsafe(`INSERT INTO vehicles(id,"plateNumber",model,"vehicleType","homeBranchId","payloadCapacityKg","volumeCapacityM3","lengthCm","widthCm","heightCm","updatedAt") VALUES ('legacy-vehicle','LEGACY-TEST','test','test','legacy-branch',1000,10,400,200,200,now())`);
  await db.$executeRawUnsafe(`INSERT INTO trips(id,"tripNumber","vehicleId","plannedStartTime","plannedEndTime","updatedAt") VALUES ('legacy-trip','LEGACY-TEST','legacy-vehicle',now(),now()+interval '1 hour',now())`);
  await db.$executeRawUnsafe(`INSERT INTO allocations(id,"orderItemId","tripId","allocatedQuantity") VALUES ('legacy-allocation','legacy-item','legacy-trip',3)`);
  prisma(['db', 'execute', '--file', 'prisma/migrations/20261002140000_order_packages_windows/migration.sql', '--schema', 'prisma/schema.prisma']);
  const row = await db.order.findUniqueOrThrow({ where: { id: 'legacy-order' }, include: { items: { include: { allocations: true, packages: true } }, stops: true } });
  if (row.packageDataStatus !== 'LEGACY_REVIEW' || row.items[0].weightKg !== 37 || row.items[0].quantity !== 3 || row.items[0].packages.length || row.items[0].allocations[0].id !== 'legacy-allocation' || row.stops[0].windowStart.toISOString() !== '2026-10-02T16:00:00.000Z') throw new Error('Legacy migration preservation failed');
  console.log('PASS migration: old quantities, measurements, UTC instant, allocation ID preserved; no guessed Package backfill.');
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => { await admin.$disconnect(); await db.$disconnect(); });
