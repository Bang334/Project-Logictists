import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Prisma, Role, TripStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { ROLES_KEY } from "../../src/auth/roles.decorator";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverGpsController } from "../../src/trips/driver-gps.controller";
import { DriverGpsService } from "../../src/trips/driver-gps.service";
import {
  DriverGpsPointDto,
  IngestDriverGpsDto,
} from "../../src/trips/dto/driver-gps.dto";
import { TripTrackingController } from "../../src/trips/trip-tracking.controller";

describe("M3.6B DriverGpsService", () => {
  const tx = {
    driver: { findUnique: jest.fn() },
    trip: { findFirst: jest.fn() },
    gpsEvent: {
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      createMany: jest.fn(),
    },
    vehicle: { updateMany: jest.fn() },
    $executeRaw: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(),
    trip: { findUnique: jest.fn() },
    gpsEvent: { findFirst: jest.fn() },
  };
  const service = new DriverGpsService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    tx.trip.findFirst.mockResolvedValue({
      id: "trip-1",
      status: TripStatus.IN_PROGRESS,
      vehicleId: "vehicle-1",
      actualStartTime: new Date(Date.now() - 60_000),
      actualEndTime: null,
      assignments: [{ role: "PRIMARY" }],
    });
    tx.gpsEvent.findFirst.mockResolvedValue(null);
    tx.gpsEvent.findFirstOrThrow.mockResolvedValue({
      latitude: 10.75,
      longitude: 106.67,
      measuredAt: new Date(Date.now() - 5_000),
    });
    tx.gpsEvent.createMany.mockResolvedValue({ count: 1 });
    tx.vehicle.updateMany.mockResolvedValue({ count: 1 });
  });

  it("khóa endpoint theo đúng role", () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriverGpsController)).toEqual([
      Role.DRIVER,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, TripTrackingController)).toEqual([
      Role.ADMIN,
      Role.DISPATCHER,
    ]);
  });

  it("derive Driver/Vehicle/Trip và đổi m/s sang km/h", async () => {
    const measuredAt = new Date(Date.now() - 5_000).toISOString();
    const dto: IngestDriverGpsDto = {
      deviceCode: randomUUID(),
      deviceSessionId: randomUUID(),
      points: [
        {
          sequence: 1,
          latitude: 10.75,
          longitude: 106.67,
          accuracyM: 8,
          speedMps: 10,
          headingDeg: 90,
          measuredAt,
        },
      ],
    };

    await expect(service.ingest("user-1", "trip-1", dto)).resolves.toMatchObject({
      tripId: "trip-1",
      acceptedCount: 1,
      duplicateCount: 0,
    });
    expect(tx.gpsEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          driverId: "driver-1",
          vehicleId: "vehicle-1",
          tripId: "trip-1",
          speedKph: 36,
          headingDegrees: 90,
        }),
      ],
      skipDuplicates: true,
    });
    expect(tx.vehicle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "vehicle-1" }),
        data: expect.objectContaining({
          currentLatitude: 10.75,
          currentLongitude: 106.67,
        }),
      }),
    );
  });

  it("từ chối session đã gắn với Trip khác", async () => {
    tx.gpsEvent.findFirst.mockResolvedValue({
      deviceCode: "other-device",
      driverId: "driver-1",
      tripId: "trip-other",
      vehicleId: "vehicle-1",
    });
    const dto: IngestDriverGpsDto = {
      deviceCode: randomUUID(),
      deviceSessionId: randomUUID(),
      points: [
        {
          sequence: 1,
          latitude: 10,
          longitude: 106,
          measuredAt: new Date().toISOString(),
        },
      ],
    };
    await expect(service.ingest("user-1", "trip-1", dto)).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "TRACKING_SESSION_CONFLICT",
      }),
    });
  });

  it("latest dùng allowlist và tính stale theo measuredAt", async () => {
    prisma.trip.findUnique.mockResolvedValue({
      id: "trip-1",
      vehicleId: "vehicle-1",
      managingBranchId: "branch-1",
      vehicle: { homeBranchId: "branch-2" },
    });
    prisma.gpsEvent.findFirst.mockResolvedValue({
      latitude: new Prisma.Decimal("10.1234567"),
      longitude: new Prisma.Decimal("106.7654321"),
      accuracyM: new Prisma.Decimal("12.50"),
      speedKph: new Prisma.Decimal("29.52"),
      headingDegrees: new Prisma.Decimal("180"),
      measuredAt: new Date(Date.now() - 121_000),
      receivedAt: new Date(),
    });
    const result = await service.getLatest("trip-1", {
      role: Role.DISPATCHER,
      branchId: "branch-1",
    });
    expect(result).toMatchObject({
      tripId: "trip-1",
      vehicleId: "vehicle-1",
      latitude: 10.1234567,
      longitude: 106.7654321,
      isStale: true,
    });
    expect(result).not.toHaveProperty("deviceCode");
    expect(result).not.toHaveProperty("deviceSessionId");
  });
});

describe("M3.6B GPS DTO validation", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const transform = (value: object) =>
    pipe.transform(value, { type: "body", metatype: IngestDriverGpsDto });

  const valid = () => ({
    deviceCode: randomUUID(),
    deviceSessionId: randomUUID(),
    points: [
      {
        sequence: 1,
        latitude: 10,
        longitude: 106,
        accuracyM: 5,
        speedMps: 4,
        headingDeg: 359.9,
        measuredAt: new Date().toISOString(),
      },
    ],
  });

  it("nhận batch hợp lệ và transform nested DTO", async () => {
    const result = await transform(valid());
    expect(result).toBeInstanceOf(IngestDriverGpsDto);
    expect(result.points[0]).toBeInstanceOf(DriverGpsPointDto);
  });

  it.each([
    ["batch rỗng", (body: ReturnType<typeof valid>) => (body.points = [])],
    [
      "batch quá 20",
      (body: ReturnType<typeof valid>) =>
        (body.points = Array.from({ length: 21 }, (_, index) => ({
          ...body.points[0],
          sequence: index + 1,
        }))),
    ],
    ["sequence 0", (body: ReturnType<typeof valid>) => (body.points[0].sequence = 0)],
    ["latitude", (body: ReturnType<typeof valid>) => (body.points[0].latitude = 91)],
    ["longitude", (body: ReturnType<typeof valid>) => (body.points[0].longitude = -181)],
    ["accuracy", (body: ReturnType<typeof valid>) => (body.points[0].accuracyM = -1)],
    ["speed", (body: ReturnType<typeof valid>) => (body.points[0].speedMps = -1)],
    ["heading", (body: ReturnType<typeof valid>) => (body.points[0].headingDeg = 360)],
    ["NaN", (body: ReturnType<typeof valid>) => (body.points[0].latitude = Number.NaN)],
    ["Infinity", (body: ReturnType<typeof valid>) => (body.points[0].speedMps = Infinity)],
  ])("từ chối %s", async (_label, mutate) => {
    const body = valid();
    mutate(body);
    await expect(transform(body)).rejects.toBeDefined();
  });

  it("từ chối field định danh do client chèn", async () => {
    await expect(transform({ ...valid(), driverId: randomUUID() })).rejects.toBeDefined();
  });

  it("class-validator trực tiếp cũng từ chối số không hữu hạn", async () => {
    const point = plainToInstance(DriverGpsPointDto, {
      ...valid().points[0],
      longitude: Number.NEGATIVE_INFINITY,
    });
    expect(await validate(point)).not.toHaveLength(0);
  });
});
