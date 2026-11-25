import "dotenv/config";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  OrderStatus,
  PackageStatus,
  Prisma,
  Role,
  StopType,
  TaskAction,
  TripStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
import request = require("supertest");
import { AuthModule } from "../../src/auth/auth.module";
import { DriversModule } from "../../src/drivers/drivers.module";
import { driverActivityQuery } from "../../src/drivers/driver-activity.query";
import { DRIVER_EXECUTION_EVENT as event, DRIVER_TRIP_COMMAND as command } from "../../src/trips/driver-trip-execution.constants";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverTripsController } from "../../src/trips/driver-trips.controller";
import { DriverTripsService } from "../../src/trips/driver-trips.service";
import { driverTripHistoryQuery } from "../../src/trips/driver-trip-history.query";
import { OptimizationJobsService } from "../../src/trips/optimization-jobs.service";
import { TripsController } from "../../src/trips/trips.controller";
import { TripsService } from "../../src/trips/trips.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("M3.1/M5.2 Driver Read APIs (PostgreSQL)", () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m31-${suffix}`;
  const tokens: Record<string, string> = {};
  const ids = {
    driverA: "",
    driverB: "",
    branchA: "",
    branchB: "",
    dispatched: "",
    inProgress: "",
    completed: "",
    cancelled: "",
    planned: "",
    draft: "",
    otherDriver: "",
    inactiveAssignment: "",
    multiAssignment: "",
  };

  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "m31-driver-trips-integration-secret-32chars";

    const tripsService = {
      getLoadPlan: jest.fn().mockResolvedValue({ id: "admin-load-plan" }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        DriversModule,
      ],
      controllers: [DriverTripsController, TripsController],
      providers: [
        DriverTripsService,
        { provide: TripsService, useValue: tripsService },
        { provide: OptimizationJobsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `${prefix}-A`,
          name: "M3.1 Branch A",
          address: "Integration test A",
          latitude: 10,
          longitude: 106,
        },
      }),
      prisma.branch.create({
        data: {
          code: `${prefix}-B`,
          name: "M3.1 Branch B",
          address: "Integration test B",
          latitude: 11,
          longitude: 107,
        },
      }),
    ]);
    ids.branchA = branchA.id;
    ids.branchB = branchB.id;

    const userInputs = [
      {
        label: "driver-a",
        role: Role.DRIVER,
        branchId: branchA.id,
        active: true,
      },
      {
        label: "driver-b",
        role: Role.DRIVER,
        branchId: null,
        active: true,
      },
      {
        label: "driver-missing",
        role: Role.DRIVER,
        branchId: branchA.id,
        active: true,
      },
      {
        label: "driver-inactive",
        role: Role.DRIVER,
        branchId: branchA.id,
        active: false,
      },
      { label: "admin", role: Role.ADMIN, branchId: null, active: true },
      {
        label: "dispatcher",
        role: Role.DISPATCHER,
        branchId: branchA.id,
        active: true,
      },
      { label: "staff", role: Role.STAFF, branchId: branchA.id, active: true },
      { label: "customer", role: Role.CUSTOMER, branchId: null, active: true },
    ];
    const users: Record<string, string> = {};
    for (const input of userInputs) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: "integration-test-not-a-real-credential",
          fullName: `M3.1 ${input.label}`,
          role: input.role,
          branchId: input.branchId,
          active: input.active,
        },
      });
      users[input.label] = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
    }

    const [driverA, driverB, inactiveDriver] = await Promise.all([
      prisma.driver.create({
        data: {
          userId: users["driver-a"],
          fullName: "Driver A",
          citizenId: `${prefix}-CID-A`,
          phone: `${prefix}-PHONE-A`,
          licenseNumber: `${prefix}-LIC-A`,
          licenseClass: "C",
          licenseExpiry: new Date("2030-01-01"),
          homeBranchId: branchB.id,
        },
      }),
      prisma.driver.create({
        data: {
          userId: users["driver-b"],
          fullName: "Driver B",
          citizenId: `${prefix}-CID-B`,
          phone: `${prefix}-PHONE-B`,
          licenseNumber: `${prefix}-LIC-B`,
          licenseClass: "C",
          licenseExpiry: new Date("2030-01-01"),
          homeBranchId: branchA.id,
        },
      }),
      prisma.driver.create({
        data: {
          userId: users["driver-inactive"],
          fullName: "Inactive Driver",
          citizenId: `${prefix}-CID-I`,
          phone: `${prefix}-PHONE-I`,
          licenseNumber: `${prefix}-LIC-I`,
          licenseClass: "C",
          licenseExpiry: new Date("2030-01-01"),
          homeBranchId: branchA.id,
        },
      }),
    ]);
    ids.driverA = driverA.id;
    ids.driverB = driverB.id;
    await prisma.driverLicense.create({
      data: {
        driverId: driverA.id,
        licenseNumber: `${prefix}-PRIVATE-LIC`,
        category: "CE",
        validFrom: new Date("2010-01-01"),
        validUntil: new Date("2015-01-01"),
        verificationStatus: "PENDING",
      },
    });

    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE`,
        model: "M3.1 Test Truck",
        vehicleType: "Truck",
        homeBranchId: branchA.id,
        payloadCapacityKg: 5000,
        volumeCapacityM3: 25,
        lengthCm: 600,
        widthCm: 240,
        heightCm: 250,
      },
    });
    const secondVehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE-2`,
        model: "Second Test Truck",
        vehicleType: "Truck",
        homeBranchId: branchA.id,
        payloadCapacityKg: 7000,
        volumeCapacityM3: 35,
        lengthCm: 700,
        widthCm: 240,
        heightCm: 270,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        code: `${prefix}-CUS`,
        name: "Private Customer Name",
        phone: `${prefix}-CUS-PHONE`,
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `${prefix}-ORDER`,
        customerId: customer.id,
        branchId: branchA.id,
        status: OrderStatus.ASSIGNED,
        totalAmount: 999999,
      },
    });
    const pkg = await prisma.package.create({
      data: {
        orderId: order.id,
        packageCode: `${prefix}-PKG`,
        lengthMm: 1200,
        widthMm: 800,
        heightMm: 600,
        weightG: 12500n,
        allowedOrientations: ["LWH"],
        measurementSource: "INTEGRATION_TEST",
        status: PackageStatus.ALLOCATED,
      },
    });

    let tripSequence = 0;
    const createTrip = async (
      label: string,
      status: TripStatus,
      assignments: Array<{ driverId: string; status?: string }>,
      withDetail = false,
    ) => {
      tripSequence += 1;
      const start = new Date(
        `2026-12-${String(tripSequence).padStart(2, "0")}T08:00:00.000Z`,
      );
      const end = new Date(start.getTime() + 3_600_000);
      const trip = await prisma.trip.create({
        data: {
          tripNumber: `${prefix}-${label}`,
          vehicleId: status === TripStatus.IN_PROGRESS ? secondVehicle.id : vehicle.id,
          managingBranchId: branchA.id,
          status,
          plannedStartTime: start,
          plannedEndTime: end,
          totalDistanceKm: 25.5,
          totalDurationMinutes: 60,
          planningSnapshot: { secret: "must-not-leak" },
          routeGeometry: "must-not-leak",
          assignments: {
            create: assignments.map((assignment, index) => ({
              driverId: assignment.driverId,
              startTime: start,
              endTime: end,
              role: index === 0 ? "PRIMARY" : "RELIEF",
              status: assignment.status ?? "ASSIGNED",
            })),
          },
        },
      });
      if (withDetail) {
        const delivery = await prisma.tripStop.create({
          data: {
            tripId: trip.id,
            sequence: 2,
            stopType: StopType.DELIVERY,
            address: "Delivery address",
            latitude: 11,
            longitude: 107,
            contactName: "Receiver",
            contactPhone: "0900000002",
          },
        });
        const pickup = await prisma.tripStop.create({
          data: {
            tripId: trip.id,
            sequence: 1,
            stopType: StopType.PICKUP,
            address: "Pickup address",
            latitude: 10,
            longitude: 106,
            contactName: "Sender",
            contactPhone: "0900000001",
          },
        });
        await prisma.stopTask.create({
          data: {
            tripStopId: pickup.id,
            orderId: order.id,
            packageId: pkg.id,
            action: TaskAction.LOAD,
            plannedQuantity: 1,
          },
        });
        await prisma.stopTask.create({
          data: {
            tripStopId: delivery.id,
            orderId: order.id,
            packageId: pkg.id,
            action: TaskAction.UNLOAD,
            plannedQuantity: 1,
          },
        });
      }
      return trip.id;
    };

    ids.dispatched = await createTrip(
      "DISPATCHED",
      TripStatus.DISPATCHED,
      [{ driverId: driverA.id }],
      true,
    );
    ids.inProgress = await createTrip("IN-PROGRESS", TripStatus.IN_PROGRESS, [
      { driverId: driverA.id },
    ]);
    ids.completed = await createTrip("COMPLETED", TripStatus.COMPLETED, [
      { driverId: driverA.id },
    ]);
    ids.cancelled = await createTrip("CANCELLED", TripStatus.CANCELLED, [
      { driverId: driverA.id },
    ]);
    ids.planned = await createTrip("PLANNED", TripStatus.PLANNED, [
      { driverId: driverA.id },
    ]);
    ids.draft = await createTrip("DRAFT", TripStatus.DRAFT, [
      { driverId: driverA.id },
    ]);
    ids.otherDriver = await createTrip("OTHER", TripStatus.DISPATCHED, [
      { driverId: driverB.id },
    ]);
    ids.inactiveAssignment = await createTrip(
      "INACTIVE-ASSIGNMENT",
      TripStatus.DISPATCHED,
      [{ driverId: driverA.id, status: "CANCELLED" }],
    );
    ids.multiAssignment = await createTrip("MULTI", TripStatus.DISPATCHED, [
      { driverId: driverA.id },
      { driverId: driverB.id },
    ]);

    await prisma.driverAssignment.create({
      data: {
        tripId: ids.dispatched,
        driverId: inactiveDriver.id,
        startTime: new Date("2026-12-01T08:00:00.000Z"),
        endTime: new Date("2026-12-01T09:00:00.000Z"),
        status: "ASSIGNED",
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.deliveryAttempt.deleteMany({ where: { tripStop: { trip: { tripNumber: { startsWith: prefix } } } } });
    await prisma.executionEvent.deleteMany({ where: { trip: { tripNumber: { startsWith: prefix } } } });
    await prisma.processedCommand.deleteMany({ where: { actorUser: { username: { startsWith: prefix } } } });
    await prisma.trip.deleteMany({
      where: { tripNumber: { startsWith: prefix } },
    });
    await prisma.package.deleteMany({
      where: { packageCode: { startsWith: prefix } },
    });
    await prisma.order.deleteMany({
      where: { orderNumber: { startsWith: prefix } },
    });
    await prisma.customer.deleteMany({
      where: { code: { startsWith: prefix } },
    });
    await prisma.driverLicense.deleteMany({
      where: { driver: { citizenId: { startsWith: prefix } } },
    });
    await prisma.driver.deleteMany({
      where: { citizenId: { startsWith: prefix } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: prefix } },
    });
    await prisma.user.deleteMany({
      where: { username: { startsWith: prefix } },
    });
    await prisma.branch.deleteMany({ where: { code: { startsWith: prefix } } });
    await app.close();
  });

  it("returns only self profile and explicit expired license from DriverLicense", async () => {
    await request(app.getHttpServer()).get("/driver/me")
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(200)
      .expect({
        id: ids.driverA,
        fullName: "Driver A",
        status: "AVAILABLE",
        operationalPhone: `${prefix}-PHONE-A`,
        homeBranch: { id: ids.branchB, code: `${prefix}-B`, name: "M3.1 Branch B", timezone: "Asia/Ho_Chi_Minh" },
        license: { category: "CE", validUntil: "2015-01-01", verificationStatus: "PENDING" },
      });
  });

  it("uses Driver.homeBranch with null User.branchId and does not infer a legacy license", async () => {
    await request(app.getHttpServer()).get("/driver/me")
      .set("Authorization", bearer(tokens["driver-b"]))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        id: ids.driverB, homeBranch: { id: ids.branchA }, license: null,
      }));
  });

  it("returns no license if the authoritative source has multiple records", async () => {
    const extra = await prisma.driverLicense.create({
      data: {
        driverId: ids.driverA, category: "D", licenseNumber: `${prefix}-ALT`,
        validFrom: new Date("2020-01-01"), validUntil: new Date("2030-01-01"),
      },
    });
    try {
      await request(app.getHttpServer()).get("/driver/me")
        .set("Authorization", bearer(tokens["driver-a"]))
        .expect(200)
        .expect(({ body }) => expect(body.license).toBeNull());
    } finally {
      await prisma.driverLicense.delete({ where: { id: extra.id } });
    }
  });

  it("rejects owner injection, missing profile, and invalid or inactive sessions", async () => {
    const server = app.getHttpServer();
    await request(server).get(`/driver/me?driverId=${ids.driverB}`)
      .set("Authorization", bearer(tokens["driver-a"])).expect(400);
    await request(server).get("/driver/me").set("Authorization", bearer(tokens["driver-missing"]))
      .expect(409).expect(({ body }) => expect(body.errorCode).toBe("DRIVER_PROFILE_NOT_FOUND"));
    await request(server).get("/driver/me").expect(401);
    await request(server).get("/driver/me").set("Authorization", "Bearer invalid").expect(401);
    await request(server).get("/driver/me").set("Authorization", bearer(tokens["driver-inactive"])).expect(401);
  });

  it.each(["admin", "dispatcher", "staff", "customer"])("blocks %s from self profile", async (label) => {
    await request(app.getHttpServer()).get("/driver/me")
      .set("Authorization", bearer(tokens[label])).expect(403);
  });

  it("projects approved specs for the correct vehicle on multiple Trips and preserves the summary DTO", async () => {
    const server = app.getHttpServer();
    const token = bearer(tokens["driver-a"]);
    const { body: list } = await request(server).get("/driver/trips").set("Authorization", token).expect(200);
    const summary = list.items[0].vehicle;
    expect(summary).toEqual({
      id: expect.any(String), plateNumber: `${prefix}-PLATE`, model: "M3.1 Test Truck", vehicleType: "Truck",
    });
    await request(server).get(`/driver/trips/${ids.dispatched}`).set("Authorization", token).expect(200)
      .expect(({ body }) => expect(body.vehicle).toEqual({
        ...summary, payloadCapacityKg: 5000, volumeCapacityM3: 25, lengthCm: 600, widthCm: 240, heightCm: 250,
      }));
    await request(server).get(`/driver/trips/${ids.inProgress}`).set("Authorization", token).expect(200)
      .expect(({ body }) => expect(body.vehicle).toEqual({
        id: expect.any(String), plateNumber: `${prefix}-PLATE-2`, model: "Second Test Truck", vehicleType: "Truck",
        payloadCapacityKg: 7000, volumeCapacityM3: 35, lengthCm: 700, widthCm: 240, heightCm: 270,
      }));
    await request(server).get(`/driver/trips/${ids.multiAssignment}`)
      .set("Authorization", bearer(tokens["driver-b"])).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        assignment: { role: "RELIEF", status: "ASSIGNED" }, vehicle: { payloadCapacityKg: 5000 },
      }));
  });

  it("DRIVER đọc list owned, chỉ visible status, không duplicate và branch mismatch không cản quyền", async () => {
    const response = await request(app.getHttpServer())
      .get("/driver/trips")
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(200);

    expect(response.body).toMatchObject({
      page: 1,
      limit: 20,
      total: 5,
      totalPages: 1,
    });
    const tripIds = response.body.items.map((trip: { id: string }) => trip.id);
    expect(tripIds).toEqual([
      ids.dispatched,
      ids.inProgress,
      ids.completed,
      ids.cancelled,
      ids.multiAssignment,
    ]);
    expect(new Set(tripIds).size).toBe(tripIds.length);
    expect(tripIds).not.toEqual(
      expect.arrayContaining([
        ids.planned,
        ids.draft,
        ids.otherDriver,
        ids.inactiveAssignment,
      ]),
    );
  });

  it("lọc status và pagination chỉ tính Trip owned", async () => {
    const filtered = await request(app.getHttpServer())
      .get("/driver/trips?status=DISPATCHED&page=2&limit=1")
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(200);
    expect(filtered.body).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(filtered.body.items[0].id).toBe(ids.multiAssignment);
  });

  it("assignment không PRIMARY vẫn cấp quyền đọc khi status ASSIGNED", async () => {
    const response = await request(app.getHttpServer())
      .get(`/driver/trips/${ids.multiAssignment}`)
      .set("Authorization", bearer(tokens["driver-b"]))
      .expect(200);

    expect(response.body).toMatchObject({
      id: ids.multiAssignment,
      assignment: { role: "RELIEF", status: "ASSIGNED" },
    });
  });

  it.each([
    "?status=DRAFT",
    "?status=PLANNED",
    "?status=UNKNOWN",
    "?page=0",
    "?page=1.5",
    "?limit=0",
    "?limit=101",
    "?driverId=injected",
    "?branchId=injected",
    "?userId=injected",
  ])("từ chối query không hợp lệ %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/driver/trips${query}`)
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(400);
  });

  it("trả detail stops đúng sequence và package mapping JSON-safe, không lộ nội bộ", async () => {
    const response = await request(app.getHttpServer())
      .get(`/driver/trips/${ids.dispatched}`)
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(200);

    expect(
      response.body.stops.map((stop: { sequence: number }) => stop.sequence),
    ).toEqual([1, 2]);
    expect(response.body.stops[0].tasks[0]).toMatchObject({
      action: TaskAction.LOAD,
      order: { id: expect.any(String), orderNumber: `${prefix}-ORDER` },
      package: {
        id: expect.any(String),
        packageCode: `${prefix}-PKG`,
        weightKg: 12.5,
        lengthCm: 120,
        widthCm: 80,
        heightCm: 60,
        status: PackageStatus.ALLOCATED,
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("Private Customer Name");
    expect(serialized).not.toContain("totalAmount");
    expect(serialized).not.toContain("planningSnapshot");
    expect(serialized).not.toContain("routeGeometry");
    expect(serialized).not.toContain("999999");
  });

  it("trả cùng 404 cho Trip khác Driver, cùng branch, không tồn tại và status chưa publish", async () => {
    for (const tripId of [ids.otherDriver, ids.planned, randomUUID()]) {
      await request(app.getHttpServer())
        .get(`/driver/trips/${tripId}`)
        .set("Authorization", bearer(tokens["driver-a"]))
        .expect(404);
    }
  });

  // Import a terminal snapshot for read-side tests without simulating an invalid completion.
  async function historicalTrip(tripId: string, status: TripStatus, actualEndTime?: Date) {
    const source = await prisma.trip.findUniqueOrThrow({
      where: { id: tripId }, include: { assignments: true, stops: { include: { tasks: true } } },
    });
    return prisma.trip.create({ data: {
      tripNumber: prefix + "-history-" + randomUUID(),
      vehicleId: source.vehicleId, managingBranchId: source.managingBranchId, status, actualEndTime,
      plannedStartTime: source.plannedStartTime, plannedEndTime: source.plannedEndTime,
      assignments: { create: source.assignments.map((assignment) => ({
        driverId: assignment.driverId, status: assignment.status, role: assignment.role,
        startTime: new Date(assignment.startTime.getTime() - 30 * 365 * 86_400_000),
        endTime: new Date(assignment.endTime.getTime() - 30 * 365 * 86_400_000),
      })) },
      stops: { create: source.stops.map((stop) => ({
        sequence: stop.sequence, address: stop.address, stopType: stop.stopType,
        latitude: stop.latitude, longitude: stop.longitude, contactName: stop.contactName,
        contactPhone: stop.contactPhone, tasks: { create: stop.tasks.map((task) => ({
          orderId: task.orderId, packageId: task.packageId, action: task.action,
          plannedQuantity: task.plannedQuantity, actualQuantity: task.action === TaskAction.LOAD ? 1 : null,
        })) },
      })) },
    } });
  }

  it("M5.8.1 giữ contact active cho PRIMARY/RELIEF và che ở response terminal mà không sửa số gốc", async () => {
    const tripId = ids.multiAssignment;
    const phone = "+12025550151";
    const stop = await prisma.tripStop.create({
      data: {
        tripId, sequence: 1, stopType: StopType.PICKUP,
        address: "QA Pickup", latitude: 10, longitude: 106,
        contactName: "QA Sender", contactPhone: phone,
      },
    });
    try {
      for (const status of [TripStatus.DISPATCHED, TripStatus.IN_PROGRESS, TripStatus.COMPLETED, TripStatus.CANCELLED]) {
        const active = status === TripStatus.DISPATCHED || status === TripStatus.IN_PROGRESS;
        const checkedId = active
          ? (await prisma.trip.update({ where: { id: tripId }, data: { status } })).id
          : (await historicalTrip(tripId, status)).id;
        for (const [label, role] of [["driver-a", "PRIMARY"], ["driver-b", "RELIEF"]]) {
          const result = await request(app.getHttpServer())
            .get(`/driver/trips/${checkedId}`)
            .set("Authorization", bearer(tokens[label]))
            .expect(200);
          expect(result.body).toMatchObject({
            status, assignment: { role, status: "ASSIGNED" },
            stops: [{ contactName: "QA Sender", address: "QA Pickup", contactPhone: active ? phone : null }],
          });
          if (!active) expect(result.text).not.toContain(phone);
        }
        if (!active) await prisma.trip.delete({ where: { id: checkedId } });
      }
      await expect(prisma.tripStop.findUnique({ where: { id: stop.id } }))
        .resolves.toMatchObject({ contactPhone: phone });
    } finally {
      await prisma.tripStop.delete({ where: { id: stop.id } });
      await prisma.trip.update({ where: { id: tripId }, data: { status: TripStatus.DISPATCHED } });
    }
  });

  it("DRIVER thiếu profile trả DRIVER_PROFILE_NOT_FOUND", async () => {
    await request(app.getHttpServer())
      .get("/driver/trips")
      .set("Authorization", bearer(tokens["driver-missing"]))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("DRIVER_PROFILE_NOT_FOUND"),
      );
  });

  it("JWT thiếu/sai và User inactive bị chặn", async () => {
    await request(app.getHttpServer()).get("/driver/trips").expect(401);
    await request(app.getHttpServer())
      .get("/driver/trips")
      .set("Authorization", "Bearer invalid-token")
      .expect(401);
    await request(app.getHttpServer())
      .get("/driver/trips")
      .set("Authorization", bearer(tokens["driver-inactive"]))
      .expect(401);
  });

  it.each(["admin", "dispatcher", "staff", "customer"])(
    "chặn role %s khỏi Driver endpoint",
    async (label) => {
      await request(app.getHttpServer())
        .get("/driver/trips")
        .set("Authorization", bearer(tokens[label]))
        .expect(403);
    },
  );

  it("DRIVER không còn gọi generic load-plan; ADMIN/DISPATCHER vẫn gọi được", async () => {
    await request(app.getHttpServer())
      .get(`/trips/${ids.dispatched}/load-plan`)
      .set("Authorization", bearer(tokens["driver-a"]))
      .expect(403);
    for (const role of ["admin", "dispatcher"]) {
      await request(app.getHttpServer())
        .get(`/trips/${ids.dispatched}/load-plan`)
        .set("Authorization", bearer(tokens[role]))
        .expect(200)
        .expect({ id: "admin-load-plan" });
    }
  });

  const calendar = (from: string, to: string, label = "driver-a") =>
    request(app.getHttpServer()).get("/driver/trips").query({ from, to })
      .set("Authorization", bearer(tokens[label]));
  const history = (label = "driver-a", query = {}) =>
    request(app.getHttpServer()).get("/driver/trips/history")
      .query({ from: "2026-12-01T00:00:00+07:00", to: "2027-01-01T00:00:00+07:00", ...query })
      .set("Authorization", bearer(tokens[label]));

  it("M5.3 selects only overlapping assignments, with exact half-open offset boundaries and RELIEF", async () => {
    const from = "2026-12-01T16:00:00+07:00";
    const to = "2026-12-02T15:00:00+07:00";
    await calendar(from, to).expect(200).expect(({ body }) => expect(body.items).toEqual([]));
    await calendar("2026-12-09T15:30:00+07:00", "2026-12-09T16:30:00+07:00", "driver-b")
      .expect(200).expect(({ body }) => {
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
          id: ids.multiAssignment, assignment: { role: "RELIEF" },
          calendarAssignments: [{ role: "RELIEF" }],
        });
      });
    await calendar("2026-12-01T08:00:00Z", "2026-12-01T09:00:00Z", "driver-b")
      .expect(200).expect(({ body }) => expect(body.items).toEqual([]));
  });

  it("M5.3 keeps one Trip for multiple matching assignments and includes an overnight interval", async () => {
    const extra = await prisma.driverAssignment.create({
      data: { tripId: ids.dispatched, driverId: ids.driverA, role: "PRIMARY", status: "ASSIGNED",
        startTime: new Date("2026-12-13T16:00:00Z"), endTime: new Date("2026-12-13T20:00:00Z") },
    });
    try {
      await calendar("2026-12-13T00:00:00+07:00", "2026-12-14T00:00:00+07:00").expect(200)
        .expect(({ body }) => expect(body.items.map((trip: { id: string }) => trip.id)).toEqual([ids.dispatched]));
      await calendar("2026-12-14T00:00:00+07:00", "2026-12-15T00:00:00+07:00").expect(200)
        .expect(({ body }) => expect(body.items.map((trip: { id: string }) => trip.id)).toEqual([ids.dispatched]));
      await calendar("2026-12-01T00:00:00Z", "2026-12-15T00:00:00Z").expect(200)
        .expect(({ body }) => {
          expect(body.items.filter((trip: { id: string }) => trip.id === ids.dispatched)).toHaveLength(1);
          expect(body.items.find((trip: { id: string }) => trip.id === ids.dispatched).calendarAssignments)
            .toHaveLength(2);
        });
    } finally {
      await prisma.driverAssignment.delete({ where: { id: extra.id } });
    }
    const assignmentColumns = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'driver_assignments'
        AND column_name IN ('startTime', 'endTime')
    `;
    expect(assignmentColumns.map((column) => column.is_nullable)).toEqual(["NO", "NO"]);
  });

  it("M5.3 validates pair, offset, dates, limits and cursor without dynamic route collisions", async () => {
    const server = app.getHttpServer();
    const token = bearer(tokens["driver-a"]);
    await request(server).get("/driver/trips?from=2026-12-01T00:00:00Z")
      .set("Authorization", token).expect(400);
    await calendar("2026-12-01T00:00:00", "2026-12-02T00:00:00Z").expect(400);
    await calendar("2026-12-01T00:00:00Z", "2027-02-01T00:00:00Z").expect(400);
    await calendar("2026-02-29T00:00:00Z", "2026-03-02T00:00:00Z").expect(400);
    await history("driver-a", { to: "2027-05-01T00:00:00Z" }).expect(400);
    await history("driver-a", { status: "DISPATCHED" }).expect(400);
    await history("driver-a", { cursor: "invalid" }).expect(400);
    await history("driver-a", { limit: 101 }).expect(400);
    await history().expect(200);
  });

  it("M5.3 protects history from other owners, revoked assignments and invalid sessions", async () => {
    await history("driver-b").expect(200).expect({ items: [], nextCursor: null });
    await history("driver-missing").expect(409);
    await history("driver-inactive").expect(401);
    await history("dispatcher").expect(403);
    const where = { tripId: ids.cancelled, driverId: ids.driverA };
    await prisma.driverAssignment.updateMany({ where, data: { status: "CANCELLED" } });
    try {
      await history().expect(200).expect(({ body }) => {
        expect(body.items.map((trip: { tripId: string }) => trip.tripId)).toEqual([ids.completed]);
      });
      await request(app.getHttpServer()).get(`/driver/trips/${ids.cancelled}`)
        .set("Authorization", bearer(tokens["driver-a"])).expect(404);
    } finally {
      await prisma.driverAssignment.updateMany({ where, data: { status: "ASSIGNED" } });
    }
  });

  it("M5.3 uses planned fallback, actual end and a no-duplicate cursor across timestamp ties", async () => {
    const first = await history().expect(200);
    expect(first.body.items).toMatchObject([
      { tripId: ids.cancelled, dateBasis: "PLANNED_START" },
      { tripId: ids.completed, dateBasis: "PLANNED_START" },
    ]);
    const cancelled = await prisma.trip.findUniqueOrThrow({ where: { id: ids.cancelled } });
    const clone = await historicalTrip(ids.completed, TripStatus.COMPLETED, cancelled.plannedStartTime);
    const original = { tripId: ids.completed, driverId: ids.driverA };
    await prisma.driverAssignment.updateMany({ where: original, data: { status: "CANCELLED" } });
    try {
      const { body: page1 } = await history("driver-a", { limit: 1 }).expect(200);
      const { body: page2 } = await history("driver-a", { limit: 1, cursor: page1.nextCursor }).expect(200);
      const items = [...page1.items, ...page2.items];
      expect(items.map((item) => item.tripId)).toEqual([ids.cancelled, clone.id].sort().reverse());
      expect(items.find((item) => item.tripId === clone.id)).toMatchObject({
        dateBasis: "ACTUAL_END", loadedQuantity: null, unloadedQuantity: null,
        distinctPackageCount: 0, loadTaskCount: 0, unloadTaskCount: 0,
      });
      expect(JSON.stringify(items)).not.toMatch(/contactPhone|recipientName|storageKey|routeGeometry|notes|driverId/);
      expect(page2.nextCursor).toBeNull();
      await history("driver-a", { from: "2026-12-04T08:00:00Z", to: "2026-12-04T09:00:00Z" })
        .expect(200).expect(({ body }) => expect(body.items).toHaveLength(2));
    } finally {
      await prisma.trip.delete({ where: { id: clone.id } });
      await prisma.driverAssignment.updateMany({ where: original, data: { status: "ASSIGNED" } });
    }
  });

  it("M5.3 reads RELIEF history and separates reported quantities, tasks and unique packages", async () => {
    await prisma.trip.update({ where: { id: ids.multiAssignment }, data: { status: "CANCELLED" } });
    const clone = await historicalTrip(ids.dispatched, TripStatus.COMPLETED);
    try {
      await history("driver-b", { status: "CANCELLED" }).expect(200).expect(({ body }) =>
        expect(body.items.map((item: { tripId: string }) => item.tripId)).toEqual([ids.multiAssignment]));
      await history("driver-a", { status: "COMPLETED" }).expect(200).expect(({ body }) => {
        expect(body.items.find((item: { tripId: string }) => item.tripId === clone.id)).toMatchObject({
          loadTaskCount: 1, unloadTaskCount: 1, distinctPackageCount: 1, loadedQuantity: 1, unloadedQuantity: null,
        });
      });
    } finally {
      await prisma.trip.delete({ where: { id: clone.id } });
      await prisma.trip.update({ where: { id: ids.multiAssignment }, data: { status: "DISPATCHED" } });
    }
  });

  it("M5.3 PostgreSQL plan applies history page limit before summary aggregates", async () => {
    const query = driverTripHistoryQuery(ids.driverA, {
      start: new Date("2026-12-01"), end: new Date("2027-01-01"),
    }, { from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z", limit: 20 });
    const plan = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
    const text = JSON.stringify(plan);
    expect(text).toContain('"Node Type":"Limit"');
    expect(text).toContain('"Node Type":"Aggregate"');
    expect(text).toContain("driver_assignments");
  });

  const activityRange = { from: "2027-03-01T00:00:00+07:00", to: "2027-03-02T00:00:00+07:00" };
  function activity(label = "driver-a", query: Record<string, string> = activityRange) {
    return request(app.getHttpServer()).get("/driver/me/activity-summary")
      .query(query).set("Authorization", bearer(tokens[label]));
  }

  it("M5.4 attributes business-time evidence, delivery outcomes and coverage by actor", async () => {
    const [a, b] = await Promise.all([ids.driverA, ids.driverB].map((id) =>
      prisma.driver.findUniqueOrThrow({ where: { id }, select: { userId: true } })));
    const actorA = a.userId;
    const actorB = b.userId;
    if (!actorA || !actorB) throw new Error("M5.4 fixture must have linked users");
    const start = new Date(activityRange.from);
    const end = new Date(activityRange.to);
    const inside = new Date(start.getTime() + 60_000);
    const receivedLate = new Date(end.getTime() + 60_000);
    const tripId = ids.multiAssignment;
    const stop = (sequence: number, stopType: StopType) => prisma.tripStop.create({
      data: { tripId, sequence, stopType, address: "Private activity fixture", latitude: 10, longitude: 106 },
    });
    const [pickup, delivery, depot, missing, orphan] = await Promise.all([
      stop(11, StopType.PICKUP), stop(12, StopType.DELIVERY), stop(13, StopType.DEPOT_START),
      stop(14, StopType.DELIVERY), stop(15, StopType.DELIVERY),
    ]);
    const existing = await prisma.order.findFirstOrThrow({ where: { orderNumber: { startsWith: prefix } } });
    const secondOrder = await prisma.order.create({ data: {
      orderNumber: `${prefix}-ACTIVITY-SECOND`, customerId: existing.customerId,
      branchId: existing.branchId, totalAmount: 0,
    } });
    await prisma.stopTask.createMany({ data: [existing, secondOrder].map((order) => ({
      tripStopId: delivery.id, orderId: order.id, action: TaskAction.UNLOAD, plannedQuantity: 1,
    })) });
    function log(actorUserId: string, eventType: string, tripStopId: string | null,
      at = inside, id = randomUUID(), eventTripId = tripId) {
      return prisma.executionEvent.create({ data: {
        actorUserId, eventType, tripId: eventTripId, tripStopId, occurredAt: at, receivedAt: receivedLate, commandId: id,
      } });
    }
    async function attempt(actorUserId: string, attemptNumber: number, result: string, id: string, withEvent = true) {
      const commandId = randomUUID();
      const row = await prisma.deliveryAttempt.create({ data: {
        tripStopId: id, attemptNumber, occurredAt: inside, commandId, result, recipientName: "Private Recipient KPI",
      } });
      await prisma.processedCommand.create({ data: {
        id: commandId, actorUserId, commandType: command.COMPLETE_STOP, status: "COMPLETED",
        idempotencyKey: randomUUID(), requestHash: "qa", result: {
          tripId, stop: { id }, deliveryAttempt: { id: row.id, result },
        },
      } });
      if (withEvent) await log(actorUserId, result === "FAILED" ? event.DELIVERY_FAILED : event.DELIVERY_COMPLETED,
        id, inside, commandId);
    }
    await log(actorA, event.PICKUP_COMPLETED, pickup.id, start);
    await log(actorA, event.PICKUP_COMPLETED, pickup.id);
    await log(actorA, event.DEPOT_STOP_COMPLETED, depot.id);
    await log(actorA, event.ARRIVE_STOP, missing.id);
    await log(actorA, event.COMPLETE_TRIP, null, inside, randomUUID(), ids.completed);
    await log(actorA, event.COMPLETE_TRIP, null, inside, randomUUID(), ids.completed);
    await log(actorA, event.COMPLETE_TRIP, null, inside, randomUUID(), ids.cancelled);
    await log(actorA, event.COMPLETE_TRIP, null, end, randomUUID(), ids.inProgress);
    await attempt(actorA, 1, "SUCCESS", delivery.id);
    await attempt(actorA, 2, "PARTIAL", delivery.id);
    await attempt(actorB, 3, "FAILED", delivery.id);
    await log(actorA, event.DELIVERY_FAILED, missing.id);
    await attempt(actorA, 1, "SUCCESS", orphan.id, false);
    await prisma.deliveryAttempt.create({ data: {
      tripStopId: orphan.id, attemptNumber: 2, occurredAt: inside,
      commandId: randomUUID(), result: "SUCCESS",
    } });

    const { body } = await activity().expect(200);
    expect(body).toEqual({
      range: { from: start.toISOString(), to: end.toISOString() }, timeZone: "Asia/Ho_Chi_Minh",
      asOf: expect.any(String), completedTripCount: 1, processedStopCount: 3, depotStopCount: 1,
      deliveries: { success: 1, partial: 1, failed: 0, unclassified: 1 }, coverage: { status: "PARTIAL" },
    });
    expect(JSON.stringify(body)).not.toMatch(/Private|commandId|username|actorUserId/);
    await activity("driver-b").expect(200).expect(({ body }) => expect(body).toMatchObject({
      completedTripCount: 0, processedStopCount: 1, depotStopCount: 0,
      deliveries: { success: 0, partial: 0, failed: 1, unclassified: 0 }, coverage: { status: "COMPLETE" },
    }));
    const query = driverActivityQuery(actorA, start, end);
    const plan = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
    expect(JSON.stringify(plan)).toEqual(expect.stringContaining('"Node Type":"Aggregate"'));
  });

  it("M5.4 rejects unsafe scope and invalid ranges and distinguishes no evidence", async () => {
    await activity("driver-b", { from: "2027-01-01T00:00:00Z", to: "2027-01-02T00:00:00Z" })
      .expect(200).expect(({ body }) => expect(body).toMatchObject({
        completedTripCount: null, processedStopCount: null, depotStopCount: null,
        deliveries: null, coverage: { status: "NO_DATA" },
      }));
    await activity("customer").expect(403);
    await activity("driver-inactive").expect(401);
    await activity("driver-missing").expect(409);
    await request(app.getHttpServer()).get("/driver/me/activity-summary").query(activityRange).expect(401);
    await activity("driver-a", { ...activityRange, driverId: ids.driverB }).expect(400);
    await activity("driver-a", { from: activityRange.from }).expect(400);
    await activity("driver-a", { from: activityRange.from, to: activityRange.from }).expect(400);
    await activity("driver-a", { from: activityRange.from, to: "2027-07-02T00:00:00Z" }).expect(400);
    await activity("driver-a", { ...activityRange, from: "2027-03-01T00:00:00" }).expect(400);
  });
});
