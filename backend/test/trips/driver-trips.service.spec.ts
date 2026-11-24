import "reflect-metadata";
import { NotFoundException, ValidationPipe } from "@nestjs/common";
import { Role, TripStatus } from "@prisma/client";
import { ROLES_KEY } from "../../src/auth/roles.decorator";
import { DriverTripsController } from "../../src/trips/driver-trips.controller";
import { DriverTripsService } from "../../src/trips/driver-trips.service";
import { QueryDriverTripsDto } from "../../src/trips/dto/query-driver-trips.dto";
import { PrismaService } from "../../src/prisma/prisma.service";

describe("M3.1 DriverTripsService", () => {
  const prisma = {
    driver: { findUnique: jest.fn() },
    trip: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new DriverTripsService(prisma as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it("Driver endpoint chỉ cho role DRIVER", () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriverTripsController)).toEqual([
      Role.DRIVER,
    ]);
  });

  it("trả DRIVER_PROFILE_NOT_FOUND khi User chưa liên kết Driver", async () => {
    prisma.driver.findUnique.mockResolvedValue(null);

    await expect(
      service.findAllForUser("user-missing", { page: 1, limit: 20 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "DRIVER_PROFILE_NOT_FOUND",
      }),
    });
  });

  it("lọc ownership và assignment ASSIGNED ngay trong Prisma query", async () => {
    prisma.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    prisma.trip.findMany.mockReturnValue("find-many-query");
    prisma.trip.count.mockReturnValue("count-query");
    prisma.$transaction.mockResolvedValue([[], 0]);

    await expect(
      service.findAllForUser("user-1", { page: 2, limit: 10 }),
    ).resolves.toEqual({
      items: [],
      page: 2,
      limit: 10,
      total: 0,
      totalPages: 0,
    });

    expect(prisma.trip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: [
              TripStatus.DISPATCHED,
              TripStatus.IN_PROGRESS,
              TripStatus.COMPLETED,
              TripStatus.CANCELLED,
            ],
          },
          assignments: {
            some: { driverId: "driver-1", status: "ASSIGNED" },
          },
        }),
        skip: 10,
        take: 10,
      }),
    );
  });

  it("detail dùng một DB query kết hợp id, visible status và assignment ownership", async () => {
    prisma.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    prisma.trip.findFirst.mockResolvedValue(null);

    await expect(
      service.findOneForUser("user-1", "trip-other"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.trip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "trip-other",
          status: {
            in: [
              TripStatus.DISPATCHED,
              TripStatus.IN_PROGRESS,
              TripStatus.COMPLETED,
              TripStatus.CANCELLED,
            ],
          },
          assignments: {
            some: { driverId: "driver-1", status: "ASSIGNED" },
          },
        },
      }),
    );
  });

  it.each([
    [TripStatus.DISPATCHED, "+12025550151"],
    [TripStatus.IN_PROGRESS, "+12025550151"],
    [TripStatus.COMPLETED, null],
    [TripStatus.CANCELLED, null],
  ])("ánh xạ contactPhone trong detail ở %s", async (status, expectedPhone) => {
    prisma.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    prisma.trip.findFirst.mockResolvedValue({
      status,
      assignments: [{ role: "PRIMARY", status: "ASSIGNED" }],
      _count: { stops: 2 },
      stops: [
        { contactName: "QA Sender", address: "QA Pickup", contactPhone: "+12025550151", tasks: [], deliveryAttempts: [] },
        { contactName: null, address: "QA Depot", contactPhone: null, tasks: [], deliveryAttempts: [] },
      ],
    });

    await expect(service.findOneForUser("user-1", "trip-1")).resolves.toMatchObject({
      stops: [
        { contactName: "QA Sender", address: "QA Pickup", contactPhone: expectedPhone },
        { contactName: null, address: "QA Depot", contactPhone: null },
      ],
    });
  });
});

describe("QueryDriverTripsDto validation", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });

  const transform = (value: object) =>
    pipe.transform(value, { type: "query", metatype: QueryDriverTripsDto });

  it("áp dụng page=1 và limit=20 mặc định", async () => {
    await expect(transform({})).resolves.toMatchObject({ page: 1, limit: 20 });
  });

  it.each([
    { status: TripStatus.DRAFT },
    { status: TripStatus.PLANNED },
    { status: "UNKNOWN" },
    { page: "0" },
    { page: "1.5" },
    { limit: "0" },
    { limit: "101" },
    { driverId: "injected" },
    { branchId: "injected" },
  ])("từ chối query không hợp lệ %#", async (query) => {
    await expect(transform(query)).rejects.toBeDefined();
  });

  it("nhận status hiển thị và chuyển đổi số phân trang", async () => {
    await expect(
      transform({ status: TripStatus.DISPATCHED, page: "2", limit: "5" }),
    ).resolves.toMatchObject({
      status: TripStatus.DISPATCHED,
      page: 2,
      limit: 5,
    });
  });
});
