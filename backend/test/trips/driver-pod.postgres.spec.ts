import "dotenv/config";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import {
  PodEvidenceType,
  Role,
  StopType,
  TripStatus,
  UploadStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require("supertest");
import { AuthModule } from "../../src/auth/auth.module";
import { CloudinaryService } from "../../src/common/services/cloudinary.service";
import { PrismaModule } from "../../src/prisma/prisma.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { DriverPodController } from "../../src/trips/driver-pod.controller";
import { DriverPodService } from "../../src/trips/driver-pod.service";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("M3.5 Driver e-POD (PostgreSQL)", () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const prefix = `m35-${randomUUID().slice(0, 8)}`;
  const tokens: Record<string, string> = {};
  const users: Record<string, string> = {};
  const drivers: Record<string, string> = {};
  const trips: Record<string, string> = {};
  const stops: Record<string, string> = {};
  const attempts: Record<string, string> = {};
  const storedAssets = new Map<string, { publicId: string; bytes: number; format: string }>();
  const cloudinary = {
    findPodImage: jest.fn(async (storageKey: string) => storedAssets.get(storageKey) ?? null),
    uploadPodImage: jest.fn(async (buffer: Buffer, storageKey: string) => {
      const asset = { publicId: storageKey, bytes: buffer.length, format: "jpg" };
      storedAssets.set(storageKey, asset);
      return asset;
    }),
    createPodDownloadUrl: jest.fn(
      () => "https://signed.example.test/pod?expires=soon",
    ),
  };

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from("valid-jpeg-content"),
  ]);
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("valid-png-content"),
  ]);

  const bearer = (label: string) => `Bearer ${tokens[label]}`;
  const podPath = (tripId: string, stopId: string, attemptId: string) =>
    `/driver/trips/${tripId}/stops/${stopId}/delivery-attempts/${attemptId}/pod`;
  const upload = (
    label: string,
    tripId: string,
    stopId: string,
    attemptId: string,
    options?: {
      key?: string;
      evidenceType?: PodEvidenceType;
      buffer?: Buffer;
      contentType?: string;
      capturedAt?: string;
      supersedesId?: string;
    },
  ) => {
    const evidenceType = options?.evidenceType ?? PodEvidenceType.PHOTO;
    const pendingRequest = request(app.getHttpServer())
      .post(podPath(tripId, stopId, attemptId))
      .set("Authorization", bearer(label))
      .field("evidenceType", evidenceType)
      .field("capturedAt", options?.capturedAt ?? "2026-11-16T08:00:00.000Z")
      .field("idempotencyKey", options?.key ?? randomUUID());
    if (options?.supersedesId) {
      pendingRequest.field("supersedesId", options.supersedesId);
    }
    return pendingRequest.attach("file", options?.buffer ?? jpeg, {
        filename: evidenceType === PodEvidenceType.PHOTO ? "proof.jpg" : "signature.png",
        contentType:
          options?.contentType ??
          (evidenceType === PodEvidenceType.PHOTO ? "image/jpeg" : "image/png"),
      });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "m35-driver-pod-test-secret-at-least-32-characters";

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule],
      controllers: [DriverPodController],
      providers: [
        DriverPodService,
        { provide: CloudinaryService, useValue: cloudinary },
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

    const branch = await prisma.branch.create({
      data: {
        code: `${prefix}-BR`,
        name: "M3.5 Branch",
        address: "Integration test",
        latitude: 10,
        longitude: 106,
      },
    });
    const roles = [
      { label: "primary", role: Role.DRIVER },
      { label: "relief", role: Role.DRIVER },
      { label: "other", role: Role.DRIVER },
      { label: "admin", role: Role.ADMIN },
    ];
    for (const input of roles) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: "integration-test-not-a-real-credential",
          fullName: `M3.5 ${input.label}`,
          role: input.role,
          branchId: input.role === Role.DRIVER ? branch.id : null,
        },
      });
      users[input.label] = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      if (input.role === Role.DRIVER) {
        const driver = await prisma.driver.create({
          data: {
            userId: user.id,
            fullName: `Driver ${input.label}`,
            citizenId: `${prefix}-CID-${input.label}`,
            phone: `${prefix}-PHONE-${input.label}`,
            licenseNumber: `${prefix}-LIC-${input.label}`,
            licenseClass: "C",
            licenseExpiry: new Date("2035-01-01"),
            homeBranchId: branch.id,
          },
        });
        drivers[input.label] = driver.id;
      }
    }
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE`,
        model: "M3.5 Truck",
        vehicleType: "Truck",
        homeBranchId: branch.id,
        payloadCapacityKg: 5000,
        volumeCapacityM3: 25,
        lengthCm: 600,
        widthCm: 240,
        heightCm: 250,
      },
    });

    const createTrip = async (
      label: string,
      status: TripStatus,
      driverId: string,
      role = "PRIMARY",
    ) => {
      const startByLabel: Record<string, string> = {
        main: "2026-11-16T07:00:00.000Z",
        other: "2026-11-16T09:00:00.000Z",
        completed: "2026-11-16T11:00:00.000Z",
      };
      const start = new Date(startByLabel[label]);
      const trip = await prisma.trip.create({
        data: {
          tripNumber: `${prefix}-TRIP-${label}`,
          vehicleId: vehicle.id,
          managingBranchId: branch.id,
          status,
          plannedStartTime: start,
          plannedEndTime: new Date(start.getTime() + 3_600_000),
          assignments: {
            create: {
              driverId,
              startTime: start,
              endTime: new Date(start.getTime() + 3_600_000),
              role,
              status: "ASSIGNED",
            },
          },
        },
      });
      trips[label] = trip.id;
      const stop = await prisma.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: 1,
          stopType: StopType.DELIVERY,
          address: "Delivery",
          latitude: 10,
          longitude: 106,
          status: "COMPLETED",
        },
      });
      stops[label] = stop.id;
      const attempt = await prisma.deliveryAttempt.create({
        data: {
          tripStopId: stop.id,
          attemptNumber: 1,
          occurredAt: new Date("2026-11-16T08:00:00.000Z"),
          recipientName: "Người nhận QA",
          result: "SUCCESS",
          commandId: randomUUID(),
        },
      });
      attempts[label] = attempt.id;
    };
    await createTrip("main", TripStatus.IN_PROGRESS, drivers.primary);
    await prisma.driverAssignment.create({
      data: {
        tripId: trips.main,
        driverId: drivers.relief,
        startTime: new Date("2026-11-16T07:00:00.000Z"),
        endTime: new Date("2026-11-16T08:00:00.000Z"),
        role: "RELIEF",
        status: "ASSIGNED",
      },
    });
    await createTrip("other", TripStatus.IN_PROGRESS, drivers.other);
    await createTrip("completed", TripStatus.COMPLETED, drivers.primary);

    const pickup = await prisma.tripStop.create({
      data: {
        tripId: trips.main,
        sequence: 2,
        stopType: StopType.PICKUP,
        address: "Pickup",
        latitude: 10,
        longitude: 106,
        status: "COMPLETED",
      },
    });
    stops.pickup = pickup.id;
    const pickupAttempt = await prisma.deliveryAttempt.create({
      data: {
        tripStopId: pickup.id,
        attemptNumber: 1,
        occurredAt: new Date(),
        result: "FAILED",
        commandId: randomUUID(),
      },
    });
    attempts.pickup = pickupAttempt.id;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    cloudinary.findPodImage.mockImplementation(async (storageKey: string) =>
      storedAssets.get(storageKey) ?? null,
    );
    cloudinary.uploadPodImage.mockImplementation(
      async (buffer: Buffer, storageKey: string) => {
        const asset = { publicId: storageKey, bytes: buffer.length, format: "jpg" };
        storedAssets.set(storageKey, asset);
        return asset;
      },
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.podFile.deleteMany({
      where: { deliveryAttempt: { tripStop: { tripId: { in: Object.values(trips) } } } },
    });
    await prisma.deliveryAttempt.deleteMany({
      where: { tripStop: { tripId: { in: Object.values(trips) } } },
    });
    await prisma.processedCommand.deleteMany({
      where: { actorUserId: { in: Object.values(users) } },
    });
    await prisma.trip.deleteMany({ where: { id: { in: Object.values(trips) } } });
    await prisma.driver.deleteMany({ where: { id: { in: Object.values(drivers) } } });
    await prisma.vehicle.deleteMany({ where: { plateNumber: `${prefix}-PLATE` } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.branch.deleteMany({ where: { code: `${prefix}-BR` } });
    await app.close();
  });

  it("PRIMARY upload PHOTO và response không lộ storage internals", async () => {
    const response = await upload("primary", trips.main, stops.main, attempts.main).expect(201);
    expect(response.body).toMatchObject({
      evidenceType: "PHOTO",
      mediaType: "image/jpeg",
      sizeBytes: jpeg.length,
      uploadStatus: "UPLOADED",
    });
    expect(response.body).not.toHaveProperty("storageKey");
    expect(response.body).not.toHaveProperty("publicId");
    expect(response.body).not.toHaveProperty("url");
  });

  it("upload SIGNATURE PNG thành công", async () => {
    await upload("primary", trips.main, stops.main, attempts.main, {
      evidenceType: PodEvidenceType.SIGNATURE,
      buffer: png,
      contentType: "image/png",
    })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          evidenceType: "SIGNATURE",
          mediaType: "image/png",
          uploadStatus: "UPLOADED",
        });
      });
  });

  it("SIGNATURE mới phải thay thế chữ ký hiện hành và giữ lịch sử", async () => {
    const current = await prisma.podFile.findFirstOrThrow({
      where: {
        deliveryAttemptId: attempts.main,
        evidenceType: PodEvidenceType.SIGNATURE,
        uploadStatus: UploadStatus.UPLOADED,
      },
      orderBy: { createdAt: "desc" },
    });
    await upload("primary", trips.main, stops.main, attempts.main, {
      evidenceType: PodEvidenceType.SIGNATURE,
      buffer: png,
      contentType: "image/png",
    }).expect(409);

    const replacement = await upload(
      "primary",
      trips.main,
      stops.main,
      attempts.main,
      {
        evidenceType: PodEvidenceType.SIGNATURE,
        buffer: png,
        contentType: "image/png",
        supersedesId: current.id,
      },
    ).expect(201);
    expect(replacement.body.supersedesId).toBe(current.id);

    const metadata = await request(app.getHttpServer())
      .get(podPath(trips.main, stops.main, attempts.main))
      .set("Authorization", bearer("primary"))
      .expect(200);
    expect(
      metadata.body.items.find((item: { id: string }) => item.id === current.id),
    ).toMatchObject({ isSuperseded: true });
    expect(
      metadata.body.items.find(
        (item: { id: string }) => item.id === replacement.body.id,
      ),
    ).toMatchObject({ isSuperseded: false, supersedesId: current.id });
  });

  it("PHOTO có thể thay thế ảnh sai mà không xóa ảnh cũ", async () => {
    const original = await upload(
      "primary",
      trips.main,
      stops.main,
      attempts.main,
    ).expect(201);
    const replacement = await upload(
      "primary",
      trips.main,
      stops.main,
      attempts.main,
      { supersedesId: original.body.id },
    ).expect(201);
    expect(replacement.body.supersedesId).toBe(original.body.id);
  });

  it("chấp nhận provider tối ưu file làm thay đổi số byte lưu trữ", async () => {
    cloudinary.uploadPodImage.mockImplementationOnce(
      async (buffer: Buffer, storageKey: string) => {
        const asset = {
          publicId: storageKey,
          bytes: Math.max(1, buffer.length - 1),
          format: "jpg",
        };
        storedAssets.set(storageKey, asset);
        return asset;
      },
    );

    const response = await upload(
      "primary",
      trips.main,
      stops.main,
      attempts.main,
    ).expect(201);

    expect(response.body.uploadStatus).toBe("UPLOADED");
  });

  it("RELIEF bị từ chối và Driver khác nhận 404", async () => {
    await upload("relief", trips.main, stops.main, attempts.main).expect(409);
    await upload("other", trips.main, stops.main, attempts.main).expect(404);
  });

  it("role khác 403; thiếu hoặc sai JWT 401", async () => {
    await upload("admin", trips.main, stops.main, attempts.main).expect(403);
    await request(app.getHttpServer())
      .get(podPath(trips.main, stops.main, attempts.main))
      .expect(401);
    await request(app.getHttpServer())
      .get(podPath(trips.main, stops.main, attempts.main))
      .set("Authorization", "Bearer invalid")
      .expect(401);
  });

  it("Stop khác Trip, Attempt khác Stop và non-DELIVERY cùng trả 404", async () => {
    await upload("primary", trips.main, stops.other, attempts.other).expect(404);
    await upload("primary", trips.main, stops.main, attempts.other).expect(404);
    await upload("primary", trips.main, stops.pickup, attempts.pickup).expect(404);
  });

  it("từ chối fake MIME, magic mismatch và file rỗng", async () => {
    await upload("primary", trips.main, stops.main, attempts.main, {
      buffer: Buffer.from("not-jpeg"),
      contentType: "image/jpeg",
    }).expect(400);
    await upload("primary", trips.main, stops.main, attempts.main, {
      buffer: jpeg,
      contentType: "image/png",
    }).expect(400);
    await upload("primary", trips.main, stops.main, attempts.main, {
      buffer: Buffer.alloc(0),
    }).expect(400);
  });

  it("từ chối SIGNATURE vượt 2 MB", async () => {
    const oversized = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    await upload("primary", trips.main, stops.main, attempts.main, {
      evidenceType: PodEvidenceType.SIGNATURE,
      buffer: oversized,
      contentType: "image/png",
    }).expect(400);
  });

  it("từ chối PHOTO vượt 5 MB tại HTTP boundary", async () => {
    const oversized = Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024)]);
    await upload("primary", trips.main, stops.main, attempts.main, {
      buffer: oversized,
      contentType: "image/jpeg",
    }).expect(413);
  });

  it("provider lỗi chuyển PodFile FAILED và không trả success", async () => {
    const key = randomUUID();
    cloudinary.uploadPodImage.mockRejectedValueOnce(new Error("provider down"));
    const response = await upload("primary", trips.main, stops.main, attempts.main, {
      key,
    }).expect(503);
    expect(response.body.errorCode).toBe("POD_STORAGE_UPLOAD_FAILED");
    const failed = await prisma.podFile.findFirst({
      where: { deliveryAttemptId: attempts.main, uploadStatus: UploadStatus.FAILED },
      orderBy: { createdAt: "desc" },
    });
    expect(failed).not.toBeNull();
    storedAssets.set(failed!.storageKey, {
      publicId: failed!.storageKey,
      bytes: failed!.sizeBytes,
      format: "jpg",
    });
    const retried = await upload("primary", trips.main, stops.main, attempts.main, {
      key,
    }).expect(201);
    expect(retried.body.id).toBe(failed!.id);
    expect(retried.body.uploadStatus).toBe("UPLOADED");
    expect(cloudinary.uploadPodImage).toHaveBeenCalledTimes(1);
  });

  it("không đánh dấu UPLOADED trước khi provider xác nhận", async () => {
    let release: ((value: { publicId: string; bytes: number; format: string }) => void) | undefined;
    cloudinary.uploadPodImage.mockImplementationOnce(
      (buffer: Buffer, storageKey: string) =>
        new Promise((resolve) => {
          release = resolve;
          storedAssets.set(storageKey, { publicId: storageKey, bytes: buffer.length, format: "jpg" });
        }),
    );
    const pendingRequest = upload(
      "primary",
      trips.main,
      stops.main,
      attempts.main,
    ).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pending = await prisma.podFile.findFirst({
      where: { deliveryAttemptId: attempts.main, uploadStatus: UploadStatus.UPLOADING },
      orderBy: { createdAt: "desc" },
    });
    expect(pending).not.toBeNull();
    expect(release).toBeDefined();
    release!({ publicId: pending!.storageKey, bytes: pending!.sizeBytes, format: "jpg" });
    expect((await pendingRequest).status).toBe(201);
  });

  it("same key/same file replay cùng PodFile; khác file trả 409", async () => {
    const key = randomUUID();
    const first = await upload("primary", trips.main, stops.main, attempts.main, { key }).expect(201);
    const replay = await upload("primary", trips.main, stops.main, attempts.main, { key }).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(cloudinary.uploadPodImage).toHaveBeenCalledTimes(1);
    await upload("primary", trips.main, stops.main, attempts.main, {
      key,
      buffer: Buffer.concat([jpeg, Buffer.from("different")]),
    }).expect(409);
  });

  it("double tap cùng key chỉ thực hiện một provider upload", async () => {
    let release: ((value: { publicId: string; bytes: number; format: string }) => void) | undefined;
    cloudinary.uploadPodImage.mockImplementationOnce(
      (buffer: Buffer, storageKey: string) =>
        new Promise((resolve) => {
          release = resolve;
          storedAssets.set(storageKey, { publicId: storageKey, bytes: buffer.length, format: "jpg" });
        }),
    );
    const key = randomUUID();
    const first = upload("primary", trips.main, stops.main, attempts.main, {
      key,
    }).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await upload("primary", trips.main, stops.main, attempts.main, { key });
    expect(second.status).toBe(409);
    const processing = await prisma.podFile.findFirstOrThrow({
      where: { deliveryAttemptId: attempts.main, uploadStatus: UploadStatus.UPLOADING },
      orderBy: { createdAt: "desc" },
    });
    release!({ publicId: processing.storageKey, bytes: processing.sizeBytes, format: "jpg" });
    expect((await first).status).toBe(201);
    expect(cloudinary.uploadPodImage).toHaveBeenCalledTimes(1);
  });

  it("cho phép upload khi Trip COMPLETED", async () => {
    await upload(
      "primary",
      trips.completed,
      stops.completed,
      attempts.completed,
    ).expect(201);
  });

  it("read POD đúng ownership và chỉ trả metadata allowlist", async () => {
    const response = await request(app.getHttpServer())
      .get(podPath(trips.main, stops.main, attempts.main))
      .set("Authorization", bearer("primary"))
      .expect(200);
    expect(response.body.requirements).toMatchObject({
      photoRequired: true,
      photoUploaded: true,
      recipientRequired: true,
      recipientSatisfied: true,
      podSatisfied: true,
    });
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain("storageKey");
    expect(JSON.stringify(response.body)).not.toContain("checksum");
    await request(app.getHttpServer())
      .get(podPath(trips.main, stops.main, attempts.main))
      .set("Authorization", bearer("other"))
      .expect(404);
  });

  it("cấp URL xem private ngắn hạn đúng ownership", async () => {
    const podFile = await prisma.podFile.findFirstOrThrow({
      where: {
        deliveryAttemptId: attempts.main,
        uploadStatus: UploadStatus.UPLOADED,
      },
      orderBy: { createdAt: "desc" },
    });
    const path = `${podPath(trips.main, stops.main, attempts.main)}/${podFile.id}/view`;
    const response = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", bearer("primary"))
      .expect(200);
    expect(response.body).toMatchObject({
      id: podFile.id,
      url: "https://signed.example.test/pod?expires=soon",
    });
    expect(new Date(response.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await request(app.getHttpServer())
      .get(path)
      .set("Authorization", bearer("other"))
      .expect(404);
  });
});
