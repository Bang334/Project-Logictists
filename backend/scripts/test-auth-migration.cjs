const fs = require('fs'), cp = require('child_process'), { randomUUID } = require('crypto');
const config = require('dotenv').parse(fs.readFileSync('.env'));
if (!config.AUTH_TEST_DATABASE_URL) throw new Error('AUTH_TEST_DATABASE_URL is required in backend/.env');
const target = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/tms_auth_test') throw new Error('Only isolated localhost tms_auth_test is allowed');
if (!/^tms-auth-test-[a-z0-9-]+$/i.test(config.AUTH_TEST_CONTAINER || '')) throw new Error('Only the configured isolated auth test container is allowed');
const sql = fs.readFileSync('prisma/migrations/20260926090000_auth_sessions_scope_constraints/migration.sql', 'utf8');
function run(input, expectSuccess = true) {
  const result = cp.spawnSync('docker', ['exec', '-i', config.AUTH_TEST_CONTAINER, 'psql', '-U', decodeURIComponent(target.username), '-d', target.pathname.slice(1), '-v', 'ON_ERROR_STOP=1', '-At'], { input, encoding: 'utf8' });
  if (expectSuccess && result.status !== 0) throw new Error(result.stderr);
  if (!expectSuccess && result.status === 0) throw new Error('Invalid migration data was accepted');
  return result.stdout.trim();
}
for (const scenario of ['missing_rbac', 'existing_valid', 'existing_duplicate', 'existing_bad_shape']) {
  const schema = 'auth_migration_' + randomUUID().replaceAll('-', '');
  run(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE branches(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('old-user'); INSERT INTO branches VALUES ('branch-a');`);
  const prefix = `SET search_path TO "${schema}";\n`;
  if (scenario !== 'missing_rbac') {
    run(prefix + sql.slice(0, sql.indexOf('ALTER TABLE "user_role_scopes"')) + '\nCOMMIT;');
    run(prefix + `INSERT INTO roles (id,code,name,"updatedAt") VALUES ('admin','ADMIN','Admin',now()); INSERT INTO user_role_scopes(id,"userId","roleId","scopeType","branchId","updatedAt") VALUES ('old-scope','old-user','admin','COMPANY',NULL,now());`);
    if (scenario === 'existing_duplicate') run(prefix + `INSERT INTO user_role_scopes(id,"userId","roleId","scopeType","branchId","updatedAt") VALUES ('duplicate','old-user','admin','COMPANY',NULL,now());`);
    if (scenario === 'existing_bad_shape') run(prefix + `UPDATE user_role_scopes SET "branchId"='branch-a';`);
  }
  const valid = ['missing_rbac','existing_valid'].includes(scenario);
  run(prefix + sql, valid);
  const users = run(prefix + 'SELECT count(*) FROM users;').split('\n').at(-1);
  if (users !== '1') throw new Error('Existing data was not preserved');
  const sessions = run(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${schema}' AND table_name='auth_sessions';`).split('\n').at(-1);
  if (sessions !== (valid ? '1' : '0')) throw new Error('Migration transaction did not commit/rollback atomically');
  console.log('PASS migration:', scenario, '(old user preserved, no inferred grants)');
}
