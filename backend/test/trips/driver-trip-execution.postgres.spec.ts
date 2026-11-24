import "dotenv/config";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  OrderStatus,
  PackageStatus,
  PodEvidenceType,
  Role,
  StopType,
  TaskAction,
  TripStatus,
  UploadStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require("supertest");
import { AuthModule } from "../../src/auth/auth.module";
import { DriversModule } from "../../src/drivers/drivers.module";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverTripExecutionController } from "../../src/trips/driver-trip-execution.controller";
import { DriverTripExecutionService } from "../../src/trips/driver-trip-execution.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

type CreatedFlow = {
  tripId: string;
  orderId: string;
  packageIds: string[];
  pickupStopId?: string;
  pickupTaskIds: string[];
  deliveryStopId?: string;
  deliveryTaskIds: string[];
};

describePostgres("M3.3 Driver Stop Execution Core (PostgreSQL)", () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m33-${suffix}`;
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  const drivers: Record<string, string> = {};
  let branchId: string;
  let vehicleId: string;
  let customerId: string;
  let sequence = 0;

  const bearer = (token: string) => `Bearer ${token}`;
  const command = (
    expectedTripVersion: number,
    idempotencyKey = randomUUID(),
  ) => ({
    idempotencyKey,
    expectedTripVersion,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "m33-driver-execution-test-secret-32chars";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        DriversModule,
      ],
      controllers: [DriverTripExecutionController],
      providers: [DriverTripExecutionService],
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

    const branch = await prisma.branch.create({
      data: {
        code: `${prefix}-BR`,
        name: "M3.3 Integration Branch",
        address: "Integration test",
        latitude: 10,
        longitude: 106,
      },
    });
    branchId = branch.id;

    for (const input of [
      { label: "primary", role: Role.DRIVER },
      { label: "relief", role: Role.DRIVER },
      { label: "other", role: Role.DRIVER },
      { label: "missing-profile", role: Role.DRIVER },
      { label: "admin", role: Role.ADMIN },
    ]) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: "integration-test-not-a-real-credential",
          fullName: `M3.3 ${input.label}`,
          role: input.role,
          branchId: input.role === Role.ADMIN ? null : branchId,
          active: true,
        },
      });
      users[input.label] = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      if (input.role === Role.DRIVER && input.label !== "missing-profile") {
        const driver = await prisma.driver.create({
          data: {
            userId: user.id,
            fullName: `Driver ${input.label}`,
            citizenId: `${prefix}-CID-${input.label}`,
            phone: `${prefix}-PHONE-${input.label}`,
            licenseNumber: `${prefix}-LIC-${input.label}`,
            licenseClass: "C",
            licenseExpiry: new Date("2035-01-01"),
            homeBranchId: branchId,
          },
        });
        drivers[input.label] = driver.id;
      }
    }

    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE`,
        model: "M3.3 Truck",
        vehicleType: "Truck",
        homeBranchId: branchId,
        payloadCapacityKg: 5000,
        volumeCapacityM3: 25,
        lengthCm: 600,
        widthCm: 240,
        heightCm: 250,
      },
    });
    vehicleId = vehicle.id;
    const customer = await prisma.customer.create({
      data: {
        code: `${prefix}-CUS`,
        name: "M3.3 Customer",
        phone: `${prefix}-CUS-PHONE`,
      },
    });
    customerId = customer.id;
  });

  beforeEach(async () => {
    // The suite reuses drivers. Each case owns its own active Trip fixtures.
    await prisma.trip.updateMany({
      where: { tripNumber: { startsWith: prefix }, status: TripStatus.IN_PROGRESS },
      data: { status: TripStatus.CANCELLED },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const tripIds = (
      await prisma.trip.findMany({
        where: { tripNumber: { startsWith: prefix } },
        select: { id: true },
      })
    ).map((trip) => trip.id);
    const stopIds = (
      await prisma.tripStop.findMany({
        where: { tripId: { in: tripIds } },
        select: { id: true },
      })
    ).map((stop) => stop.id);
    const orderIds = (
      await prisma.order.findMany({
        where: { orderNumber: { startsWith: prefix } },
        select: { id: true },
      })
    ).map((order) => order.id);
    await prisma.executionEvent.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await prisma.podFile.deleteMany({
      where: { deliveryAttempt: { tripStopId: { in: stopIds } } },
    });
    await prisma.deliveryAttempt.deleteMany({
      where: { tripStopId: { in: stopIds } },
    });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma.orderEvent.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.package.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.processedCommand.deleteMany({
      where: { actorUserId: { in: Object.values(users) } },
    });
    await prisma.driver.deleteMany({
      where: { id: { in: Object.values(drivers) } },
    });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await app.close();
  });

  async function createFlow(options?: {
    tripStatus?: TripStatus;
    tripVersion?: number;
    assignmentDriver?: string;
    assignmentRole?: string;
    assignmentStatus?: string;
    packageCount?: number;
    packageStatus?: PackageStatus;
    orderStatus?: OrderStatus;
    pickup?: boolean;
    delivery?: boolean;
    pickupStatus?: string;
    deliveryStatus?: string;
    actualQuantities?: number | null;
    actualStartTime?: Date;
    pickupArrivalTime?: Date;
    deliveryArrivalTime?: Date;
  }): Promise<CreatedFlow> {
    sequence += 1;
    const packageCount = options?.packageCount ?? 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: `${prefix}-ORDER-${sequence}`,
        customerId,
        branchId,
        status: options?.orderStatus ?? OrderStatus.ASSIGNED,
        totalAmount: 0,
      },
    });
    const packages: Array<{ id: string }> = [];
    for (let index = 0; index < packageCount; index += 1) {
      packages.push(
        await prisma.package.create({
          data: {
            orderId: order.id,
            packageCode: `${prefix}-PKG-${sequence}-${index}`,
            lengthMm: 1000,
            widthMm: 500,
            heightMm: 500,
            weightG: 10000n,
            allowedOrientations: ["LWH"],
            measurementSource: "INTEGRATION_TEST",
            status: options?.packageStatus ?? PackageStatus.ALLOCATED,
          },
        }),
      );
    }
    const start = new Date(Date.UTC(2027, 0, 1, 8 + sequence));
    const trip = await prisma.trip.create({
      data: {
        tripNumber: `${prefix}-TRIP-${sequence}`,
        vehicleId,
        managingBranchId: branchId,
        status: options?.tripStatus ?? TripStatus.DISPATCHED,
        version: options?.tripVersion ?? 1,
        actualStartTime:
          options?.actualStartTime ??
          (options?.tripStatus === TripStatus.IN_PROGRESS
            ? new Date(Date.now() - 60 * 60 * 1000)
            : null),
        plannedStartTime: start,
        plannedEndTime: new Date(start.getTime() + 3_600_000),
        assignments: {
          create: {
            driverId: options?.assignmentDriver ?? drivers.primary,
            startTime: start,
            endTime: new Date(start.getTime() + 3_600_000),
            role: options?.assignmentRole ?? "PRIMARY",
            status: options?.assignmentStatus ?? "ASSIGNED",
          },
        },
      },
    });
    const result: CreatedFlow = {
      tripId: trip.id,
      orderId: order.id,
      packageIds: packages.map((pkg) => pkg.id),
      pickupTaskIds: [],
      deliveryTaskIds: [],
    };

    if (options?.pickup !== false) {
      const stop = await prisma.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: 1,
          stopType: StopType.PICKUP,
          address: "Pickup",
          latitude: 10,
          longitude: 106,
          status: options?.pickupStatus ?? "PENDING",
          actualArrivalTime:
            options?.pickupArrivalTime ??
            (options?.pickupStatus === "ARRIVED"
              ? new Date(Date.now() - 30 * 60 * 1000)
              : null),
        },
      });
      result.pickupStopId = stop.id;
      for (const pkg of packages) {
        const task = await prisma.stopTask.create({
          data: {
            tripStopId: stop.id,
            orderId: order.id,
            packageId: pkg.id,
            action: TaskAction.LOAD,
            plannedQuantity: 1,
            actualQuantity: options?.actualQuantities,
          },
        });
        result.pickupTaskIds.push(task.id);
      }
    }
    if (options?.delivery !== false) {
      const stop = await prisma.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: options?.pickup === false ? 1 : 2,
          stopType: StopType.DELIVERY,
          address: "Delivery",
          latitude: 11,
          longitude: 107,
          status: options?.deliveryStatus ?? "PENDING",
          actualArrivalTime:
            options?.deliveryArrivalTime ??
            (options?.deliveryStatus === "ARRIVED"
              ? new Date(Date.now() - 30 * 60 * 1000)
              : null),
        },
      });
      result.deliveryStopId = stop.id;
      for (const pkg of packages) {
        const task = await prisma.stopTask.create({
          data: {
            tripStopId: stop.id,
            orderId: order.id,
            packageId: pkg.id,
            action: TaskAction.UNLOAD,
            plannedQuantity: 1,
            actualQuantity: options?.actualQuantities,
          },
        });
        result.deliveryTaskIds.push(task.id);
      }
    }
    return result;
  }

  it("thực thi đầy đủ START → pickup → delivery → COMPLETE_TRIP", async () => {
    const flow = await createFlow();
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(1))
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: TripStatus.IN_PROGRESS,
          version: 2,
        });
      });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/arrive`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(2))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(3),
        tasks: flow.pickupTaskIds.map((taskId) => ({
          taskId,
          actualQuantity: 1,
        })),
      })
      .expect(201);
    expect(
      await prisma.package.findUnique({ where: { id: flow.packageIds[0] } }),
    ).toMatchObject({ status: PackageStatus.LOADED, version: 2 });
    expect(
      await prisma.order.findUnique({ where: { id: flow.orderId } }),
    ).toMatchObject({ status: OrderStatus.IN_TRANSIT, version: 2 });

    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.deliveryStopId}/arrive`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(4))
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/driver/trips/${flow.tripId}/stops/${flow.deliveryStopId}/complete`,
      )
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(5),
        tasks: flow.deliveryTaskIds.map((taskId) => ({
          taskId,
          actualQuantity: 1,
        })),
        deliveryResult: "SUCCESS",
        recipientName: "Integration Recipient",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.deliveryAttempt).toMatchObject({
          attemptNumber: 1,
          result: "SUCCESS",
        });
      });
    expect(
      await prisma.package.findUnique({ where: { id: flow.packageIds[0] } }),
    ).toMatchObject({ status: PackageStatus.DELIVERED, version: 3 });
    expect(
      await prisma.order.findUnique({ where: { id: flow.orderId } }),
    ).toMatchObject({ status: OrderStatus.COMPLETED, version: 3 });

    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(6))
      .expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe("POD_REQUIRED"));
    expect(
      await prisma.trip.findUnique({ where: { id: flow.tripId } }),
    ).toMatchObject({ status: TripStatus.IN_PROGRESS, version: 6 });

    const deliveryAttempt = await prisma.deliveryAttempt.findFirstOrThrow({
      where: { tripStopId: flow.deliveryStopId },
    });
    await prisma.podFile.create({
      data: {
        deliveryAttemptId: deliveryAttempt.id,
        storageKey: `qa/pod/${randomUUID()}`,
        checksum: "integration-checksum",
        evidenceType: PodEvidenceType.PHOTO,
        mediaType: "image/jpeg",
        sizeBytes: 1024,
        uploadStatus: UploadStatus.UPLOADED,
        capturedAt: new Date(),
        uploadedAt: new Date(),
      },
    });

    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(6))
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: TripStatus.COMPLETED,
          version: 7,
        });
      });
    expect(
      await prisma.executionEvent.count({ where: { tripId: flow.tripId } }),
    ).toBe(6);
    expect(
      await prisma.orderEvent.count({ where: { orderId: flow.orderId } }),
    ).toBe(2);
  });

  it("partial pickup hoàn thành stop, giữ package thiếu ở ALLOCATED", async () => {
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      pickupStatus: "ARRIVED",
      delivery: false,
      packageCount: 2,
    });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1),
        tasks: [
          { taskId: flow.pickupTaskIds[0], actualQuantity: 1 },
          { taskId: flow.pickupTaskIds[1], actualQuantity: 0 },
        ],
        reasonCode: "PACKAGE_NOT_AVAILABLE",
      })
      .expect(201);
    const packages = await prisma.package.findMany({
      where: { id: { in: flow.packageIds } },
      orderBy: { packageCode: "asc" },
    });
    expect(packages.map((pkg) => pkg.status).sort()).toEqual(
      [PackageStatus.ALLOCATED, PackageStatus.LOADED].sort(),
    );
    expect(
      await prisma.order.findUnique({ where: { id: flow.orderId } }),
    ).toMatchObject({ status: OrderStatus.IN_TRANSIT });
  });

  it("failed delivery tạo attempt server-side và vẫn cho complete Trip", async () => {
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      pickup: false,
      deliveryStatus: "ARRIVED",
      packageStatus: PackageStatus.LOADED,
      orderStatus: OrderStatus.IN_TRANSIT,
    });
    await prisma.deliveryAttempt.create({
      data: {
        tripStopId: flow.deliveryStopId!,
        attemptNumber: 1,
        occurredAt: new Date(),
        result: "FAILED",
        failureReason: "RECIPIENT_UNAVAILABLE",
        commandId: randomUUID(),
      },
    });
    await request(app.getHttpServer())
      .post(
        `/driver/trips/${flow.tripId}/stops/${flow.deliveryStopId}/complete`,
      )
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1),
        tasks: flow.deliveryTaskIds.map((taskId) => ({
          taskId,
          actualQuantity: 0,
        })),
        deliveryResult: "FAILED",
        reasonCode: "RECIPIENT_UNAVAILABLE",
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body.eventType).toBe("DELIVERY_FAILED");
        expect(body.deliveryAttempt.attemptNumber).toBe(2);
      });
    expect(
      await prisma.package.findUnique({ where: { id: flow.packageIds[0] } }),
    ).toMatchObject({ status: PackageStatus.LOADED });
    expect(
      await prisma.order.findUnique({ where: { id: flow.orderId } }),
    ).toMatchObject({ status: OrderStatus.IN_TRANSIT });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(2))
      .expect(201);
  });

  it("RELIEF đọc được theo M3.1 nhưng mutation bị DRIVER_NOT_PRIMARY", async () => {
    const flow = await createFlow({
      assignmentDriver: drivers.relief,
      assignmentRole: "RELIEF",
    });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.relief))
      .send(command(1))
      .expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe("DRIVER_NOT_PRIMARY"));
  });

  it("Driver khác nhận 404; role khác 403; thiếu JWT 401", async () => {
    const flow = await createFlow();
    const payload = command(1);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.other))
      .send(payload)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.admin))
      .send(payload)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .send(payload)
      .expect(401);
  });

  it("Driver thiếu profile trả DRIVER_PROFILE_NOT_FOUND", async () => {
    const flow = await createFlow();
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens["missing-profile"]))
      .send(command(1))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("DRIVER_PROFILE_NOT_FOUND"),
      );
  });

  it("ARRIVE chặn sai sequence và version stale", async () => {
    const flow = await createFlow({ tripStatus: TripStatus.IN_PROGRESS });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.deliveryStopId}/arrive`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(1))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("STOP_OUT_OF_SEQUENCE"),
      );
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/arrive`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(99))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("TRIP_VERSION_CONFLICT"),
      );
  });

  it("complete stop chặn thiếu task, quantity > planned và thiếu reason", async () => {
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      pickupStatus: "ARRIVED",
      delivery: false,
      packageCount: 2,
    });
    const endpoint = `/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/complete`;
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1),
        tasks: [{ taskId: flow.pickupTaskIds[0], actualQuantity: 1 }],
      })
      .expect(409);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1),
        tasks: flow.pickupTaskIds.map((taskId) => ({
          taskId,
          actualQuantity: 2,
        })),
      })
      .expect(409);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1),
        tasks: flow.pickupTaskIds.map((taskId) => ({
          taskId,
          actualQuantity: 0,
        })),
      })
      .expect(409);
  });

  it("depot stop không task được arrive và complete", async () => {
    sequence += 1;
    const start = new Date(Date.UTC(2027, 2, 1, 8 + sequence));
    const trip = await prisma.trip.create({
      data: {
        tripNumber: `${prefix}-DEPOT-${sequence}`,
        vehicleId,
        status: TripStatus.IN_PROGRESS,
        actualStartTime: new Date(Date.now() - 60 * 60 * 1000),
        plannedStartTime: start,
        plannedEndTime: new Date(start.getTime() + 3_600_000),
        assignments: {
          create: {
            driverId: drivers.primary,
            startTime: start,
            endTime: new Date(start.getTime() + 3_600_000),
            role: "PRIMARY",
          },
        },
        stops: {
          create: {
            sequence: 1,
            stopType: StopType.DEPOT_START,
            address: "Depot",
            latitude: 10,
            longitude: 106,
          },
        },
      },
      include: { stops: true },
    });
    const stopId = trip.stops[0].id;
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/stops/${stopId}/arrive`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(1))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/driver/trips/${trip.id}/stops/${stopId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send({ ...command(2), tasks: [], note: "Rời depot" })
      .expect(201)
      .expect(({ body }) =>
        expect(body.eventType).toBe("DEPOT_STOP_COMPLETED"),
      );
  });

  it("COMPLETE_TRIP chặn stop unresolved", async () => {
    const flow = await createFlow({ tripStatus: TripStatus.IN_PROGRESS });
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/complete`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(1))
      .expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe("UNRESOLVED_STOPS"));
  });

  it("idempotency replay không tạo duplicate event; payload mismatch trả 409", async () => {
    const flow = await createFlow();
    const key = randomUUID();
    const payload = command(1, key);
    const first = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.primary))
      .send(payload)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.executionEvent.count({
        where: { tripId: flow.tripId, eventType: "START_TRIP" },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/start`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(2, key))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH"),
      );
  });

  it("hai START concurrent cùng version chỉ một mutation thắng", async () => {
    const flow = await createFlow();
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/driver/trips/${flow.tripId}/start`)
        .set("Authorization", bearer(tokens.primary))
        .send(command(1)),
      request(app.getHttpServer())
        .post(`/driver/trips/${flow.tripId}/start`)
        .set("Authorization", bearer(tokens.primary))
        .send(command(1)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await prisma.executionEvent.count({
        where: { tripId: flow.tripId, eventType: "START_TRIP" },
      }),
    ).toBe(1);
  });

  it("serializes Starts on different Trips assigned to the same primary driver", async () => {
    const trips = [await createFlow(), await createFlow()];
    const commands = [command(1), command(1)];
    const responses = await Promise.all(trips.map((flow, index) =>
      request(app.getHttpServer())
        .post(`/driver/trips/${flow.tripId}/start`)
        .set("Authorization", bearer(tokens.primary))
        .send(commands[index]),
    ));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.errorCode)
      .toBe("DRIVER_ALREADY_ON_TRIP");
    const tripIds = trips.map((trip) => trip.tripId);
    const stored = await prisma.trip.findMany({ where: { id: { in: tripIds } } });
    expect(stored.filter((trip) => trip.status === TripStatus.IN_PROGRESS)).toHaveLength(1);
    expect(stored.find((trip) => trip.status === TripStatus.DISPATCHED))
      .toMatchObject({ actualStartTime: null, version: 1 });
    expect(await prisma.driverAssignment.count({
      where: { tripId: { in: tripIds }, status: "ASSIGNED" },
    })).toBe(2);
    expect(await prisma.executionEvent.count({
      where: { tripId: { in: tripIds }, eventType: "START_TRIP" },
    })).toBe(1);
    expect(await prisma.processedCommand.count({
      where: { idempotencyKey: { in: commands.map((dto) => dto.idempotencyKey) } },
    })).toBe(1);
  });

  it("preserves offline timestamps and exact replay for ARRIVE and COMPLETE", async () => {
    const tripStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const arrivedAt = new Date(Date.now() - 90 * 60 * 1000);
    const completedAt = new Date(Date.now() - 60 * 60 * 1000);
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      actualStartTime: tripStartedAt,
      delivery: false,
    });
    const arriveKey = randomUUID();
    const arrivePayload = {
      ...command(1, arriveKey),
      occurredAt: arrivedAt.toISOString(),
    };
    const arriveEndpoint = `/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/arrive`;
    const firstArrive = await request(app.getHttpServer())
      .post(arriveEndpoint)
      .set("Authorization", bearer(tokens.primary))
      .send(arrivePayload)
      .expect(201);
    const replayArrive = await request(app.getHttpServer())
      .post(arriveEndpoint)
      .set("Authorization", bearer(tokens.primary))
      .send(arrivePayload)
      .expect(201);
    expect(replayArrive.body).toEqual(firstArrive.body);

    const completeKey = randomUUID();
    const completePayload = {
      ...command(2, completeKey),
      occurredAt: completedAt.toISOString(),
      tasks: flow.pickupTaskIds.map((taskId) => ({
        taskId,
        actualQuantity: 1,
      })),
    };
    const completeEndpoint = `/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/complete`;
    const firstComplete = await request(app.getHttpServer())
      .post(completeEndpoint)
      .set("Authorization", bearer(tokens.primary))
      .send(completePayload)
      .expect(201);
    const replayComplete = await request(app.getHttpServer())
      .post(completeEndpoint)
      .set("Authorization", bearer(tokens.primary))
      .send(completePayload)
      .expect(201);
    expect(replayComplete.body).toEqual(firstComplete.body);

    const stop = await prisma.tripStop.findUniqueOrThrow({
      where: { id: flow.pickupStopId },
    });
    expect(stop.actualArrivalTime).toEqual(arrivedAt);
    expect(stop.actualDepartureTime).toEqual(completedAt);
    const events = await prisma.executionEvent.findMany({
      where: { tripId: flow.tripId },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.occurredAt)).toEqual([
      arrivedAt,
      completedAt,
    ]);
    expect(events.every((event) => event.receivedAt > event.occurredAt)).toBe(
      true,
    );
    expect(
      await prisma.orderEvent.findFirstOrThrow({
        where: { orderId: flow.orderId },
      }),
    ).toMatchObject({ occurredAt: completedAt });
  });

  it("validates ARRIVE timestamp window and Trip start boundary", async () => {
    const cases = [
      {
        occurredAt: new Date(Date.now() + 6 * 60 * 1000),
        actualStartTime: new Date(Date.now() - 60 * 60 * 1000),
      },
      {
        occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        actualStartTime: new Date(Date.now() - 26 * 60 * 60 * 1000),
      },
      {
        occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        actualStartTime: new Date(Date.now() - 60 * 60 * 1000),
      },
    ];
    for (const item of cases) {
      const flow = await createFlow({
        tripStatus: TripStatus.IN_PROGRESS,
        actualStartTime: item.actualStartTime,
        delivery: false,
      });
      await request(app.getHttpServer())
        .post(`/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/arrive`)
        .set("Authorization", bearer(tokens.primary))
        .send({ ...command(1), occurredAt: item.occurredAt.toISOString() })
        .expect(400)
        .expect(({ body }) =>
          expect(body.errorCode).toBe("INVALID_COMMAND_TIMESTAMP"),
        );
    }
  });

  it("allows COMPLETE at arrival time and rejects before arrival", async () => {
    const arrivalTime = new Date(Date.now() - 30 * 60 * 1000);
    const complete = async (occurredAt: Date, shouldPass: boolean) => {
      const flow = await createFlow({
        tripStatus: TripStatus.IN_PROGRESS,
        pickupStatus: "ARRIVED",
        pickupArrivalTime: arrivalTime,
        delivery: false,
      });
      const response = request(app.getHttpServer())
        .post(
          `/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/complete`,
        )
        .set("Authorization", bearer(tokens.primary))
        .send({
          ...command(1),
          occurredAt: occurredAt.toISOString(),
          tasks: flow.pickupTaskIds.map((taskId) => ({
            taskId,
            actualQuantity: 1,
          })),
        });
      if (shouldPass) return response.expect(201);
      return response
        .expect(400)
        .expect(({ body }) =>
          expect(body.errorCode).toBe("INVALID_COMMAND_TIMESTAMP"),
        );
    };
    await complete(new Date(arrivalTime.getTime() - 1), false);
    await complete(arrivalTime, true);
    await complete(new Date(Date.now() + 6 * 60 * 1000), false);
    await complete(new Date(Date.now() - 25 * 60 * 60 * 1000), false);
  });

  it("same key with different occurredAt returns payload mismatch", async () => {
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      delivery: false,
    });
    const key = randomUUID();
    const occurredAt = new Date(Date.now() - 30 * 60 * 1000);
    const endpoint = `/driver/trips/${flow.tripId}/stops/${flow.pickupStopId}/arrive`;
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({ ...command(1, key), occurredAt: occurredAt.toISOString() })
      .expect(201);
    const equivalentOffsetTime = new Date(
      occurredAt.getTime() + 7 * 60 * 60 * 1000,
    )
      .toISOString()
      .replace("Z", "+07:00");
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({ ...command(1, key), occurredAt: equivalentOffsetTime })
      .expect(201);
    await request(app.getHttpServer())
      .post(endpoint)
      .set("Authorization", bearer(tokens.primary))
      .send({
        ...command(1, key),
        occurredAt: new Date(occurredAt.getTime() + 1000).toISOString(),
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH"),
      );
  });

  it("concurrent COMPLETE_STOP same key creates one delivery mutation", async () => {
    const arrivedAt = new Date(Date.now() - 30 * 60 * 1000);
    const occurredAt = new Date(Date.now() - 20 * 60 * 1000);
    const flow = await createFlow({
      tripStatus: TripStatus.IN_PROGRESS,
      pickup: false,
      deliveryStatus: "ARRIVED",
      deliveryArrivalTime: arrivedAt,
      packageStatus: PackageStatus.LOADED,
      orderStatus: OrderStatus.IN_TRANSIT,
    });
    const key = randomUUID();
    const payload = {
      ...command(1, key),
      occurredAt: occurredAt.toISOString(),
      tasks: flow.deliveryTaskIds.map((taskId) => ({
        taskId,
        actualQuantity: 1,
      })),
      deliveryResult: "SUCCESS",
      recipientName: "Concurrent Recipient",
    };
    const endpoint = `/driver/trips/${flow.tripId}/stops/${flow.deliveryStopId}/complete`;
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(endpoint)
        .set("Authorization", bearer(tokens.primary))
        .send(payload),
      request(app.getHttpServer())
        .post(endpoint)
        .set("Authorization", bearer(tokens.primary))
        .send(payload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses[1].body).toEqual(responses[0].body);
    expect(
      await prisma.processedCommand.count({
        where: {
          actorUserId: users.primary,
          commandType: "COMPLETE_STOP",
          idempotencyKey: key,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.executionEvent.count({
        where: { tripId: flow.tripId, eventType: "DELIVERY_COMPLETED" },
      }),
    ).toBe(1);
    const attempts = await prisma.deliveryAttempt.findMany({
      where: { tripStopId: flow.deliveryStopId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ occurredAt });
    expect(attempts[0].createdAt > attempts[0].occurredAt).toBe(true);
    await request(app.getHttpServer())
      .get("/driver/me/activity-summary")
      .query({ from: occurredAt.toISOString(), to: new Date(occurredAt.getTime() + 1).toISOString() })
      .set("Authorization", bearer(tokens.primary))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({
        processedStopCount: 1,
        deliveries: { success: 1, partial: 0, failed: 0, unclassified: 0 },
        coverage: { status: "COMPLETE" },
      }));
    expect(
      await prisma.package.findUniqueOrThrow({
        where: { id: flow.packageIds[0] },
      }),
    ).toMatchObject({ status: PackageStatus.DELIVERED, version: 2 });
    expect(
      await prisma.order.findUniqueOrThrow({ where: { id: flow.orderId } }),
    ).toMatchObject({ status: OrderStatus.COMPLETED, version: 2 });
    expect(
      await prisma.orderEvent.findFirstOrThrow({
        where: { orderId: flow.orderId },
      }),
    ).toMatchObject({ occurredAt });
  });
});
