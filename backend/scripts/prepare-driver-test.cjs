// Clone ONLY the isolated merge test database; never touches the development DB.
const fs = require("fs");
const cp = require("child_process");
const assert = require("node:assert/strict");
const { PrismaClient } = require("@prisma/client");
const config = require("dotenv").parse(fs.readFileSync(".env"));
const source = new URL(config.AUTH_TEST_DATABASE_URL);
if (
  !["localhost", "127.0.0.1"].includes(source.hostname) ||
  source.pathname !== "/tms_auth_test"
)
  throw new Error("Local test database required");
const target = new URL(source);
target.pathname = "/tms_driver_test_20261007";
const admin = new PrismaClient({ datasources: { db: { url: source.href } } });
const db = new PrismaClient({ datasources: { db: { url: target.href } } });
(async () => {
  const existing =
    await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname='tms_driver_test_20261007'`;
  if (!existing.length)
    await admin.$executeRawUnsafe(
      "CREATE DATABASE tms_driver_test_20261007 TEMPLATE tms_merge_test_20261005",
    );
  const applied =
    await db.$queryRaw`SELECT 1 FROM information_schema.columns WHERE table_name='driver_assignments' AND column_name='offered_at'`;
  const env = {
    ...process.env,
    ...config,
    DATABASE_URL: target.href,
    DIRECT_URL: target.href,
  };
  const apply = (file) => {
    const result = cp.spawnSync(
      process.execPath,
      [
        "node_modules/prisma/build/index.js",
        "db",
        "execute",
        "--schema",
        "prisma/schema.prisma",
        "--file",
        file,
      ],
      { env, encoding: "utf8", windowsHide: true },
    );
    if (result.status)
      throw new Error("Driver migration failed: " + result.stderr);
  };
  if (!applied.length) {
    const before =
      await db.$queryRaw`SELECT id, status, "createdAt" FROM driver_assignments ORDER BY id`;
    apply(
      "prisma/migrations/20261007090000_driver_assignment_response/migration.sql",
    );
    for (const old of before) {
      const row = await db.driverAssignment.findUniqueOrThrow({
        where: { id: old.id },
      });
      assert.equal(row.status, old.status);
      assert.equal(row.version, 1);
      assert.equal(row.respondedAt, null);
      assert.equal(row.rejectionReason, null);
      assert.equal(+row.offeredAt, +old.createdAt);
    }
    console.log(
      `PASS migration on PostgreSQL: ${before.length} existing assignments preserved, no inferred acceptance.`,
    );
  }
  const constraints =
    await db.$queryRaw`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='driver_assignments'::regclass AND conname='driver_assignments_no_overlap'`;
  if (!constraints[0]?.definition.includes("ACCEPTED"))
    apply(
      "prisma/migrations/20261007100000_driver_accepted_schedule_guard/migration.sql",
    );
  console.log(
    "Driver test database ready; accepted assignments retain schedule protection. No reset.",
  );
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await admin.$disconnect();
  });
