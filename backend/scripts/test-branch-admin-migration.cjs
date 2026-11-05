// Replay the exact migration against populated copies in isolated test schemas.
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const config = require('dotenv').parse(fs.readFileSync('.env'));
const target = new URL(config.AUTH_TEST_DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/tms_auth_test');
assert.match(config.AUTH_TEST_CONTAINER, /^tms-auth-test-[a-z0-9-]+$/i);
const migration = fs.readFileSync('prisma/migrations/20261021100000_branch_lifecycle_guard/migration.sql', 'utf8');
function sql(input, success = true) {
  const result = cp.spawnSync('docker', ['exec', '-i', config.AUTH_TEST_CONTAINER, 'psql', '-U', decodeURIComponent(target.username), '-d', 'tms_auth_test', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input, encoding: 'utf8', timeout: 30000 });
  if (success) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, 'Migration must reject conflicting legacy codes');
  return result.stdout.trim();
}
const tables = ['branches', 'users', 'user_role_scopes', 'auth_sessions', 'drivers', 'vehicles', 'customer_branches', 'trips', 'orders', 'resource_reservations'];
for (const scenario of ['populated', 'conflicting_codes']) {
  const schema = 'branch_migration_' + randomUUID().replaceAll('-', '');
  const prefix = `SET search_path TO "${schema}";\n`;
  sql(`CREATE SCHEMA "${schema}";\n` + prefix + tables.map(table => `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS); INSERT INTO "${table}" SELECT * FROM public."${table}";`).join('\n'));
  if (scenario === 'conflicting_codes') sql(prefix + `UPDATE branches SET code = ' duplicate-code ' WHERE id = (SELECT id FROM branches ORDER BY id LIMIT 1); UPDATE branches SET code = 'DUPLICATE-CODE' WHERE id = (SELECT id FROM branches ORDER BY id OFFSET 1 LIMIT 1);`);
  const snapshot = tables.map(table => `SELECT '${table}', count(*), md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) FROM "${table}" t;`).join('\n');
  const before = sql(prefix + snapshot);
  sql(prefix + migration, scenario === 'populated');
  if (scenario === 'populated') sql(prefix + fs.readFileSync('prisma/migrations/20261101100000_branch_link_lock_order/migration.sql', 'utf8'));
  if (scenario === 'populated') sql(prefix + fs.readFileSync('prisma/migrations/20261101103000_branch_reservation_resources/migration.sql', 'utf8'));
  assert.equal(sql(prefix + snapshot), before, 'Existing users, passwords, scopes, sessions and business history must be unchanged');
  const indexCount = sql(`SELECT count(*) FROM pg_indexes WHERE schemaname='${schema}' AND indexname='branches_normalized_code_unique';`);
  assert.equal(indexCount, scenario === 'populated' ? '1' : '0');
  console.log(`PASS branch migration: ${scenario}; existing rows preserved, atomic ${scenario === 'populated' ? 'commit' : 'rollback'}`);
}
