// Read-only comparison of a restored pre-migration copy and its upgraded copy.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
function local(name) {
  const value = process.env[name]; if (!value) throw new Error('Missing '+name);
  const url = new URL(value);
  if (!['localhost','127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/tms_customers_')) throw new Error('Only isolated tms_customers_* databases are allowed');
  return new PrismaClient({ datasources: { db: { url:value } }, log:[] });
}
const source=local('CUSTOMER_BASELINE_DATABASE_URL'), target=local('CUSTOMER_TEST_DATABASE_URL');
(async()=>{try{
  const customers=await source.$queryRawUnsafe('SELECT row_to_json(c) AS data FROM customers c');
  for(const {data} of customers){
    const rows=await target.$queryRawUnsafe('SELECT row_to_json(c) AS data FROM customers c WHERE id=$1',data.id);
    assert.equal(rows.length,1,'Original customer missing');const actual=rows[0].data;
    for(const field of Object.keys(data)) assert.deepEqual(actual[field],data[field],'Original customer field changed: '+field);
    assert.equal(actual.retailPhoneKey,data.phone,'Retail identity changed');assert.equal(actual.version,1);
    const expected=await source.$queryRawUnsafe('SELECT DISTINCT "branchId" FROM orders WHERE "customerId"=$1 AND "orderType"=\'B2B_TRANSPORT\' ORDER BY "branchId"',data.id);
    const memberships=await target.$queryRawUnsafe('SELECT "branchId" FROM customer_branches WHERE "customerId"=$1 ORDER BY "branchId"',data.id);
    assert.deepEqual(memberships,expected,'Branch backfill differs from approved transport history');
  }
  const unassigned=await target.$queryRawUnsafe('SELECT count(*)::int AS count FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_branches b WHERE b."customerId"=c.id)');
  console.log(JSON.stringify({preservedCustomers:customers.length,unassignedCustomers:unassigned[0].count,backfillVerified:true}));
}catch(e){console.error('Migration verification failed:',e.code||e.name);process.exitCode=1;}finally{await source.$disconnect();await target.$disconnect();}})();
