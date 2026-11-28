import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  LocationType,
  OrderStatus,
  PackageEventType,
  PackageStatus,
  Prisma,
  ReservationStatus,
  StopType,
  TaskAction,
  TripStatus,
} from '@prisma/client';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { assertPermission, Principal, type PermissionCode } from '../auth/access';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ResolvedStackingPolicy } from '../settings/settings.types';
import {
  isFloorRotationLocked,
  normalizeAllowedOrientations,
} from '../orders/package-orientations';
import {
  ConfirmTaskDto,
  DeliveryFailureCategory,
  EnhancedFailedDeliveryDto,
  ReturnToHubDto,
} from './driver-execution.dto';

type DbClient = PrismaService | Prisma.TransactionClient;

type EvalStopDecision = {
  stop_id: string;
  sequence: number;
  stop_type: 'PICKUP' | 'DELIVERY';
  order_id: string;
  decision:
    | 'KEEP_DELIVER'
    | 'KEEP_PICKUP'
    | 'RETURN_TO_HUB'
    | 'DETACH_TO_FREE_VEHICLE';
  reason_code?:
    | 'CLEAR'
    | 'BLOCKED_BY_RETAINED_CARGO'
    | 'OUTSIDE_SHIFT_WINDOW'
    | 'INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO'
    | null;
  blocker_item_ids?: string[];
  unload_sequence?: string[];
  reason_message?: string | null;
};

type EvalResponse = {
  trip_id: string;
  used_exact_placements: boolean;
  stop_decisions: EvalStopDecision[];
  keep_delivery_stop_ids: string[];
  return_to_hub_stop_ids: string[];
  return_to_hub_item_ids: string[];
  detached_order_ids: string[];
  diagnostics: string[];
};

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

@Injectable()
export class DriverContinuationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Optional() private readonly settingsService?: SettingsService,
  ) {}

  private get optimizerUrl(): string {
    return process.env.OPTIMIZER_URL || 'http://localhost:8000';
  }

  private assertKey(key: string | undefined): string {
    if (!key || !IDEMPOTENCY_PATTERN.test(key)) {
      throw new BadRequestException('Idempotency-Key không hợp lệ');
    }
    return key;
  }

  private parseEventTime(raw?: string): Date {
    if (!raw) return new Date();
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Thời điểm thao tác không hợp lệ');
    }
    return parsed;
  }

  private commandHash(userId: string, scope: string, key: string): string {
    return createHash('sha256')
      .update(JSON.stringify([userId, scope, key]))
      .digest('hex');
  }

  private async verifyDriver(
    user: Principal,
    permission: PermissionCode,
    tx: DbClient,
  ) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM drivers WHERE "userId" = ${user.id} FOR SHARE`;
    const current = await this.auth.authenticatePayload({
      sub: user.id,
      sid: user.sessionId,
    });
    assertPermission(current, permission);
    const driver = await tx.driver.findUnique({
      where: { userId: user.id },
      select: { id: true, homeBranchId: true, status: true },
    });
    if (!driver) {
      throw new ForbiddenException({
        code: 'DRIVER_NOT_LINKED',
        message: 'Tài khoản chưa liên kết hồ sơ tài xế',
      });
    }
    return driver;
  }

  private async lockAssignmentAndTrip(
    tx: Prisma.TransactionClient,
    driverId: string,
    assignmentId: string,
    expectedVersion: number,
    expectedTripVersion: number,
    commandId: string,
    requestHash: string,
  ): Promise<{
    replayResponse?: Record<string, unknown>;
    assignment: {
      id: string;
      driverId: string;
      tripId: string;
      status: string;
      version: number;
      startStopId: string | null;
      endStopId: string | null;
      startTime: Date;
      endTime: Date;
    };
    trip: {
      id: string;
      branchId: string;
      status: TripStatus;
      version: number;
      vehicleId: string;
      driverId: string;
      actualStartTime: Date | null;
      plannedEndTime: Date;
    };
  }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(71007, hashtext(${commandId}))`;
    await tx.$queryRaw`SELECT id FROM driver_assignments WHERE id = ${assignmentId} AND "driverId" = ${driverId} FOR UPDATE`;
    const assignment = await tx.driverAssignment.findFirst({
      where: { id: assignmentId, driverId },
      select: {
        id: true,
        driverId: true,
        tripId: true,
        status: true,
        version: true,
        startStopId: true,
        endStopId: true,
        startTime: true,
        endTime: true,
      },
    });
    if (!assignment) {
      throw new NotFoundException('Không tìm thấy phân công');
    }

    const previous = await tx.executionEvent.findUnique({
      where: { commandId },
      select: { payload: true },
    });
    if (previous) {
      const payload =
        previous.payload &&
        typeof previous.payload === 'object' &&
        !Array.isArray(previous.payload)
          ? (previous.payload as Record<string, unknown>)
          : null;
      if (!payload || payload.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency key đã được dùng cho nội dung khác',
        );
      }
      if (
        payload.response &&
        typeof payload.response === 'object' &&
        !Array.isArray(payload.response)
      ) {
        return {
          replayResponse: payload.response as Record<string, unknown>,
          assignment,
          trip: {
            id: assignment.tripId,
            branchId: '',
            status: TripStatus.IN_PROGRESS,
            version: expectedTripVersion,
            vehicleId: '',
            driverId,
            actualStartTime: null,
            plannedEndTime: assignment.endTime,
          },
        };
      }
      return {
        replayResponse: {
          attemptId: payload.attemptId,
          tripVersion: payload.tripVersion,
        },
        assignment,
        trip: {
          id: assignment.tripId,
          branchId: '',
          status: TripStatus.IN_PROGRESS,
          version: expectedTripVersion,
          vehicleId: '',
          driverId,
          actualStartTime: null,
          plannedEndTime: assignment.endTime,
        },
      };
    }

    await tx.$queryRaw`SELECT id FROM trips WHERE id = ${assignment.tripId} FOR UPDATE`;
    const tripRow = await tx.trip.findUniqueOrThrow({
      where: { id: assignment.tripId },
      select: {
        id: true,
        managingBranchId: true,
        status: true,
        version: true,
        vehicleId: true,
        actualStartTime: true,
        plannedEndTime: true,
        vehicle: { select: { homeBranchId: true } },
      },
    });

    const trip = {
      id: tripRow.id,
      branchId: tripRow.managingBranchId ?? tripRow.vehicle.homeBranchId,
      status: tripRow.status,
      version: tripRow.version,
      vehicleId: tripRow.vehicleId,
      driverId,
      actualStartTime: tripRow.actualStartTime,
      plannedEndTime: tripRow.plannedEndTime,
    };

    if (
      assignment.version !== expectedVersion ||
      trip.version !== expectedTripVersion
    ) {
      throw new ConflictException(
        'Kế hoạch hoặc phân công đã thay đổi. Hãy tải lại',
      );
    }
    if (
      assignment.status !== 'ACCEPTED' ||
      !(['DISPATCHED', 'IN_PROGRESS'] as TripStatus[]).includes(trip.status)
    ) {
      throw new ConflictException(
        'Phân công chưa sẵn sàng thực hiện hoặc chuyến đã kết thúc',
      );
    }

    return { assignment, trip };
  }

  private async assertBoundaryStop(
    tx: Prisma.TransactionClient,
    assignment: { startStopId: string | null; endStopId: string | null },
    stopSequence: number,
  ) {
    const boundaryIds = [assignment.startStopId, assignment.endStopId].filter(
      (id): id is string => Boolean(id),
    );
    if (!boundaryIds.length) return;
    const boundaries = await tx.tripStop.findMany({
      where: { id: { in: boundaryIds } },
      select: { id: true, sequence: true },
    });
    const startSeq = boundaries.find(
      (b) => b.id === assignment.startStopId,
    )?.sequence;
    const endSeq = boundaries.find(
      (b) => b.id === assignment.endStopId,
    )?.sequence;
    if (
      boundaries.length !== new Set(boundaryIds).size ||
      (startSeq !== undefined && stopSequence < startSeq) ||
      (endSeq !== undefined && stopSequence > endSeq)
    ) {
      throw new ConflictException(
        'Điểm dừng nằm ngoài phạm vi phân công của tài xế',
      );
    }
  }

  private async resolveBranchWarehouse(
    tx: DbClient,
    branchId: string,
    vehicleId: string,
    explicitWarehouseId?: string,
  ) {
    if (explicitWarehouseId) {
      const explicit = await tx.location.findUnique({
        where: { id: explicitWarehouseId },
      });
      if (
        !explicit ||
        explicit.type !== LocationType.CENTRAL_WAREHOUSE ||
        !explicit.active ||
        (explicit.managingBranchId && explicit.managingBranchId !== branchId)
      ) {
        throw new ConflictException({
          code: 'INVALID_WAREHOUSE',
          message:
            'Kho lưu chuyển được chọn không hợp lệ hoặc không thuộc chi nhánh chuyến.',
        });
      }
      return explicit;
    }

    const vehicle = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      select: { homeDepotLocationId: true },
    });

    if (vehicle?.homeDepotLocationId) {
      const home = await tx.location.findFirst({
        where: {
          id: vehicle.homeDepotLocationId,
          type: LocationType.CENTRAL_WAREHOUSE,
          active: true,
        },
      });
      if (home) return home;
    }

    const candidates = await tx.location.findMany({
      where: {
        type: LocationType.CENTRAL_WAREHOUSE,
        managingBranchId: branchId,
        active: true,
      },
      orderBy: [{ code: 'asc' }],
    });
    return candidates[0] ?? null;
  }

  private async resolveStackingPolicy(
    tx: Prisma.TransactionClient,
    branchId: string,
    loadPlanGeometry: Prisma.JsonValue | null,
  ): Promise<ResolvedStackingPolicy | null> {
    if (
      loadPlanGeometry &&
      typeof loadPlanGeometry === 'object' &&
      !Array.isArray(loadPlanGeometry) &&
      'demoStackingPolicy' in loadPlanGeometry
    ) {
      const raw = (loadPlanGeometry as Record<string, unknown>)
        .demoStackingPolicy;
      if (raw === null) return null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        return {
          max_tiers: typeof obj.max_tiers === 'number' ? obj.max_tiers : 3,
          lift_clearance_cm:
            typeof obj.lift_clearance_cm === 'number'
              ? obj.lift_clearance_cm
              : 5,
          owner_mode:
            obj.owner_mode === 'SAME_CUSTOMER'
              ? 'SAME_CUSTOMER'
              : 'ANY_CUSTOMER',
          max_top_load_percent:
            typeof obj.max_top_load_percent === 'number'
              ? obj.max_top_load_percent
              : 30,
        };
      }
    }

    if (this.settingsService) {
      const resolved = await this.settingsService.resolveStackingPolicy(
        branchId,
        tx,
      );
      return resolved.policy ?? null;
    }

    return {
      max_tiers: 3,
      lift_clearance_cm: 5,
      owner_mode: 'ANY_CUSTOMER',
      max_top_load_percent: 30,
    };
  }

  private async upsertWarehouseReturnStop(
    tx: Prisma.TransactionClient,
    tripId: string,
    warehouse: {
      id: string;
      code: string;
      name: string;
      address: string;
      latitude: number;
      longitude: number;
    },
    returningAllocations: Array<{
      id: string;
      packageId: string | null;
      orderItem: { orderId: string };
    }>,
    occurredAt: Date,
  ): Promise<{ id: string; sequence: number }> {
    const existingEnd = await tx.tripStop.findFirst({
      where: { tripId, stopType: StopType.DEPOT_END },
      orderBy: { sequence: 'desc' },
      include: {
        tasks: { select: { id: true, allocationId: true, action: true } },
      },
    });

    const addressLabel = `${warehouse.name} — ${warehouse.address}`;
    let depotEndStopId: string;
    let sequence: number;

    if (existingEnd) {
      const updated = await tx.tripStop.update({
        where: { id: existingEnd.id },
        data: {
          hubLocationId: warehouse.id,
          address: addressLabel,
          latitude: warehouse.latitude,
          longitude: warehouse.longitude,
          status: 'PENDING',
          skipReason: null,
        },
        select: { id: true, sequence: true },
      });
      depotEndStopId = updated.id;
      sequence = updated.sequence;
    } else {
      const { _max } = await tx.tripStop.aggregate({
        where: { tripId },
        _max: { sequence: true },
      });
      sequence = (_max.sequence ?? 0) + 1;
      const created = await tx.tripStop.create({
        data: {
          tripId,
          sequence,
          stopType: StopType.DEPOT_END,
          hubLocationId: warehouse.id,
          address: addressLabel,
          latitude: warehouse.latitude,
          longitude: warehouse.longitude,
          plannedArrivalTime: new Date(occurredAt.getTime() + 30 * 60 * 1000),
          plannedDepartureTime: new Date(occurredAt.getTime() + 45 * 60 * 1000),
          status: 'PENDING',
        },
        select: { id: true, sequence: true },
      });
      depotEndStopId = created.id;
    }

    const existingTasks = existingEnd?.tasks ?? [];
    for (const alloc of returningAllocations) {
      if (!alloc.packageId) continue;
      const alreadyHas = existingTasks.some(
        (t) => t.allocationId === alloc.id && t.action === TaskAction.UNLOAD,
      );
      if (alreadyHas) continue;
      await tx.stopTask.create({
        data: {
          tripStopId: depotEndStopId,
          allocationId: alloc.id,
          orderId: alloc.orderItem.orderId,
          packageId: alloc.packageId,
          action: TaskAction.UNLOAD,
          plannedQuantity: 1,
        },
      });
    }

    return { id: depotEndStopId, sequence };
  }

  private async maybeCompleteTripIfFinished(
    tx: Prisma.TransactionClient,
    tripId: string,
    driverId: string,
    occurredAt: Date,
    endWarehouse?: { latitude: number; longitude: number } | null,
  ): Promise<boolean> {
    const remainingActiveAllocs = await tx.allocation.count({
      where: {
        tripId,
        releasedAt: null,
        package: { status: { in: [PackageStatus.ALLOCATED, PackageStatus.LOADED] } },
      },
    });
    if (remainingActiveAllocs > 0) return false;

    const remainingPendingActionStops = await tx.tripStop.count({
      where: {
        tripId,
        stopType: { in: [StopType.PICKUP, StopType.DELIVERY] },
        status: 'PENDING',
      },
    });
    if (remainingPendingActionStops > 0) return false;

    const trip = await tx.trip.findUniqueOrThrow({
      where: { id: tripId },
      select: { vehicleId: true },
    });

    await tx.trip.update({
      where: { id: tripId },
      data: {
        status: TripStatus.COMPLETED,
        actualEndTime: occurredAt,
      },
    });

    await tx.resourceReservation.updateMany({
      where: {
        tripId,
        status: { in: [ReservationStatus.HELD, ReservationStatus.ACTIVE] },
      },
      data: { status: ReservationStatus.COMMITTED },
    });

    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: {
        status: 'AVAILABLE',
        ...(endWarehouse
          ? {
              currentLatitude: endWarehouse.latitude,
              currentLongitude: endWarehouse.longitude,
              lastLocationAt: occurredAt,
            }
          : {}),
      },
    });

    await tx.driver.update({
      where: { id: driverId },
      data: { status: 'AVAILABLE' },
    });

    return true;
  }

  private async syncOrderStatusAfterPackageChange(
    tx: Prisma.TransactionClient,
    orderIds: string[],
    actorUserId: string,
    commandIdPrefix: string,
    eventType:
      | 'ORDER_COMPLETED'
      | 'ORDER_RETURNED_TO_HUB'
      | 'ORDER_DETACHED_FOR_FREE_VEHICLE',
    payload: Record<string, unknown>,
  ) {
    const uniqueOrderIds = [...new Set(orderIds)];
    for (const orderId of uniqueOrderIds) {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          items: {
            select: {
              packages: {
                select: {
                  id: true,
                  status: true,
                  allocations: {
                    where: { releasedAt: null },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!order || order.status === OrderStatus.CANCELLED) continue;

      const pkgs = order.items.flatMap((i) => i.packages);
      if (!pkgs.length) continue;

      const allDelivered = pkgs.every((p) => p.status === PackageStatus.DELIVERED);
      const anyOnVehicle = pkgs.some(
        (p) =>
          p.status === PackageStatus.LOADED ||
          p.status === PackageStatus.ALLOCATED ||
          p.allocations.length > 0,
      );

      let nextStatus: OrderStatus = order.status;
      if (allDelivered) {
        nextStatus = OrderStatus.COMPLETED;
      } else if (!anyOnVehicle && pkgs.some((p) => p.status === PackageStatus.READY)) {
        nextStatus = OrderStatus.CONFIRMED;
      }

      if (nextStatus !== order.status || eventType !== 'ORDER_COMPLETED') {
        if (nextStatus !== order.status) {
          await tx.order.update({
            where: { id: orderId },
            data: { status: nextStatus },
          });
        }
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType,
            fromStatus: order.status,
            toStatus: nextStatus,
            actorUserId,
            commandId: `${commandIdPrefix}:${orderId}`,
            payload: payload as Prisma.InputJsonValue,
          },
        });
      }
    }
  }

  async confirmPickupTask(
    user: Principal,
    assignmentId: string,
    taskId: string,
    key: string | undefined,
    dto: ConfirmTaskDto,
  ) {
    const idempKey = this.assertKey(key);
    const occurredAt = this.parseEventTime(dto.occurredAt);
    const commandId = this.commandHash(user.id, 'pickup-confirm', idempKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          assignmentId,
          taskId,
          dto.expectedVersion,
          dto.expectedTripVersion,
          dto.notes ?? null,
        ]),
      )
      .digest('hex');

    return this.prisma.$transaction(async (tx) => {
      const driver = await this.verifyDriver(
        user,
        'driver.assignments.respond',
        tx,
      );
      const locked = await this.lockAssignmentAndTrip(
        tx,
        driver.id,
        assignmentId,
        dto.expectedVersion,
        dto.expectedTripVersion,
        commandId,
        requestHash,
      );
      if (locked.replayResponse) return locked.replayResponse;

      const { assignment, trip } = locked;
      const task = await tx.stopTask.findFirst({
        where: { id: taskId, action: TaskAction.LOAD, tripStop: { tripId: trip.id } },
        select: {
          id: true,
          tripStopId: true,
          plannedQuantity: true,
          actualQuantity: true,
          orderId: true,
          packageId: true,
          allocationId: true,
          tripStop: {
            select: { id: true, sequence: true, status: true, hubLocationId: true },
          },
          allocation: {
            select: { id: true, packageId: true, orderItem: { select: { orderId: true } } },
          },
        },
      });
      if (!task) throw new NotFoundException('Không tìm thấy tác vụ lấy hàng');
      await this.assertBoundaryStop(tx, assignment, task.tripStop.sequence);

      if (task.tripStop.status === 'SKIPPED') {
        throw new ConflictException({
          code: 'STOP_SKIPPED',
          message: 'Điểm lấy hàng này đã được tách khỏi chuyến.',
        });
      }
      if ((task.actualQuantity ?? 0) >= task.plannedQuantity) {
        throw new ConflictException({
          code: 'TASK_ALREADY_COMPLETED',
          message: 'Kiện hàng này đã được xác nhận lấy trước đó.',
        });
      }

      const packageId = task.packageId ?? task.allocation?.packageId;
      if (!packageId) {
        throw new ConflictException('Tác vụ lấy hàng chưa gắn kiện hàng');
      }

      const loadedPkg = await tx.package.updateMany({
        where: { id: packageId, status: PackageStatus.ALLOCATED },
        data: { status: PackageStatus.LOADED },
      });
      if (loadedPkg.count !== 1) {
        throw new ConflictException({
          code: 'INVALID_PACKAGE_STATE',
          message: 'Kiện hàng không ở trạng thái chờ lấy (ALLOCATED).',
        });
      }

      await tx.packageEvent.create({
        data: {
          packageId,
          eventType: PackageEventType.COLLECTED,
          locationId: task.tripStop.hubLocationId ?? null,
          actorUserId: user.id,
          notes: dto.notes ?? 'Tài xế đã xác nhận lấy hàng lên xe',
          occurredAt,
          metadata: { tripId: trip.id, stopTaskId: task.id },
        },
      });

      await tx.stopTask.update({
        where: { id: task.id },
        data: { actualQuantity: task.plannedQuantity },
      });

      const remainingStopTasks = await tx.stopTask.count({
        where: {
          tripStopId: task.tripStopId,
          OR: [{ actualQuantity: null }, { actualQuantity: { lt: 1 } }],
        },
      });
      if (remainingStopTasks === 0) {
        await tx.tripStop.update({
          where: { id: task.tripStopId },
          data: {
            status: 'COMPLETED',
            actualArrivalTime: occurredAt,
            actualDepartureTime: occurredAt,
          },
        });
      }

      const orderId = task.orderId ?? task.allocation?.orderItem.orderId ?? null;
      if (orderId) {
        await tx.order.updateMany({
          where: {
            id: orderId,
            status: { in: [OrderStatus.CONFIRMED, OrderStatus.ASSIGNED] },
          },
          data: { status: OrderStatus.IN_TRANSIT },
        });
      }

      const updatedTrip = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: TripStatus.IN_PROGRESS,
          actualStartTime: trip.actualStartTime ?? occurredAt,
          version: { increment: 1 },
        },
        select: { status: true, version: true },
      });

      await tx.vehicle.updateMany({
        where: { id: trip.vehicleId, status: 'AVAILABLE' },
        data: { status: 'ON_TRIP' },
      });
      await tx.driver.updateMany({
        where: { id: trip.driverId, status: 'AVAILABLE' },
        data: { status: 'ON_DUTY' },
      });

      const response = {
        taskId: task.id,
        packageId,
        packageStatus: PackageStatus.LOADED,
        tripId: trip.id,
        tripStatus: updatedTrip.status,
        tripVersion: updatedTrip.version,
        assignmentVersion: assignment.version,
      };

      await tx.executionEvent.create({
        data: {
          tripId: trip.id,
          tripStopId: task.tripStopId,
          stopTaskId: task.id,
          eventType: 'PICKUP_CONFIRMED',
          occurredAt,
          actorUserId: user.id,
          commandId,
          payload: { requestHash, response },
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventId: randomUUID(),
          aggregateType: 'Trip',
          aggregateId: trip.id,
          aggregateVersion: updatedTrip.version,
          eventType: 'TRIP_PICKUP_CONFIRMED',
          payload: { tripId: trip.id, taskId: task.id, packageId },
        },
      });

      return response;
    });
  }

  async confirmDeliveryTask(
    user: Principal,
    assignmentId: string,
    taskId: string,
    key: string | undefined,
    dto: ConfirmTaskDto,
  ) {
    const idempKey = this.assertKey(key);
    const occurredAt = this.parseEventTime(dto.occurredAt);
    const commandId = this.commandHash(user.id, 'delivery-confirm', idempKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          assignmentId,
          taskId,
          dto.expectedVersion,
          dto.expectedTripVersion,
          dto.notes ?? null,
        ]),
      )
      .digest('hex');

    return this.prisma.$transaction(async (tx) => {
      const driver = await this.verifyDriver(
        user,
        'driver.assignments.respond',
        tx,
      );
      const locked = await this.lockAssignmentAndTrip(
        tx,
        driver.id,
        assignmentId,
        dto.expectedVersion,
        dto.expectedTripVersion,
        commandId,
        requestHash,
      );
      if (locked.replayResponse) return locked.replayResponse;

      const { assignment, trip } = locked;
      const task = await tx.stopTask.findFirst({
        where: {
          id: taskId,
          action: TaskAction.UNLOAD,
          tripStop: { tripId: trip.id, stopType: StopType.DELIVERY },
        },
        select: {
          id: true,
          tripStopId: true,
          plannedQuantity: true,
          actualQuantity: true,
          orderId: true,
          packageId: true,
          allocationId: true,
          tripStop: {
            select: { id: true, sequence: true, status: true, skipReason: true },
          },
          allocation: {
            select: {
              id: true,
              packageId: true,
              orderItem: { select: { orderId: true } },
            },
          },
          deliveryResults: {
            where: { result: 'RETAINED_ON_VEHICLE' },
            select: { id: true },
          },
        },
      });
      if (!task) throw new NotFoundException('Không tìm thấy tác vụ giao hàng');
      await this.assertBoundaryStop(tx, assignment, task.tripStop.sequence);

      if (task.tripStop.status === 'SKIPPED') {
        throw new ConflictException({
          code: 'STOP_SKIPPED_RETURN_TO_HUB',
          message:
            'Điểm giao này đang giữ hàng để chở về kho theo quy tắc xếp dỡ 3D/giờ.',
        });
      }
      if (task.deliveryResults.length > 0) {
        throw new ConflictException({
          code: 'DELIVERY_ALREADY_MARKED_FAILED',
          message:
            'Kiện hàng này đã được báo khách bận/không nhận; vui lòng trả về kho.',
        });
      }
      if ((task.actualQuantity ?? 0) >= task.plannedQuantity) {
        throw new ConflictException({
          code: 'TASK_ALREADY_COMPLETED',
          message: 'Tác vụ giao hàng này đã hoàn tất trước đó.',
        });
      }

      const packageId = task.packageId ?? task.allocation?.packageId;
      if (!packageId) {
        throw new ConflictException('Tác vụ giao hàng chưa gắn kiện hàng');
      }

      const deliveredPkg = await tx.package.updateMany({
        where: { id: packageId, status: PackageStatus.LOADED },
        data: {
          status: PackageStatus.DELIVERED,
          custodyLocationId: null,
          deliveryAttemptCount: { increment: 1 },
        },
      });
      if (deliveredPkg.count !== 1) {
        throw new ConflictException({
          code: 'PACKAGE_NOT_LOADED_YET',
          message:
            'Kiện hàng chưa được xác nhận lấy lên xe hoặc trạng thái đã thay đổi.',
        });
      }

      if (task.allocationId) {
        await tx.allocation.update({
          where: { id: task.allocationId },
          data: { status: 'DELIVERED', releasedAt: occurredAt },
        });
      }

      await tx.packageEvent.create({
        data: {
          packageId,
          eventType: PackageEventType.DELIVERY_ATTEMPTED,
          actorUserId: user.id,
          notes: dto.notes ?? 'Giao hàng thành công cho khách hàng',
          occurredAt,
          metadata: { tripId: trip.id, stopTaskId: task.id, outcome: 'DELIVERED' },
        },
      });

      const { _max } = await tx.deliveryAttempt.aggregate({
        where: { tripStopId: task.tripStopId },
        _max: { attemptNumber: true },
      });
      await tx.deliveryAttempt.create({
        data: {
          tripStopId: task.tripStopId,
          attemptNumber: (_max.attemptNumber ?? 0) + 1,
          occurredAt,
          result: 'SUCCEEDED',
          commandId,
          results: {
            create: {
              stopTaskId: task.id,
              packageId,
              result: 'DELIVERED',
            },
          },
        },
      });

      await tx.stopTask.update({
        where: { id: task.id },
        data: { actualQuantity: task.plannedQuantity },
      });

      const stopTasks = await tx.stopTask.findMany({
        where: { tripStopId: task.tripStopId },
        select: {
          id: true,
          actualQuantity: true,
          deliveryResults: {
            where: { result: 'RETAINED_ON_VEHICLE' },
            select: { id: true },
          },
        },
      });
      const unresolved = stopTasks.some(
        (t) => (t.actualQuantity ?? 0) === 0 && t.deliveryResults.length === 0,
      );
      if (!unresolved) {
        const anyRetained = stopTasks.some((t) => t.deliveryResults.length > 0);
        await tx.tripStop.update({
          where: { id: task.tripStopId },
          data: {
            status: anyRetained ? 'FAILED' : 'COMPLETED',
            actualArrivalTime: occurredAt,
            actualDepartureTime: occurredAt,
          },
        });
      }

      const orderId = task.orderId ?? task.allocation?.orderItem.orderId;
      if (orderId) {
        await this.syncOrderStatusAfterPackageChange(
          tx,
          [orderId],
          user.id,
          commandId,
          'ORDER_COMPLETED',
          { tripId: trip.id, stopTaskId: task.id },
        );
      }

      const completedTrip = await this.maybeCompleteTripIfFinished(
        tx,
        trip.id,
        trip.driverId,
        occurredAt,
        null,
      );

      const updatedTrip = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: completedTrip ? TripStatus.COMPLETED : TripStatus.IN_PROGRESS,
          actualStartTime: trip.actualStartTime ?? occurredAt,
          version: { increment: 1 },
        },
        select: { status: true, version: true },
      });

      const response = {
        taskId: task.id,
        packageId,
        packageStatus: PackageStatus.DELIVERED,
        tripId: trip.id,
        tripStatus: updatedTrip.status,
        tripVersion: updatedTrip.version,
        tripCompleted: completedTrip,
        assignmentVersion: assignment.version,
      };

      await tx.executionEvent.create({
        data: {
          tripId: trip.id,
          tripStopId: task.tripStopId,
          stopTaskId: task.id,
          eventType: 'DELIVERY_CONFIRMED',
          occurredAt,
          actorUserId: user.id,
          commandId,
          payload: { requestHash, response },
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventId: randomUUID(),
          aggregateType: 'Trip',
          aggregateId: trip.id,
          aggregateVersion: updatedTrip.version,
          eventType: 'TRIP_DELIVERY_CONFIRMED',
          payload: { tripId: trip.id, taskId: task.id, packageId },
        },
      });

      return response;
    });
  }

  async reportDeliveryFailure(
    user: Principal,
    assignmentId: string,
    taskId: string,
    key: string | undefined,
    dto: EnhancedFailedDeliveryDto,
  ) {
    const idempKey = this.assertKey(key);
    const reason = dto.reason.trim();
    const failureCategory: DeliveryFailureCategory =
      dto.failureCategory ?? 'CUSTOMER_BUSY';
    const requestedRedeliveryAt = dto.requestedRedeliveryAt
      ? this.parseEventTime(dto.requestedRedeliveryAt)
      : null;

    const commandId = this.commandHash(user.id, 'delivery-failure', idempKey);
    const hashTuple: unknown[] = [
      assignmentId,
      taskId,
      dto.expectedVersion,
      dto.expectedTripVersion,
      reason,
    ];
    if (dto.failureCategory) hashTuple.push(dto.failureCategory);
    if (dto.requestedRedeliveryAt) hashTuple.push(dto.requestedRedeliveryAt);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(hashTuple))
      .digest('hex');

    return this.prisma.$transaction(
      async (tx) => {
        const driver = await this.verifyDriver(
          user,
          'driver.assignments.respond',
          tx,
        );
        const locked = await this.lockAssignmentAndTrip(
          tx,
          driver.id,
          assignmentId,
          dto.expectedVersion,
          dto.expectedTripVersion,
          commandId,
          requestHash,
        );
        if (locked.replayResponse) return locked.replayResponse;

        const { assignment, trip } = locked;
        const task = await tx.stopTask.findFirst({
          where: {
            id: taskId,
            action: TaskAction.UNLOAD,
            tripStop: { tripId: trip.id, stopType: StopType.DELIVERY },
          },
          select: {
            id: true,
            tripStopId: true,
            actualQuantity: true,
            packageId: true,
            allocation: { select: { id: true, packageId: true } },
            tripStop: {
              select: {
                id: true,
                sequence: true,
                status: true,
                plannedArrivalTime: true,
                plannedDepartureTime: true,
              },
            },
          },
        });
        if (!task || !task.allocation?.packageId) {
          throw new NotFoundException('Không tìm thấy tác vụ giao hàng');
        }
        await this.assertBoundaryStop(tx, assignment, task.tripStop.sequence);

        if (
          (task.packageId && task.packageId !== task.allocation.packageId) ||
          (task.actualQuantity ?? 0) > 0 ||
          ['COMPLETED', 'SKIPPED'].includes(task.tripStop.status)
        ) {
          throw new ConflictException(
            'Kiện đã xử lý hoặc không có phân bổ hợp lệ trên xe này',
          );
        }

        const { allocation } = task;
        const packageId = allocation.packageId!;
        const pickup = await tx.stopTask.findFirst({
          where: {
            allocationId: allocation.id,
            action: TaskAction.LOAD,
            tripStop: { tripId: trip.id, sequence: { lt: task.tripStop.sequence } },
          },
          select: { id: true },
        });
        const recorded = await tx.deliveryResult.findFirst({
          where: { stopTaskId: taskId, result: 'RETAINED_ON_VEHICLE' },
          select: { id: true },
        });
        if (!pickup || recorded) {
          throw new ConflictException(
            'Kiện thiếu điểm lấy hàng hoặc đã báo giao thất bại',
          );
        }

        const retained = await tx.package.updateMany({
          where: { id: packageId, status: PackageStatus.LOADED },
          data: {
            status: PackageStatus.LOADED,
            deliveryAttemptCount: { increment: 1 },
          },
        });
        if (retained.count !== 1) {
          throw new ConflictException('Trạng thái kiện đã thay đổi');
        }

        const occurredAt = new Date();
        const { _max } = await tx.deliveryAttempt.aggregate({
          where: { tripStopId: task.tripStopId },
          _max: { attemptNumber: true },
        });
        const attempt = await tx.deliveryAttempt.create({
          data: {
            tripStopId: task.tripStopId,
            attemptNumber: (_max.attemptNumber ?? 0) + 1,
            occurredAt,
            result: 'FAILED',
            failureReason: reason,
            failureCategory,
            requestedRedeliveryAt,
            commandId,
            results: {
              create: {
                stopTaskId: taskId,
                packageId,
                result: 'RETAINED_ON_VEHICLE',
              },
            },
          },
          select: { id: true },
        });

        await tx.packageEvent.create({
          data: {
            packageId,
            eventType: PackageEventType.DELIVERY_ATTEMPTED,
            actorUserId: user.id,
            notes: `${failureCategory}: ${reason}`,
            occurredAt,
            metadata: {
              tripId: trip.id,
              stopTaskId: taskId,
              failureCategory,
              requestedRedeliveryAt: requestedRedeliveryAt?.toISOString() ?? null,
            },
          },
        });

        const failedStopTasks = await tx.stopTask.findMany({
          where: { tripStopId: task.tripStopId },
          select: {
            actualQuantity: true,
            deliveryResults: {
              where: { result: 'RETAINED_ON_VEHICLE' },
              select: { id: true },
            },
          },
        });
        if (
          failedStopTasks.every(
            (t) => (t.actualQuantity ?? 0) > 0 || t.deliveryResults.length > 0,
          )
        ) {
          await tx.tripStop.update({
            where: { id: task.tripStopId },
            data: { status: 'FAILED', actualDepartureTime: occurredAt },
          });
        }

        const continuation = await this.evaluateAndApplyContinuation(
          tx,
          trip,
          assignment,
          task.tripStop,
          packageId,
          occurredAt,
          user.id,
          commandId,
        );

        const updatedTrip = await tx.trip.update({
          where: { id: trip.id },
          data: {
            status: TripStatus.IN_PROGRESS,
            actualStartTime: trip.actualStartTime ?? occurredAt,
            version: { increment: 1 },
          },
          select: { version: true, status: true },
        });

        const response = {
          attemptId: attempt.id,
          tripVersion: updatedTrip.version,
          failureCategory,
          requestedRedeliveryAt: requestedRedeliveryAt?.toISOString() ?? null,
          ...(continuation ? { continuation } : {}),
        };

        await tx.executionEvent.create({
          data: {
            tripId: trip.id,
            tripStopId: task.tripStopId,
            stopTaskId: taskId,
            eventType: 'DELIVERY_FAILED',
            occurredAt,
            actorUserId: user.id,
            commandId,
            payload: {
              ...response,
              requestHash,
              packageId,
              response,
            },
          },
        });

        await tx.outboxEvent.create({
          data: {
            eventId: randomUUID(),
            aggregateType: 'Trip',
            aggregateId: trip.id,
            aggregateVersion: updatedTrip.version,
            eventType: 'TRIP_DELIVERY_FAILED',
            payload: {
              tripId: trip.id,
              taskId,
              attemptId: attempt.id,
              packageId,
              reason,
              failureCategory,
              continuation,
            },
          },
        });

        return response;
      },
      { timeout: 15000 },
    );
  }

  private async evaluateAndApplyContinuation(
    tx: Prisma.TransactionClient,
    trip: {
      id: string;
      branchId: string;
      vehicleId: string;
      plannedEndTime: Date;
    },
    assignment: { endTime: Date },
    failedStop: {
      id: string;
      sequence: number;
      plannedArrivalTime: Date | null;
      plannedDepartureTime: Date | null;
    },
    newlyRetainedPackageId: string,
    occurredAt: Date,
    actorUserId: string,
    commandId: string,
  ): Promise<{
    returnWarehouseId: string | null;
    returnWarehouseName: string | null;
    keptDeliveryStopIds: string[];
    returnToHubStopIds: string[];
    detachedOrderIds: string[];
    usedExactPlacements: boolean;
  } | null> {
    const warehouse = await this.resolveBranchWarehouse(
      tx,
      trip.branchId,
      trip.vehicleId,
    );

    const remainingActionStops = await tx.tripStop.findMany({
      where: {
        tripId: trip.id,
        sequence: { gt: failedStop.sequence },
        stopType: { in: [StopType.PICKUP, StopType.DELIVERY] },
        status: 'PENDING',
      },
      orderBy: { sequence: 'asc' },
      include: {
        tasks: {
          orderBy: { id: 'asc' },
          include: {
            orderStop: { select: { windowEnd: true, windowStart: true } },
            allocation: {
              include: {
                orderItem: {
                  select: {
                    orderId: true,
                    order: {
                      select: { id: true, orderNumber: true, customerId: true },
                    },
                  },
                },
                package: {
                  select: {
                    id: true,
                    lengthMm: true,
                    widthMm: true,
                    heightMm: true,
                    weightG: true,
                    cargoKind: true,
                    allowUpperTier: true,
                    noTopLoadRequested: true,
                    maxTopLoadG: true,
                    allowedOrientations: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const onboardAllocs = await tx.allocation.findMany({
      where: {
        tripId: trip.id,
        releasedAt: null,
        package: { status: PackageStatus.LOADED },
      },
      include: {
        orderItem: {
          select: {
            orderId: true,
            order: { select: { id: true, customerId: true } },
          },
        },
        package: {
          select: {
            id: true,
            lengthMm: true,
            widthMm: true,
            heightMm: true,
            weightG: true,
            cargoKind: true,
            allowUpperTier: true,
            noTopLoadRequested: true,
            maxTopLoadG: true,
            allowedOrientations: true,
            status: true,
          },
        },
        tasks: {
          where: {
            action: TaskAction.UNLOAD,
            tripStop: { stopType: StopType.DELIVERY },
          },
          select: {
            tripStopId: true,
            deliveryResults: {
              where: { result: 'RETAINED_ON_VEHICLE' },
              select: { id: true },
            },
          },
        },
      },
    });

    if (remainingActionStops.length === 0) {
      if (!warehouse) return null;
      await this.upsertWarehouseReturnStop(
        tx,
        trip.id,
        warehouse,
        onboardAllocs,
        occurredAt,
      );
      return {
        returnWarehouseId: warehouse.id,
        returnWarehouseName: warehouse.name,
        keptDeliveryStopIds: [],
        returnToHubStopIds: [],
        detachedOrderIds: [],
        usedExactPlacements: false,
      };
    }

    if (!warehouse) {
      throw new ConflictException({
        code: 'NO_BRANCH_WAREHOUSE',
        message:
          'Chi nhánh chưa có Kho lưu chuyển (CENTRAL_WAREHOUSE) để lập chặng hoàn hàng.',
      });
    }

    const vehicle = await tx.vehicle.findUniqueOrThrow({
      where: { id: trip.vehicleId },
      include: { vehicleTypeRecord: true },
    });
    if (!vehicle.vehicleTypeRecord) {
      throw new ConflictException('Xe chưa gắn thông số kích thước thùng');
    }

    const loadPlan = await tx.loadPlan.findFirst({
      where: { tripId: trip.id },
      orderBy: { revision: 'desc' },
      include: {
        steps: {
          orderBy: { stepNumber: 'desc' },
          include: { placements: true },
        },
      },
    });
    const stackingPolicy = await this.resolveStackingPolicy(
      tx,
      trip.branchId,
      loadPlan?.geometrySnapshot ?? null,
    );

    const placementByPackageId = new Map<
      string,
      {
        xCm: number;
        yCm: number;
        zCm: number;
        lengthCm: number;
        widthCm: number;
        heightCm: number;
        supportItemId: string | null;
      }
    >();
    if (loadPlan?.steps?.length) {
      for (const step of loadPlan.steps) {
        const rawPlacedList =
          step.validationResult &&
          typeof step.validationResult === 'object' &&
          !Array.isArray(step.validationResult) &&
          Array.isArray(
            (step.validationResult as Record<string, unknown>).placed_items,
          )
            ? ((step.validationResult as Record<string, unknown>)
                .placed_items as Array<Record<string, unknown>>)
            : [];

        const itemIdByPackageId = new Map<string, string>();
        for (const lp of step.placements) {
          const match = rawPlacedList.find(
            (p) =>
              p.item_id === lp.packageId ||
              (typeof p.x === 'number' &&
                typeof p.y === 'number' &&
                typeof p.z === 'number' &&
                Math.abs(Math.round(p.x * 10) - lp.xMm) <= 2 &&
                Math.abs(Math.round(p.y * 10) - lp.yMm) <= 2 &&
                Math.abs(Math.round(p.z * 10) - lp.zMm) <= 2),
          );
          if (match && typeof match.item_id === 'string') {
            itemIdByPackageId.set(lp.packageId, match.item_id);
          }
        }
        const packageIdByItemId = new Map<string, string>(
          [...itemIdByPackageId.entries()].map(([pkgId, itemId]) => [
            itemId,
            pkgId,
          ]),
        );

        for (const lp of step.placements) {
          if (placementByPackageId.has(lp.packageId)) continue;
          const matched = rawPlacedList.find(
            (p) => p.item_id === itemIdByPackageId.get(lp.packageId),
          );
          const rawSupportId =
            matched && typeof matched.support_item_id === 'string'
              ? matched.support_item_id
              : null;
          const mappedSupportId = rawSupportId
            ? packageIdByItemId.get(rawSupportId) ?? null
            : null;
          placementByPackageId.set(lp.packageId, {
            xCm: Number((lp.xMm / 10).toFixed(2)),
            yCm: Number((lp.yMm / 10).toFixed(2)),
            zCm: Number((lp.zMm / 10).toFixed(2)),
            lengthCm: Number((lp.effectiveLengthMm / 10).toFixed(2)),
            widthCm: Number((lp.effectiveWidthMm / 10).toFixed(2)),
            heightCm: Number((lp.effectiveHeightMm / 10).toFixed(2)),
            supportItemId: mappedSupportId,
          });
        }
      }
    }

    const toCargoItem = (
      pkg: {
        id: string;
        lengthMm: number;
        widthMm: number;
        heightMm: number;
        weightG: bigint;
        cargoKind: string;
        allowUpperTier: boolean;
        noTopLoadRequested: boolean;
        maxTopLoadG: number | null;
        allowedOrientations: Prisma.JsonValue | null;
      },
      orderId: string,
      customerId: string | null,
    ) => {
      const allowedOrientations = normalizeAllowedOrientations(
        pkg.allowedOrientations,
      );
      return {
        id: pkg.id,
        order_id: orderId,
        customer_id: customerId,
        length_cm: Number((pkg.lengthMm / 10).toFixed(2)),
        width_cm: Number((pkg.widthMm / 10).toFixed(2)),
        height_cm: Number((pkg.heightMm / 10).toFixed(2)),
        weight_kg: Number((Number(pkg.weightG) / 1000).toFixed(3)),
        can_rotate: !isFloorRotationLocked(allowedOrientations),
        ...(allowedOrientations ? { allowed_orientations: allowedOrientations } : {}),
        cargo_kind: pkg.cargoKind,
        allow_upper_tier: pkg.allowUpperTier,
        no_top_load_requested: pkg.noTopLoadRequested,
        max_top_load_g: pkg.maxTopLoadG,
      };
    };

    const onboardItemsPayload = onboardAllocs
      .filter((a) => Boolean(a.package))
      .map((a) => {
        const pkg = a.package!;
        const placement = placementByPackageId.get(pkg.id);
        const delivTask = a.tasks[0];
        const isRetained =
          pkg.id === newlyRetainedPackageId ||
          a.tasks.some((t) => t.deliveryResults.length > 0);
        return {
          item: toCargoItem(
            pkg,
            a.orderItem.orderId,
            a.orderItem.order.customerId,
          ),
          retained: isRetained,
          unload_stop_id: delivTask?.tripStopId ?? null,
          ...(placement
            ? {
                x: placement.xCm,
                y: placement.yCm,
                z: placement.zCm,
                placed_length_cm: placement.lengthCm,
                placed_width_cm: placement.widthCm,
                placed_height_cm: placement.heightCm,
                support_item_id: placement.supportItemId,
              }
            : {}),
        };
      });

    const plannedBaseRef =
      failedStop.plannedDepartureTime ??
      failedStop.plannedArrivalTime ??
      occurredAt;
    const delaySec = Math.max(
      0,
      Math.round((occurredAt.getTime() - plannedBaseRef.getTime()) / 1000),
    );
    const shiftEndMs = Math.max(
      assignment.endTime.getTime(),
      trip.plannedEndTime.getTime(),
    );
    const shiftEndEpochSec =
      shiftEndMs > 0 ? Math.floor(shiftEndMs / 1000) : null;

    const remainingStopsPayload = remainingActionStops
      .map((stop) => {
        const orderId =
          stop.tasks.find((t) => t.orderId)?.orderId ??
          stop.tasks.find((t) => t.allocation)?.allocation?.orderItem.orderId ??
          null;
        const orderNumber =
          stop.tasks.find((t) => t.allocation)?.allocation?.orderItem.order
            .orderNumber ?? null;
        const itemIds = stop.tasks
          .map((t) => t.packageId ?? t.allocation?.packageId)
          .filter((id): id is string => Boolean(id));
        if (!orderId || itemIds.length === 0) return null;

        const itemsToLoad =
          stop.stopType === StopType.PICKUP
            ? stop.tasks
                .filter((t) => t.allocation?.package)
                .map((t) =>
                  toCargoItem(
                    t.allocation!.package!,
                    t.allocation!.orderItem.orderId,
                    t.allocation!.orderItem.order.customerId,
                  ),
                )
            : [];

        const plannedArrSec = stop.plannedArrivalTime
          ? Math.floor(stop.plannedArrivalTime.getTime() / 1000) + delaySec
          : null;
        const windowEnds = stop.tasks
          .map((t) => t.orderStop?.windowEnd)
          .filter((d): d is Date => Boolean(d));
        const earliestWindowEnd = windowEnds.length
          ? Math.min(...windowEnds.map((d) => d.getTime()))
          : null;
        const windowEndSec =
          earliestWindowEnd !== null ? Math.floor(earliestWindowEnd / 1000) : null;

        return {
          stop_id: stop.id,
          sequence: stop.sequence,
          stop_type: stop.stopType === StopType.PICKUP ? 'PICKUP' : 'DELIVERY',
          order_id: orderId,
          order_number: orderNumber,
          item_ids: itemIds,
          items_to_load: itemsToLoad,
          estimated_arrival_epoch_sec: plannedArrSec,
          window_end_epoch_sec: windowEndSec,
          service_duration_sec: 900,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    let evalResult: EvalResponse;
    try {
      const { data } = await axios.post<EvalResponse>(
        `${this.optimizerUrl}/evaluate-inprogress-trip`,
        {
          trip_id: trip.id,
          vehicle: {
            id: vehicle.id,
            plate_number: vehicle.plateNumber,
            length_cm: vehicle.vehicleTypeRecord.lengthCm,
            width_cm: vehicle.vehicleTypeRecord.widthCm,
            height_cm: vehicle.vehicleTypeRecord.heightCm,
            door_width_cm: null,
            door_position: 'REAR',
            payload_limit_kg: Number(vehicle.vehicleTypeRecord.payloadCapacityKg),
          },
          demo_stacking: stackingPolicy,
          shift_end_epoch_sec: shiftEndEpochSec,
          return_to_hub_travel_sec: 900,
          onboard_items: onboardItemsPayload,
          remaining_stops: remainingStopsPayload,
        },
        { timeout: 10000 },
      );
      evalResult = data;
    } catch {
      throw new ServiceUnavailableException({
        code: 'OPTIMIZER_UNAVAILABLE',
        message:
          'Không thể đánh giá chặng tiếp theo và đường dỡ 3D vì Optimization Engine không phản hồi.',
      });
    }

    const decisionByStop = new Map(
      evalResult.stop_decisions.map((d) => [d.stop_id, d]),
    );

    const blockedOrderIds: string[] = [];
    for (const stopId of evalResult.return_to_hub_stop_ids) {
      const dec = decisionByStop.get(stopId);
      const stopRow = remainingActionStops.find((s) => s.id === stopId);
      if (stopRow) {
        await tx.tripStop.update({
          where: { id: stopId },
          data: {
            status: 'SKIPPED',
            skipReason: dec?.reason_code ?? 'BLOCKED_BY_RETAINED_CARGO',
          },
        });
        for (const t of stopRow.tasks) {
          const oid = t.orderId ?? t.allocation?.orderItem.orderId;
          if (oid) blockedOrderIds.push(oid);
        }
      }
    }

    if (blockedOrderIds.length > 0) {
      for (const oid of [...new Set(blockedOrderIds)]) {
        const orderRow = await tx.order.findUnique({
          where: { id: oid },
          select: { status: true },
        });
        await tx.orderEvent.create({
          data: {
            orderId: oid,
            eventType: 'CARGO_BLOCKED_RETURN_TO_HUB',
            fromStatus: orderRow?.status ?? null,
            toStatus: orderRow?.status ?? null,
            actorUserId,
            commandId: `${commandId}:blocked:${oid}`,
            payload: {
              tripId: trip.id,
              warehouseId: warehouse.id,
              reason:
                'Bị hàng hoàn giữ trên xe chắn lối/đè tầng hoặc lỡ giờ; chở về kho',
            },
          },
        });
      }
    }

    const detachedOrderIds = evalResult.detached_order_ids ?? [];
    if (detachedOrderIds.length > 0) {
      const unpickedAllocs = await tx.allocation.findMany({
        where: {
          tripId: trip.id,
          releasedAt: null,
          orderItem: { orderId: { in: detachedOrderIds } },
          package: { status: PackageStatus.ALLOCATED },
        },
        select: { id: true, packageId: true },
      });

      const detachedAllocIds = unpickedAllocs.map((a) => a.id);
      const detachedPackageIds = unpickedAllocs
        .map((a) => a.packageId)
        .filter((pid): pid is string => Boolean(pid));

      if (detachedAllocIds.length > 0) {
        await tx.allocation.updateMany({
          where: { id: { in: detachedAllocIds } },
          data: { status: 'RELEASED', releasedAt: occurredAt },
        });
      }
      if (detachedPackageIds.length > 0) {
        await tx.package.updateMany({
          where: { id: { in: detachedPackageIds } },
          data: { status: PackageStatus.READY },
        });
      }

      for (const stop of remainingActionStops) {
        const stopDecision = decisionByStop.get(stop.id);
        const belongsToDetached = stop.tasks.some((t) => {
          const oid = t.orderId ?? t.allocation?.orderItem.orderId;
          return oid ? detachedOrderIds.includes(oid) : false;
        });
        if (
          stopDecision?.decision === 'DETACH_TO_FREE_VEHICLE' ||
          belongsToDetached
        ) {
          await tx.tripStop.update({
            where: { id: stop.id },
            data: {
              status: 'SKIPPED',
              skipReason:
                stopDecision?.reason_code ?? 'DETACHED_TO_FREE_VEHICLE',
            },
          });
        }
      }

      await this.syncOrderStatusAfterPackageChange(
        tx,
        detachedOrderIds,
        actorUserId,
        `${commandId}:detach`,
        'ORDER_DETACHED_FOR_FREE_VEHICLE',
        {
          tripId: trip.id,
          reason:
            'Tách đơn chưa lấy khỏi chuyến gặp sự cố để điều phối cho xe rảnh',
        },
      );
    }

    await this.upsertWarehouseReturnStop(
      tx,
      trip.id,
      warehouse,
      onboardAllocs,
      occurredAt,
    );

    return {
      returnWarehouseId: warehouse.id,
      returnWarehouseName: warehouse.name,
      keptDeliveryStopIds: evalResult.keep_delivery_stop_ids,
      returnToHubStopIds: evalResult.return_to_hub_stop_ids,
      detachedOrderIds,
      usedExactPlacements: evalResult.used_exact_placements,
    };
  }

  async confirmReturnToHub(
    user: Principal,
    assignmentId: string,
    stopId: string,
    key: string | undefined,
    dto: ReturnToHubDto,
  ) {
    const idempKey = this.assertKey(key);
    const occurredAt = this.parseEventTime(dto.occurredAt);
    const commandId = this.commandHash(user.id, 'return-to-hub', idempKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          assignmentId,
          stopId,
          dto.expectedVersion,
          dto.expectedTripVersion,
          dto.hubLocationId ?? null,
          dto.notes ?? null,
        ]),
      )
      .digest('hex');

    return this.prisma.$transaction(async (tx) => {
      const driver = await this.verifyDriver(
        user,
        'driver.assignments.respond',
        tx,
      );
      const locked = await this.lockAssignmentAndTrip(
        tx,
        driver.id,
        assignmentId,
        dto.expectedVersion,
        dto.expectedTripVersion,
        commandId,
        requestHash,
      );
      if (locked.replayResponse) return locked.replayResponse;

      const { assignment, trip } = locked;
      const hubStop = await tx.tripStop.findFirst({
        where: { id: stopId, tripId: trip.id, stopType: StopType.DEPOT_END },
        select: {
          id: true,
          sequence: true,
          status: true,
          hubLocationId: true,
        },
      });
      if (!hubStop) {
        throw new NotFoundException('Không tìm thấy điểm trả hàng về kho');
      }
      await this.assertBoundaryStop(tx, assignment, hubStop.sequence);

      const pendingDeliveries = await tx.tripStop.count({
        where: {
          tripId: trip.id,
          stopType: StopType.DELIVERY,
          status: 'PENDING',
        },
      });
      if (pendingDeliveries > 0) {
        throw new ConflictException({
          code: 'REMAINING_CLEAR_DELIVERIES_PENDING',
          message: `Còn ${pendingDeliveries} điểm giao chưa xử lý trên đường. Hãy hoàn tất giao các điểm đủ điều kiện trước khi về kho.`,
        });
      }

      const warehouse = await this.resolveBranchWarehouse(
        tx,
        trip.branchId,
        trip.vehicleId,
        dto.hubLocationId ?? hubStop.hubLocationId ?? undefined,
      );
      if (!warehouse) {
        throw new ConflictException({
          code: 'NO_BRANCH_WAREHOUSE',
          message: 'Không xác định được kho lưu chuyển của chi nhánh.',
        });
      }

      const returningAllocs = await tx.allocation.findMany({
        where: {
          tripId: trip.id,
          releasedAt: null,
          package: { status: PackageStatus.LOADED },
        },
        include: {
          orderItem: { select: { orderId: true } },
          package: { select: { id: true, packageCode: true } },
        },
      });

      const returnedPackageIds: string[] = [];
      const affectedOrderIds: string[] = [];

      for (const alloc of returningAllocs) {
        if (!alloc.packageId) continue;
        returnedPackageIds.push(alloc.packageId);
        affectedOrderIds.push(alloc.orderItem.orderId);

        await tx.package.update({
          where: { id: alloc.packageId },
          data: {
            status: PackageStatus.READY,
            custodyLocationId: warehouse.id,
            returnedToHubAt: occurredAt,
          },
        });

        await tx.packageEvent.create({
          data: {
            packageId: alloc.packageId,
            eventType: PackageEventType.RETURNED,
            locationId: warehouse.id,
            actorUserId: user.id,
            notes:
              dto.notes ??
              `Đã trả hàng về kho ${warehouse.name} chờ điều phối lại`,
            occurredAt,
            metadata: { tripId: trip.id, stopId: hubStop.id },
          },
        });

        await tx.allocation.update({
          where: { id: alloc.id },
          data: {
            status: 'RETURNED_TO_HUB',
            releasedAt: occurredAt,
          },
        });
      }

      await tx.stopTask.updateMany({
        where: {
          tripStopId: hubStop.id,
          action: TaskAction.UNLOAD,
          OR: [{ actualQuantity: null }, { actualQuantity: { lt: 1 } }],
        },
        data: { actualQuantity: 1 },
      });

      await tx.tripStop.update({
        where: { id: hubStop.id },
        data: {
          hubLocationId: warehouse.id,
          address: `${warehouse.name} — ${warehouse.address}`,
          latitude: warehouse.latitude,
          longitude: warehouse.longitude,
          status: 'COMPLETED',
          actualArrivalTime: occurredAt,
          actualDepartureTime: occurredAt,
        },
      });

      if (affectedOrderIds.length > 0) {
        await this.syncOrderStatusAfterPackageChange(
          tx,
          affectedOrderIds,
          user.id,
          `${commandId}:hub-return`,
          'ORDER_RETURNED_TO_HUB',
          {
            tripId: trip.id,
            warehouseId: warehouse.id,
            warehouseName: warehouse.name,
            returnedPackageCount: returnedPackageIds.length,
          },
        );
      }

      const completedTrip = await this.maybeCompleteTripIfFinished(
        tx,
        trip.id,
        trip.driverId,
        occurredAt,
        warehouse,
      );

      const updatedTrip = await tx.trip.update({
        where: { id: trip.id },
        data: {
          status: completedTrip ? TripStatus.COMPLETED : TripStatus.IN_PROGRESS,
          version: { increment: 1 },
        },
        select: { status: true, version: true },
      });

      const response = {
        stopId: hubStop.id,
        warehouse: {
          id: warehouse.id,
          code: warehouse.code,
          name: warehouse.name,
          address: warehouse.address,
        },
        returnedPackageIds,
        returnedPackageCount: returnedPackageIds.length,
        tripId: trip.id,
        tripStatus: updatedTrip.status,
        tripVersion: updatedTrip.version,
        tripCompleted: completedTrip,
      };

      await tx.executionEvent.create({
        data: {
          tripId: trip.id,
          tripStopId: hubStop.id,
          eventType: 'RETURNED_TO_HUB',
          occurredAt,
          actorUserId: user.id,
          commandId,
          payload: { requestHash, response },
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventId: randomUUID(),
          aggregateType: 'Trip',
          aggregateId: trip.id,
          aggregateVersion: updatedTrip.version,
          eventType: 'TRIP_RETURNED_TO_HUB',
          payload: response,
        },
      });

      return response;
    });
  }
}
