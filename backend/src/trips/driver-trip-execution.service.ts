import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OrderStatus,
  PackageStatus,
  PodEvidenceType,
  Prisma,
  ReservationStatus,
  StopType,
  TaskAction,
  TripStatus,
  UploadStatus,
} from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import {
  DELIVERY_RESULTS,
  DRIVER_ASSIGNMENT_ROLE_PRIMARY,
  DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
  DRIVER_EXECUTION_EVENT,
  DRIVER_TRIP_COMMAND,
  TRIP_STOP_STATUS,
} from "./driver-trip-execution.constants";
import {
  ArriveDriverStopDto,
  CompleteDriverStopDto,
  DriverTripCommandDto,
} from "./dto/driver-trip-command.dto";
import { isDriverPodPhotoRequired } from "./driver-pod-policy";
import { tripStartWindow } from "./service-day";

const TRIP_EXECUTION_LOCK_NAMESPACE = 4201;
const COMMAND_LOCK_NAMESPACE = 4202;
// Shared with planning resource locks. Follow its vehicle-before-driver order.
const VEHICLE_SCHEDULE_LOCK_NAMESPACE = 4101;
const DRIVER_SCHEDULE_LOCK_NAMESPACE = 4102;
const MAX_FUTURE_COMMAND_OFFSET_MS = 5 * 60 * 1000;
const MAX_PAST_COMMAND_OFFSET_MS = 24 * 60 * 60 * 1000;

type TransactionClient = Prisma.TransactionClient;

type AuthorizedTrip = Prisma.TripGetPayload<{
  include: { assignments: true };
}> & { actorDriverId: string };

@Injectable()
export class DriverTripExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  startTrip(userId: string, tripId: string, dto: DriverTripCommandDto) {
    return this.executeCommand(
      userId,
      DRIVER_TRIP_COMMAND.START_TRIP,
      dto.idempotencyKey,
      { tripId, expectedTripVersion: dto.expectedTripVersion },
      tripId,
      async (tx, commandId, trip) => {
        this.assertTripState(trip.status, TripStatus.DISPATCHED);
        this.assertTripVersion(trip.version, dto.expectedTripVersion);

        const runningTrips = await tx.trip.count({
          where: {
            id: { not: tripId },
            status: TripStatus.IN_PROGRESS,
            assignments: {
              some: {
                driver: { userId },
                role: DRIVER_ASSIGNMENT_ROLE_PRIMARY,
                status: { in: [DRIVER_ASSIGNMENT_STATUS_ASSIGNED, "ACCEPTED", "ACTIVE"] },
              },
            },
          },
        });
        if (runningTrips > 0) {
          this.conflict(
            "DRIVER_ALREADY_ON_TRIP",
            "Bạn đang thực hiện một chuyến khác. Hãy hoàn thành chuyến đó trước khi bắt đầu.",
          );
        }

        const branch = await tx.branch.findFirst({
          where: trip.managingBranchId
            ? { id: trip.managingBranchId }
            : { vehicles: { some: { id: trip.vehicleId } } },
          select: { timezone: true },
        });
        const now = new Date();
        if (!branch?.timezone || trip.plannedEndTime <= trip.plannedStartTime) {
          this.conflict("TRIP_START_SCHEDULE_INVALID", "Chuyến thiếu lịch hoặc múi giờ hợp lệ. Hãy liên hệ điều phối.");
        }

        let windowError: ReturnType<typeof tripStartWindow>;
        try {
          windowError = tripStartWindow(now, trip.plannedStartTime, branch.timezone);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          this.conflict("TRIP_START_SCHEDULE_INVALID", "Múi giờ của chuyến không hợp lệ. Hãy liên hệ điều phối.");
        }
        if (windowError) {
          const messages = {
            TRIP_START_BEFORE_SERVICE_DAY: "Chưa đến ngày thực hiện chuyến theo lịch chi nhánh.",
            TRIP_START_TOO_EARLY: "Chỉ có thể bắt đầu trong vòng 30 phút trước giờ dự kiến.",
            TRIP_START_SERVICE_DAY_EXPIRED: "Chuyến đã qua ngày thực hiện. Hãy liên hệ điều phối để kiểm tra lịch.",
          };
          this.conflict(windowError, messages[windowError]);
        }

        const vehicleBusy = await tx.trip.count({
          where: { id: { not: tripId }, vehicleId: trip.vehicleId, status: TripStatus.IN_PROGRESS },
        });
        if (vehicleBusy > 0) {
          this.conflict("VEHICLE_ALREADY_ON_TRIP", "Xe đang thực hiện chuyến khác. Hãy liên hệ điều phối.");
        }

        const reserved = await tx.resourceReservation.findFirst({
          where: {
            tripId: { not: tripId },
            status: { in: [ReservationStatus.HELD, ReservationStatus.ACTIVE] },
            startsAt: { lte: now },
            endsAt: { gt: now },
            trip: { status: { notIn: [TripStatus.COMPLETED, TripStatus.CANCELLED] } },
            OR: [{ vehicleId: trip.vehicleId }, { driverId: trip.actorDriverId }],
          },
          select: { id: true },
        });
        if (reserved) {
          this.conflict("TRIP_START_RESOURCE_RESERVED", "Tài xế hoặc xe đang giữ lịch cho chuyến khác. Hãy liên hệ điều phối.");
        }

        await this.updateTripState(
          tx,
          tripId,
          TripStatus.DISPATCHED,
          dto.expectedTripVersion,
          {
            status: TripStatus.IN_PROGRESS,
            actualStartTime: now,
            version: { increment: 1 },
          },
        );
        await tx.executionEvent.create({
          data: {
            tripId,
            eventType: DRIVER_EXECUTION_EVENT.START_TRIP,
            occurredAt: now,
            actorUserId: userId,
            commandId,
            payload: { previousStatus: trip.status },
          },
        });
        return {
          id: tripId,
          status: TripStatus.IN_PROGRESS,
          version: dto.expectedTripVersion + 1,
          actualStartTime: now.toISOString(),
        };
      },
    );
  }

  arriveStop(
    userId: string,
    tripId: string,
    stopId: string,
    dto: ArriveDriverStopDto,
  ) {
    const requestedOccurredAt = dto.occurredAt
      ? new Date(dto.occurredAt).toISOString()
      : null;
    return this.executeCommand(
      userId,
      DRIVER_TRIP_COMMAND.ARRIVE_STOP,
      dto.idempotencyKey,
      {
        tripId,
        stopId,
        expectedTripVersion: dto.expectedTripVersion,
        occurredAt: requestedOccurredAt,
      },
      tripId,
      async (tx, commandId, trip) => {
        this.assertTripState(trip.status, TripStatus.IN_PROGRESS);
        this.assertTripVersion(trip.version, dto.expectedTripVersion);
        const stop = await this.getTripStop(tx, tripId, stopId);
        if (stop.status !== TRIP_STOP_STATUS.PENDING) {
          this.conflict(
            "INVALID_STOP_STATE",
            `Stop ở trạng thái ${stop.status}, không thể xác nhận đến`,
          );
        }
        await this.assertFirstUnresolvedStop(tx, tripId, stopId);

        const persistedAt = new Date();
        const occurredAt = requestedOccurredAt
          ? new Date(requestedOccurredAt)
          : persistedAt;
        this.assertCommandOccurredAt(occurredAt, persistedAt, {
          tripStartedAt: trip.actualStartTime,
        });
        const updatedStop = await tx.tripStop.updateMany({
          where: { id: stopId, tripId, status: TRIP_STOP_STATUS.PENDING },
          data: {
            status: TRIP_STOP_STATUS.ARRIVED,
            actualArrivalTime: occurredAt,
          },
        });
        if (updatedStop.count !== 1) {
          this.conflict(
            "INVALID_STOP_STATE",
            "Stop đã được request khác thay đổi",
          );
        }
        await this.incrementTripVersion(
          tx,
          tripId,
          TripStatus.IN_PROGRESS,
          dto.expectedTripVersion,
        );
        await tx.executionEvent.create({
          data: {
            tripId,
            tripStopId: stopId,
            eventType: DRIVER_EXECUTION_EVENT.ARRIVE_STOP,
            occurredAt,
            actorUserId: userId,
            commandId,
            payload: { sequence: stop.sequence, stopType: stop.stopType },
          },
        });
        return {
          tripId,
          tripVersion: dto.expectedTripVersion + 1,
          stop: {
            id: stopId,
            status: TRIP_STOP_STATUS.ARRIVED,
            actualArrivalTime: occurredAt.toISOString(),
          },
        };
      },
    );
  }

  completeStop(
    userId: string,
    tripId: string,
    stopId: string,
    dto: CompleteDriverStopDto,
  ) {
    const requestedOccurredAt = dto.occurredAt
      ? new Date(dto.occurredAt).toISOString()
      : null;
    const canonicalTasks = [...dto.tasks]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((task) => ({
        taskId: task.taskId,
        actualQuantity: task.actualQuantity,
      }));
    return this.executeCommand(
      userId,
      DRIVER_TRIP_COMMAND.COMPLETE_STOP,
      dto.idempotencyKey,
      {
        tripId,
        stopId,
        expectedTripVersion: dto.expectedTripVersion,
        occurredAt: requestedOccurredAt,
        tasks: canonicalTasks,
        deliveryResult: dto.deliveryResult ?? null,
        reasonCode: dto.reasonCode ?? null,
        note: dto.note ?? null,
        recipientName: dto.recipientName ?? null,
      },
      tripId,
      async (tx, commandId, trip) => {
        this.assertTripState(trip.status, TripStatus.IN_PROGRESS);
        this.assertTripVersion(trip.version, dto.expectedTripVersion);
        const stop = await this.getTripStopWithTasks(tx, tripId, stopId);
        if (stop.status !== TRIP_STOP_STATUS.ARRIVED) {
          this.conflict(
            "INVALID_STOP_STATE",
            `Stop ở trạng thái ${stop.status}, không thể hoàn thành`,
          );
        }
        await this.assertFirstUnresolvedStop(tx, tripId, stopId);
        this.validateStopExecution(stop, dto);

        const persistedAt = new Date();
        const occurredAt = requestedOccurredAt
          ? new Date(requestedOccurredAt)
          : persistedAt;
        if (!stop.actualArrivalTime) {
          this.conflict(
            "DATA_INTEGRITY_CONFLICT",
            "Stop ARRIVED không có actualArrivalTime",
          );
        }
        this.assertCommandOccurredAt(occurredAt, persistedAt, {
          tripStartedAt: trip.actualStartTime,
          stopArrivedAt: stop.actualArrivalTime,
        });

        const taskInputById = new Map(
          dto.tasks.map((task) => [task.taskId, task]),
        );
        const affectedOrderIds = new Set<string>();
        const seenPackageIds = new Set<string>();

        for (const task of stop.tasks) {
          const input = taskInputById.get(task.id)!;
          const updatedTask = await tx.stopTask.updateMany({
            where: { id: task.id, tripStopId: stopId, actualQuantity: null },
            data: { actualQuantity: input.actualQuantity },
          });
          if (updatedTask.count !== 1) {
            this.conflict(
              "INVALID_TASK_EXECUTION",
              "StopTask đã được xử lý hoặc bị thay đổi bởi request khác",
            );
          }
          if (task.orderId) affectedOrderIds.add(task.orderId);
          if (!task.package) continue;
          if (seenPackageIds.has(task.package.id)) {
            this.conflict(
              "DATA_INTEGRITY_CONFLICT",
              "Một Package xuất hiện nhiều lần trong cùng Stop",
            );
          }
          seenPackageIds.add(task.package.id);
          await this.applyPackageExecution(
            tx,
            stop.stopType,
            task,
            input.actualQuantity,
          );
        }

        await this.updateOrderAggregates(
          tx,
          affectedOrderIds,
          stop.stopType,
          userId,
          commandId,
          occurredAt,
        );

        let deliveryAttempt:
          { id: string; attemptNumber: number; result: string } | undefined;
        if (stop.stopType === StopType.DELIVERY) {
          const latestAttempt = await tx.deliveryAttempt.aggregate({
            where: { tripStopId: stopId },
            _max: { attemptNumber: true },
          });
          const attemptNumber = (latestAttempt._max.attemptNumber ?? 0) + 1;
          deliveryAttempt = await tx.deliveryAttempt.create({
            data: {
              tripStopId: stopId,
              attemptNumber,
              occurredAt,
              recipientName: dto.recipientName ?? null,
              result: dto.deliveryResult!,
              failureReason: dto.reasonCode ?? null,
              commandId,
            },
            select: { id: true, attemptNumber: true, result: true },
          });
        }

        const updatedStop = await tx.tripStop.updateMany({
          where: { id: stopId, tripId, status: TRIP_STOP_STATUS.ARRIVED },
          data: {
            status: TRIP_STOP_STATUS.COMPLETED,
            actualDepartureTime: occurredAt,
          },
        });
        if (updatedStop.count !== 1) {
          this.conflict(
            "INVALID_STOP_STATE",
            "Stop đã được request khác thay đổi",
          );
        }
        await this.incrementTripVersion(
          tx,
          tripId,
          TripStatus.IN_PROGRESS,
          dto.expectedTripVersion,
        );

        const eventType = this.resolveStopEventType(
          stop.stopType,
          dto.deliveryResult,
        );
        await tx.executionEvent.create({
          data: {
            tripId,
            tripStopId: stopId,
            eventType,
            occurredAt,
            actorUserId: userId,
            commandId,
            payload: {
              sequence: stop.sequence,
              stopType: stop.stopType,
              tasks: dto.tasks.map((task) => ({
                taskId: task.taskId,
                actualQuantity: task.actualQuantity,
              })),
              deliveryResult: dto.deliveryResult ?? null,
              reasonCode: dto.reasonCode ?? null,
              note: dto.note ?? null,
            },
          },
        });
        return {
          tripId,
          tripVersion: dto.expectedTripVersion + 1,
          eventType,
          stop: {
            id: stopId,
            status: TRIP_STOP_STATUS.COMPLETED,
            actualDepartureTime: occurredAt.toISOString(),
          },
          deliveryAttempt: deliveryAttempt ?? null,
        };
      },
    );
  }

  completeTrip(userId: string, tripId: string, dto: DriverTripCommandDto) {
    return this.executeCommand(
      userId,
      DRIVER_TRIP_COMMAND.COMPLETE_TRIP,
      dto.idempotencyKey,
      { tripId, expectedTripVersion: dto.expectedTripVersion },
      tripId,
      async (tx, commandId, trip) => {
        this.assertTripState(trip.status, TripStatus.IN_PROGRESS);
        this.assertTripVersion(trip.version, dto.expectedTripVersion);

        const primaryAssignments = trip.assignments.filter(
          (assignment) => assignment.role === DRIVER_ASSIGNMENT_ROLE_PRIMARY,
        );
        const [primary] = primaryAssignments;
        if (
          primaryAssignments.length !== 1 ||
          !primary ||
          primary.driverId !== trip.actorDriverId ||
          primary.actualEndTime !== null ||
          primary.completionEventId !== null
        ) {
          this.conflict(
            "DRIVER_ASSIGNMENT_COMPLETION_CONFLICT",
            "Không xác định được phân công chính chưa hoàn thành của chuyến",
          );
        }

        const [
          unresolvedStops,
          unresolvedTasks,
          deliveryWithoutAttempt,
          deliveryAttempts,
        ] = await Promise.all([
          tx.tripStop.count({
            where: {
              tripId,
              status: {
                notIn: [TRIP_STOP_STATUS.COMPLETED, TRIP_STOP_STATUS.SKIPPED],
              },
            },
          }),
          tx.stopTask.count({
            where: { tripStop: { tripId }, actualQuantity: null },
          }),
          tx.tripStop.count({
            where: {
              tripId,
              stopType: StopType.DELIVERY,
              status: TRIP_STOP_STATUS.COMPLETED,
              deliveryAttempts: { none: {} },
            },
          }),
          tx.deliveryAttempt.findMany({
            where: {
              tripStop: {
                tripId,
                stopType: StopType.DELIVERY,
                status: TRIP_STOP_STATUS.COMPLETED,
              },
            },
            select: {
              result: true,
              failureReason: true,
              podFiles: {
                where: {
                  evidenceType: PodEvidenceType.PHOTO,
                  uploadStatus: UploadStatus.UPLOADED,
                  replacements: {
                    none: { uploadStatus: UploadStatus.UPLOADED },
                  },
                },
                select: { id: true },
                take: 1,
              },
            },
          }),
        ]);
        if (
          unresolvedStops > 0 ||
          unresolvedTasks > 0 ||
          deliveryWithoutAttempt > 0
        ) {
          this.conflict(
            "UNRESOLVED_STOPS",
            "Chuyến còn stop, task hoặc delivery attempt chưa được xử lý",
          );
        }
        const missingRequiredPod = deliveryAttempts.some(
          (attempt) =>
            isDriverPodPhotoRequired(attempt.result, attempt.failureReason) &&
            attempt.podFiles.length === 0,
        );
        if (missingRequiredPod) {
          this.conflict(
            "POD_REQUIRED",
            "Chuyến còn điểm giao chưa có ảnh e-POD bắt buộc",
          );
        }

        const now = new Date();
        await this.updateTripState(
          tx,
          tripId,
          TripStatus.IN_PROGRESS,
          dto.expectedTripVersion,
          {
            status: TripStatus.COMPLETED,
            actualEndTime: now,
            version: { increment: 1 },
          },
        );
        const completion = await tx.executionEvent.create({
          data: {
            tripId,
            eventType: DRIVER_EXECUTION_EVENT.TRIP_COMPLETED,
            occurredAt: now,
            actorUserId: userId,
            commandId,
            payload: { assignmentId: primary.id },
          },
          select: { id: true },
        });
        const updated = await tx.driverAssignment.updateMany({
          where: {
            id: primary.id,
            tripId,
            driverId: trip.actorDriverId,
            role: DRIVER_ASSIGNMENT_ROLE_PRIMARY,
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
            actualEndTime: null,
            completionEventId: null,
          },
          data: { actualEndTime: now, completionEventId: completion.id },
        });
        if (updated.count !== 1) {
          this.conflict(
            "DRIVER_ASSIGNMENT_COMPLETION_CONFLICT",
            "Phân công tài xế đã thay đổi; hãy tải lại chuyến",
          );
        }
        await tx.resourceReservation.updateMany({
          where: {
            tripId,
            status: { in: [ReservationStatus.HELD, ReservationStatus.ACTIVE] },
          },
          data: { status: ReservationStatus.RELEASED },
        });
        return {
          id: tripId,
          status: TripStatus.COMPLETED,
          version: dto.expectedTripVersion + 1,
          actualEndTime: now.toISOString(),
        };
      },
    );
  }

  private async executeCommand<T extends Prisma.JsonObject>(
    userId: string,
    commandType: string,
    idempotencyKey: string,
    hashPayload: Prisma.JsonObject,
    tripId: string,
    mutation: (tx: TransactionClient, commandId: string, trip: AuthorizedTrip) => Promise<T>,
  ): Promise<T | Prisma.JsonValue> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify(hashPayload))
      .digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMAND_LOCK_NAMESPACE}::int4, hashtext(${`${userId}:${commandType}:${idempotencyKey}`})::int4)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIP_EXECUTION_LOCK_NAMESPACE}::int4, hashtext(${tripId})::int4)`;
      let trip = await this.getAuthorizedTrip(tx, userId, tripId);
      const existing = await tx.processedCommand.findUnique({
        where: {
          actorUserId_commandType_idempotencyKey: {
            actorUserId: userId,
            commandType,
            idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          this.conflict(
            "IDEMPOTENCY_PAYLOAD_MISMATCH",
            "Idempotency key đã được dùng với payload khác",
          );
        }
        if (existing.status === "COMPLETED" && existing.result !== null) {
          return existing.result;
        }
        this.conflict(
          "IDEMPOTENCY_COMMAND_IN_PROGRESS",
          "Command đang được xử lý, vui lòng thử lại sau",
        );
      }

      if (
        commandType === DRIVER_TRIP_COMMAND.START_TRIP ||
        commandType === DRIVER_TRIP_COMMAND.COMPLETE_TRIP
      ) {
        const { vehicleId, actorDriverId } = trip;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${VEHICLE_SCHEDULE_LOCK_NAMESPACE}::int4, hashtext(${vehicleId})::int4)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DRIVER_SCHEDULE_LOCK_NAMESPACE}::int4, hashtext(${actorDriverId})::int4)`;
        trip = await this.getAuthorizedTrip(tx, userId, tripId);
        if (trip.vehicleId !== vehicleId || trip.actorDriverId !== actorDriverId) {
          this.conflict("TRIP_VERSION_CONFLICT", "Tài nguyên của chuyến đã thay đổi");
        }
      }
      const commandId = randomUUID();
      await tx.processedCommand.create({
        data: {
          id: commandId,
          actorUserId: userId,
          commandType,
          idempotencyKey,
          requestHash,
          status: "PROCESSING",
        },
      });
      const result = await mutation(tx, commandId, trip);
      await tx.processedCommand.update({
        where: { id: commandId },
        data: { status: "COMPLETED", result },
      });
      // Evaluate deferred evidence checks before handing a receipt back to the caller.
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return result;
    });
  }

  private async getAuthorizedTrip(
    tx: TransactionClient,
    userId: string,
    tripId: string,
  ): Promise<AuthorizedTrip> {
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
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
        },
      },
      include: {
        assignments: {
          where: {
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException("Không tìm thấy chuyến được phân công");
    }
    if (
      !trip.assignments.some(
        (assignment) =>
          assignment.driverId === driver.id && assignment.role === DRIVER_ASSIGNMENT_ROLE_PRIMARY,
      )
    ) {
      this.conflict(
        "DRIVER_NOT_PRIMARY",
        "Chỉ tài xế PRIMARY được thực thi chuyến",
      );
    }
    return { ...trip, actorDriverId: driver.id };
  }

  private async getTripStop(
    tx: TransactionClient,
    tripId: string,
    stopId: string,
  ) {
    const stop = await tx.tripStop.findFirst({ where: { id: stopId, tripId } });
    if (!stop)
      throw new NotFoundException("Không tìm thấy điểm dừng của chuyến");
    return stop;
  }

  private async getTripStopWithTasks(
    tx: TransactionClient,
    tripId: string,
    stopId: string,
  ) {
    const stop = await tx.tripStop.findFirst({
      where: { id: stopId, tripId },
      include: { tasks: { include: { package: true } } },
    });
    if (!stop)
      throw new NotFoundException("Không tìm thấy điểm dừng của chuyến");
    return stop;
  }

  private async assertFirstUnresolvedStop(
    tx: TransactionClient,
    tripId: string,
    stopId: string,
  ) {
    const first = await tx.tripStop.findFirst({
      where: {
        tripId,
        status: {
          notIn: [TRIP_STOP_STATUS.COMPLETED, TRIP_STOP_STATUS.SKIPPED],
        },
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!first || first.id !== stopId) {
      this.conflict("STOP_OUT_OF_SEQUENCE", "Điểm dừng chưa đến lượt thực thi");
    }
  }

  private validateStopExecution(
    stop: Awaited<
      ReturnType<DriverTripExecutionService["getTripStopWithTasks"]>
    >,
    dto: CompleteDriverStopDto,
  ) {
    const expectedIds = new Set(stop.tasks.map((task) => task.id));
    const receivedIds = new Set(dto.tasks.map((task) => task.taskId));
    if (
      expectedIds.size !== receivedIds.size ||
      [...expectedIds].some((id) => !receivedIds.has(id))
    ) {
      this.conflict(
        "INVALID_TASK_EXECUTION",
        "Payload phải chứa đúng và đầy đủ StopTask của điểm dừng",
      );
    }

    const isDepot =
      stop.stopType === StopType.DEPOT_START ||
      stop.stopType === StopType.DEPOT_END;
    if (isDepot) {
      if (
        stop.tasks.length > 0 ||
        dto.tasks.length > 0 ||
        dto.deliveryResult != null ||
        dto.reasonCode != null ||
        dto.recipientName != null
      ) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Depot stop không nhận task hoặc dữ liệu giao hàng",
        );
      }
      return;
    }

    const expectedAction =
      stop.stopType === StopType.PICKUP ? TaskAction.LOAD : TaskAction.UNLOAD;
    if (
      stop.tasks.some(
        (task) =>
          task.action !== expectedAction ||
          !task.packageId ||
          !task.orderId ||
          !task.package,
      )
    ) {
      this.conflict(
        "DATA_INTEGRITY_CONFLICT",
        "StopTask không có action hoặc Package/Order mapping hợp lệ",
      );
    }
    for (const task of stop.tasks) {
      const input = dto.tasks.find((item) => item.taskId === task.id)!;
      if (input.actualQuantity > task.plannedQuantity) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "actualQuantity không được lớn hơn plannedQuantity",
        );
      }
      if (
        task.packageId &&
        (task.plannedQuantity !== 1 || ![0, 1].includes(input.actualQuantity))
      ) {
        this.conflict(
          "DATA_INTEGRITY_CONFLICT",
          "Task ánh xạ physical Package phải có quantity 0 hoặc 1",
        );
      }
    }

    const hasShortage = stop.tasks.some((task) => {
      const actual = dto.tasks.find((item) => item.taskId === task.id)!;
      return actual.actualQuantity < task.plannedQuantity;
    });
    if (stop.stopType === StopType.PICKUP) {
      if (dto.deliveryResult != null || dto.recipientName != null) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Pickup không nhận deliveryResult hoặc recipientName",
        );
      }
      if (hasShortage && !dto.reasonCode) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Pickup partial/zero phải có reasonCode",
        );
      }
    } else {
      if (
        !dto.deliveryResult ||
        !DELIVERY_RESULTS.includes(dto.deliveryResult)
      ) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery phải có deliveryResult hợp lệ",
        );
      }
      if (
        ["SUCCESS", "PARTIAL"].includes(dto.deliveryResult) &&
        !dto.recipientName?.trim()
      ) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery SUCCESS/PARTIAL phải có tên người nhận",
        );
      }
      const totalActual = dto.tasks.reduce(
        (sum, task) => sum + task.actualQuantity,
        0,
      );
      if (dto.deliveryResult === "SUCCESS" && hasShortage) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery SUCCESS yêu cầu mọi task đủ số lượng",
        );
      }
      if (
        dto.deliveryResult === "PARTIAL" &&
        (!hasShortage || totalActual <= 0)
      ) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery PARTIAL phải giao ít nhất một kiện và còn thiếu",
        );
      }
      if (dto.deliveryResult === "FAILED" && totalActual !== 0) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery FAILED yêu cầu actualQuantity bằng 0",
        );
      }
      if (
        ["PARTIAL", "FAILED"].includes(dto.deliveryResult) &&
        !dto.reasonCode
      ) {
        this.conflict(
          "INVALID_TASK_EXECUTION",
          "Delivery PARTIAL/FAILED phải có reasonCode",
        );
      }
    }
    if (dto.reasonCode === "OTHER" && !dto.note?.trim()) {
      this.conflict("INVALID_TASK_EXECUTION", "reasonCode OTHER phải có note");
    }
  }

  private async applyPackageExecution(
    tx: TransactionClient,
    stopType: StopType,
    task: Awaited<
      ReturnType<DriverTripExecutionService["getTripStopWithTasks"]>
    >["tasks"][number],
    actualQuantity: number,
  ) {
    const pkg = task.package!;
    const expectedStatus =
      stopType === StopType.PICKUP
        ? PackageStatus.ALLOCATED
        : PackageStatus.LOADED;
    if (pkg.status !== expectedStatus) {
      this.conflict(
        "DATA_INTEGRITY_CONFLICT",
        `Package không ở trạng thái ${expectedStatus}`,
      );
    }
    if (actualQuantity === 0) return;
    const nextStatus =
      stopType === StopType.PICKUP
        ? PackageStatus.LOADED
        : PackageStatus.DELIVERED;
    const updated = await tx.package.updateMany({
      where: { id: pkg.id, status: expectedStatus, version: pkg.version },
      data: { status: nextStatus, version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      this.conflict(
        "DATA_INTEGRITY_CONFLICT",
        "Package đã được request khác thay đổi",
      );
    }
  }

  private async updateOrderAggregates(
    tx: TransactionClient,
    orderIds: Set<string>,
    stopType: StopType,
    actorUserId: string,
    commandId: string,
    occurredAt: Date,
  ) {
    if (stopType !== StopType.PICKUP && stopType !== StopType.DELIVERY) return;
    for (const orderId of orderIds) {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          version: true,
          packages: { select: { status: true } },
        },
      });
      if (!order || order.packages.length === 0) {
        this.conflict(
          "DATA_INTEGRITY_CONFLICT",
          "Order không có Package hợp lệ để cập nhật trạng thái",
        );
      }
      let nextStatus: OrderStatus | null = null;
      if (
        stopType === StopType.PICKUP &&
        order.status === OrderStatus.ASSIGNED &&
        order.packages.some(
          (pkg) =>
            pkg.status === PackageStatus.LOADED ||
            pkg.status === PackageStatus.DELIVERED,
        )
      ) {
        nextStatus = OrderStatus.IN_TRANSIT;
      }
      const activePackages = order.packages.filter(
        (pkg) => pkg.status !== PackageStatus.CANCELLED,
      );
      if (
        stopType === StopType.DELIVERY &&
        order.status === OrderStatus.IN_TRANSIT &&
        activePackages.length > 0 &&
        activePackages.every((pkg) => pkg.status === PackageStatus.DELIVERED)
      ) {
        nextStatus = OrderStatus.COMPLETED;
      }
      if (!nextStatus) continue;
      const updated = await tx.order.updateMany({
        where: { id: orderId, status: order.status, version: order.version },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        this.conflict(
          "DATA_INTEGRITY_CONFLICT",
          "Order đã được request khác thay đổi",
        );
      }
      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_STATUS_CHANGED_BY_DRIVER_EXECUTION",
          fromStatus: order.status,
          toStatus: nextStatus,
          actorUserId,
          commandId: `${commandId}:${orderId}`,
          occurredAt,
          payload: { rootCommandId: commandId, stopType },
        },
      });
    }
  }

  private resolveStopEventType(
    stopType: StopType,
    deliveryResult?: string | null,
  ) {
    if (stopType === StopType.PICKUP) {
      return DRIVER_EXECUTION_EVENT.PICKUP_COMPLETED;
    }
    if (stopType === StopType.DELIVERY) {
      return deliveryResult === "FAILED"
        ? DRIVER_EXECUTION_EVENT.DELIVERY_FAILED
        : DRIVER_EXECUTION_EVENT.DELIVERY_COMPLETED;
    }
    return DRIVER_EXECUTION_EVENT.DEPOT_STOP_COMPLETED;
  }

  private assertTripState(actual: TripStatus, expected: TripStatus) {
    if (actual !== expected) {
      this.conflict(
        "INVALID_TRIP_STATE",
        `Trip ở trạng thái ${actual}, yêu cầu ${expected}`,
      );
    }
  }

  private assertTripVersion(actual: number, expected: number) {
    if (actual !== expected) {
      this.conflict(
        "TRIP_VERSION_CONFLICT",
        `Trip version hiện tại là ${actual}, request dùng ${expected}`,
      );
    }
  }

  private assertCommandOccurredAt(
    occurredAt: Date,
    persistedAt: Date,
    boundaries: {
      tripStartedAt: Date | null;
      stopArrivedAt?: Date;
    },
  ) {
    const offset = occurredAt.getTime() - persistedAt.getTime();
    if (
      offset > MAX_FUTURE_COMMAND_OFFSET_MS ||
      offset < -MAX_PAST_COMMAND_OFFSET_MS
    ) {
      this.invalidCommandTimestamp(
        "occurredAt phải nằm trong 24 giờ trước và không quá 5 phút trong tương lai",
      );
    }
    if (!boundaries.tripStartedAt) {
      this.conflict(
        "DATA_INTEGRITY_CONFLICT",
        "Trip IN_PROGRESS không có actualStartTime",
      );
    }
    if (occurredAt < boundaries.tripStartedAt) {
      this.invalidCommandTimestamp(
        "occurredAt không được trước thời điểm bắt đầu Trip",
      );
    }
    if (boundaries.stopArrivedAt && occurredAt < boundaries.stopArrivedAt) {
      this.invalidCommandTimestamp(
        "occurredAt hoàn thành Stop không được trước thời điểm đến Stop",
      );
    }
  }

  private invalidCommandTimestamp(message: string): never {
    throw new BadRequestException({
      errorCode: "INVALID_COMMAND_TIMESTAMP",
      message,
    });
  }

  private incrementTripVersion(
    tx: TransactionClient,
    tripId: string,
    status: TripStatus,
    version: number,
  ) {
    return this.updateTripState(tx, tripId, status, version, {
      version: { increment: 1 },
    });
  }

  private async updateTripState(
    tx: TransactionClient,
    tripId: string,
    status: TripStatus,
    version: number,
    data: Prisma.TripUpdateManyMutationInput,
  ) {
    const updated = await tx.trip.updateMany({
      where: { id: tripId, status, version },
      data,
    });
    if (updated.count !== 1) {
      this.conflict(
        "TRIP_VERSION_CONFLICT",
        "Trip đã được request khác thay đổi",
      );
    }
  }

  private conflict(errorCode: string, message: string): never {
    throw new ConflictException({ errorCode, message });
  }
}
