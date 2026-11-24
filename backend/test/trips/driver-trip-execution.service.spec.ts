import "reflect-metadata";
import { ConflictException, ValidationPipe } from "@nestjs/common";
import { Role, TripStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { ROLES_KEY } from "../../src/auth/roles.decorator";
import { DriverTripExecutionController } from "../../src/trips/driver-trip-execution.controller";
import { DriverTripExecutionService } from "../../src/trips/driver-trip-execution.service";
import {
  ArriveDriverStopDto,
  CompleteDriverStopDto,
  DriverTripCommandDto,
} from "../../src/trips/dto/driver-trip-command.dto";
import { PrismaService } from "../../src/prisma/prisma.service";

describe("M3.3 DriverTripExecutionService", () => {
  const tx = {
    $executeRaw: jest.fn(),
    processedCommand: { findUnique: jest.fn(), create: jest.fn() },
    driver: { findUnique: jest.fn() },
    trip: { findFirst: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
    executionEvent: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new DriverTripExecutionService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tx.processedCommand.findUnique.mockResolvedValue(null);
    tx.processedCommand.create.mockResolvedValue({});
    tx.driver.findUnique.mockResolvedValue({ id: "driver-1" });
    tx.trip.findFirst.mockResolvedValue({
      id: "trip-1",
      status: TripStatus.DISPATCHED,
      version: 2,
      assignments: [{ role: "PRIMARY", status: "ASSIGNED" }],
    });
    tx.trip.count.mockResolvedValue(0);
    tx.trip.updateMany.mockResolvedValue({ count: 1 });
    tx.executionEvent.create.mockResolvedValue({});
  });

  it("controller mutation chỉ cho role DRIVER", () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, DriverTripExecutionController),
    ).toEqual([Role.DRIVER]);
  });

  it("START_TRIP cập nhật trạng thái/version và ghi event + command atomically", async () => {
    const result = await service.startTrip("user-1", "trip-1", {
      idempotencyKey: randomUUID(),
      expectedTripVersion: 2,
    });

    expect(result).toMatchObject({
      id: "trip-1",
      status: TripStatus.IN_PROGRESS,
      version: 3,
    });
    expect(tx.trip.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trip-1",
        status: TripStatus.DISPATCHED,
        version: 2,
      },
      data: expect.objectContaining({
        status: TripStatus.IN_PROGRESS,
        version: { increment: 1 },
      }),
    });
    expect(tx.executionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "START_TRIP",
        actorUserId: "user-1",
      }),
    });
    expect(tx.processedCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandType: "START_TRIP",
        status: "COMPLETED",
      }),
    });
  });

  it("RELIEF ASSIGNED bị từ chối bằng DRIVER_NOT_PRIMARY", async () => {
    tx.trip.findFirst.mockResolvedValue({
      id: "trip-1",
      status: TripStatus.DISPATCHED,
      version: 2,
      assignments: [{ role: "RELIEF", status: "ASSIGNED" }],
    });

    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: randomUUID(),
        expectedTripVersion: 2,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "DRIVER_NOT_PRIMARY" }),
    });
  });

  it("retry cùng key trả result cũ trước khi kiểm tra state/version", async () => {
    const storedResult = {
      id: "trip-1",
      status: TripStatus.IN_PROGRESS,
      version: 3,
    };
    const key = randomUUID();
    tx.processedCommand.findUnique.mockResolvedValue({
      requestHash: expect.anything(),
    });
    const firstHashLookup = tx.processedCommand.findUnique;

    // Lấy hash thực bằng một lần request bị giữ trong mock rồi replay với record đó.
    firstHashLookup.mockResolvedValueOnce(null);
    await service.startTrip("user-1", "trip-1", {
      idempotencyKey: key,
      expectedTripVersion: 2,
    });
    const created = tx.processedCommand.create.mock.calls[0][0].data;
    jest.clearAllMocks();
    tx.processedCommand.findUnique.mockResolvedValue({
      requestHash: created.requestHash,
      status: "COMPLETED",
      result: storedResult,
    });

    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: key,
        expectedTripVersion: 2,
      }),
    ).resolves.toEqual(storedResult);
    expect(tx.driver.findUnique).not.toHaveBeenCalled();
    expect(tx.trip.updateMany).not.toHaveBeenCalled();
    expect(tx.executionEvent.create).not.toHaveBeenCalled();
  });

  it("cùng key nhưng payload khác trả IDEMPOTENCY_PAYLOAD_MISMATCH", async () => {
    tx.processedCommand.findUnique.mockResolvedValue({
      requestHash: "different-hash",
      status: "COMPLETED",
      result: {},
    });

    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: randomUUID(),
        expectedTripVersion: 2,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "IDEMPOTENCY_PAYLOAD_MISMATCH",
      }),
    });
  });

  it("version sai trả TRIP_VERSION_CONFLICT", async () => {
    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: randomUUID(),
        expectedTripVersion: 99,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: randomUUID(),
        expectedTripVersion: 99,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "TRIP_VERSION_CONFLICT",
      }),
    });
  });

  it("không hoàn tất ProcessedCommand khi ghi ExecutionEvent thất bại", async () => {
    tx.executionEvent.create.mockRejectedValueOnce(
      new Error("simulated execution event failure"),
    );

    await expect(
      service.startTrip("user-1", "trip-1", {
        idempotencyKey: randomUUID(),
        expectedTripVersion: 2,
      }),
    ).rejects.toThrow("simulated execution event failure");
    expect(tx.processedCommand.create).not.toHaveBeenCalled();
  });
});

describe("M3.3 command DTO validation", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const command = () => ({
    idempotencyKey: randomUUID(),
    expectedTripVersion: 2,
  });

  it("accepts strict ISO-8601 occurredAt for ARRIVE and COMPLETE_STOP", async () => {
    const occurredAt = new Date().toISOString();
    await expect(
      pipe.transform(
        { ...command(), occurredAt },
        { type: "body", metatype: ArriveDriverStopDto },
      ),
    ).resolves.toMatchObject({ occurredAt });
    await expect(
      pipe.transform(
        { ...command(), occurredAt, tasks: [] },
        { type: "body", metatype: CompleteDriverStopDto },
      ),
    ).resolves.toMatchObject({ occurredAt });
  });

  it("rejects occurredAt that is not strict ISO-8601", async () => {
    await expect(
      pipe.transform(
        { ...command(), occurredAt: "2026-11-18 08:30:00" },
        { type: "body", metatype: ArriveDriverStopDto },
      ),
    ).rejects.toBeDefined();
  });

  it("nhận command tối thiểu hợp lệ", async () => {
    await expect(
      pipe.transform(command(), {
        type: "body",
        metatype: DriverTripCommandDto,
      }),
    ).resolves.toMatchObject({ expectedTripVersion: 2 });
  });

  it.each([
    { idempotencyKey: "not-uuid", expectedTripVersion: 2 },
    { idempotencyKey: randomUUID(), expectedTripVersion: 0 },
    { idempotencyKey: randomUUID(), expectedTripVersion: 1.5 },
    { ...command(), driverId: randomUUID() },
    { ...command(), startedAt: new Date().toISOString() },
  ])("từ chối command field không hợp lệ %#", async (body) => {
    await expect(
      pipe.transform(body, {
        type: "body",
        metatype: DriverTripCommandDto,
      }),
    ).rejects.toBeDefined();
  });

  it("từ chối task trùng và quantity decimal/âm", async () => {
    const taskId = randomUUID();
    const transform = (tasks: object[]) =>
      pipe.transform(
        { ...command(), tasks },
        { type: "body", metatype: CompleteDriverStopDto },
      );

    await expect(
      transform([
        { taskId, actualQuantity: 1 },
        { taskId, actualQuantity: 1 },
      ]),
    ).rejects.toBeDefined();
    await expect(
      transform([{ taskId: randomUUID(), actualQuantity: -1 }]),
    ).rejects.toBeDefined();
    await expect(
      transform([{ taskId: randomUUID(), actualQuantity: 0.5 }]),
    ).rejects.toBeDefined();
  });
});
