const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const { transactionalDdl } = require('./sql-migration-statements.cjs');

const MIGRATION_NAME = '20261127100000_interprovincial_warehouse_tms';

async function main() {
  if (
    process.env.NODE_ENV !== 'development' ||
    !process.argv.includes('--confirm-development')
  ) {
    throw new Error('Only an explicitly confirmed development migration is allowed');
  }
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../prisma/migrations', MIGRATION_NAME, 'migration.sql'),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') || 'public';
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(schema)) {
    throw new Error('Unsupported database schema name');
  }
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4107, hashtext(${MIGRATION_NAME}))`;
        const previous = await tx.$queryRaw`
          SELECT checksum, finished_at
          FROM _prisma_migrations
          WHERE migration_name = ${MIGRATION_NAME} AND rolled_back_at IS NULL
        `;
        if (previous.length) {
          if (previous.length !== 1 || previous[0].checksum !== checksum || !previous[0].finished_at) {
            throw new Error('Migration history conflicts; refusing to overwrite it');
          }
          console.log('Interprovincial warehouse migration already applied with matching checksum');
          return;
        }
        await tx.$executeRawUnsafe(transactionalDdl(sql));
        await tx.$executeRaw`
          INSERT INTO _prisma_migrations (
            id, checksum, migration_name, started_at, finished_at, applied_steps_count
          ) VALUES (
            ${randomUUID()}, ${checksum}, ${MIGRATION_NAME}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
          )
        `;
        console.log('Applied additive interprovincial warehouse migration and recorded its checksum');
      },
      { timeout: 60000, maxWait: 10000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
