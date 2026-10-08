const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/src/app.module");
const { PrismaService } = require("../dist/src/prisma/prisma.service");
const {
  seedDriverMobile,
  createDriverDemoTrip,
} = require("../dist/prisma/seed-driver-mobile");
const { seedAuth } = require("../dist/prisma/seed-auth");

test("Driver mobile HTTP + real PostgreSQL", { timeout: 120000 }, async (t) => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(
    ["localhost", "127.0.0.1"].includes(target.hostname) &&
      target.pathname === "/tms_driver_test_20261007",
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(0, "127.0.0.1");
  const db = app.get(PrismaService),
    base = await app.getUrl();
  const request = async (path, token, body, key) => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const login = (username, password = process.env.AUTH_DEMO_PASSWORD) =>
    request("/auth/login", null, { username, password });
  try {
    await seedAuth(db);
    await seedDriverMobile(db);
    const demoA = await db.user.findUniqueOrThrow({
      where: { username: "demo_driver_a" },
      include: { driver: true },
    });
    const demoB = await db.user.findUniqueOrThrow({
      where: { username: "demo_driver_b" },
      include: { driver: true },
    });
    const role = await db.accessRole.findUniqueOrThrow({
      where: { code: "DRIVER" },
    });
    const suffix = randomUUID();
    const user = await db.user.create({
      data: {
        username: "driver-test-" + suffix,
        password: demoA.password,
        fullName: "[TEST] Driver",
        role: "DRIVER",
      },
    });
    const driver = await db.driver.create({
      data: {
        userId: user.id,
        fullName: "[TEST]",
        citizenId: suffix,
        phone: "000",
        licenseNumber: suffix,
        licenseClass: "C",
        licenseExpiry: new Date("2035-01-01"),
        homeBranchId: demoA.driver.homeBranchId,
      },
    });
    const scope = await db.userRoleScope.create({
      data: {
        userId: user.id,
        roleId: role.id,
        scopeType: "BRANCH",
        branchId: driver.homeBranchId,
      },
    });
    const vehicle = await db.vehicle.findUniqueOrThrow({
      where: { plateNumber: "DEMO-MOBILE-A" },
    });
    const fresh = async (tag, driverId = driver.id) => {
      const trip = await db.$transaction((tx) =>
        createDriverDemoTrip(
          tx,
          suffix + "-" + tag,
          driver.homeBranchId,
          vehicle.id,
          driverId,
        ),
      );
      const assignment = await db.driverAssignment.findFirstOrThrow({
        where: { tripId: trip.id },
      });
      return {
        trip,
        assignment,
        body: {
          expectedVersion: assignment.version,
          expectedTripVersion: trip.version,
        },
      };
    };
    const a = await fresh("accept"),
      reject = await fresh("reject"),
      race = await fresh("race"),
      rollback = await fresh("rollback");
    const sameBranch = await fresh("other-driver", demoA.driver.id);
    const draft = await fresh("draft");
    await db.trip.update({
      where: { id: draft.trip.id },
      data: { status: "DRAFT" },
    });
    let token;
    await t.test("DRIVER login/profile and wrong password", async () => {
      const r = await login(user.username);
      assert.equal(r.status, 200);
      token = r.body.accessToken;
      const me = await request("/driver/me", token);
      assert.equal(me.status, 200);
      assert.equal(me.body.id, driver.id);
      assert.equal((await login(user.username, "wrong")).status, 401);
      assert.equal((await request("/driver/me")).status, 401);
    });
    await t.test(
      "legacy DRIVER role cannot enable unrelated files/locations APIs",
      async () => {
        assert.equal((await request("/locations", token)).status, 403);
        assert.equal((await request("/files/upload", token, {})).status, 403);
      },
    );
    await t.test(
      "own relation only; other branch, same branch and drafts hidden",
      async () => {
        const list = await request("/driver/assignments", token);
        assert.equal(list.status, 200);
        assert.equal(list.body.total, 4);
        assert.ok(
          list.body.data.every((x) =>
            [a, reject, race, rollback].some((y) => y.assignment.id === x.id),
          ),
        );
        const b = await db.driverAssignment.findFirstOrThrow({
          where: { driverId: demoB.driver.id },
        });
        for (const id of [b.id, sameBranch.assignment.id, draft.assignment.id])
          assert.equal(
            (await request("/driver/assignments/" + id, token)).status,
            404,
          );
        assert.equal(
          (
            await request(
              "/driver/assignments/" + b.id + "/accept",
              token,
              a.body,
              randomUUID(),
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await request(
              "/driver/assignments?driverId=" + demoB.driver.id,
              token,
            )
          ).status,
          400,
        );
      },
    );
    await t.test("pagination, dates, status, bounded input", async () => {
      const p1 = await request(
        "/driver/assignments?limit=1&page=1&status=ASSIGNED",
        token,
      );
      const p2 = await request("/driver/assignments?limit=1&page=2", token);
      assert.equal(p1.body.data.length, 1);
      assert.notEqual(p1.body.data[0].id, p2.body.data[0].id);
      assert.equal(
        (await request("/driver/assignments?from=2031-01-01T00:00:00Z", token))
          .body.total,
        0,
      );
      assert.equal(
        (await request("/driver/assignments?to=2029-01-01T00:00:00Z", token))
          .body.total,
        0,
      );
      for (const q of [
        "limit=1000",
        "page=0",
        "status=INVALID",
        "from=2030-01-01",
        "from=2031-01-01T00:00:00Z&to=2029-01-01T00:00:00Z",
      ])
        assert.equal(
          (await request("/driver/assignments?" + q, token)).status,
          400,
        );
    });
    await t.test(
      "detail is a safe real manifest with package IDs and service windows",
      async () => {
        const r = await request(
          "/driver/assignments/" + a.assignment.id,
          token,
        );
        assert.equal(r.status, 200);
        assert.deepEqual(
          r.body.trip.stops.map((s) => s.sequence),
          [1, 2],
        );
        assert.deepEqual(
          r.body.trip.stops.map((s) => s.tasks[0].action),
          ["LOAD", "UNLOAD"],
        );
        assert.equal(r.body.trip.stops[0].tasks[0].package.weightG, "10000");
        assert.equal(
          r.body.trip.stops[0].tasks[0].windowBasis,
          "SERVICE_START",
        );
        assert.equal(
          r.body.trip.stops[0].tasks[0].package.id,
          r.body.trip.stops[1].tasks[0].package.id,
        );
        const json = JSON.stringify(r.body);
        for (const field of [
          "password",
          "salary",
          "planningSnapshot",
          "accessToken",
          "fixedSalaryMonthly",
          "costEntries",
          "sessionId",
        ])
          assert.ok(!json.includes(field));
      },
    );
    await t.test(
      "upcoming assignments appear before past history",
      async () => {
        const past = await fresh("past");
        await db.$transaction(async (tx) => {
          await tx.driverAssignment.update({
            where: { id: past.assignment.id },
            data: {
              startTime: new Date("2020-01-01T00:00:00Z"),
              endTime: new Date("2020-01-01T04:00:00Z"),
            },
          });
          await tx.trip.update({
            where: { id: past.trip.id },
            data: {
              plannedStartTime: new Date("2020-01-01T00:00:00Z"),
              plannedEndTime: new Date("2020-01-01T04:00:00Z"),
            },
          });
        });
        const list = await request("/driver/assignments", token);
        assert.equal(list.body.data.at(-1).id, past.assignment.id);
        assert.ok(new Date(list.body.data[0].startTime) > new Date());
      },
    );
    await t.test(
      "invalid reason/input/key and stale versions have no side effects",
      async () => {
        const path = "/driver/assignments/" + a.assignment.id;
        assert.equal(
          (await request(path + "/reject", token, a.body, randomUUID())).status,
          400,
        );
        assert.equal(
          (
            await request(
              path + "/reject",
              token,
              { ...a.body, reason: "   " },
              randomUUID(),
            )
          ).status,
          400,
        );
        assert.equal(
          (await request(path + "/accept", token, a.body)).status,
          400,
        );
        for (const body of [
          { ...a.body, expectedVersion: 99 },
          { ...a.body, expectedTripVersion: 99 },
        ]) {
          const r = await request(path + "/accept", token, body, randomUUID());
          assert.equal(r.status, 409);
          assert.equal(r.body.code, "VERSION_CONFLICT");
        }
      },
    );
    await t.test(
      "accept; same-key retry; mismatches across endpoints; transition rejected",
      async () => {
        const key = randomUUID(),
          path = "/driver/assignments/" + a.assignment.id;
        const first = await request(path + "/accept", token, a.body, key);
        assert.equal(first.status, 200);
        assert.deepEqual(
          (await request(path + "/accept", token, a.body, key)).body,
          first.body,
        );
        assert.equal(
          (
            await request(
              path + "/reject",
              token,
              { ...a.body, reason: "changed" },
              key,
            )
          ).body.code,
          "IDEMPOTENCY_MISMATCH",
        );
        assert.equal(
          (
            await request(
              path + "/accept",
              token,
              { ...a.body, expectedVersion: 2 },
              key,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await request(
              path + "/reject",
              token,
              { ...a.body, expectedVersion: 2, reason: "no" },
              randomUUID(),
            )
          ).body.code,
          "INVALID_TRANSITION",
        );
        assert.equal(
          (await db.trip.findUniqueOrThrow({ where: { id: a.trip.id } }))
            .status,
          "DISPATCHED",
        );
        assert.equal(
          await db.auditLog.count({ where: { entityId: a.assignment.id } }),
          1,
        );
        assert.equal(
          await db.outboxEvent.count({
            where: { aggregateId: a.assignment.id },
          }),
          1,
        );
        const command = await db.processedCommand.findFirstOrThrow({
          where: { actorUserId: user.id, idempotencyKey: key },
        });
        assert.equal(command.status, "COMPLETED");
        const audit = await db.auditLog.findFirstOrThrow({
          where: { entityId: a.assignment.id },
        });
        assert.equal(audit.changeSummary.commandId, command.id);
      },
    );
    await t.test(
      "reject persists reason; cannot accept again; filters reflect response",
      async () => {
        const path = "/driver/assignments/" + reject.assignment.id;
        assert.equal(
          (
            await request(
              path + "/reject",
              token,
              { ...reject.body, reason: "  Không thể nhận  " },
              randomUUID(),
            )
          ).status,
          200,
        );
        const row = await db.driverAssignment.findUniqueOrThrow({
          where: { id: reject.assignment.id },
        });
        assert.equal(row.rejectionReason, "Không thể nhận");
        assert.ok(row.respondedAt);
        assert.equal(row.version, 2);
        assert.equal(
          (
            await request(
              path + "/accept",
              token,
              { ...reject.body, expectedVersion: 2 },
              randomUUID(),
            )
          ).status,
          409,
        );
        assert.equal(
          (await request("/driver/assignments?status=REJECTED", token)).body
            .total,
          1,
        );
        assert.equal(
          (
            await db.outboxEvent.findFirstOrThrow({
              where: { aggregateId: row.id },
            })
          ).eventType,
          "driver.assignment.rejected",
        );
      },
    );
    await t.test(
      "accepted assignment still blocks overlapping schedule at database level",
      async () => {
        await assert.rejects(
          db.driverAssignment.create({
            data: {
              tripId: sameBranch.trip.id,
              driverId: driver.id,
              startTime: a.assignment.startTime,
              endTime: a.assignment.endTime,
            },
          }),
          /driver_assignments_no_overlap/,
        );
      },
    );
    await t.test("simultaneous accept/reject: exactly one wins", async () => {
      const path = "/driver/assignments/" + race.assignment.id;
      const results = await Promise.all([
        request(path + "/accept", token, race.body, randomUUID()),
        request(
          path + "/reject",
          token,
          { ...race.body, reason: "race" },
          randomUUID(),
        ),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        await db.outboxEvent.count({
          where: { aggregateId: race.assignment.id },
        }),
        1,
      );
      assert.equal(
        await db.auditLog.count({ where: { entityId: race.assignment.id } }),
        1,
      );
    });
    await t.test(
      "simultaneous same key is replayed, not a second command",
      async () => {
        const x = await fresh("duplicate"),
          key = randomUUID(),
          path = "/driver/assignments/" + x.assignment.id + "/accept";
        const results = await Promise.all([
          request(path, token, x.body, key),
          request(path, token, x.body, key),
        ]);
        assert.deepEqual(
          results.map((r) => r.status),
          [200, 200],
        );
        assert.deepEqual(results[0].body, results[1].body);
        assert.equal(
          await db.outboxEvent.count({
            where: { aggregateId: x.assignment.id },
          }),
          1,
        );
      },
    );
    await t.test(
      "database failure rolls back assignment, audit, outbox and command",
      async () => {
        const key = randomUUID();
        await db.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION driver_test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."aggregateId" = '${rollback.assignment.id}' THEN RAISE EXCEPTION 'test injected failure'; END IF; RETURN NEW; END $$`,
        );
        await db.$executeRawUnsafe(
          "CREATE TRIGGER driver_test_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION driver_test_fail_outbox()",
        );
        try {
          assert.equal(
            (
              await request(
                "/driver/assignments/" + rollback.assignment.id + "/accept",
                token,
                rollback.body,
                key,
              )
            ).status,
            503,
          );
          assert.equal(
            (
              await db.driverAssignment.findUniqueOrThrow({
                where: { id: rollback.assignment.id },
              })
            ).status,
            "ASSIGNED",
          );
          assert.equal(
            await db.auditLog.count({
              where: { entityId: rollback.assignment.id },
            }),
            0,
          );
          assert.equal(
            await db.outboxEvent.count({
              where: { aggregateId: rollback.assignment.id },
            }),
            0,
          );
          assert.equal(
            await db.processedCommand.count({
              where: { actorUserId: user.id, idempotencyKey: key },
            }),
            0,
          );
        } finally {
          await db.$executeRawUnsafe(
            "DROP TRIGGER driver_test_fail_outbox ON outbox_events",
          );
          await db.$executeRawUnsafe("DROP FUNCTION driver_test_fail_outbox()");
        }
      },
    );
    await t.test(
      "locked account, revoked scope and inactive role denied on next request",
      async () => {
        await db.user.update({
          where: { id: user.id },
          data: { active: false },
        });
        try {
          assert.equal((await request("/driver/me", token)).status, 401);
          assert.equal(
            (await login(user.username)).body.code,
            "ACCOUNT_DISABLED",
          );
        } finally {
          await db.user.update({
            where: { id: user.id },
            data: { active: true },
          });
        }
        await db.userRoleScope.update({
          where: { id: scope.id },
          data: { active: false },
        });
        try {
          assert.equal((await request("/driver/me", token)).status, 403);
          assert.equal(
            (
              await request(
                "/driver/assignments/" + rollback.assignment.id + "/accept",
                token,
                rollback.body,
                randomUUID(),
              )
            ).status,
            403,
          );
        } finally {
          await db.userRoleScope.update({
            where: { id: scope.id },
            data: { active: true },
          });
        }
        await db.accessRole.update({
          where: { id: role.id },
          data: { active: false },
        });
        try {
          assert.equal((await request("/driver/me", token)).status, 403);
        } finally {
          await db.accessRole.update({
            where: { id: role.id },
            data: { active: true },
          });
        }
      },
    );
    await t.test(
      "missing link and wrong home branch denied; legacy role never grants driver access",
      async () => {
        await db.driver.update({
          where: { id: driver.id },
          data: { userId: null },
        });
        try {
          assert.equal((await login(user.username)).status, 403);
          assert.equal((await request("/driver/me", token)).status, 403);
        } finally {
          await db.driver.update({
            where: { id: driver.id },
            data: { userId: user.id },
          });
        }
        await db.driver.update({
          where: { id: driver.id },
          data: { homeBranchId: demoB.driver.homeBranchId },
        });
        try {
          assert.equal((await request("/driver/me", token)).status, 403);
        } finally {
          await db.driver.update({
            where: { id: driver.id },
            data: { homeBranchId: demoA.driver.homeBranchId },
          });
        }
        for (const username of ["demo_auth_admin", "demo_auth_a"]) {
          const r = await login(username);
          assert.equal(r.status, 200);
          assert.equal(
            (await request("/driver/me", r.body.accessToken)).status,
            403,
          );
          assert.equal(
            (await request("/trips", r.body.accessToken)).status,
            200,
          );
        }
      },
    );
    await t.test(
      "demo rerun preserves revoked scopes/locked users and existing responses",
      async () => {
        const s = await db.userRoleScope.findFirstOrThrow({
          where: { userId: demoA.id, roleId: role.id },
        });
        await db.user.update({
          where: { id: demoA.id },
          data: { active: false },
        });
        await db.userRoleScope.update({
          where: { id: s.id },
          data: { active: false },
        });
        try {
          await seedDriverMobile(db);
          assert.equal(
            (await db.user.findUniqueOrThrow({ where: { id: demoA.id } }))
              .active,
            false,
          );
          assert.equal(
            (await db.userRoleScope.findUniqueOrThrow({ where: { id: s.id } }))
              .active,
            false,
          );
        } finally {
          await db.user.update({
            where: { id: demoA.id },
            data: { active: demoA.active },
          });
          await db.userRoleScope.update({
            where: { id: s.id },
            data: { active: s.active },
          });
        }
      },
    );
    await t.test("logout revokes token", async () => {
      assert.equal((await request("/auth/logout", token, {})).status, 200);
      assert.equal((await request("/driver/me", token)).status, 401);
    });
  } finally {
    await app.close();
  }
});
