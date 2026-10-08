// Runs the actual mobile API/store modules against Nest HTTP and PostgreSQL.
// Token storage is a test adapter; native SecureStore still requires device QA.
require("ts-node").register({
  skipProject: true,
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "Node",
    target: "ES2021",
    esModuleInterop: true,
  },
});
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { NestFactory } = require("@nestjs/core");
const { ValidationPipe } = require("@nestjs/common");
const { AppModule } = require("../dist/src/app.module");
const { PrismaService } = require("../dist/src/prisma/prisma.service");
const {
  OutboxEventPublisher,
} = require("../dist/src/common/services/outbox-event.publisher");
const {
  seedDriverMobile,
  createDriverDemoTrip,
} = require("../dist/prisma/seed-driver-mobile");
const { seedAuth } = require("../dist/prisma/seed-auth");
const { Api } = require("../../mobile/src/api.ts");
const { DriverStore } = require("../../mobile/src/store.ts");
const { io } = require("../../frontend/node_modules/socket.io-client");

test(
  "mobile client → HTTP → PostgreSQL, restart, account switch and authorized outbox transport",
  { timeout: 60000 },
  async () => {
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
    const sockets = [];
    try {
      await seedAuth(db);
      await seedDriverMobile(db);
      const driver = await db.driver.findFirstOrThrow({
        where: { user: { username: "demo_driver_a" } },
      });
      const vehicle = await db.vehicle.findUniqueOrThrow({
        where: { plateNumber: "DEMO-MOBILE-A" },
      });
      const assignments = [];
      for (const action of ["accept", "reject"]) {
        const trip = await db.$transaction((tx) =>
          createDriverDemoTrip(
            tx,
            "CLIENT-" + action + "-" + randomUUID(),
            driver.homeBranchId,
            vehicle.id,
            driver.id,
          ),
        );
        assignments.push(
          await db.driverAssignment.findFirstOrThrow({
            where: { tripId: trip.id },
          }),
        );
      }
      let stored = null;
      const storage = {
        read: async () => stored,
        write: async (token) => {
          stored = token;
        },
        clear: async () => {
          stored = null;
        },
      };
      const store = new DriverStore(new Api(base), storage, randomUUID);
      await store.login("demo_driver_a", process.env.AUTH_DEMO_PASSWORD);
      assert.equal(store.snapshot().error, null);
      assert.equal(store.snapshot().profile.id, driver.id);
      const login = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "demo_auth_admin",
          password: process.env.AUTH_DEMO_PASSWORD,
        }),
      });
      assert.equal(login.status, 200);
      const admin = await login.json();
      const connect = async (token) => {
        const client = io(base, {
          auth: { token },
          transports: ["websocket"],
          reconnection: false,
        });
        sockets.push(client);
        await new Promise((resolve, reject) => {
          client.once("connect", resolve);
          client.once("connect_error", reject);
        });
        return client;
      };
      const adminSocket = await connect(admin.accessToken),
        driverSocket = await connect(stored);
      const join = (socket) =>
        new Promise((resolve, reject) =>
          socket
            .timeout(3000)
            .emit("join:branch", driver.homeBranchId, (e, result) =>
              e ? reject(e) : resolve(result),
            ),
        );
      assert.equal((await join(adminSocket)).ok, true);
      assert.equal((await join(driverSocket)).ok, false);
      for (const [i, action] of ["accept", "reject"].entries()) {
        await store.open(assignments[i].id);
        assert.equal(store.snapshot().error, null);
        await store.respond(action, "Không thể nhận chuyến demo");
        assert.equal(store.snapshot().error, null);
        assert.equal(
          store.snapshot().detail.status,
          action === "accept" ? "ACCEPTED" : "REJECTED",
        );
        const row = await db.driverAssignment.findUniqueOrThrow({
          where: { id: assignments[i].id },
        });
        assert.equal(row.status, store.snapshot().detail.status);
        const event = await db.outboxEvent.findFirstOrThrow({
          where: { aggregateId: row.id },
        });
        assert.equal(
          event.eventType,
          "driver.assignment." +
            (action === "accept" ? "accepted" : "rejected"),
        );
        const received = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Missing authorized socket invalidation")),
            3000,
          );
          adminSocket.once("trip:updated", (data) => {
            clearTimeout(timer);
            resolve(data);
          });
        });
        await app.get(OutboxEventPublisher).publish(event);
        assert.deepEqual(await received, { id: row.tripId, version: 2 });
      }
      const reopened = new DriverStore(new Api(base), storage, randomUUID);
      await reopened.restore();
      assert.equal(reopened.snapshot().profile.id, driver.id);
      await reopened.open(assignments[0].id);
      assert.equal(reopened.snapshot().detail.status, "ACCEPTED");
      await reopened.logout();
      assert.equal(stored, null);
      assert.equal(reopened.snapshot().detail, null);
      await reopened.login("demo_driver_b", process.env.AUTH_DEMO_PASSWORD);
      assert.notEqual(reopened.snapshot().profile.id, driver.id);
      await reopened.open(assignments[0].id);
      assert.equal(reopened.snapshot().detail, null);
      assert.ok(reopened.snapshot().error);
      await reopened.logout();
    } finally {
      sockets.forEach((s) => s.disconnect());
      await app.close();
    }
  },
);
