import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { Role, TripStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { ROLES_KEY } from "../../src/auth/roles.decorator";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverIncidentsController } from "../../src/trips/driver-incidents.controller";
import { DriverIncidentsService } from "../../src/trips/driver-incidents.service";
import {
  CreateDriverIncidentDto,
  QueryDriverIncidentsDto,
} from "../../src/trips/dto/driver-incident.dto";

describe("M3.7.1 DriverIncidentsService", () => {
  const now = new Date();
  const tx = {
    $executeRaw: jest.fn(),
    processedCommand: { findUnique: jest.fn(), create: jest.fn() },
    driver: { findUnique: jest.fn() },
    trip: { findFirst: jest.fn() },
    stopTask: { findMany: jest.fn() },
    incident: { create: jest.fn() },
    executionEvent: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new DriverIncidentsService(
    prisma as unknown as PrismaService,
  );
  const validDto = (): CreateDriverIncidentDto => ({
    idempotencyKey: randomUUID(),
    type: "VEHICLE_BREAKDOWN",
    severity: "HIGH",
    description: "Động cơ quá nhiệt và xe cần dừng kiểm tra.",
    occurredAt: new Date().toISOString(),
    affectedOrderIds: [],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    tx.processedCommand.findUnique.mockResolvedValue(null);
    tx.processedCommand.create.mockResolvedValue({});
    tx.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    tx.trip.findFirst.mockResolvedValue({
      status: TripStatus.DISPATCHED,
      vehicleId: "vehicle-1",
      assignments: [{ role: "PRIMARY" }],
    });
    tx.stopTask.findMany.mockResolvedValue([]);
    tx.incident.create.mockResolvedValue({
      id: "incident-1",
      tripId: "trip-1",
      type: "VEHICLE_BREAKDOWN",
      severity: "HIGH",
      status: "OPEN",
      description: "Động cơ quá nhiệt và xe cần dừng kiểm tra.",
      occurredAt: now,
      resolution: null,
      createdAt: now,
      updatedAt: now,
      orders: [],
    });
    tx.executionEvent.create.mockResolvedValue({});
  });

  it("controller chỉ cho role DRIVER", () => {
    expect(Reflect.getMetadata(ROLES_KEY, DriverIncidentsController)).toEqual([
      Role.DRIVER,
    ]);
  });

  it("PRIMARY tạo Incident, audit event và ProcessedCommand trong transaction", async () => {
    const result = await service.create("user-1", "trip-1", validDto());

    expect(result).toMatchObject({
      id: "incident-1",
      tripId: "trip-1",
      status: "OPEN",
    });
    expect(tx.incident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reporterId: "user-1",
          driverId: "driver-1",
          vehicleId: "vehicle-1",
          status: "OPEN",
        }),
      }),
    );
    expect(tx.executionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "INCIDENT_REPORTED",
        actorUserId: "user-1",
      }),
    });
    expect(tx.processedCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandType: "CREATE_DRIVER_INCIDENT",
        status: "COMPLETED",
      }),
    });
  });

  it("RELIEF bị từ chối tạo Incident", async () => {
    tx.trip.findFirst.mockResolvedValue({
      status: TripStatus.DISPATCHED,
      vehicleId: "vehicle-1",
      assignments: [{ role: "RELIEF" }],
    });

    await expect(
      service.create("user-1", "trip-1", validDto()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "DRIVER_NOT_PRIMARY" }),
    });
  });

  it.each([TripStatus.COMPLETED, TripStatus.CANCELLED])(
    "từ chối tạo Incident khi Trip là %s",
    async (status) => {
      tx.trip.findFirst.mockResolvedValue({
        status,
        vehicleId: "vehicle-1",
        assignments: [{ role: "PRIMARY" }],
      });
      await expect(
        service.create("user-1", "trip-1", validDto()),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ errorCode: "INVALID_TRIP_STATE" }),
      });
    },
  );

  it("replay cùng key/hash trả result cũ trước khi kiểm tra ownership", async () => {
    const dto = validDto();
    await service.create("user-1", "trip-1", dto);
    const command = tx.processedCommand.create.mock.calls[0][0].data;
    jest.clearAllMocks();
    tx.processedCommand.findUnique.mockResolvedValue({
      requestHash: command.requestHash,
      status: "COMPLETED",
      result: { id: "incident-1", status: "OPEN" },
    });

    await expect(service.create("user-1", "trip-1", dto)).resolves.toEqual({
      id: "incident-1",
      status: "OPEN",
    });
    expect(tx.driver.findUnique).not.toHaveBeenCalled();
  });

  it("cùng key nhưng payload khác bị từ chối", async () => {
    tx.processedCommand.findUnique.mockResolvedValue({
      requestHash: "different",
      status: "COMPLETED",
      result: {},
    });
    await expect(
      service.create("user-1", "trip-1", validDto()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "IDEMPOTENCY_PAYLOAD_MISMATCH",
      }),
    });
  });

  it("không hoàn tất command khi ghi audit event thất bại", async () => {
    tx.executionEvent.create.mockRejectedValueOnce(
      new Error("simulated audit failure"),
    );
    await expect(
      service.create("user-1", "trip-1", validDto()),
    ).rejects.toThrow("simulated audit failure");
    expect(tx.processedCommand.create).not.toHaveBeenCalled();
  });
});

describe("M3.7.1 Incident DTO validation", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const body = () => ({
    idempotencyKey: randomUUID(),
    type: "ACCIDENT",
    severity: "MEDIUM",
    description: "  Mô tả sự cố hợp lệ để kiểm tra.  ",
    occurredAt: new Date().toISOString(),
    affectedOrderIds: [randomUUID()],
  });

  it("trim description và nhận request hợp lệ", async () => {
    await expect(
      pipe.transform(body(), {
        type: "body",
        metatype: CreateDriverIncidentDto,
      }),
    ).resolves.toMatchObject({
      description: "Mô tả sự cố hợp lệ để kiểm tra.",
    });
  });

  it.each([
    { ...body(), type: "DELIVERY_ACCESS_ISSUE" },
    { ...body(), severity: "URGENT" },
    { ...body(), description: "ngắn" },
    { ...body(), description: "x".repeat(2001) },
    { ...body(), affectedOrderIds: ["invalid"] },
    (() => {
      const id = randomUUID();
      return { ...body(), affectedOrderIds: [id, id] };
    })(),
    { ...body(), driverId: randomUUID() },
  ])("từ chối body không hợp lệ %#", async (invalidBody) => {
    await expect(
      pipe.transform(invalidBody, {
        type: "body",
        metatype: CreateDriverIncidentDto,
      }),
    ).rejects.toBeDefined();
  });

  it("validate query pagination/type/status", async () => {
    await expect(
      pipe.transform(
        { page: "2", limit: "10", type: "ACCIDENT", status: "OPEN" },
        { type: "query", metatype: QueryDriverIncidentsDto },
      ),
    ).resolves.toMatchObject({ page: 2, limit: 10 });
    await expect(
      pipe.transform(
        { page: 0, limit: 101, type: "UNKNOWN" },
        { type: "query", metatype: QueryDriverIncidentsDto },
      ),
    ).rejects.toBeDefined();
  });
});
