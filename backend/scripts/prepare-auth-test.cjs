const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { PrismaClient } = require('@prisma/client');
const config = require('dotenv').parse(fs.readFileSync('.env'));
if (!config.AUTH_TEST_DATABASE_URL) throw new Error('AUTH_TEST_DATABASE_URL is required in backend/.env');
const target = new URL(config.AUTH_TEST_DATABASE_URL);
if (!['127.0.0.1','localhost'].includes(target.hostname) || target.pathname !== '/tms_auth_test') throw new Error('Only isolated localhost tms_auth_test is allowed');
Object.assign(process.env, config, { DATABASE_URL: config.AUTH_TEST_DATABASE_URL, DIRECT_URL: config.AUTH_TEST_DATABASE_URL });
const db = new PrismaClient();
(async () => {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  if (tables.length) throw new Error('Test bootstrap requires an empty database. It never resets existing data.');
  let schema = fs.readFileSync('prisma/schema.prisma','utf8');
  schema = schema.replace(/^  authSessions.*\r?\n/m,'').replace(/model AuthSession \{[\s\S]*?\n\}/,'').replace(/model AuthLoginLimit \{[\s\S]*?\n\}/,'');
  const fixture = path.resolve('node_modules/.cache/auth-test'); fs.mkdirSync(fixture,{recursive:true});
  fs.writeFileSync(path.join(fixture,'schema.prisma'),schema);
  // Test-only pre-auth snapshot. This is deliberately not represented as recovered historical migrations.
  const diff=cp.spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','diff','--from-empty','--to-schema-datamodel',path.join(fixture,'schema.prisma'),'--script'],{encoding:'utf8',env:process.env});
  if(diff.status) throw new Error('Cannot generate test snapshot');
  fs.writeFileSync(path.join(fixture,'baseline.sql'),diff.stdout);
  const apply=file=>{const r=cp.spawnSync(process.execPath,['node_modules/prisma/build/index.js','db','execute','--file',file,'--schema','prisma/schema.prisma'],{encoding:'utf8',env:process.env});if(r.status) throw new Error('SQL application failed: '+r.stderr);};
  apply(path.join(fixture,'baseline.sql'));
  // Representative old data must survive the new migration. No implicit admin backfill.
  await db.user.create({data:{username:'pre_auth_legacy',fullName:'[TEST] Legacy account',password:'not-a-login-hash',role:'ADMIN'}});
  apply('prisma/migrations/20260926090000_auth_sessions_scope_constraints/migration.sql');
  if(await db.userRoleScope.count({where:{user:{username:'pre_auth_legacy'}}})!==0) throw new Error('Unexpected permission backfill');
  console.log('PostgreSQL snapshot + auth migration applied; existing legacy user preserved without grants.');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
