import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  PodEvidenceType,
  Prisma,
  StopType,
  TripStatus,
  UploadStatus,
} from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { CloudinaryService } from "../common/services/cloudinary.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  DRIVER_ASSIGNMENT_ROLE_PRIMARY,
  DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
} from "./driver-trip-execution.constants";
import { UploadDriverPodDto } from "./dto/driver-pod.dto";
import { isDriverPodPhotoRequired } from "./driver-pod-policy";

const POD_COMMAND_TYPE = "UPLOAD_DELIVERY_POD";
const POD_COMMAND_LOCK_NAMESPACE = 4203;
const POD_REPLACEMENT_LOCK_NAMESPACE = 4204;
const UPLOAD_STALE_AFTER_MS = 2 * 60 * 1000;
const POD_VIEW_URL_TTL_MS = 5 * 60 * 1000;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
const POD_FILE_SELECT = Prisma.validator<Prisma.PodFileSelect>()({
  id: true,
  evidenceType: true,
  mediaType: true,
  sizeBytes: true,
  uploadStatus: true,
  capturedAt: true,
  uploadedAt: true,
  createdAt: true,
  supersedesId: true,
  replacements: {
    where: { uploadStatus: UploadStatus.UPLOADED },
    select: { id: true },
  },
});

type PodFileRecord = Prisma.PodFileGetPayload<{
  select: typeof POD_FILE_SELECT;
}>;

type ReservedUpload = {
  podFileId: string;
  storageKey: string;
  sizeBytes: number;
  replay?: ReturnType<DriverPodService["toPodResponse"]>;
};

@Injectable()
export class DriverPodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async upload(
    userId: string,
    tripId: string,
    stopId: string,
    attemptId: string,
    dto: UploadDriverPodDto,
    file: Express.Multer.File,
  ) {
    const fileMetadata = this.validateAndDescribeFile(dto.evidenceType, file);
    const checksum = createHash("sha256").update(file.buffer).digest("hex");
    const capturedAt = new Date(dto.capturedAt);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          tripId,
          stopId,
          attemptId,
          evidenceType: dto.evidenceType,
          checksum,
          capturedAt: capturedAt.toISOString(),
          supersedesId: dto.supersedesId ?? null,
        }),
      )
      .digest("hex");

    const reserved = await this.prisma.$transaction((tx) =>
      this.reserveUpload(tx, {
        userId,
        tripId,
        stopId,
        attemptId,
        dto,
        capturedAt,
        checksum,
        requestHash,
        mediaType: fileMetadata.mediaType,
        sizeBytes: file.buffer.length,
      }),
    );
    if (reserved.replay) return reserved.replay;

    try {
      let asset = await this.cloudinary.findPodImage(reserved.storageKey);
      if (!asset) {
        asset = await this.cloudinary.uploadPodImage(
          file.buffer,
          reserved.storageKey,
        );
      }
      if (asset.publicId !== reserved.storageKey) {
        throw new ConflictException({
          errorCode: "POD_STORAGE_METADATA_MISMATCH",
          message: "Metadata file trên storage không khớp request",
        });
      }

      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.podFile.updateMany({
          where: {
            id: reserved.podFileId,
            uploadStatus: UploadStatus.UPLOADING,
          },
          data: {
            uploadStatus: UploadStatus.UPLOADED,
            uploadedAt: new Date(),
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            errorCode: "POD_UPLOAD_STATE_CONFLICT",
            message: "Trạng thái POD đã được request khác thay đổi",
          });
        }
        const podFile = await tx.podFile.findUniqueOrThrow({
          where: { id: reserved.podFileId },
          select: POD_FILE_SELECT,
        });
        const response = this.toPodResponse(podFile);
        await tx.processedCommand.update({
          where: { id: reserved.podFileId },
          data: { status: "COMPLETED", result: response },
        });
        return response;
      });
    } catch (error) {
      await this.markUploadFailed(reserved.podFileId);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({
        errorCode: "POD_STORAGE_UPLOAD_FAILED",
        message: "Không thể lưu bằng chứng giao hàng, vui lòng thử lại",
      });
    }
  }

  async findAll(
    userId: string,
    tripId: string,
    stopId: string,
    attemptId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.authorizeAttempt(
        tx,
        userId,
        tripId,
        stopId,
        attemptId,
      );
      const items = await tx.podFile.findMany({
        where: { deliveryAttemptId: attemptId },
        select: POD_FILE_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const photoUploaded = items.some(
        (item) =>
          item.evidenceType === PodEvidenceType.PHOTO &&
          item.uploadStatus === UploadStatus.UPLOADED &&
          item.replacements.length === 0,
      );
      const photoRequired = isDriverPodPhotoRequired(
        attempt.result,
        attempt.failureReason,
      );
      const recipientRequired = ["SUCCESS", "PARTIAL"].includes(attempt.result);
      return {
        deliveryAttempt: {
          id: attempt.id,
          result: attempt.result,
          recipientName: attempt.recipientName,
        },
        requirements: {
          photoRequired,
          photoUploaded,
          recipientRequired,
          recipientSatisfied:
            !recipientRequired || Boolean(attempt.recipientName?.trim()),
          podSatisfied: !photoRequired || photoUploaded,
        },
        items: items.map((item) => this.toPodResponse(item)),
      };
    });
  }

  async createViewUrl(
    userId: string,
    tripId: string,
    stopId: string,
    attemptId: string,
    podFileId: string,
  ) {
    const podFile = await this.prisma.$transaction(async (tx) => {
      await this.authorizeAttempt(tx, userId, tripId, stopId, attemptId);
      const found = await tx.podFile.findFirst({
        where: {
          id: podFileId,
          deliveryAttemptId: attemptId,
          uploadStatus: UploadStatus.UPLOADED,
        },
        select: { id: true, storageKey: true, mediaType: true },
      });
      if (!found) throw this.notFound();
      return found;
    });
    const expiresAt = new Date(Date.now() + POD_VIEW_URL_TTL_MS);
    const format = podFile.mediaType === "image/png" ? "png" : "jpg";
    return {
      id: podFile.id,
      url: this.cloudinary.createPodDownloadUrl(
        podFile.storageKey,
        format,
        expiresAt,
      ),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async reserveUpload(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      tripId: string;
      stopId: string;
      attemptId: string;
      dto: UploadDriverPodDto;
      capturedAt: Date;
      checksum: string;
      requestHash: string;
      mediaType: string;
      sizeBytes: number;
    },
  ): Promise<ReservedUpload> {
    await this.authorizeAttempt(
      tx,
      input.userId,
      input.tripId,
      input.stopId,
      input.attemptId,
    );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POD_COMMAND_LOCK_NAMESPACE}::int4, hashtext(${`${input.userId}:${POD_COMMAND_TYPE}:${input.dto.idempotencyKey}`})::int4)`;

    const existing = await tx.processedCommand.findUnique({
      where: {
        actorUserId_commandType_idempotencyKey: {
          actorUserId: input.userId,
          commandType: POD_COMMAND_TYPE,
          idempotencyKey: input.dto.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        this.conflict(
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "Idempotency key đã được dùng với file hoặc payload khác",
        );
      }
      const podFile = await tx.podFile.findUnique({
        where: { id: existing.id },
      });
      if (!podFile) {
        this.conflict(
          "POD_UPLOAD_STATE_CONFLICT",
          "Không tìm thấy PodFile của upload command",
        );
      }
      if (podFile.uploadStatus === UploadStatus.UPLOADED) {
        const selected = await tx.podFile.findUniqueOrThrow({
          where: { id: podFile.id },
          select: POD_FILE_SELECT,
        });
        return {
          podFileId: podFile.id,
          storageKey: podFile.storageKey,
          sizeBytes: podFile.sizeBytes,
          replay: this.toPodResponse(selected),
        };
      }
      const isRecentUpload =
        podFile.uploadStatus === UploadStatus.UPLOADING &&
        Date.now() - existing.updatedAt.getTime() < UPLOAD_STALE_AFTER_MS;
      if (isRecentUpload) {
        this.conflict(
          "IDEMPOTENCY_COMMAND_IN_PROGRESS",
          "Upload POD đang được xử lý, vui lòng thử lại sau",
        );
      }
      await tx.podFile.update({
        where: { id: podFile.id },
        data: { uploadStatus: UploadStatus.UPLOADING },
      });
      await tx.processedCommand.update({
        where: { id: existing.id },
        data: { status: "PROCESSING" },
      });
      return {
        podFileId: podFile.id,
        storageKey: podFile.storageKey,
        sizeBytes: podFile.sizeBytes,
      };
    }

    if (input.dto.supersedesId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${POD_REPLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${input.dto.supersedesId})::int4)`;
      const superseded = await tx.podFile.findFirst({
        where: {
          id: input.dto.supersedesId,
          deliveryAttemptId: input.attemptId,
          evidenceType: input.dto.evidenceType,
          uploadStatus: UploadStatus.UPLOADED,
        },
        select: {
          id: true,
          replacements: {
            where: { uploadStatus: UploadStatus.UPLOADED },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!superseded) throw this.notFound();
      if (superseded.replacements.length > 0) {
        this.conflict(
          "POD_ALREADY_SUPERSEDED",
          "Bằng chứng này đã được thay thế trước đó",
        );
      }
    } else if (input.dto.evidenceType === PodEvidenceType.SIGNATURE) {
      const activeSignature = await tx.podFile.findFirst({
        where: {
          deliveryAttemptId: input.attemptId,
          evidenceType: PodEvidenceType.SIGNATURE,
          uploadStatus: UploadStatus.UPLOADED,
          replacements: {
            none: { uploadStatus: UploadStatus.UPLOADED },
          },
        },
        select: { id: true },
      });
      if (activeSignature) {
        this.conflict(
          "POD_REPLACEMENT_REQUIRED",
          "Chữ ký hiện tại phải được thay thế thay vì tạo thêm",
        );
      }
    }

    const podFileId = randomUUID();
    const storageKey = `tms/pod/${input.attemptId}/${podFileId}`;
    await tx.podFile.create({
      data: {
        id: podFileId,
        deliveryAttemptId: input.attemptId,
        storageKey,
        checksum: input.checksum,
        evidenceType: input.dto.evidenceType,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        uploadStatus: UploadStatus.PENDING,
        capturedAt: input.capturedAt,
        supersedesId: input.dto.supersedesId,
      },
    });
    await tx.processedCommand.create({
      data: {
        id: podFileId,
        actorUserId: input.userId,
        commandType: POD_COMMAND_TYPE,
        idempotencyKey: input.dto.idempotencyKey,
        requestHash: input.requestHash,
        status: "PROCESSING",
        result: { podFileId },
      },
    });
    await tx.podFile.update({
      where: { id: podFileId },
      data: { uploadStatus: UploadStatus.UPLOADING },
    });
    return { podFileId, storageKey, sizeBytes: input.sizeBytes };
  }

  private async authorizeAttempt(
    tx: Prisma.TransactionClient,
    userId: string,
    tripId: string,
    stopId: string,
    attemptId: string,
  ) {
    const driver = await tx.driver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!driver) {
      throw new ConflictException({
        errorCode: "DRIVER_PROFILE_NOT_FOUND",
        message: "Tài khoản DRIVER chưa được liên kết hồ sơ tài xế",
      });
    }
    const trip = await tx.trip.findFirst({
      where: {
        id: tripId,
        status: { in: [TripStatus.IN_PROGRESS, TripStatus.COMPLETED] },
        assignments: {
          some: {
            driverId: driver.id,
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
        },
      },
      select: {
        assignments: {
          where: {
            driverId: driver.id,
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
          select: { role: true },
        },
      },
    });
    if (!trip) throw this.notFound();
    if (
      !trip.assignments.some(
        (assignment) => assignment.role === DRIVER_ASSIGNMENT_ROLE_PRIMARY,
      )
    ) {
      this.conflict(
        "DRIVER_NOT_PRIMARY",
        "Chỉ tài xế PRIMARY được quản lý POD của chuyến",
      );
    }
    const attempt = await tx.deliveryAttempt.findFirst({
      where: {
        id: attemptId,
        tripStopId: stopId,
        tripStop: {
          id: stopId,
          tripId,
          stopType: StopType.DELIVERY,
        },
      },
      select: {
        id: true,
        result: true,
        failureReason: true,
        recipientName: true,
      },
    });
    if (!attempt) throw this.notFound();
    return attempt;
  }

  private validateAndDescribeFile(
    evidenceType: PodEvidenceType,
    file: Express.Multer.File,
  ) {
    if (!file.buffer?.length) {
      throw new BadRequestException({
        errorCode: "POD_FILE_EMPTY",
        message: "File bằng chứng không được rỗng",
      });
    }
    const isJpeg =
      file.buffer.length >= 3 &&
      file.buffer[0] === 0xff &&
      file.buffer[1] === 0xd8 &&
      file.buffer[2] === 0xff;
    const isPng =
      file.buffer.length >= 8 &&
      file.buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const expectedMediaType =
      evidenceType === PodEvidenceType.PHOTO ? "image/jpeg" : "image/png";
    const validMagic = evidenceType === PodEvidenceType.PHOTO ? isJpeg : isPng;
    const maxBytes =
      evidenceType === PodEvidenceType.PHOTO
        ? PHOTO_MAX_BYTES
        : SIGNATURE_MAX_BYTES;
    if (file.buffer.length > maxBytes) {
      throw new BadRequestException({
        errorCode: "POD_FILE_TOO_LARGE",
        message: `File vượt giới hạn ${maxBytes} bytes`,
      });
    }
    if (file.mimetype !== expectedMediaType || !validMagic) {
      throw new BadRequestException({
        errorCode: "POD_FILE_TYPE_INVALID",
        message: `${evidenceType} phải là ${expectedMediaType} hợp lệ`,
      });
    }
    return { mediaType: expectedMediaType };
  }

  private async markUploadFailed(podFileId: string) {
    await this.prisma.$transaction([
      this.prisma.podFile.updateMany({
        where: {
          id: podFileId,
          uploadStatus: UploadStatus.UPLOADING,
        },
        data: { uploadStatus: UploadStatus.FAILED },
      }),
      this.prisma.processedCommand.updateMany({
        where: { id: podFileId, status: "PROCESSING" },
        data: { status: "FAILED" },
      }),
    ]);
  }

  private toPodResponse(podFile: PodFileRecord) {
    return {
      id: podFile.id,
      evidenceType: podFile.evidenceType,
      mediaType: podFile.mediaType,
      sizeBytes: podFile.sizeBytes,
      uploadStatus: podFile.uploadStatus,
      capturedAt: podFile.capturedAt?.toISOString() ?? null,
      uploadedAt: podFile.uploadedAt?.toISOString() ?? null,
      supersedesId: podFile.supersedesId,
      isSuperseded: podFile.replacements.length > 0,
    };
  }

  private notFound() {
    return new NotFoundException("Không tìm thấy bằng chứng giao hàng");
  }

  private conflict(errorCode: string, message: string): never {
    throw new ConflictException({ errorCode, message });
  }
}
