import "dotenv/config";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  OrderStatus,
  Role,
  StopType,
  TaskAction,
  TripStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require("supertest");
import { AuthModule } from "../../src/auth/auth.module";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverIncidentsController } from "../../src/trips/driver-incidents.controller";
import { DriverIncidentsService } from "../../src/trips/driver-incidents.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

type IncidentFlow = {
  tripId: string;
  orderIds: string[];
  version: number;
  status: TripStatus;
};

describePostgres("M3.7.1 Driver Incident API (PostgreSQL)", () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let service: DriverIncidentsService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m371-${suffix}`;
  const users: Record<string, string> = {};
  const drivers: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let branchId: string;
  let vehicleId: string;
  let customerId: string;
  let sequence = 0;

  const bearer = (token: string) => `Bearer ${token}`;
  const command = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    type: "VEHICLE_BREAKDOWN",
    severity: "HIGH",
    description: "Động cơ quá nhiệt, xe cần dừng để kiểm tra an toàn.",
    occurredAt: new Date().toISOString(),
    affectedOrderIds: [],
    ...overrides,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "m371-driver-incident-integration-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
      ],
      controllers: [DriverIncidentsController],
      providers: [DriverIncidentsService],
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
    service = app.get(DriverIncidentsService);

    const branch = await prisma.branch.create({
      data: {
        code: `${prefix}-BR`,
        name: "M3.7.1 Branch",
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
          fullName: `M3.7.1 ${input.label}`,
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
        model: "M3.7.1 Truck",
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
        name: "M3.7.1 Customer",
        phone: `${prefix}-CUS-PHONE`,
      },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const tripIds = (
      await prisma.trip.findMany({
        where: { tripNumber: { startsWith: prefix } },
        select: { id: true },
      })
    ).map(({ id }) => id);
    const orderIds = (
      await prisma.order.findMany({
        where: { orderNumber: { startsWith: prefix } },
        select: { id: true },
      })
    ).map(({ id }) => id);
    await prisma.incident.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.executionEvent.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await prisma.processedCommand.deleteMany({
      where: { actorUserId: { in: Object.values(users) } },
    });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
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
    status?: TripStatus;
    driver?: string;
    role?: string;
    assignmentStatus?: string;
    orderCount?: number;
  }): Promise<IncidentFlow> {
    sequence += 1;
    const orderIds: string[] = [];
    for (let index = 0; index < (options?.orderCount ?? 1); index += 1) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `${prefix}-ORDER-${sequence}-${index}`,
          customerId,
          branchId,
          status: OrderStatus.ASSIGNED,
          totalAmount: 0,
        },
      });
      orderIds.push(order.id);
    }
    const start = new Date(Date.now() + sequence * 5 * 60 * 60 * 1000);
    const status = options?.status ?? TripStatus.DISPATCHED;
    const trip = await prisma.trip.create({
      data: {
        tripNumber: `${prefix}-TRIP-${sequence}`,
        vehicleId,
        managingBranchId: branchId,
        status,
        version: 7,
        plannedStartTime: start,
        plannedEndTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        assignments: {
          create: {
            driverId: options?.driver ?? drivers.primary,
            startTime: start,
            endTime: new Date(start.getTime() + 4 * 60 * 60 * 1000),
            role: options?.role ?? "PRIMARY",
            status: options?.assignmentStatus ?? "ASSIGNED",
          },
        },
      },
    });
    const stop = await prisma.tripStop.create({
      data: {
        tripId: trip.id,
        sequence: 1,
        stopType: StopType.PICKUP,
        address: "Incident test pickup",
        latitude: 10,
        longitude: 106,
      },
    });
    for (const orderId of orderIds) {
      await prisma.stopTask.create({
        data: {
          tripStopId: stop.id,
          orderId,
          action: TaskAction.LOAD,
          plannedQuantity: 1,
        },
      });
    }
    return { tripId: trip.id, orderIds, version: trip.version, status };
  }

  async function createStoredIncident(flow: IncidentFlow, type = "ACCIDENT") {
    return prisma.incident.create({
      data: {
        tripId: flow.tripId,
        vehicleId,
        driverId: drivers.primary,
        reporterId: users.primary,
        type,
        severity: "MEDIUM",
        status: "OPEN",
        occurredAt: new Date(),
        description: "Sự cố được tạo trực tiếp cho integration read test.",
      },
    });
  }

  it("PRIMARY tạo Incident với nhiều affected Orders và không mutate Trip", async () => {
    const flow = await createFlow({ orderCount: 2 });
    const response = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(command({ affectedOrderIds: [...flow.orderIds].reverse() }))
      .expect(201);

    expect(response.body).toMatchObject({
      tripId: flow.tripId,
      type: "VEHICLE_BREAKDOWN",
      severity: "HIGH",
      status: "OPEN",
    });
    expect(response.body.affectedOrders).toHaveLength(2);
    expect(response.body).not.toHaveProperty("driverId");
    expect(response.body).not.toHaveProperty("reporterId");

    const [incident, event, processed, trip] = await Promise.all([
      prisma.incident.findUnique({
        where: { id: response.body.id },
        include: { orders: true },
      }),
      prisma.executionEvent.findFirst({
        where: { tripId: flow.tripId, eventType: "INCIDENT_REPORTED" },
      }),
      prisma.processedCommand.findFirst({
        where: {
          actorUserId: users.primary,
          commandType: "CREATE_DRIVER_INCIDENT",
        },
      }),
      prisma.trip.findUnique({ where: { id: flow.tripId } }),
    ]);
    expect(incident?.orders).toHaveLength(2);
    expect(event?.payload).toMatchObject({ incidentId: response.body.id });
    expect(processed?.status).toBe("COMPLETED");
    expect(trip).toMatchObject({ version: flow.version, status: flow.status });
  });

  it("IN_PROGRESS tạo Incident không có affected Order", async () => {
    const flow = await createFlow({ status: TripStatus.IN_PROGRESS });
    const response = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(command())
      .expect(201);
    expect(response.body.affectedOrders).toEqual([]);
  });

  it("RELIEF đọc được nhưng không tạo Incident", async () => {
    const flow = await createFlow({ driver: drivers.relief, role: "RELIEF" });
    const incident = await createStoredIncident(flow);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.relief))
      .send(command())
      .expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe("DRIVER_NOT_PRIMARY"));
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents/${incident.id}`)
      .set("Authorization", bearer(tokens.relief))
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(incident.id));
  });

  it.each([TripStatus.COMPLETED, TripStatus.CANCELLED])(
    "%s chỉ cho đọc, không cho tạo",
    async (status) => {
      const flow = await createFlow({ status });
      const incident = await createStoredIncident(flow);
      await request(app.getHttpServer())
        .post(`/driver/trips/${flow.tripId}/incidents`)
        .set("Authorization", bearer(tokens.primary))
        .send(command())
        .expect(409)
        .expect(({ body }) =>
          expect(body.errorCode).toBe("INVALID_TRIP_STATE"),
        );
      await request(app.getHttpServer())
        .get(`/driver/trips/${flow.tripId}/incidents/${incident.id}`)
        .set("Authorization", bearer(tokens.primary))
        .expect(200);
    },
  );

  it("ẩn foreign Trip bằng 404 và báo missing profile bằng 409", async () => {
    const flow = await createFlow({ driver: drivers.other });
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens["missing-profile"]))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("DRIVER_PROFILE_NOT_FOUND"),
      );
  });

  it("chặn role khác và request thiếu JWT", async () => {
    const flow = await createFlow();
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.admin))
      .expect(403);
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents`)
      .expect(401);
  });

  it.each([
    { type: "DELIVERY_ACCESS_ISSUE" },
    { severity: "URGENT" },
    { description: "quá ngắn" },
    { description: "x".repeat(2001) },
    { occurredAt: new Date(Date.now() + 6 * 60 * 1000).toISOString() },
    { occurredAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    { driverId: randomUUID() },
  ])("từ chối input không hợp lệ %#", async (override) => {
    const flow = await createFlow();
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(command(override))
      .expect(400);
  });

  it("từ chối affectedOrderIds trùng và Order ngoài Trip", async () => {
    const flow = await createFlow();
    const foreign = await createFlow();
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(command({ affectedOrderIds: [flow.orderIds[0], flow.orderIds[0]] }))
      .expect(400);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(command({ affectedOrderIds: [foreign.orderIds[0]] }))
      .expect(409)
      .expect(({ body }) =>
        expect(body.errorCode).toBe("INCIDENT_ORDER_NOT_IN_TRIP"),
      );
  });

  it("replay cùng key/payload trả cùng Incident; payload khác bị conflict", async () => {
    const flow = await createFlow();
    const body = command({ affectedOrderIds: flow.orderIds });
    const first = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send({ ...body, severity: "LOW" })
      .expect(409)
      .expect(({ body: responseBody }) =>
        expect(responseBody.errorCode).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH"),
      );
    expect(
      await prisma.incident.count({ where: { tripId: flow.tripId } }),
    ).toBe(1);
  });

  it("hai request đồng thời cùng key chỉ tạo một Incident", async () => {
    const flow = await createFlow();
    const body = command();
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post(`/driver/trips/${flow.tripId}/incidents`)
          .set("Authorization", bearer(tokens.primary))
          .send(body),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[0].body.id).toBe(responses[1].body.id);
    expect(
      await prisma.incident.count({ where: { tripId: flow.tripId } }),
    ).toBe(1);
  });

  it("rollback Incident nếu ExecutionEvent thất bại", async () => {
    const flow = await createFlow();
    const reservedCommandId = randomUUID();
    await prisma.executionEvent.create({
      data: {
        tripId: flow.tripId,
        eventType: "RESERVED_TEST_EVENT",
        occurredAt: new Date(),
        actorUserId: users.primary,
        commandId: reservedCommandId,
        payload: {},
      },
    });
    const commandIdSpy = jest
      .spyOn(
        service as unknown as { createCommandId: () => string },
        "createCommandId",
      )
      .mockReturnValue(reservedCommandId);
    const body = command();
    await request(app.getHttpServer())
      .post(`/driver/trips/${flow.tripId}/incidents`)
      .set("Authorization", bearer(tokens.primary))
      .send(body)
      .expect(500);
    commandIdSpy.mockRestore();
    expect(
      await prisma.incident.count({ where: { tripId: flow.tripId } }),
    ).toBe(0);
    expect(
      await prisma.processedCommand.count({
        where: {
          actorUserId: users.primary,
          commandType: "CREATE_DRIVER_INCIDENT",
          idempotencyKey: body.idempotencyKey,
        },
      }),
    ).toBe(0);
  });

  it("list filter/pagination ổn định và detail che Incident sai Trip", async () => {
    const flow = await createFlow();
    const otherFlow = await createFlow();
    await createStoredIncident(flow, "ACCIDENT");
    await createStoredIncident(flow, "TRAFFIC_JAM");
    await createStoredIncident(flow, "ACCIDENT");
    const foreignIncident = await createStoredIncident(otherFlow, "ACCIDENT");

    const list = await request(app.getHttpServer())
      .get(
        `/driver/trips/${flow.tripId}/incidents?type=ACCIDENT&status=OPEN&page=1&limit=1`,
      )
      .set("Authorization", bearer(tokens.primary))
      .expect(200);
    expect(list.body).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].type).toBe("ACCIDENT");

    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents/${foreignIncident.id}`)
      .set("Authorization", bearer(tokens.primary))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/driver/trips/${flow.tripId}/incidents?page=0&limit=101`)
      .set("Authorization", bearer(tokens.primary))
      .expect(400);
  });
});
