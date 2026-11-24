import "dotenv/config";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { Role, TripStatus } from "@prisma/client";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require("supertest");
import { AuthModule } from "../../src/auth/auth.module";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverGpsController } from "../../src/trips/driver-gps.controller";
import { DriverGpsService } from "../../src/trips/driver-gps.service";
import { TripTrackingController } from "../../src/trips/trip-tracking.controller";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("M3.6B Driver GPS (PostgreSQL)", () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m36b-${suffix}`;
  const users: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const drivers: Record<string, string> = {};
  let branchA: string;
  let branchB: string;
  let vehicleId: string;
  let tripSequence = 0;

  const bearer = (token: string) => `Bearer ${token}`;
  const gpsPayload = (overrides?: {
    deviceCode?: string;
    deviceSessionId?: string;
    measuredAt?: string;
    sequence?: number;
  }) => ({
    deviceCode: overrides?.deviceCode ?? randomUUID(),
    deviceSessionId: overrides?.deviceSessionId ?? randomUUID(),
    points: [
      {
        sequence: overrides?.sequence ?? 1,
        latitude: 10.8231,
        longitude: 106.6297,
        accuracyM: 8.5,
        speedMps: 10,
        headingDeg: 90,
        measuredAt:
          overrides?.measuredAt ?? new Date(Date.now() - 5_000).toISOString(),
      },
    ],
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "m36b-driver-gps-test-secret-at-least-32chars";
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
      ],
      controllers: [DriverGpsController, TripTrackingController],
      providers: [DriverGpsService],
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

    const [createdBranchA, createdBranchB] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `${prefix}-A`,
          name: "M3.6B Branch A",
          address: "Test A",
          latitude: 10,
          longitude: 106,
        },
      }),
      prisma.branch.create({
        data: {
          code: `${prefix}-B`,
          name: "M3.6B Branch B",
          address: "Test B",
          latitude: 11,
          longitude: 107,
        },
      }),
    ]);
    branchA = createdBranchA.id;
    branchB = createdBranchB.id;

    for (const input of [
      { label: "primary", role: Role.DRIVER, branchId: branchA },
      { label: "relief", role: Role.DRIVER, branchId: branchA },
      { label: "other", role: Role.DRIVER, branchId: branchA },
      { label: "missing", role: Role.DRIVER, branchId: branchA },
      { label: "admin", role: Role.ADMIN, branchId: null },
      { label: "dispatcher-a", role: Role.DISPATCHER, branchId: branchA },
      { label: "dispatcher-b", role: Role.DISPATCHER, branchId: branchB },
      { label: "staff", role: Role.STAFF, branchId: branchA },
      { label: "customer", role: Role.CUSTOMER, branchId: null },
    ]) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: "integration-test-not-a-real-credential",
          fullName: `M3.6B ${input.label}`,
          role: input.role,
          branchId: input.branchId,
          active: true,
        },
      });
      users[input.label] = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      if (input.role === Role.DRIVER && input.label !== "missing") {
        const driver = await prisma.driver.create({
          data: {
            userId: user.id,
            fullName: `Driver ${input.label}`,
            citizenId: `${prefix}-CID-${input.label}`,
            phone: `${prefix}-PHONE-${input.label}`,
            licenseNumber: `${prefix}-LIC-${input.label}`,
            licenseClass: "C",
            licenseExpiry: new Date("2035-01-01"),
            homeBranchId: branchA,
          },
        });
        drivers[input.label] = driver.id;
      }
    }

    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE`,
        model: "GPS Truck",
        vehicleType: "Truck",
        homeBranchId: branchA,
        payloadCapacityKg: 5000,
        volumeCapacityM3: 25,
        lengthCm: 600,
        widthCm: 240,
        heightCm: 250,
      },
    });
    vehicleId = vehicle.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const trips = await prisma.trip.findMany({
      where: { tripNumber: { startsWith: prefix } },
      select: { id: true },
    });
    const tripIds = trips.map((trip) => trip.id);
    await prisma.gpsEvent.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma.driver.deleteMany({
      where: { id: { in: Object.values(drivers) } },
    });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await prisma.branch.deleteMany({ where: { id: { in: [branchA, branchB] } } });
    await app.close();
  });

  async function createTrip(options?: {
    status?: TripStatus;
    driverId?: string;
    assignmentRole?: string;
    assignmentStatus?: string;
    managingBranchId?: string;
    actualStartTime?: Date | null;
    actualEndTime?: Date | null;
  }) {
    tripSequence += 1;
    const now = new Date();
    const assignmentStart = new Date(
      Date.UTC(2030, 0, 1, tripSequence * 3),
    );
    const assignmentEnd = new Date(assignmentStart.getTime() + 2 * 60 * 60_000);
    return prisma.trip.create({
      data: {
        tripNumber: `${prefix}-TRIP-${tripSequence}`,
        vehicleId,
        managingBranchId: options?.managingBranchId ?? branchA,
        status: options?.status ?? TripStatus.IN_PROGRESS,
        plannedStartTime: assignmentStart,
        plannedEndTime: assignmentEnd,
        actualStartTime:
          options?.actualStartTime === undefined
            ? new Date(now.getTime() - 30 * 60_000)
            : options.actualStartTime,
        actualEndTime: options?.actualEndTime,
        assignments: {
          create: {
            driverId: options?.driverId ?? drivers.primary,
            startTime: assignmentStart,
            endTime: assignmentEnd,
            role: options?.assignmentRole ?? "PRIMARY",
            status: options?.assignmentStatus ?? "ASSIGNED",
          },
        },
      },
    });
  }

  it("ingest batch hợp lệ, derive relation và map speed sang km/h", async () => {
    const trip = await createTrip();
    const payload = gpsPayload();
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          tripId: trip.id,
          deviceSessionId: payload.deviceSessionId,
          acceptedCount: 1,
          duplicateCount: 0,
        });
      });

    const event = await prisma.gpsEvent.findFirstOrThrow({
      where: { tripId: trip.id },
    });
    expect(event).toMatchObject({
      driverId: drivers.primary,
      vehicleId,
      deviceCode: payload.deviceCode,
      deviceSessionId: payload.deviceSessionId,
    });
    expect(Number(event.speedKph)).toBeCloseTo(36);
    expect(Number(event.headingDegrees)).toBe(90);
  });

  it("retry và hai request concurrent được dedupe bởi PostgreSQL unique", async () => {
    const trip = await createTrip();
    const payload = gpsPayload();
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ acceptedCount: 0, duplicateCount: 1 });
      });

    const conflictingRetry = structuredClone(payload);
    conflictingRetry.points[0].latitude = 12;
    conflictingRetry.points[0].longitude = 108;
    conflictingRetry.points[0].measuredAt = new Date().toISOString();
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(conflictingRetry)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ acceptedCount: 0, duplicateCount: 1 });
      });
    const vehicleAfterConflictingRetry = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });
    expect(vehicleAfterConflictingRetry.currentLatitude).toBeCloseTo(10.8231);

    const concurrentTrip = await createTrip();
    const concurrentPayload = gpsPayload();
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/driver/trips/${concurrentTrip.id}/gps`)
        .set("Authorization", bearer(tokens.primary))
        .send(concurrentPayload),
      request(app.getHttpServer())
        .post(`/driver/trips/${concurrentTrip.id}/gps`)
        .set("Authorization", bearer(tokens.primary))
        .send(concurrentPayload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(
      responses
        .map((response) => response.body.acceptedCount)
        .sort((left, right) => left - right),
    ).toEqual([0, 1]);
    await expect(
      prisma.gpsEvent.count({
        where: {
          deviceCode: concurrentPayload.deviceCode,
          deviceSessionId: concurrentPayload.deviceSessionId,
          sequence: 1n,
        },
      }),
    ).resolves.toBe(1);
  });

  it("session không được tái sử dụng cho Trip khác", async () => {
    const firstTrip = await createTrip();
    const secondTrip = await createTrip();
    const payload = gpsPayload();
    await request(app.getHttpServer())
      .post(`/driver/trips/${firstTrip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/driver/trips/${secondTrip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send({ ...payload, points: [{ ...payload.points[0], sequence: 2 }] })
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("TRACKING_SESSION_CONFLICT"),
      );
  });

  it("authorization: RELIEF 409, Driver khác 404, profile thiếu 409", async () => {
    const reliefTrip = await createTrip({
      driverId: drivers.relief,
      assignmentRole: "RELIEF",
    });
    await request(app.getHttpServer())
      .post(`/driver/trips/${reliefTrip.id}/gps`)
      .set("Authorization", bearer(tokens.relief))
      .send(gpsPayload())
      .expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe("DRIVER_NOT_PRIMARY"));

    const primaryTrip = await createTrip();
    await request(app.getHttpServer())
      .post(`/driver/trips/${primaryTrip.id}/gps`)
      .set("Authorization", bearer(tokens.other))
      .send(gpsPayload())
      .expect(404);
    await request(app.getHttpServer())
      .post(`/driver/trips/${primaryTrip.id}/gps`)
      .set("Authorization", bearer(tokens.missing))
      .send(gpsPayload())
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("DRIVER_PROFILE_NOT_FOUND"),
      );
  });

  it("ingest chặn role khác và JWT thiếu", async () => {
    const trip = await createTrip();
    for (const label of ["admin", "dispatcher-a", "staff", "customer"]) {
      await request(app.getHttpServer())
        .post(`/driver/trips/${trip.id}/gps`)
        .set("Authorization", bearer(tokens[label]))
        .send(gpsPayload())
        .expect(403);
    }
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .send(gpsPayload())
      .expect(401);
  });

  it("chặn state thường nhưng nhận backlog COMPLETED đúng cửa sổ", async () => {
    const dispatched = await createTrip({ status: TripStatus.DISPATCHED });
    await request(app.getHttpServer())
      .post(`/driver/trips/${dispatched.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(gpsPayload())
      .expect(409);

    const end = new Date(Date.now() - 60_000);
    const start = new Date(end.getTime() - 10 * 60_000);
    const completed = await createTrip({
      status: TripStatus.COMPLETED,
      actualStartTime: start,
      actualEndTime: end,
    });
    await request(app.getHttpServer())
      .post(`/driver/trips/${completed.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(gpsPayload({ measuredAt: new Date(end.getTime() - 30_000).toISOString() }))
      .expect(201);

    const expiredEnd = new Date(Date.now() - 31 * 60_000);
    const expired = await createTrip({
      status: TripStatus.COMPLETED,
      actualStartTime: new Date(expiredEnd.getTime() - 10 * 60_000),
      actualEndTime: expiredEnd,
    });
    await request(app.getHttpServer())
      .post(`/driver/trips/${expired.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(
        gpsPayload({
          measuredAt: new Date(expiredEnd.getTime() - 30_000).toISOString(),
        }),
      )
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("GPS_TRACKING_NOT_ALLOWED"),
      );
  });

  it.each([
    ["latitude", (body: ReturnType<typeof gpsPayload>) => (body.points[0].latitude = 91)],
    ["longitude", (body: ReturnType<typeof gpsPayload>) => (body.points[0].longitude = -181)],
    ["accuracy", (body: ReturnType<typeof gpsPayload>) => (body.points[0].accuracyM = -1)],
    ["speed", (body: ReturnType<typeof gpsPayload>) => (body.points[0].speedMps = -1)],
    ["heading", (body: ReturnType<typeof gpsPayload>) => (body.points[0].headingDeg = 360)],
  ])("validation từ chối %s invalid", async (_label, mutate) => {
    const trip = await createTrip();
    const body = gpsPayload();
    mutate(body);
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(body)
      .expect(400);
  });

  it("validation từ chối batch empty, >20, future và field injection", async () => {
    const trip = await createTrip();
    const endpoint = `/driver/trips/${trip.id}/gps`;
    const auth = bearer(tokens.primary);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", auth)
      .send({ ...gpsPayload(), points: [] })
      .expect(400);
    const tooMany = gpsPayload();
    tooMany.points = Array.from({ length: 21 }, (_, index) => ({
      ...tooMany.points[0],
      sequence: index + 1,
    }));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", auth)
      .send(tooMany)
      .expect(400);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", auth)
      .send(gpsPayload({ measuredAt: new Date(Date.now() + 121_000).toISOString() }))
      .expect(400)
      .expect(({ body }) => expect(body.errorCode).toBe("GPS_TIMESTAMP_INVALID"));
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", auth)
      .send({ ...gpsPayload(), driverId: drivers.other })
      .expect(400);
  });

  it("point đến muộn được lưu nhưng không làm Vehicle latest lùi", async () => {
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { currentLatitude: null, currentLongitude: null, lastLocationAt: null },
    });
    const trip = await createTrip();
    const deviceCode = randomUUID();
    const deviceSessionId = randomUUID();
    const newest = new Date(Date.now() - 5_000);
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(
        gpsPayload({
          deviceCode,
          deviceSessionId,
          measuredAt: newest.toISOString(),
          sequence: 2,
        }),
      )
      .expect(201);
    const latePayload = gpsPayload({
      deviceCode,
      deviceSessionId,
      measuredAt: new Date(newest.getTime() - 60_000).toISOString(),
      sequence: 1,
    });
    latePayload.points[0].latitude = 12;
    latePayload.points[0].longitude = 108;
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(latePayload)
      .expect(201);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
    });
    expect(vehicle.lastLocationAt?.toISOString()).toBe(newest.toISOString());
    expect(vehicle.currentLatitude).toBeCloseTo(10.8231);
    expect(await prisma.gpsEvent.count({ where: { tripId: trip.id } })).toBe(2);
  });

  it("latest cho ADMIN/DISPATCHER đúng branch và không lộ session", async () => {
    const trip = await createTrip();
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(gpsPayload())
      .expect(201);
    for (const label of ["admin", "dispatcher-a"]) {
      await request(app.getHttpServer())
        .get(`/trips/${trip.id}/tracking/latest`)
        .set("Authorization", bearer(tokens[label]))
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            tripId: trip.id,
            vehicleId,
            speedKph: 36,
            isStale: false,
          });
          expect(body).not.toHaveProperty("deviceCode");
          expect(body).not.toHaveProperty("deviceSessionId");
        });
    }
    await request(app.getHttpServer())
      .get(`/trips/${trip.id}/tracking/latest`)
      .set("Authorization", bearer(tokens["dispatcher-b"]))
      .expect(403);
  });

  it("latest chặn role khác, trả 404 khi chưa có GPS và đánh dấu stale", async () => {
    const noGpsTrip = await createTrip();
    await request(app.getHttpServer())
      .get(`/trips/${noGpsTrip.id}/tracking/latest`)
      .set("Authorization", bearer(tokens.admin))
      .expect(404)
      .expect(({ body }) => expect(body.errorCode).toBe("GPS_POSITION_NOT_FOUND"));
    for (const label of ["staff", "primary", "customer"]) {
      await request(app.getHttpServer())
        .get(`/trips/${noGpsTrip.id}/tracking/latest`)
        .set("Authorization", bearer(tokens[label]))
        .expect(403);
    }

    const staleTrip = await createTrip();
    await request(app.getHttpServer())
      .post(`/driver/trips/${staleTrip.id}/gps`)
      .set("Authorization", bearer(tokens.primary))
      .send(gpsPayload({ measuredAt: new Date(Date.now() - 121_000).toISOString() }))
      .expect(201);
    await request(app.getHttpServer())
      .get(`/trips/${staleTrip.id}/tracking/latest`)
      .set("Authorization", bearer(tokens.admin))
      .expect(200)
      .expect(({ body }) => expect(body.isStale).toBe(true));
  });
});
