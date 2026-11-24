import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, Role, TripStatus } from "@prisma/client";
import { assertBranchAccess } from "../auth/branch-scope";
import { PrismaService } from "../prisma/prisma.service";
import { IngestDriverGpsDto } from "./dto/driver-gps.dto";

const GPS_SESSION_LOCK_NAMESPACE = 4204;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1_000;
const COMPLETED_BACKLOG_WINDOW_MS = 30 * 60 * 1_000;
const STALE_THRESHOLD_MS = 2 * 60 * 1_000;
const ASSIGNMENT_STATUS_ASSIGNED = "ASSIGNED";
const ASSIGNMENT_ROLE_PRIMARY = "PRIMARY";

type TransactionClient = Prisma.TransactionClient;

type GpsPoint = {
  sequence: number;
  latitude: number;
  longitude: number;
  accuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  measuredAt: Date;
};

@Injectable()
export class DriverGpsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(userId: string, tripId: string, dto: IngestDriverGpsDto) {
    const receivedAt = new Date();
    const points = dto.points.map((point) => ({
      ...point,
      measuredAt: new Date(point.measuredAt),
    }));
    this.assertTimestampBounds(points, receivedAt);

    return this.prisma.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (!driver) {
        throw new ConflictException({
          errorCode: "DRIVER_PROFILE_NOT_FOUND",
          message: "Tài khoản DRIVER chưa được liên kết với hồ sơ tài xế",
        });
      }

      const trip = await tx.trip.findFirst({
        where: {
          id: tripId,
          assignments: {
            some: {
              driverId: driver.id,
              status: ASSIGNMENT_STATUS_ASSIGNED,
            },
          },
        },
        select: {
          id: true,
          status: true,
          vehicleId: true,
          actualStartTime: true,
          actualEndTime: true,
          assignments: {
            where: {
              driverId: driver.id,
              status: ASSIGNMENT_STATUS_ASSIGNED,
            },
            select: { role: true },
          },
        },
      });
      if (!trip) {
        throw new NotFoundException("Không tìm thấy chuyến được phân công");
      }
      if (
        !trip.assignments.some(
          (assignment) => assignment.role === ASSIGNMENT_ROLE_PRIMARY,
        )
      ) {
        throw new ConflictException({
          errorCode: "DRIVER_NOT_PRIMARY",
          message: "Chỉ tài xế PRIMARY được gửi vị trí chuyến",
        });
      }
      this.assertTrackingState(trip, points, receivedAt);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GPS_SESSION_LOCK_NAMESPACE}::int4, hashtext(${dto.deviceSessionId})::int4)`;
      await this.assertSessionConsistency(tx, {
        deviceCode: dto.deviceCode,
        deviceSessionId: dto.deviceSessionId,
        driverId: driver.id,
        tripId,
        vehicleId: trip.vehicleId,
      });

      const inserted = await tx.gpsEvent.createMany({
        data: points.map((point) => ({
          deviceCode: dto.deviceCode,
          deviceSessionId: dto.deviceSessionId,
          sequence: BigInt(point.sequence),
          driverId: driver.id,
          vehicleId: trip.vehicleId,
          tripId,
          measuredAt: point.measuredAt,
          receivedAt,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracyM: point.accuracyM,
          speedKph:
            point.speedMps === undefined ? undefined : point.speedMps * 3.6,
          headingDegrees: point.headingDeg,
        })),
        skipDuplicates: true,
      });

      const latestPersistedPoint = await tx.gpsEvent.findFirstOrThrow({
        where: {
          deviceCode: dto.deviceCode,
          deviceSessionId: dto.deviceSessionId,
          sequence: { in: points.map((point) => BigInt(point.sequence)) },
          driverId: driver.id,
          tripId,
          vehicleId: trip.vehicleId,
        },
        orderBy: [
          { measuredAt: "desc" },
          { sequence: "desc" },
          { id: "desc" },
        ],
        select: {
          latitude: true,
          longitude: true,
          measuredAt: true,
        },
      });
      await tx.vehicle.updateMany({
        where: {
          id: trip.vehicleId,
          OR: [
            { lastLocationAt: null },
            { lastLocationAt: { lt: latestPersistedPoint.measuredAt } },
          ],
        },
        data: {
          currentLatitude: Number(latestPersistedPoint.latitude),
          currentLongitude: Number(latestPersistedPoint.longitude),
          lastLocationAt: latestPersistedPoint.measuredAt,
        },
      });

      return {
        tripId,
        deviceSessionId: dto.deviceSessionId,
        acceptedCount: inserted.count,
        duplicateCount: points.length - inserted.count,
        receivedAt: receivedAt.toISOString(),
      };
    });
  }

  async getLatest(
    tripId: string,
    user: { role: Role; branchId?: string | null },
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        vehicleId: true,
        managingBranchId: true,
        vehicle: { select: { homeBranchId: true } },
      },
    });
    if (!trip) throw new NotFoundException("Không tìm thấy chuyến đi");

    assertBranchAccess(
      user,
      trip.managingBranchId ?? trip.vehicle.homeBranchId,
    );
    const latest = await this.prisma.gpsEvent.findFirst({
      where: { tripId },
      orderBy: [{ measuredAt: "desc" }, { receivedAt: "desc" }, { id: "desc" }],
      select: {
        latitude: true,
        longitude: true,
        accuracyM: true,
        speedKph: true,
        headingDegrees: true,
        measuredAt: true,
        receivedAt: true,
      },
    });
    if (!latest) {
      throw new NotFoundException({
        errorCode: "GPS_POSITION_NOT_FOUND",
        message: "Chuyến chưa có dữ liệu vị trí GPS",
      });
    }

    return {
      tripId: trip.id,
      vehicleId: trip.vehicleId,
      latitude: Number(latest.latitude),
      longitude: Number(latest.longitude),
      accuracyM: latest.accuracyM === null ? null : Number(latest.accuracyM),
      speedKph: latest.speedKph === null ? null : Number(latest.speedKph),
      headingDegrees:
        latest.headingDegrees === null ? null : Number(latest.headingDegrees),
      measuredAt: latest.measuredAt.toISOString(),
      receivedAt: latest.receivedAt.toISOString(),
      isStale: Date.now() - latest.measuredAt.getTime() > STALE_THRESHOLD_MS,
    };
  }

  private assertTimestampBounds(points: GpsPoint[], receivedAt: Date) {
    const futureLimit = receivedAt.getTime() + MAX_FUTURE_SKEW_MS;
    if (
      points.some(
        (point) =>
          !Number.isFinite(point.measuredAt.getTime()) ||
          point.measuredAt.getTime() > futureLimit,
      )
    ) {
      throw new BadRequestException({
        errorCode: "GPS_TIMESTAMP_INVALID",
        message: "measuredAt không hợp lệ hoặc vượt quá 2 phút trong tương lai",
      });
    }
  }

  private assertTrackingState(
    trip: {
      status: TripStatus;
      actualStartTime: Date | null;
      actualEndTime: Date | null;
    },
    points: GpsPoint[],
    receivedAt: Date,
  ) {
    if (trip.status === TripStatus.IN_PROGRESS) return;
    if (trip.status === TripStatus.COMPLETED) {
      const { actualStartTime, actualEndTime } = trip;
      const insideGraceWindow =
        actualStartTime !== null &&
        actualEndTime !== null &&
        receivedAt.getTime() <=
          actualEndTime.getTime() + COMPLETED_BACKLOG_WINDOW_MS;
      const allMeasuredDuringTrip =
        insideGraceWindow &&
        points.every(
          (point) =>
            point.measuredAt >= actualStartTime &&
            point.measuredAt <= actualEndTime,
        );
      if (allMeasuredDuringTrip) return;
    }
    throw new ConflictException({
      errorCode: "GPS_TRACKING_NOT_ALLOWED",
      message: `Trip ở trạng thái ${trip.status}, không được nhận GPS`,
    });
  }

  private async assertSessionConsistency(
    tx: TransactionClient,
    expected: {
      deviceCode: string;
      deviceSessionId: string;
      driverId: string;
      tripId: string;
      vehicleId: string;
    },
  ) {
    const existing = await tx.gpsEvent.findFirst({
      where: { deviceSessionId: expected.deviceSessionId },
      select: {
        deviceCode: true,
        driverId: true,
        tripId: true,
        vehicleId: true,
      },
    });
    if (
      existing &&
      (existing.deviceCode !== expected.deviceCode ||
        existing.driverId !== expected.driverId ||
        existing.tripId !== expected.tripId ||
        existing.vehicleId !== expected.vehicleId)
    ) {
      throw new ConflictException({
        errorCode: "TRACKING_SESSION_CONFLICT",
        message: "Tracking session đã thuộc chuyến hoặc thiết bị khác",
      });
    }
  }

}
