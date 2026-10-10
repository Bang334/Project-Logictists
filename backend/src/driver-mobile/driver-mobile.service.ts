import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, TripStatus } from "@prisma/client";
import { createHash, randomUUID } from "crypto";
import { AuthService } from "../auth/auth.service";
import { assertPermission, PermissionCode, Principal } from "../auth/access";
import { PrismaService } from "../prisma/prisma.service";
import { AssignmentQuery, AssignmentResponseDto } from "./driver-mobile.dto";

const visibleStatuses: TripStatus[] = [
  "DISPATCHED",
  "IN_PROGRESS",
  "COMPLETED",
];
const assignmentFields = {
  id: true,
  status: true,
  version: true,
  offeredAt: true,
  respondedAt: true,
  rejectionReason: true,
  startTime: true,
  endTime: true,
  role: true,
} as const;
const stopFields = {
  id: true,
  sequence: true,
  stopType: true,
  address: true,
  latitude: true,
  longitude: true,
  contactName: true,
  contactPhone: true,
  plannedArrivalTime: true,
  plannedDepartureTime: true,
  actualArrivalTime: true,
  actualDepartureTime: true,
  status: true,
} as const;
const tripFields = {
  id: true,
  tripNumber: true,
  status: true,
  version: true,
  plannedStartTime: true,
  plannedEndTime: true,
  actualStartTime: true,
  actualEndTime: true,
  executionSnapshot: { select: { id: true, sourceTripVersion: true } },
  vehicle: { select: { id: true, plateNumber: true, model: true } },
} as const;
const packageFields = {
  id: true,
  packageCode: true,
  lengthMm: true,
  widthMm: true,
  heightMm: true,
  weightG: true,
} as const;

@Injectable()
export class DriverMobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async identity(
    user: Principal,
    permission: PermissionCode,
    tx: Prisma.TransactionClient,
  ) {
    // Read session/grants again inside the same transaction as the command.
    const current = await this.auth.authenticatePayload(
      { sub: user.id, sid: user.sessionId },
      tx,
    );
    const driver = await tx.driver.findUnique({
      where: { userId: current.id },
      select: {
        id: true,
        fullName: true,
        phone: true,
        homeBranchId: true,
        homeBranch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!driver)
      throw new ForbiddenException({
        code: "DRIVER_NOT_LINKED",
        message: "Tài khoản chưa liên kết hồ sơ tài xế",
      });
    assertPermission(current, permission, driver.homeBranchId);
    return driver;
  }
  me(user: Principal) {
    return this.prisma.$transaction((tx) =>
      this.identity(user, "driver.profile.read", tx),
    );
  }
  list(user: Principal, query: AssignmentQuery) {
    for (const date of [query.from, query.to])
      if (date && !/(Z|[+-]\d{2}:\d{2})$/.test(date))
        throw new BadRequestException("Thời gian lọc phải có timezone");
    if (query.from && query.to && new Date(query.from) > new Date(query.to))
      throw new BadRequestException("Khoảng thời gian không hợp lệ");
    return this.prisma.$transaction(
      async (tx) => {
        const driver = await this.identity(user, "driver.assignments.read", tx);
        const where: Prisma.DriverAssignmentWhereInput = {
          driverId: driver.id,
          status: query.status,
          trip: { status: { in: visibleStatuses } },
          startTime: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        };
        // Upcoming work comes before history; within history show the most recent.
        const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT da.id FROM driver_assignments da JOIN trips t ON t.id = da."tripId"
        WHERE da."driverId" = ${driver.id} AND t.status::text IN (${Prisma.join(visibleStatuses)})
        ${query.status ? Prisma.sql`AND da.status = ${query.status}` : Prisma.empty}
        ${query.from ? Prisma.sql`AND da."startTime" >= ${new Date(query.from)}` : Prisma.empty}
        ${query.to ? Prisma.sql`AND da."startTime" <= ${new Date(query.to)}` : Prisma.empty}
        ORDER BY CASE WHEN da."startTime" >= now() THEN 0 ELSE 1 END,
          CASE WHEN da."startTime" >= now() THEN da."startTime" END ASC,
          CASE WHEN da."startTime" < now() THEN da."startTime" END DESC, da.id
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`);
        const [data, total] = await Promise.all([
          tx.driverAssignment.findMany({
            where: { ...where, id: { in: ids.map((row) => row.id) } },
            select: {
              ...assignmentFields,
              trip: {
                select: {
                  ...tripFields,
                  stops: {
                    orderBy: { sequence: "asc" },
                    select: { id: true, sequence: true, address: true },
                  },
                },
              },
            },
          }),
          tx.driverAssignment.count({ where }),
        ]);
        const positions = new Map(ids.map((row, i) => [row.id, i]));
        data.sort(
          (a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0),
        );
        return {
          data: data.map(({ trip, ...assignment }) => ({
            ...assignment,
            trip: {
              ...tripFieldsForList(trip),
              start: trip.stops[0] ?? null,
              end: trip.stops[trip.stops.length - 1] ?? null,
            },
          })),
          total,
          page: query.page,
          limit: query.limit,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  detail(user: Principal, id: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const driver = await this.identity(user, "driver.assignments.read", tx);
        const assignment = await tx.driverAssignment.findFirst({
          where: {
            id,
            driverId: driver.id,
            trip: { status: { in: visibleStatuses } },
          },
          select: {
            ...assignmentFields,
            trip: {
              select: {
                ...tripFields,
                stops: {
                  orderBy: { sequence: "asc" },
                  select: {
                    ...stopFields,
                    tasks: {
                      orderBy: { id: "asc" },
                      select: {
                        id: true,
                        action: true,
                        plannedQuantity: true,
                        actualQuantity: true,
                        pickupResult: { select: { outcome: true, reason: true, event: { select: { occurredAt: true } } } },
                        orderStop: {
                          select: {
                            orderId: true,
                            windowStart: true,
                            windowEnd: true,
                            windowBasis: true,
                          },
                        },
                        allocation: {
                          select: {
                            id: true,
                            tripId: true,
                            package: { select: packageFields },
                            orderItem: {
                              select: {
                                description: true,
                                order: {
                                  select: { id: true, orderNumber: true },
                                },
                              },
                            },
                          },
                        },
                        order: { select: { id: true, orderNumber: true } },
                        package: { select: packageFields },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (!assignment)
          throw new NotFoundException("Không tìm thấy phân công");
        return {
          ...assignment,
          trip: {
            ...assignment.trip,
            stops: assignment.trip.stops.map((stop) => ({
              ...stop,
              pickupSummary: stop.stopType === 'PICKUP' && stop.status === 'COMPLETED' && stop.tasks.length > 0 && stop.tasks.every(t => t.action === 'LOAD' && t.pickupResult)
                ? { plannedCount: stop.tasks.length, loadedCount: stop.tasks.filter(t => t.pickupResult?.outcome === 'LOADED').length,
                  outcome: stop.tasks.every(t => t.pickupResult?.outcome === 'LOADED') ? 'FULL' : stop.tasks.some(t => t.pickupResult?.outcome === 'LOADED') ? 'PARTIAL' : 'NONE' }
                : null,
              tasks: stop.tasks.map((task) => {
                const order = task.allocation?.orderItem.order ?? task.order;
                if (
                  (task.allocation &&
                    task.allocation.tripId !== assignment.trip.id) ||
                  (task.orderStop && task.orderStop.orderId !== order?.id)
                )
                  throw new ConflictException({
                    code: "PLAN_DATA_CONFLICT",
                    message:
                      "Dữ liệu kế hoạch không nhất quán; liên hệ điều phối",
                  });
                const parcel = task.allocation?.package ?? task.package;
                return {
                  id: task.id,
                  action: task.action,
                  plannedQuantity: task.plannedQuantity,
                  actualQuantity: task.actualQuantity,
                  pickup: task.pickupResult ? { outcome: task.pickupResult.outcome, reason: task.pickupResult.reason, occurredAt: task.pickupResult.event.occurredAt } : null,
                  allocationId: task.allocation?.id ?? null,
                  description: task.allocation?.orderItem.description ?? null,
                  order,
                  package: parcel
                    ? { ...parcel, weightG: parcel.weightG?.toString() ?? null }
                    : null,
                  windowStart: task.orderStop?.windowStart ?? null,
                  windowEnd: task.orderStop?.windowEnd ?? null,
                  windowBasis: task.orderStop?.windowBasis ?? null,
                };
              }),
            })),
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async respond(
    user: Principal,
    id: string,
    key: string | undefined,
    dto: AssignmentResponseDto,
    status: "ACCEPTED" | "REJECTED",
    reason?: string,
  ) {
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new BadRequestException(
        "Idempotency-Key phải có 8–128 ký tự chữ, số, _ hoặc -",
      );
    if (status === "REJECTED" && (!reason?.trim() || reason.length > 1000))
      throw new BadRequestException(
        "Lý do từ chối bắt buộc, tối đa 1000 ký tự",
      );
    const payload = {
      id,
      status,
      expectedVersion: dto.expectedVersion,
      expectedTripVersion: dto.expectedTripVersion,
      reason: status === "REJECTED" ? (reason?.trim() ?? null) : null,
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM drivers WHERE "userId" = ${user.id} FOR SHARE`;
      const driver = await this.identity(
        user,
        "driver.assignments.respond",
        tx,
      );
      // One namespace for BOTH transitions: changing accept to reject under a key is a mismatch.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71007, hashtext(${user.id + ":" + key}))`;
      const commandType = "DRIVER_ASSIGNMENT_RESPONSE";
      const commandWhere = {
        actorUserId_commandType_idempotencyKey: {
          actorUserId: user.id,
          commandType,
          idempotencyKey: key,
        },
      };
      const previous = await tx.processedCommand.findUnique({
        where: commandWhere,
      });
      await tx.$queryRaw`SELECT id FROM driver_assignments WHERE id = ${id} AND "driverId" = ${driver.id} FOR UPDATE`;
      const assignment = await tx.driverAssignment.findFirst({
        where: { id, driverId: driver.id },
      });
      if (!assignment) throw new NotFoundException("Không tìm thấy phân công");
      if (previous) {
        if (previous.requestHash !== hash)
          throw new ConflictException({
            code: "IDEMPOTENCY_MISMATCH",
            message: "Idempotency key đã được dùng cho nội dung khác",
          });
        if (previous.status === "COMPLETED") return previous.result;
        throw new ConflictException({
          code: "COMMAND_IN_PROGRESS",
          message: "Lệnh đang xử lý",
        });
      }
      await tx.$queryRaw`SELECT id FROM trips WHERE id = ${assignment.tripId} FOR SHARE`;
      const trip = await tx.trip.findUniqueOrThrow({
        where: { id: assignment.tripId },
        select: { id: true, status: true, version: true },
      });
      if (
        assignment.version !== dto.expectedVersion ||
        trip.version !== dto.expectedTripVersion
      )
        throw new ConflictException({
          code: "VERSION_CONFLICT",
          message: "Kế hoạch hoặc phân công đã thay đổi. Hãy tải lại",
        });
      if (assignment.status !== "ASSIGNED" || trip.status !== "DISPATCHED")
        throw new ConflictException({
          code: "INVALID_TRANSITION",
          message: "Phân công không còn cho phép nhận/từ chối",
        });
      const command = await tx.processedCommand.create({
        data: {
          actorUserId: user.id,
          commandType,
          idempotencyKey: key,
          requestHash: hash,
          status: "PROCESSING",
        },
      });
      const updated = await tx.driverAssignment.update({
        where: { id },
        data: {
          status,
          respondedAt: new Date(),
          rejectionReason: payload.reason,
          version: { increment: 1 },
        },
        select: { id: true, status: true, version: true, respondedAt: true },
      });
      const result = {
        ...updated,
        respondedAt: updated.respondedAt?.toISOString() ?? null,
        tripId: trip.id,
        tripVersion: trip.version,
      };
      await tx.auditLog.create({
        data: {
          entityType: "DriverAssignment",
          entityId: id,
          action: status,
          performedBy: user.id,
          actorUserId: user.id,
          changeSummary: {
            commandId: command.id,
            from: "ASSIGNED",
            to: status,
            version: updated.version,
            tripVersion: trip.version,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: randomUUID(),
          aggregateType: "DriverAssignment",
          aggregateId: id,
          aggregateVersion: updated.version,
          eventType:
            status === "ACCEPTED"
              ? "driver.assignment.accepted"
              : "driver.assignment.rejected",
          payload: {
            assignmentId: id,
            driverId: driver.id,
            tripId: trip.id,
            version: updated.version,
            tripVersion: trip.version,
          },
        },
      });
      await tx.processedCommand.update({
        where: { id: command.id },
        data: { status: "COMPLETED", result },
      });
      return result;
    });
  }
}

function tripFieldsForList<T extends { stops: unknown }>(
  trip: T,
): Omit<T, "stops"> {
  const { stops: _stops, ...fields } = trip;
  return fields;
}
