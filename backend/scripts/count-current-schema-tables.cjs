const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.$queryRawUnsafe(
  "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
).then((rows) => console.log(`TABLE_COUNT=${rows[0].count}`))
  .finally(() => prisma.$disconnect());
