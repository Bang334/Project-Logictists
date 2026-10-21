const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const url = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/tms_monitor_test') throw new Error('Only isolated tms_monitor_test allowed');
const db = new PrismaClient();
(async () => { try {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  if (tables.length) { console.log('Existing isolated schema retained.'); return; }
  fs.mkdirSync('node_modules/.cache', { recursive: true });
  for (const args of [
    ['migrate','diff','--from-empty','--to-schema-datamodel','prisma/schema.prisma','--script','--output','node_modules/.cache/monitor-schema.sql'],
    ['db','execute','--file','node_modules/.cache/monitor-schema.sql','--schema','prisma/schema.prisma'],
  ]) {
    const r = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { windowsHide: true, env: process.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('Isolated schema preparation failed');
  }
  console.log('Fresh PostgreSQL schema for read-query tests; execution triggers are not tested here.');
} finally { await db.$disconnect(); } })().catch(e => { console.error(e.message); process.exitCode = 1; });
