// Test-only upgrade from the already-applied incoming baseline. Never uses DATABASE_URL from .env.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const config = require('dotenv').parse(fs.readFileSync('.env'));
const source = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname) || source.pathname !== '/tms_auth_test') throw new Error('Local isolated test database required');
const target = new URL(source); target.pathname = '/tms_merge_test_20261011';
const admin = new PrismaClient({ datasources: { db: { url: source.href } } });
const db = new PrismaClient({ datasources: { db: { url: target.href } } });
const env = { ...process.env, ...config, DATABASE_URL: target.href, DIRECT_URL: target.href };
function sqlFile(file) {
  const r = cp.spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'execute', '--url', target.href, '--file', file], { env, encoding: 'utf8' });
  if (r.status) throw new Error('Isolated migration failed: ' + r.stderr);
}
(async () => {
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname='tms_merge_test_20261011'`;
  if (!exists.length) await admin.$executeRawUnsafe('CREATE DATABASE tms_merge_test_20261011');
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  if (tables.length) {
    const marker = await db.$queryRaw`SELECT 1 FROM information_schema.tables WHERE table_name='merge_test_verified'`;
    if (!marker.length) throw new Error('Existing test DB is incomplete; refusing reset or overwrite');
    console.log('Isolated merge database already verified; no reset.'); return;
  }
  for (const migration of [
    '20261001000000_demo_66_table_baseline',
    '20261002170000_replace_delivery_deadlines_with_late_penalty',
    '20261003193000_optimization_job_idempotency_and_lease',
    '20261003194500_trip_planning_snapshot',
    '20261003210000_vehicle_home_depot',
  ]) sqlFile(path.join('prisma/migrations', migration, 'migration.sql'));
  const statements = [
    `INSERT INTO branches(id,code,name,address,latitude,longitude,"updatedAt") VALUES ('merge-b','MERGE-LEGACY','[TEST] legacy','test',21,105,now())`,
    `INSERT INTO customers(id,code,name,phone,"updatedAt") VALUES ('merge-c','MERGE-LEGACY','[TEST] legacy','merge-test-only',now())`,
    `INSERT INTO orders(id,"orderNumber","customerId","branchId","totalWeightKg","totalPackages","updatedAt") VALUES ('merge-o','MERGE-LEGACY','merge-c','merge-b',37,3,now())`,
    `INSERT INTO order_items(id,"orderId",description,quantity,"weightKg","lengthCm","widthCm","heightCm","volumeM3") VALUES ('merge-i','merge-o','Unknown unit weights',3,37,40,30,20,0.072)`,
    `INSERT INTO order_stops(id,"orderId",type,sequence,address,latitude,longitude,"contactName","contactPhone") VALUES ('merge-s','merge-o','PICKUP',1,'test',21,105,'test','000')`,
    `INSERT INTO packages(id,"orderId","packageCode","lengthMm","widthMm","heightMm","weightG","allowedOrientations","measurementSource","updatedAt") VALUES ('merge-p','merge-o','MERGE-LEGACY',400,300,200,37000,'["DEFAULT"]','LEGACY',now())`,
    `INSERT INTO package_items(id,"packageId","orderItemId",quantity) VALUES ('merge-pi','merge-p','merge-i',3)`,
    `INSERT INTO order_status_events(id,"orderId","eventType",payload) VALUES ('merge-e','merge-o','HISTORICAL','{"preserve":true}')`,
    `INSERT INTO vehicles(id,"plateNumber",model,"vehicleType","homeBranchId","payloadCapacityKg","volumeCapacityM3","lengthCm","widthCm","heightCm","fuelConsumptionLitersPer100Km","loadFuelSurchargePercentAtFullPayload","fixedOperatingCostPerTrip","updatedAt") VALUES ('00000000-0000-4000-8000-000000000001','MERGE-V1','Model A','Truck A','merge-b',1000,10,400,200,200,12,20,50000,now()),('00000000-0000-4000-8000-000000000002','MERGE-V2','Model A2','Truck A','merge-b',1000,10,400,200,200,12,20,50000,now()),('00000000-0000-4000-8000-000000000003','MERGE-V3','Model B','Truck B','merge-b',2000,18,500,210,210,15,25,75000,now())`,
  ];
  for (const statement of statements) await db.$executeRawUnsafe(statement);
  sqlFile('prisma/migrations/20261005140000_merge_packages_windows_auth/migration.sql');
  const order = await db.order.findUniqueOrThrow({ where: { id: 'merge-o' }, include: { items: { include: { packages: true } }, packages: { include: { items: true } }, stops: true, events: true } });
  assert.equal(order.packageDataStatus, 'LEGACY_REVIEW');
  assert.equal(order.items[0].weightKg, 37);
  assert.equal(order.items[0].quantity, 3);
  assert.equal(order.items[0].packages.length, 0);
  assert.equal(order.packages[0].id, 'merge-p');
  assert.equal(order.packages[0].weightG, 37000n);
  assert.equal(order.packages[0].items[0].quantity, 3);
  assert.equal(order.packages[0].orderItemId, null);
  assert.equal(order.events[0].id, 'merge-e');
  assert.deepEqual(order.events[0].payload, { preserve: true });
  assert.equal(order.stops[0].windowStart, null);
  assert.equal(order.stops[0].windowBasis, null);
  const vehicleTypes = await db.vehicleType.findMany({ include: { vehicles: true } });
  assert.equal(vehicleTypes.length, 2);
  assert.equal(vehicleTypes.find(type => type.name === 'Truck A')?.vehicles.length, 2);
  const removedTables = await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('driver_shifts','driver_leave','vehicle_doors')`;
  assert.equal(removedTables.length, 0);
  const legacyVehicleColumns = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicles' AND column_name IN ('vehicleType','payloadCapacityKg','volumeCapacityM3','lengthCm','widthCm','heightCm')`;
  assert.equal(legacyVehicleColumns.length, 0);
  await db.$executeRawUnsafe('CREATE TABLE merge_test_verified (verified_at timestamptz NOT NULL DEFAULT now())');
  await db.$executeRawUnsafe('INSERT INTO merge_test_verified DEFAULT VALUES');
  console.log('PASS merge migration: legacy order data preserved; vehicle capabilities normalized into two types; removed shift/leave/door tables absent.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); await admin.$disconnect(); });
