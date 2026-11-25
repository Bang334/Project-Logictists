import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, TripStatus } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import {
  DRIVER_INCIDENT_COMMAND,
  DRIVER_INCIDENT_EVENT,
  DRIVER_INCIDENT_STATUS_OPEN,
} from "./driver-incidents.constants";
import {
  DRIVER_ASSIGNMENT_ROLE_PRIMARY,
  DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
} from "./driver-trip-execution.constants";
import {
  CreateDriverIncidentDto,
  QueryDriverIncidentsDto,
} from "./dto/driver-incident.dto";

const COMMAND_LOCK_NAMESPACE = 4202;
const TRIP_EXECUTION_LOCK_NAMESPACE = 4201;
const MAX_FUTURE_OFFSET_MS = 5 * 60 * 1000;
const MAX_PAST_OFFSET_MS = 24 * 60 * 60 * 1000;
const READABLE_TRIP_STATUSES = [
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
  TripStatus.COMPLETED,
  TripStatus.CANCELLED,
];
const CREATABLE_TRIP_STATUSES = new Set<TripStatus>([
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
]);

type TransactionClient = Prisma.TransactionClient;

const INCIDENT_SELECT = Prisma.validator<Prisma.IncidentSelect>()({
  id: true,
  tripId: true,
  type: true,
  severity: true,
  status: true,
  description: true,
  occurredAt: true,
  resolution: true,
  createdAt: true,
  updatedAt: true,
  orders: {
    select: { order: { select: { id: true, orderNumber: true } } },
    orderBy: { orderId: Prisma.SortOrder.asc },
  },
});

type IncidentRecord = Prisma.IncidentGetPayload<{
  select: typeof INCIDENT_SELECT;
}>;

@Injectable()
export class DriverIncidentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, tripId: string, dto: CreateDriverIncidentDto) {
    const occurredAt = new Date(dto.occurredAt);
    const affectedOrderIds = [...(dto.affectedOrderIds ?? [])].sort();
    const hashPayload: Prisma.JsonObject = {
      tripId,
      type: dto.type,
      severity: dto.severity,
      description: dto.description,
      occurredAt: occurredAt.toISOString(),
      affectedOrderIds,
    };
    const requestHash = createHash("sha256")
      .update(JSON.stringify(hashPayload))
      .digest("hex");

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMAND_LOCK_NAMESPACE}::int4, hashtext(${`${userId}:${DRIVER_INCIDENT_COMMAND}:${dto.idempotencyKey}`})::int4)`;
      const existing = await tx.processedCommand.findUnique({
        where: {
          actorUserId_commandType_idempotencyKey: {
            actorUserId: userId,
            commandType: DRIVER_INCIDENT_COMMAND,
            idempotencyKey: dto.idempotencyKey,
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

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TRIP_EXECUTION_LOCK_NAMESPACE}::int4, hashtext(${tripId})::int4)`;
      const { driverId, vehicleId, status } = await this.getAuthorizedTrip(
        tx,
        userId,
        tripId,
        true,
      );
      if (!CREATABLE_TRIP_STATUSES.has(status)) {
        this.conflict(
          "INVALID_TRIP_STATE",
          `Không thể báo sự cố khi chuyến ở trạng thái ${status}`,
        );
      }
      this.assertOccurredAt(occurredAt, new Date());
      const affectedOrders = await this.getAffectedOrders(
        tx,
        tripId,
        affectedOrderIds,
      );
      const commandId = this.createCommandId();
      await tx.processedCommand.create({
        data: {
          id: commandId,
          actorUserId: userId,
          commandType: DRIVER_INCIDENT_COMMAND,
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          status: "PROCESSING",
        },
      });
      const incident = await tx.incident.create({
        data: {
          tripId,
          vehicleId,
          driverId,
          type: dto.type,
          severity: dto.severity,
          status: DRIVER_INCIDENT_STATUS_OPEN,
          occurredAt,
          reporterId: userId,
          description: dto.description,
          orders:
            affectedOrders.length === 0
              ? undefined
              : {
                  create: affectedOrders.map((order) => ({
                    order: { connect: { id: order.id } },
                  })),
                },
        },
        select: INCIDENT_SELECT,
      });
      await tx.executionEvent.create({
        data: {
          tripId,
          eventType: DRIVER_INCIDENT_EVENT,
          occurredAt,
          actorUserId: userId,
          commandId,
          payload: {
            incidentId: incident.id,
            type: incident.type,
            severity: incident.severity,
            affectedOrderIds,
            occurredAt: occurredAt.toISOString(),
          },
        },
      });
      const result = this.toResponse(incident);
      await tx.processedCommand.update({
        where: { id: commandId },
        data: { status: "COMPLETED", result },
      });
      return result;
    });
  }

  async findAll(
    userId: string,
    tripId: string,
    query: QueryDriverIncidentsDto,
  ) {
    await this.getAuthorizedTrip(this.prisma, userId, tripId, false);
    const where: Prisma.IncidentWhereInput = {
      tripId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const skip = (query.page - 1) * query.limit;
    const [incidents, total] = await this.prisma.$transaction([
      this.prisma.incident.findMany({
        where,
        select: INCIDENT_SELECT,
        orderBy: [
          { occurredAt: Prisma.SortOrder.desc },
          { id: Prisma.SortOrder.desc },
        ],
        skip,
        take: query.limit,
      }),
      this.prisma.incident.count({ where }),
    ]);
    return {
      items: incidents.map((incident) => this.toResponse(incident)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    };
  }

  async findOne(userId: string, tripId: string, incidentId: string) {
    await this.getAuthorizedTrip(this.prisma, userId, tripId, false);
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, tripId },
      select: INCIDENT_SELECT,
    });
    if (!incident) {
      throw new NotFoundException("Không tìm thấy sự cố của chuyến");
    }
    return this.toResponse(incident);
  }

  private async getAuthorizedTrip(
    client: TransactionClient | PrismaService,
    userId: string,
    tripId: string,
    requirePrimary: boolean,
  ) {
    const driver = await client.driver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!driver) {
      throw new ConflictException({
        errorCode: "DRIVER_PROFILE_NOT_FOUND",
        message: "Tài khoản DRIVER chưa được liên kết với hồ sơ tài xế",
      });
    }
    const trip = await client.trip.findFirst({
      where: {
        id: tripId,
        status: { in: READABLE_TRIP_STATUSES },
        assignments: {
          some: {
            driverId: driver.id,
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
        },
      },
      select: {
        status: true,
        vehicleId: true,
        assignments: {
          where: {
            driverId: driver.id,
            status: DRIVER_ASSIGNMENT_STATUS_ASSIGNED,
          },
          select: { role: true },
        },
      },
    });
    if (!trip) {
      throw new NotFoundException("Không tìm thấy chuyến được phân công");
    }
    if (
      requirePrimary &&
      !trip.assignments.some(
        (assignment) => assignment.role === DRIVER_ASSIGNMENT_ROLE_PRIMARY,
      )
    ) {
      this.conflict(
        "DRIVER_NOT_PRIMARY",
        "Chỉ tài xế PRIMARY được báo sự cố cho chuyến",
      );
    }
    return {
      driverId: driver.id,
      vehicleId: trip.vehicleId,
      status: trip.status,
    };
  }

  private async getAffectedOrders(
    tx: TransactionClient,
    tripId: string,
    affectedOrderIds: string[],
  ) {
    if (affectedOrderIds.length === 0) return [];
    const tasks = await tx.stopTask.findMany({
      where: {
        tripStop: { tripId },
        orderId: { in: affectedOrderIds },
      },
      select: { order: { select: { id: true, orderNumber: true } } },
      distinct: ["orderId"],
    });
    const orders = tasks.flatMap((task) => (task.order ? [task.order] : []));
    if (orders.length !== affectedOrderIds.length) {
      this.conflict(
        "INCIDENT_ORDER_NOT_IN_TRIP",
        "Có đơn hàng bị ảnh hưởng không thuộc chuyến",
      );
    }
    return orders.sort((left, right) => left.id.localeCompare(right.id));
  }

  private assertOccurredAt(occurredAt: Date, now: Date) {
    const offset = occurredAt.getTime() - now.getTime();
    if (offset > MAX_FUTURE_OFFSET_MS || offset < -MAX_PAST_OFFSET_MS) {
      throw new BadRequestException({
        errorCode: "INVALID_INCIDENT_OCCURRED_AT",
        message:
          "Thời điểm sự cố phải nằm trong 24 giờ trước và không quá 5 phút trong tương lai",
      });
    }
  }

  private toResponse(incident: IncidentRecord): Prisma.JsonObject {
    return {
      id: incident.id,
      tripId: incident.tripId,
      type: incident.type,
      severity: incident.severity,
      status: incident.status,
      description: incident.description,
      occurredAt: incident.occurredAt.toISOString(),
      resolution: incident.resolution,
      createdAt: incident.createdAt.toISOString(),
      updatedAt: incident.updatedAt.toISOString(),
      affectedOrders: incident.orders.map(({ order }) => order),
    };
  }

  private createCommandId() {
    return randomUUID();
  }

  private conflict(errorCode: string, message: string): never {
    throw new ConflictException({ errorCode, message });
  }
}
