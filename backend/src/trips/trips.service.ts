import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripsValidator, StopWithItems } from './trips.validator';
import {
  DriverStatus,
  Driver as DriverRecord,
  LoadValidationStatus,
  OrderStatus,
  PackageStatus,
  Prisma,
  ReservationStatus,
  Role,
  StopType,
  TaskAction,
  TripStatus,
  VehicleStatus,
  Vehicle as VehicleRecord,
} from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import {
  expandOrderItemsToCargoUnits,
  expandPhysicalPackagesToCargoUnits,
  splitOversizedOrdersAcrossFleet,
} from './optimizer-payload';
import {
  assertFleetOptimizationBatchResult,
  OptimizedRouteResult,
} from './optimizer-contract';
import { resolveBranchScope } from '../auth/branch-scope';
import { ApplyAutomaticOptimizationDto } from './dto/apply-automatic-optimization.dto';
import {
  assertOptimizationProposal,
  OptimizationProposal,
  signOptimizationProposal,
  verifyOptimizationProposalSignature,
} from './optimization-proposal';
import {
  AutomaticDispatchScheduleMode,
  RunAutomaticOptimizationDto,
} from './dto/run-automatic-optimization.dto';
import {
  buildServiceDayWindows,
  getFullServiceDayPlanningEpoch,
  getNextDayPlanningEpoch,
  getPlanningEpoch,
  ServiceDayWindow,
} from './service-day';
import { OutboxService } from '../common/services/outbox.service';
import { PublishTripDto } from './dto/publish-trip.dto';
import { UpdateTripPlanDto } from './dto/update-trip-plan.dto';
import {
  resolveVehiclePlanningStart,
  VEHICLE_HOME_DEPOT_SELECT,
} from './vehicle-planning-start';
import { OptimizationProgressReporter } from './optimization-progress';

const ACTIVE_TRIP_STATUSES = [
  TripStatus.PLANNED,
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
];
const OPTIMIZATION_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const AUTOMATIC_PLANNING_DAY_COUNT = 7;
const LOCK_NAMESPACE_VEHICLE = 4101;
const LOCK_NAMESPACE_DRIVER = 4102;
const LOCK_NAMESPACE_ORDER = 4103;
const LOCK_NAMESPACE_TRIP_NUMBER = 4104;
const LOCK_NAMESPACE_TRIP_COMMAND = 4105;

type PhysicalPackageRecord = Prisma.PackageGetPayload<{
  include: { items: true };
}>;

type OrderWithStopsAndItems = Prisma.OrderGetPayload<{
  include: { stops: true; items: true };
}> & { packages?: PhysicalPackageRecord[] };

type DispatchStopWithItems = {
  orderStop: OrderWithStopsAndItems['stops'][number];
  order: OrderWithStopsAndItems;
};

type TripPlanningSnapshot = {
  orders: Array<{ id: string; version: number }>;
  vehicle: { id: string; updatedAt: string };
  driver: { id: string; updatedAt: string };
};

type PlannedAutomaticTrip = {
  vehicleId: string;
  driverId: string;
  plannedStartTime: Date;
  plannedEndTime: Date;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  routeGeometry: string | null;
  spatialValidation: OptimizedRouteResult['spatial_validation'];
  orderIds: string[];
  cargoUnitIds: string[];
  planningSnapshot: {
    orders: Array<{ id: string; version: number }>;
    vehicle: { id: string; updatedAt: string };
    driver: { id: string; updatedAt: string };
  };
  stops: Array<{
    optimizerStopId: string;
    orderId: string;
    orderStopId: string;
    cargoUnitIds: string[];
    sequence: number;
    stopType: StopType;
    address: string;
    latitude: number;
    longitude: number;
    contactName: string;
    contactPhone: string;
    plannedArrivalTime: Date;
    plannedDepartureTime: Date;
  }>;
};

export type StoredOptimizationCandidate = {
  proposal: OptimizationProposal;
  signature: string;
  rank: number;
  searchStrategy: string;
  improvementSequence?: number;
  solverObjective: number;
  isBestFound: boolean;
};

export type StoredOptimizationCandidateBatch = {
  best: StoredOptimizationCandidate;
  candidates: StoredOptimizationCandidate[];
};

@Injectable()
export class TripsService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
    private outbox: OutboxService,
  ) {}

  async findAll(status?: TripStatus, user?: { branchId?: string; role: Role }) {
    return this.prisma.trip.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(user && user.role !== Role.ADMIN
          ? {
              OR: [
                { managingBranchId: user.branchId },
                {
                  managingBranchId: null,
                  vehicle: { homeBranchId: user.branchId },
                },
              ],
            }
          : {}),
      },
      include: {
        vehicle: {
          include: { homeBranch: true },
        },
        assignments: {
          include: { driver: true },
        },
        stops: {
          orderBy: { sequence: 'asc' },
          include: { tasks: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { include: { homeBranch: true } },
        assignments: { include: { driver: true } },
        stops: {
          orderBy: { sequence: 'asc' },
          include: {
            tasks: {
              include: {
                order: { include: { items: true, customer: true } },
                package: true,
              },
            },
          },
        },
      },
    });

    if (!trip) {
      throw new NotFoundException(`Không tìm thấy chuyến đi [${id}]`);
    }

    return trip;
  }

  async findOneAuthorized(id: string, user: { branchId?: string; role: Role }) {
    const trip = await this.findOne(id);
    this.assertTripAccess(trip, user);
    return trip;
  }

  async getLoadPlan(tripId: string, user: { branchId?: string; role: Role }) {
    const trip = await this.findOne(tripId);
    this.assertTripAccess(trip, user);
    const loadPlan = await this.prisma.loadPlan.findFirst({
      where: { tripId },
      orderBy: { revision: 'desc' },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            placements: {
              include: { package: true },
              orderBy: { packageId: 'asc' },
            },
          },
        },
      },
    });
    if (!loadPlan) {
      throw new NotFoundException(
        `Chuyến ${trip.tripNumber} chưa có Load Plan`,
      );
    }
    return loadPlan;
  }

  /**
   * Tạo chuyến đi mới (Lập kế hoạch Trip)
   */
  async create(
    dto: CreateTripDto,
    user: { id: string; branchId?: string; role: Role },
  ) {
    const commandHash = createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex');
    const existingCommand = await this.prisma.processedCommand.findUnique({
      where: {
        actorUserId_commandType_idempotencyKey: {
          actorUserId: user.id,
          commandType: 'CREATE_TRIP',
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existingCommand) {
      if (existingCommand.requestHash !== commandHash) {
        throw new ConflictException(
          'Idempotency key đã được dùng với nội dung tạo chuyến khác',
        );
      }
      const result = existingCommand.result as { tripId?: unknown } | null;
      if (
        existingCommand.status === 'COMPLETED' &&
        typeof result?.tripId === 'string'
      ) {
        return this.findOne(result.tripId);
      }
      throw new ConflictException(
        'Lệnh tạo chuyến với idempotency key này đang xử lý',
      );
    }
    const plannedStart = new Date(dto.plannedStartTime);
    const plannedEnd = new Date(dto.plannedEndTime);

    if (plannedStart >= plannedEnd) {
      throw new BadRequestException(
        'Thời gian bắt đầu chuyến đi phải trước thời gian kết thúc',
      );
    }

    // 1. Kiểm tra Xe và kiểm tra trùng lịch (BR06)
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: dto.vehicleId, status: VehicleStatus.AVAILABLE },
      include: {
        homeBranch: true,
        homeDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT },
      },
    });
    if (!vehicle) {
      throw new NotFoundException(`Không tìm thấy xe [${dto.vehicleId}]`);
    }

    resolveBranchScope(user, vehicle.homeBranchId);
    const planningStart = resolveVehiclePlanningStart(vehicle);

    const vehicleOverlap = await this.prisma.trip.findFirst({
      where: {
        vehicleId: dto.vehicleId,
        status: {
          in: [
            TripStatus.PLANNED,
            TripStatus.DISPATCHED,
            TripStatus.IN_PROGRESS,
          ],
        },
        OR: [
          {
            plannedStartTime: { lt: plannedEnd },
            plannedEndTime: { gt: plannedStart },
          },
        ],
      },
    });
    if (vehicleOverlap) {
      throw new ConflictException(
        `Xe ${vehicle.plateNumber} đã được phân công cho chuyến ${vehicleOverlap.tripNumber} trong khung giờ này! (BR06)`,
      );
    }

    // 2. Kiểm tra Tài xế và kiểm tra trùng lịch (BR06)
    const driver = await this.prisma.driver.findFirst({
      where: {
        id: dto.driverId,
        homeBranchId: vehicle.homeBranchId,
        status: DriverStatus.AVAILABLE,
      },
    });
    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế [${dto.driverId}]`);
    }
    if (driver.licenseExpiry <= new Date()) {
      throw new BadRequestException(
        `Bằng lái của tài xế ${driver.fullName} đã hết hạn!`,
      );
    }

    const driverOverlap = await this.prisma.driverAssignment.findFirst({
      where: {
        driverId: dto.driverId,
        trip: {
          status: {
            in: [
              TripStatus.PLANNED,
              TripStatus.DISPATCHED,
              TripStatus.IN_PROGRESS,
            ],
          },
        },
        startTime: { lt: plannedEnd },
        endTime: { gt: plannedStart },
      },
      include: { trip: true },
    });
    if (driverOverlap) {
      throw new ConflictException(
        `Tài xế ${driver.fullName} đã có lịch chạy chuyến ${driverOverlap.trip.tripNumber} trong khoảng thời gian này! (BR06)`,
      );
    }

    // 3. Tải danh sách đơn hàng được chọn
    const orders = await this.prisma.order.findMany({
      where: {
        id: { in: dto.orderIds },
        branchId: vehicle.homeBranchId,
        status: OrderStatus.CONFIRMED,
      },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
        packages: { include: { items: true }, orderBy: { packageCode: 'asc' } },
      },
    });

    if (orders.length !== dto.orderIds.length) {
      throw new BadRequestException(
        'Một số đơn hàng không tồn tại trong hệ thống',
      );
    }

    // 4. Sắp xếp thứ tự các điểm dừng (Ordered Stops)
    const stopWithItemsList: DispatchStopWithItems[] = [];

    if (dto.orderedStopIds && dto.orderedStopIds.length > 0) {
      const requiredStopIds = orders.flatMap((order) =>
        order.stops.map((stop) => stop.id),
      );
      if (
        dto.orderedStopIds.length !== requiredStopIds.length ||
        new Set(dto.orderedStopIds).size !== dto.orderedStopIds.length ||
        dto.orderedStopIds.some((id) => !requiredStopIds.includes(id))
      ) {
        throw new BadRequestException(
          'orderedStopIds phải chứa đúng mỗi pickup/delivery một lần',
        );
      }
      // Điều phối viên chủ động sắp xếp thứ tự các stop
      for (const stopId of dto.orderedStopIds) {
        for (const order of orders) {
          const match = order.stops.find((s) => s.id === stopId);
          if (match) {
            stopWithItemsList.push({ orderStop: match, order });
            break;
          }
        }
      }
    } else {
      // Mặc định: gom tất cả các điểm PICKUP lên trước, sau đó là các điểm DELIVERY
      const pickups: DispatchStopWithItems[] = [];
      const deliveries: DispatchStopWithItems[] = [];

      for (const order of orders) {
        for (const stop of order.stops) {
          if (stop.type === StopType.PICKUP) {
            pickups.push({ orderStop: stop, order });
          } else {
            deliveries.push({ orderStop: stop, order });
          }
        }
      }
      stopWithItemsList.push(...pickups, ...deliveries);
    }

    // 5. Kiểm tra các bất biến cốt lõi (Invariants BR03 & BR04)
    TripsValidator.validatePickupBeforeDelivery(stopWithItemsList);
    TripsValidator.calculateAndValidateLoad(vehicle, stopWithItemsList);

    // 6. Tích hợp Mapbox Directions API để tính cự ly, thời gian và lộ trình thực tế
    // Điểm bắt đầu là kho đỗ của xe (quyết định lập lịch theo kho)
    const routeCoords: [number, number][] = [
      [planningStart.longitude, planningStart.latitude],
      [dto.startLocation.longitude, dto.startLocation.latitude],
      ...stopWithItemsList.map(
        (s) =>
          [s.orderStop.longitude, s.orderStop.latitude] as [number, number],
      ),
      [dto.endLocation.longitude, dto.endLocation.latitude],
    ];

    const routeResult = await this.mapboxService.getRoute(routeCoords);
    const spatialValidation = await this.validateSpatialPlan(
      vehicle,
      stopWithItemsList,
    );
    const requiredDurationMinutes =
      routeResult.durationMinutes +
      stopWithItemsList.reduce(
        (sum, item) => sum + item.orderStop.serviceDurationMinutes,
        0,
      );
    if (
      plannedStart.getTime() + requiredDurationMinutes * 60_000 >
      plannedEnd.getTime()
    ) {
      throw new BadRequestException(
        'Khung giờ chuyến không đủ cho thời gian chạy Mapbox và phục vụ tại các stop',
      );
    }

    // 7. Tạo mã chuyến đi tự động: TRIP-YYYYMMDD-XXXX
    // 8. Thực thi Transaction lưu toàn bộ vào PostgreSQL
    const createdTripId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`${user.id}:CREATE_TRIP:${dto.idempotencyKey}`})::int4)`;
      const command = await tx.processedCommand.findUnique({
        where: {
          actorUserId_commandType_idempotencyKey: {
            actorUserId: user.id,
            commandType: 'CREATE_TRIP',
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });
      if (command) {
        if (command.requestHash !== commandHash) {
          throw new ConflictException(
            'Idempotency key đã được dùng với nội dung tạo chuyến khác',
          );
        }
        const result = command.result as { tripId?: unknown } | null;
        if (
          command.status === 'COMPLETED' &&
          typeof result?.tripId === 'string'
        ) {
          return result.tripId;
        }
        throw new ConflictException('Lệnh tạo chuyến trước đang xử lý');
      }

      await this.acquireApplicationLocks(
        tx,
        [dto.vehicleId],
        [dto.driverId],
        dto.orderIds,
      );
      const [
        currentVehicle,
        currentDriver,
        currentOrders,
        lockedVehicleOverlap,
        lockedDriverOverlap,
      ] = await Promise.all([
        tx.vehicle.findFirst({
          where: {
            id: dto.vehicleId,
            homeBranchId: vehicle.homeBranchId,
            status: VehicleStatus.AVAILABLE,
          },
        }),
        tx.driver.findFirst({
          where: {
            id: dto.driverId,
            homeBranchId: vehicle.homeBranchId,
            status: DriverStatus.AVAILABLE,
            licenseExpiry: { gt: new Date() },
          },
        }),
        tx.order.findMany({
          where: {
            id: { in: dto.orderIds },
            branchId: vehicle.homeBranchId,
            status: OrderStatus.CONFIRMED,
          },
          select: { id: true, version: true },
        }),
        tx.trip.findFirst({
          where: {
            vehicleId: dto.vehicleId,
            status: { in: ACTIVE_TRIP_STATUSES },
            plannedStartTime: { lt: plannedEnd },
            plannedEndTime: { gt: plannedStart },
          },
          select: { tripNumber: true },
        }),
        tx.driverAssignment.findFirst({
          where: {
            driverId: dto.driverId,
            trip: { status: { in: ACTIVE_TRIP_STATUSES } },
            startTime: { lt: plannedEnd },
            endTime: { gt: plannedStart },
          },
          include: { trip: { select: { tripNumber: true } } },
        }),
      ]);
      if (
        !currentVehicle ||
        !currentDriver ||
        currentOrders.length !== dto.orderIds.length
      ) {
        throw new ConflictException(
          'Xe hoặc tài xế không còn khả dụng trong chi nhánh',
        );
      }
      const originalOrderVersions = new Map(
        orders.map((order) => [order.id, order.version]),
      );
      if (
        currentOrders.some(
          (order) => originalOrderVersions.get(order.id) !== order.version,
        )
      ) {
        throw new ConflictException(
          'Một số đơn đã thay đổi sau khi kiểm tra tuyến; hãy lập lại phương án',
        );
      }
      if (lockedVehicleOverlap || lockedDriverOverlap) {
        throw new ConflictException(
          `Lịch xe/tài xế đã thay đổi trong lúc tạo chuyến`,
        );
      }
      const [tripNumber] = await this.allocateTripNumbers(tx, 1);
      const trip = await tx.trip.create({
        data: {
          tripNumber,
          vehicleId: dto.vehicleId,
          managingBranchId: vehicle.homeBranchId,
          status: TripStatus.PLANNED,
          plannedStartTime: plannedStart,
          plannedEndTime: plannedEnd,
          totalDistanceKm: routeResult.distanceKm,
          totalDurationMinutes: routeResult.durationMinutes,
          routeGeometry: routeResult.geometry
            ? JSON.stringify(routeResult.geometry)
            : null,
          planningSnapshot: {
            orders: currentOrders.map((order) => ({
              id: order.id,
              version: order.version + 1,
            })),
            vehicle: {
              id: currentVehicle.id,
              updatedAt: currentVehicle.updatedAt.toISOString(),
            },
            driver: {
              id: currentDriver.id,
              updatedAt: currentDriver.updatedAt.toISOString(),
            },
            startLocation: {
              address: dto.startLocation.address,
              latitude: dto.startLocation.latitude,
              longitude: dto.startLocation.longitude,
            },
            endLocation: {
              address: dto.endLocation.address,
              latitude: dto.endLocation.latitude,
              longitude: dto.endLocation.longitude,
            },
          },
          notes: dto.notes,
        },
      });
      const stopTaskIdByOrderStopId = new Map<string, string>();

      await tx.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: 1,
          stopType: StopType.DEPOT_START,
          address: dto.startLocation.address,
          latitude: dto.startLocation.latitude,
          longitude: dto.startLocation.longitude,
        },
      });

      // Tạo TripStops & StopTasks
      for (let i = 0; i < stopWithItemsList.length; i++) {
        const item = stopWithItemsList[i];
        const isPickup = item.orderStop.type === StopType.PICKUP;
        if (
          item.orderStop.latitude === undefined ||
          item.orderStop.longitude === undefined
        ) {
          throw new BadRequestException('Điểm dừng thiếu tọa độ');
        }

        const tripStop = await tx.tripStop.create({
          data: {
            tripId: trip.id,
            sequence: i + 2,
            stopType: item.orderStop.type,
            address: item.orderStop.address,
            latitude: item.orderStop.latitude,
            longitude: item.orderStop.longitude,
            contactName: item.orderStop.contactName,
            contactPhone: item.orderStop.contactPhone,
          },
        });

        // Tạo Allocation và Tasks cho từng OrderItem của đơn
        const stopTask = await tx.stopTask.create({
          data: {
            tripStopId: tripStop.id,
            orderId: item.order.id,
            orderStopId: item.orderStop.id,
            action: isPickup ? TaskAction.LOAD : TaskAction.UNLOAD,
            plannedQuantity: item.order.items.reduce(
              (sum, orderItem) => sum + orderItem.quantity,
              0,
            ),
          },
        });
        stopTaskIdByOrderStopId.set(item.orderStop.id, stopTask.id);
      }

      await tx.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: stopWithItemsList.length + 2,
          stopType: StopType.DEPOT_END,
          address: dto.endLocation.address,
          latitude: dto.endLocation.latitude,
          longitude: dto.endLocation.longitude,
        },
      });

      await this.persistValidatedLoadPlan(
        tx,
        trip.id,
        dto.vehicleId,
        orders,
        stopTaskIdByOrderStopId,
        spatialValidation,
      );

      // Phân công tài xế
      await tx.driverAssignment.create({
        data: {
          tripId: trip.id,
          driverId: dto.driverId,
          startTime: plannedStart,
          endTime: plannedEnd,
          role: 'PRIMARY',
        },
      });
      await tx.resourceReservation.createMany({
        data: [
          {
            tripId: trip.id,
            vehicleId: dto.vehicleId,
            startsAt: plannedStart,
            endsAt: plannedEnd,
            status: ReservationStatus.HELD,
          },
          {
            tripId: trip.id,
            driverId: dto.driverId,
            startsAt: plannedStart,
            endsAt: plannedEnd,
            status: ReservationStatus.HELD,
          },
        ],
      });

      // Cập nhật trạng thái các đơn hàng sang ASSIGNED
      const updatedOrders = await tx.order.updateMany({
        where: {
          id: { in: dto.orderIds },
          branchId: vehicle.homeBranchId,
          status: OrderStatus.CONFIRMED,
        },
        data: { status: OrderStatus.ASSIGNED, version: { increment: 1 } },
      });
      if (updatedOrders.count !== dto.orderIds.length) {
        throw new ConflictException(
          'Một số đơn không còn CONFIRMED hoặc đã thay đổi chi nhánh',
        );
      }

      await tx.processedCommand.create({
        data: {
          actorUserId: user.id,
          commandType: 'CREATE_TRIP',
          idempotencyKey: dto.idempotencyKey,
          requestHash: commandHash,
          status: 'COMPLETED',
          result: { tripId: trip.id },
        },
      });
      await this.outbox.enqueue(
        {
          aggregateType: 'Trip',
          aggregateId: trip.id,
          aggregateVersion: trip.version,
          eventType: 'TRIP_CREATED',
          payload: { tripId: trip.id, branchId: vehicle.homeBranchId },
        },
        tx,
      );

      return trip.id;
    });

    return this.findOne(createdTripId);
  }

  async updatePlan(
    id: string,
    dto: UpdateTripPlanDto,
    user: { id: string; branchId?: string; role: Role },
  ) {
    const existing = await this.findOne(id);
    this.assertTripAccess(existing, user);
    if (
      existing.status !== TripStatus.DRAFT &&
      existing.status !== TripStatus.PLANNED
    ) {
      throw new ConflictException(
        'Chỉ được chỉnh kế hoạch của chuyến DRAFT/PLANNED',
      );
    }
    if (existing.version !== dto.expectedVersion) {
      throw new ConflictException(
        'Trip Plan đã thay đổi; hãy tải lại trước khi sửa',
      );
    }
    const plannedStart = new Date(dto.plannedStartTime);
    const plannedEnd = new Date(dto.plannedEndTime);
    if (plannedStart >= plannedEnd) {
      throw new BadRequestException(
        'Thời gian bắt đầu phải trước thời gian kết thúc',
      );
    }
    const branchId = existing.managingBranchId ?? existing.vehicle.homeBranchId;
    resolveBranchScope(user, branchId);
    const orderIds = Array.from(
      new Set(
        existing.stops.flatMap((stop) =>
          stop.tasks
            .map((task) => task.orderId)
            .filter(
              (orderId): orderId is string => typeof orderId === 'string',
            ),
        ),
      ),
    );
    const [vehicle, driver, orders] = await Promise.all([
      this.prisma.vehicle.findFirst({
        where: {
          id: dto.vehicleId,
          homeBranchId: branchId,
          status: VehicleStatus.AVAILABLE,
        },
        include: { homeDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT } },
      }),
      this.prisma.driver.findFirst({
        where: {
          id: dto.driverId,
          homeBranchId: branchId,
          status: DriverStatus.AVAILABLE,
          licenseExpiry: { gt: plannedEnd },
        },
      }),
      this.prisma.order.findMany({
        where: { id: { in: orderIds }, branchId, status: OrderStatus.ASSIGNED },
        include: { stops: true, items: true },
      }),
    ]);
    if (!vehicle || !driver || orders.length !== orderIds.length) {
      throw new ConflictException(
        'Xe, tài xế hoặc đơn không còn hợp lệ để sửa kế hoạch',
      );
    }
    const planningStart = resolveVehiclePlanningStart(vehicle);
    const requiredStopIds = orders.flatMap((order) =>
      order.stops.map((stop) => stop.id),
    );
    if (
      dto.orderedStopIds.length !== requiredStopIds.length ||
      new Set(dto.orderedStopIds).size !== requiredStopIds.length ||
      dto.orderedStopIds.some((stopId) => !requiredStopIds.includes(stopId))
    ) {
      throw new BadRequestException(
        'orderedStopIds phải chứa đúng mỗi pickup/delivery một lần',
      );
    }
    const stopWithItems: DispatchStopWithItems[] = dto.orderedStopIds.map(
      (stopId) => {
        for (const order of orders) {
          const orderStop = order.stops.find((stop) => stop.id === stopId);
          if (orderStop) return { orderStop, order };
        }
        throw new BadRequestException(`Không tìm thấy điểm dừng [${stopId}]`);
      },
    );
    TripsValidator.validatePickupBeforeDelivery(stopWithItems);
    TripsValidator.calculateAndValidateLoad(vehicle, stopWithItems);
    const route = await this.mapboxService.getRoute([
      [planningStart.longitude, planningStart.latitude],
      [dto.startLocation.longitude, dto.startLocation.latitude],
      ...stopWithItems.map(
        (item) =>
          [item.orderStop.longitude, item.orderStop.latitude] as [
            number,
            number,
          ],
      ),
      [dto.endLocation.longitude, dto.endLocation.latitude],
    ]);
    const spatial = await this.validateSpatialPlan(vehicle, stopWithItems);
    const requiredDurationMinutes =
      route.durationMinutes +
      stopWithItems.reduce(
        (sum, item) => sum + item.orderStop.serviceDurationMinutes,
        0,
      );
    if (
      plannedStart.getTime() + requiredDurationMinutes * 60_000 >
      plannedEnd.getTime()
    ) {
      throw new BadRequestException(
        'Khung giờ mới không đủ cho tuyến và thời gian phục vụ',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`UPDATE_TRIP:${id}`})::int4)`;
      await this.acquireApplicationLocks(
        tx,
        [dto.vehicleId],
        [dto.driverId],
        orderIds,
      );
      const [currentTrip, currentVehicle, currentDriver, currentOrders] =
        await Promise.all([
          tx.trip.findUnique({
            where: { id },
            select: { version: true, status: true },
          }),
          tx.vehicle.findFirst({
            where: {
              id: dto.vehicleId,
              homeBranchId: branchId,
              status: VehicleStatus.AVAILABLE,
            },
          }),
          tx.driver.findFirst({
            where: {
              id: dto.driverId,
              homeBranchId: branchId,
              status: DriverStatus.AVAILABLE,
              licenseExpiry: { gt: plannedEnd },
            },
          }),
          tx.order.findMany({
            where: {
              id: { in: orderIds },
              branchId,
              status: OrderStatus.ASSIGNED,
            },
            select: { id: true, version: true },
          }),
        ]);
      if (
        !currentTrip ||
        currentTrip.version !== dto.expectedVersion ||
        (currentTrip.status !== TripStatus.DRAFT &&
          currentTrip.status !== TripStatus.PLANNED) ||
        !currentVehicle ||
        !currentDriver ||
        currentOrders.length !== orderIds.length
      ) {
        throw new ConflictException(
          'Trip Plan hoặc tài nguyên đã thay đổi trong lúc sửa',
        );
      }
      const originalVersions = new Map(
        orders.map((order) => [order.id, order.version]),
      );
      if (
        currentOrders.some(
          (order) => originalVersions.get(order.id) !== order.version,
        )
      ) {
        throw new ConflictException(
          'Đơn hàng đã thay đổi trong lúc sửa Trip Plan',
        );
      }
      const [vehicleOverlap, driverOverlap] = await Promise.all([
        tx.trip.findFirst({
          where: {
            id: { not: id },
            vehicleId: dto.vehicleId,
            status: { in: ACTIVE_TRIP_STATUSES },
            plannedStartTime: { lt: plannedEnd },
            plannedEndTime: { gt: plannedStart },
          },
        }),
        tx.driverAssignment.findFirst({
          where: {
            tripId: { not: id },
            driverId: dto.driverId,
            trip: { status: { in: ACTIVE_TRIP_STATUSES } },
            startTime: { lt: plannedEnd },
            endTime: { gt: plannedStart },
          },
        }),
      ]);
      if (vehicleOverlap || driverOverlap) {
        throw new ConflictException(
          'Lịch xe hoặc tài xế bị trùng với chuyến khác',
        );
      }

      const stopTaskIdByOrderStopId = new Map<string, string>();
      const tripStopIdByOrderStopId = new Map<string, string>();
      for (const stop of existing.stops) {
        for (const task of stop.tasks) {
          if (task.orderStopId) {
            stopTaskIdByOrderStopId.set(task.orderStopId, task.id);
            tripStopIdByOrderStopId.set(task.orderStopId, stop.id);
          }
        }
      }
      await tx.tripStop.updateMany({
        where: { tripId: id },
        data: { sequence: { increment: 10_000 } },
      });
      const startStop = existing.stops.find(
        (stop) => stop.stopType === StopType.DEPOT_START,
      );
      const endStop = existing.stops.find(
        (stop) => stop.stopType === StopType.DEPOT_END,
      );
      if (startStop) {
        await tx.tripStop.update({
          where: { id: startStop.id },
          data: { sequence: 1, ...dto.startLocation },
        });
      } else {
        await tx.tripStop.create({
          data: {
            tripId: id,
            sequence: 1,
            stopType: StopType.DEPOT_START,
            ...dto.startLocation,
          },
        });
      }
      for (let index = 0; index < dto.orderedStopIds.length; index++) {
        const tripStopId = tripStopIdByOrderStopId.get(
          dto.orderedStopIds[index],
        );
        if (!tripStopId)
          throw new ConflictException('Trip Stop không còn khớp Order Stop');
        await tx.tripStop.update({
          where: { id: tripStopId },
          data: { sequence: index + 2 },
        });
      }
      if (endStop) {
        await tx.tripStop.update({
          where: { id: endStop.id },
          data: { sequence: dto.orderedStopIds.length + 2, ...dto.endLocation },
        });
      } else {
        await tx.tripStop.create({
          data: {
            tripId: id,
            sequence: dto.orderedStopIds.length + 2,
            stopType: StopType.DEPOT_END,
            ...dto.endLocation,
          },
        });
      }
      const latestLoadPlan = await tx.loadPlan.findFirst({
        where: { tripId: id },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      await this.persistValidatedLoadPlan(
        tx,
        id,
        dto.vehicleId,
        orders,
        stopTaskIdByOrderStopId,
        spatial,
        (latestLoadPlan?.revision ?? 0) + 1,
      );
      await tx.driverAssignment.updateMany({
        where: { tripId: id, role: 'PRIMARY' },
        data: {
          driverId: dto.driverId,
          startTime: plannedStart,
          endTime: plannedEnd,
        },
      });
      await tx.resourceReservation.deleteMany({ where: { tripId: id } });
      await tx.resourceReservation.createMany({
        data: [
          {
            tripId: id,
            vehicleId: dto.vehicleId,
            startsAt: plannedStart,
            endsAt: plannedEnd,
            status: ReservationStatus.HELD,
          },
          {
            tripId: id,
            driverId: dto.driverId,
            startsAt: plannedStart,
            endsAt: plannedEnd,
            status: ReservationStatus.HELD,
          },
        ],
      });
      const updated = await tx.trip.updateMany({
        where: { id, version: dto.expectedVersion, status: currentTrip.status },
        data: {
          vehicleId: dto.vehicleId,
          plannedStartTime: plannedStart,
          plannedEndTime: plannedEnd,
          totalDistanceKm: route.distanceKm,
          totalDurationMinutes: route.durationMinutes,
          routeGeometry: route.geometry ? JSON.stringify(route.geometry) : null,
          notes: dto.notes,
          planningSnapshot: {
            orders: currentOrders,
            vehicle: {
              id: currentVehicle.id,
              updatedAt: currentVehicle.updatedAt.toISOString(),
            },
            driver: {
              id: currentDriver.id,
              updatedAt: currentDriver.updatedAt.toISOString(),
            },
            startLocation: {
              address: dto.startLocation.address,
              latitude: dto.startLocation.latitude,
              longitude: dto.startLocation.longitude,
            },
            endLocation: {
              address: dto.endLocation.address,
              latitude: dto.endLocation.latitude,
              longitude: dto.endLocation.longitude,
            },
          },
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Trip Plan đã bị request khác cập nhật');
      }
      await this.outbox.enqueue(
        {
          aggregateType: 'Trip',
          aggregateId: id,
          aggregateVersion: dto.expectedVersion + 1,
          eventType: 'TRIP_PLAN_UPDATED',
          payload: { tripId: id, branchId, updatedBy: user.id },
        },
        tx,
      );
    });
    return this.findOne(id);
  }

  /**
   * Phát hành chuyến đi (Publish Trip)
   */
  async publish(
    id: string,
    dto: PublishTripDto,
    user: { id: string; branchId?: string; role: Role },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`PUBLISH_TRIP:${id}`})::int4)`;
      const trip = await tx.trip.findUnique({
        where: { id },
        include: {
          vehicle: true,
          assignments: { include: { driver: true } },
          stops: {
            orderBy: { sequence: 'asc' },
            include: { tasks: true },
          },
        },
      });
      if (!trip) {
        throw new NotFoundException(`Không tìm thấy chuyến đi [${id}]`);
      }
      this.assertTripAccess(trip, user);
      if (
        trip.status !== TripStatus.PLANNED &&
        trip.status !== TripStatus.DRAFT
      ) {
        throw new BadRequestException(
          `Chuyến đi ở trạng thái [${trip.status}] không thể phát hành`,
        );
      }
      if (trip.version !== dto.expectedVersion) {
        throw new ConflictException(
          `Chuyến đi đã thay đổi (version ${trip.version}); hãy tải lại trước khi phát hành`,
        );
      }
      if (
        !trip.assignments.some((assignment) => assignment.role === 'PRIMARY')
      ) {
        throw new ConflictException(
          'Chuyến đi chưa có tài xế PRIMARY nên không thể phát hành',
        );
      }
      const primaryAssignment = trip.assignments.find(
        (assignment) => assignment.role === 'PRIMARY',
      );
      if (
        trip.vehicle.status !== VehicleStatus.AVAILABLE ||
        !primaryAssignment ||
        primaryAssignment.driver.status !== DriverStatus.AVAILABLE ||
        primaryAssignment.driver.licenseExpiry <= trip.plannedEndTime
      ) {
        throw new ConflictException(
          'Xe hoặc tài xế không còn khả dụng cho toàn bộ khoảng thời gian chuyến',
        );
      }
      const planningSnapshot = this.parsePlanningSnapshot(
        trip.planningSnapshot,
      );
      if (
        planningSnapshot.vehicle.id !== trip.vehicleId ||
        planningSnapshot.driver.id !== primaryAssignment.driverId
      ) {
        throw new ConflictException(
          'Planning snapshot không khớp xe hoặc tài xế của chuyến',
        );
      }
      const orderIds = planningSnapshot.orders.map((order) => order.id);
      await this.acquireApplicationLocks(
        tx,
        [trip.vehicleId],
        [primaryAssignment.driverId],
        orderIds,
      );
      const [
        currentOrders,
        currentVehicle,
        currentDriver,
        vehicleOverlap,
        driverOverlap,
      ] = await Promise.all([
        tx.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, version: true, status: true },
        }),
        tx.vehicle.findUnique({ where: { id: trip.vehicleId } }),
        tx.driver.findUnique({ where: { id: primaryAssignment.driverId } }),
        tx.trip.findFirst({
          where: {
            id: { not: id },
            vehicleId: trip.vehicleId,
            status: { in: ACTIVE_TRIP_STATUSES },
            plannedStartTime: { lt: trip.plannedEndTime },
            plannedEndTime: { gt: trip.plannedStartTime },
          },
          select: { tripNumber: true },
        }),
        tx.driverAssignment.findFirst({
          where: {
            driverId: primaryAssignment.driverId,
            tripId: { not: id },
            trip: { status: { in: ACTIVE_TRIP_STATUSES } },
            startTime: { lt: trip.plannedEndTime },
            endTime: { gt: trip.plannedStartTime },
          },
          select: { tripId: true },
        }),
      ]);
      const expectedOrderVersions = new Map(
        planningSnapshot.orders.map((order) => [order.id, order.version]),
      );
      if (
        currentOrders.length !== planningSnapshot.orders.length ||
        currentOrders.some(
          (order) =>
            order.status !== OrderStatus.ASSIGNED ||
            expectedOrderVersions.get(order.id) !== order.version,
        ) ||
        !currentVehicle ||
        currentVehicle.status !== VehicleStatus.AVAILABLE ||
        currentVehicle.updatedAt.toISOString() !==
          planningSnapshot.vehicle.updatedAt ||
        !currentDriver ||
        currentDriver.status !== DriverStatus.AVAILABLE ||
        currentDriver.licenseExpiry <= trip.plannedEndTime ||
        currentDriver.updatedAt.toISOString() !==
          planningSnapshot.driver.updatedAt
      ) {
        throw new ConflictException(
          'Đơn hàng, xe hoặc tài xế đã thay đổi sau khi lập kế hoạch',
        );
      }
      if (vehicleOverlap || driverOverlap) {
        throw new ConflictException(
          'Lịch xe hoặc tài xế đã bị trùng trước khi phát hành chuyến',
        );
      }
      const reservations = await tx.resourceReservation.findMany({
        where: {
          tripId: id,
          status: { in: [ReservationStatus.HELD, ReservationStatus.ACTIVE] },
          startsAt: trip.plannedStartTime,
          endsAt: trip.plannedEndTime,
        },
      });
      const hasVehicleReservation = reservations.some(
        (reservation) => reservation.vehicleId === trip.vehicleId,
      );
      const hasDriverReservation = reservations.some(
        (reservation) => reservation.driverId === primaryAssignment?.driverId,
      );
      if (!hasVehicleReservation || !hasDriverReservation) {
        throw new ConflictException(
          'Chuyến đi thiếu reservation hợp lệ cho xe hoặc tài xế',
        );
      }

      const loadPlan = await tx.loadPlan.findFirst({
        where: { tripId: id },
        orderBy: { revision: 'desc' },
        include: { steps: { select: { stopTaskId: true } } },
      });
      if (
        !loadPlan ||
        loadPlan.validationStatus !== LoadValidationStatus.VALID
      ) {
        throw new ConflictException(
          'Chuyến đi chưa có Load Plan hợp lệ nên không thể phát hành',
        );
      }
      const requiredTaskIds = new Set(
        trip.stops.flatMap((stop) => stop.tasks.map((task) => task.id)),
      );
      const plannedTaskIds = new Set(
        loadPlan.steps
          .map((step) => step.stopTaskId)
          .filter((taskId): taskId is string => typeof taskId === 'string'),
      );
      if (
        requiredTaskIds.size === 0 ||
        plannedTaskIds.size !== requiredTaskIds.size ||
        [...requiredTaskIds].some((taskId) => !plannedTaskIds.has(taskId))
      ) {
        throw new ConflictException(
          'Load Plan không bao phủ đầy đủ các thao tác xếp/dỡ của chuyến',
        );
      }

      const updated = await tx.trip.updateMany({
        where: { id, version: dto.expectedVersion, status: trip.status },
        data: { status: TripStatus.DISPATCHED, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'Chuyến đi đã được thay đổi bởi request khác; hãy tải lại',
        );
      }
      const activatedReservations = await tx.resourceReservation.updateMany({
        where: {
          tripId: id,
          status: ReservationStatus.HELD,
        },
        data: { status: ReservationStatus.ACTIVE },
      });
      if (
        activatedReservations.count > 0 &&
        activatedReservations.count !== 2
      ) {
        throw new ConflictException(
          'Không thể kích hoạt đầy đủ reservation xe và tài xế',
        );
      }
      await this.outbox.enqueue(
        {
          aggregateType: 'Trip',
          aggregateId: id,
          aggregateVersion: dto.expectedVersion + 1,
          eventType: 'TRIP_PUBLISHED',
          payload: {
            tripId: id,
            branchId: trip.managingBranchId ?? trip.vehicle.homeBranchId,
            publishedBy: user.id,
            loadPlanId: loadPlan.id,
          },
        },
        tx,
      );
      return {
        ...trip,
        status: TripStatus.DISPATCHED,
        version: dto.expectedVersion + 1,
      };
    });
  }

  /**
   * Lấy biểu đồ phân tích tải trọng xe qua từng điểm dừng (Load Profile)
   */
  async getLoadProfile(id: string, user?: { branchId?: string; role: Role }) {
    const trip = user
      ? await this.findOneAuthorized(id, user)
      : await this.findOne(id);
    const stopsWithItems: StopWithItems[] = [];
    for (const stop of trip.stops) {
      for (const task of stop.tasks) {
        if (!task.order) continue;
        stopsWithItems.push({
          orderStop: {
            orderId: task.order.id,
            type: stop.stopType,
            address: stop.address,
          },
          order: {
            id: task.order.id,
            orderNumber: task.order.orderNumber,
            totalWeightKg: task.order.totalWeightKg,
            totalVolumeM3: task.order.totalVolumeM3,
            items: task.order.items,
          },
        });
      }
    }
    return TripsValidator.calculateAndValidateLoad(
      trip.vehicle,
      stopsWithItems,
    );
  }

  async runOptimization(body: OptimizeTripDto) {
    if (new Set(body.orderIds).size !== body.orderIds.length) {
      throw new BadRequestException(
        'Danh sách orderIds không được chứa ID trùng',
      );
    }
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: body.vehicleId },
      include: {
        homeBranch: true,
        homeDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT },
      },
    });
    if (!vehicle) {
      throw new NotFoundException('Không tìm thấy xe');
    }
    const planningStart = resolveVehiclePlanningStart(vehicle);

    const orders = await this.prisma.order.findMany({
      where: { id: { in: body.orderIds } },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
    });
    if (orders.length !== body.orderIds.length) {
      throw new BadRequestException('Một số đơn hàng tối ưu không tồn tại');
    }

    const orderedOrders = body.orderIds.map((id) =>
      orders.find((order) => order.id === id)!,
    );
    const planningEpoch = getPlanningEpoch(
      orderedOrders.map((order) => order.orderedAt),
      vehicle.homeBranch.timezone,
    );
    const optimizerOrders = this.buildOptimizerOrders(
      orderedOrders,
      planningEpoch,
    );
    const matrixCoordinates: [number, number][] = [
      [planningStart.longitude, planningStart.latitude],
      ...optimizerOrders.flatMap((order) => [
        [order.pickup_location.longitude, order.pickup_location.latitude] as [
          number,
          number,
        ],
        [
          order.delivery_location.longitude,
          order.delivery_location.latitude,
        ] as [number, number],
      ]),
    ];
    const matrix = await this.mapboxService.getRoadMatrix(matrixCoordinates);

    const payload = {
      job_id: `job-${Date.now()}`,
      vehicle: {
        id: vehicle.id,
        plate_number: vehicle.plateNumber,
        length_cm: vehicle.lengthCm,
        width_cm: vehicle.widthCm,
        height_cm: vehicle.heightCm,
        payload_limit_kg: vehicle.payloadCapacityKg,
        door_position: 'REAR',
      },
      depot: {
        id: `depot:${planningStart.locationId}`,
        name: planningStart.name,
        latitude: planningStart.latitude,
        longitude: planningStart.longitude,
      },
      orders: optimizerOrders,
      max_time_seconds: 5,
      distance_matrix_meters: matrix.distancesMeters,
      duration_matrix_seconds: matrix.durationsSeconds,
    };

    try {
      const res = await axios.post(`${this.optimizerUrl}/optimize`, payload, {
        timeout: 10000,
      });
      if (
        !res.data ||
        typeof res.data.job_id !== 'string' ||
        !Array.isArray(res.data.stops)
      ) {
        throw new Error('Optimization Engine trả response sai contract');
      }
      return res.data;
    } catch (error) {
      throw new BadRequestException(
        error.response?.data?.detail ||
          error.message ||
          'Lỗi khi gọi Optimization Engine',
      );
    }
  }

  async executeAutomaticOptimization(
    user: { id: string; branchId?: string; role: Role },
    dto?: RunAutomaticOptimizationDto | string,
    persistedJobId?: string,
    reportProgress?: OptimizationProgressReporter,
  ) {
    const requestedBranchId = typeof dto === 'string' ? dto : dto?.branchId;
    const scheduleMode =
      typeof dto === 'object' ? dto?.scheduleMode : undefined;
    const customStartTimeStr =
      typeof dto === 'object' ? dto?.customStartTime : undefined;
    const branchId = resolveBranchScope(user, requestedBranchId);

    const [branch, vehicles, drivers, candidateOrders] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: branchId, active: true } }),
      this.prisma.vehicle.findMany({
        where: {
          homeBranchId: branchId,
          status: 'AVAILABLE',
          homeDepotLocationId: { not: null },
        },
        include: {
          homeBranch: true,
          homeDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT },
        },
        orderBy: { plateNumber: 'asc' },
      }),
      this.prisma.driver.findMany({
        where: {
          homeBranchId: branchId,
          status: 'AVAILABLE',
          licenseExpiry: { gt: new Date() },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.order.findMany({
        where: { branchId, status: OrderStatus.CONFIRMED },
        include: {
          stops: { orderBy: { sequence: 'asc' } },
          items: true,
          packages: {
            include: { items: true },
            orderBy: { packageCode: 'asc' },
          },
        },
        orderBy: { orderedAt: 'asc' },
      }),
    ]);

    const orders = candidateOrders.filter((order) => {
      if (order.packages.length === 0) return true;
      const activePackages = order.packages.filter(
        (physicalPackage) => physicalPackage.status !== PackageStatus.CANCELLED,
      );
      return (
        activePackages.length > 0 &&
        activePackages.every(
          (physicalPackage) => physicalPackage.status === PackageStatus.READY,
        )
      );
    });

    if (!branch)
      throw new NotFoundException('Không tìm thấy chi nhánh đang hoạt động');
    if (vehicles.length === 0)
      throw new BadRequestException(
        'Không có xe khả dụng đã được gán kho đỗ trong chi nhánh',
      );
    if (drivers.length === 0)
      throw new BadRequestException('Không có tài xế khả dụng trong chi nhánh');
    if (orders.length === 0)
      throw new BadRequestException('Không có đơn CONFIRMED để tối ưu');

    const candidateVehicles = vehicles
      .slice(0, drivers.length)
      .map((vehicle) => ({
        ...vehicle,
        planningStart: resolveVehiclePlanningStart(vehicle),
      }));

    const now = new Date();
    let planningEpoch: Date;
    let effectiveStartTime: Date | undefined;

    if (scheduleMode === AutomaticDispatchScheduleMode.NEXT_DAY) {
      planningEpoch = getNextDayPlanningEpoch(
        orders.map((order) => order.orderedAt),
        branch.timezone,
        now,
      );
    } else if (scheduleMode === AutomaticDispatchScheduleMode.CURRENT_TIME) {
      planningEpoch = getPlanningEpoch(
        orders.map((order) => order.orderedAt),
        branch.timezone,
        now,
      );
      if (customStartTimeStr) {
        effectiveStartTime = new Date(customStartTimeStr);
        if (Number.isNaN(effectiveStartTime.getTime())) {
          throw new BadRequestException('customStartTime không hợp lệ');
        }
      } else {
        effectiveStartTime = now;
      }
    } else {
      planningEpoch = getFullServiceDayPlanningEpoch(
        orders.map((order) => order.orderedAt),
        branch.timezone,
        branch.workStartTime,
        now,
      );
    }

    let serviceDays: ServiceDayWindow[];
    try {
      serviceDays = buildServiceDayWindows(
        planningEpoch,
        branch.timezone,
        branch.workStartTime,
        branch.workEndTime,
        AUTOMATIC_PLANNING_DAY_COUNT,
        {
          scheduleMode,
          effectiveStartTime,
        },
      );
    } catch (error: any) {
      throw new BadRequestException(
        error.message || 'Không thể tạo cửa sổ thời gian điều phối',
      );
    }
    const baseVehicles = candidateVehicles.map((vehicle) => ({
      id: vehicle.id,
      source_vehicle_id: vehicle.id,
      plate_number: vehicle.plateNumber,
      model: vehicle.model,
      vehicle_type: vehicle.vehicleType,
      length_cm: vehicle.lengthCm,
      width_cm: vehicle.widthCm,
      height_cm: vehicle.heightCm,
      payload_limit_kg: vehicle.payloadCapacityKg,
      door_position: 'REAR',
      depot: {
        id: `depot:${vehicle.planningStart.locationId}`,
        name: vehicle.planningStart.name,
        latitude: vehicle.planningStart.latitude,
        longitude: vehicle.planningStart.longitude,
      },
      fuel_consumption_liters_per_100_km: Number(
        vehicle.fuelConsumptionLitersPer100Km,
      ),
      load_fuel_surcharge_percent_at_full_payload: Number(
        vehicle.loadFuelSurchargePercentAtFullPayload,
      ),
      fixed_operating_cost_vnd: Number(vehicle.fixedOperatingCostPerTrip),
    }));
    const baseDrivers = drivers.map((driver) => ({
      source_driver_id: driver.id,
      full_name: driver.fullName,
      license_class: driver.licenseClass,
      fixed_salary_monthly_vnd: Number(driver.fixedSalaryMonthly),
      trip_base_pay_vnd: Number(driver.tripBasePay),
      per_km_pay_vnd: Number(driver.perKmPay),
    }));
    const snapshot = {
      vehicles: serviceDays.flatMap((day) =>
        baseVehicles.map((vehicle) => ({
          ...vehicle,
          id: `${vehicle.source_vehicle_id}::day:${day.serviceDayIndex}`,
          service_day_index: day.serviceDayIndex,
          available_start_sec: day.startSec,
          available_end_sec: day.endSec,
        })),
      ),
      drivers: serviceDays.flatMap((day) =>
        baseDrivers.map((driver) => ({
          ...driver,
          id: `${driver.source_driver_id}::day:${day.serviceDayIndex}`,
          service_day_index: day.serviceDayIndex,
        })),
      ),
      orders: splitOversizedOrdersAcrossFleet(
        this.buildOptimizerOrders(orders, planningEpoch),
        baseVehicles,
      ),
      policy: {
        fuel_price_per_liter_vnd: Number(branch.fuelPricePerLiter),
        monthly_working_minutes: branch.monthlyWorkingMinutes,
        cargo_holding_cost_vnd_per_ton_hour: Number(
          branch.cargoHoldingCostVndPerTonHour,
        ),
        unassigned_order_penalty_vnd: 1_000_000_000,
        delivery_grace_days: branch.deliveryGraceDays,
        late_delivery_penalty_mode: branch.lateDeliveryPenaltyMode,
        late_delivery_penalty_value: Number(branch.lateDeliveryPenaltyValue),
      },
      planning_epoch_iso: planningEpoch.toISOString(),
      // Optimizer là nguồn duy nhất chọn ngân sách thực theo độ phức tạp.
      // Backend chỉ truyền trần cứng hai phút để snapshot/provenance không
      // nhân đôi công thức chính sách giữa Node và Python.
      max_time_seconds: 120,
    };
    const vehicleCount = snapshot.vehicles.length;
    const optimizationUnitCount = snapshot.orders.length;
    const orderCount = orders.length;
    const progressDetails = {
      orderCount,
      packageCount: snapshot.orders.reduce(
        (total, order) => total + order.items.length,
        0,
      ),
      physicalVehicleCount: candidateVehicles.length,
      driverCount: drivers.length,
      serviceSlotCount: vehicleCount,
    };
    await reportProgress?.({
      stage: 'BUILDING_MATRIX',
      details: progressDetails,
    });
    const firstDepot = snapshot.vehicles[0]?.depot;
    const allSameDepot =
      firstDepot &&
      snapshot.vehicles.every(
        (vehicle) =>
          vehicle.depot.longitude === firstDepot.longitude &&
          vehicle.depot.latitude === firstDepot.latitude,
      );

    const matrixQueriedAt = new Date();
    let fullDistances: number[][];
    let fullDurations: number[][];

    if (allSameDepot && vehicleCount > 1) {
      const compactCoordinates: [number, number][] = [
        [firstDepot.longitude, firstDepot.latitude],
        ...snapshot.orders.flatMap((order) => [
          [order.pickup_location.longitude, order.pickup_location.latitude] as [
            number,
            number,
          ],
          [
            order.delivery_location.longitude,
            order.delivery_location.latitude,
          ] as [number, number],
        ]),
      ];
      const matrix = await this.mapboxService.getRoadMatrix(compactCoordinates);
      const fullSize = vehicleCount + optimizationUnitCount * 2;
      fullDistances = Array.from({ length: fullSize }, () =>
        Array(fullSize).fill(0),
      );
      fullDurations = Array.from({ length: fullSize }, () =>
        Array(fullSize).fill(0),
      );

      for (let i = 0; i < fullSize; i++) {
        const mapboxI = i < vehicleCount ? 0 : i - vehicleCount + 1;
        for (let j = 0; j < fullSize; j++) {
          const mapboxJ = j < vehicleCount ? 0 : j - vehicleCount + 1;
          if (i < vehicleCount && j < vehicleCount) continue;
          fullDistances[i][j] = matrix.distancesMeters[mapboxI][mapboxJ];
          fullDurations[i][j] = matrix.durationsSeconds[mapboxI][mapboxJ];
        }
      }
    } else {
      const coordinates: [number, number][] = [
        ...snapshot.vehicles.map(
          (vehicle) =>
            [vehicle.depot.longitude, vehicle.depot.latitude] as [
              number,
              number,
            ],
        ),
        ...snapshot.orders.flatMap((order) => [
          [order.pickup_location.longitude, order.pickup_location.latitude] as [
            number,
            number,
          ],
          [
            order.delivery_location.longitude,
            order.delivery_location.latitude,
          ] as [number, number],
        ]),
      ];
      const matrix = await this.mapboxService.getRoadMatrix(coordinates);
      fullDistances = matrix.distancesMeters;
      fullDurations = matrix.durationsSeconds;
    }

    const payload = {
      job_id: persistedJobId ?? `request-${randomUUID()}`,
      vehicles: snapshot.vehicles,
      drivers: snapshot.drivers,
      orders: snapshot.orders,
      policy: snapshot.policy,
      max_time_seconds: snapshot.max_time_seconds,
      distance_matrix_meters: fullDistances,
      duration_matrix_seconds: fullDurations,
    };

    if (persistedJobId) {
      const requestSnapshot = {
        branchId,
        planningEpochIso: planningEpoch.toISOString(),
        scheduleMode: scheduleMode ?? null,
        resources: {
          orders: orders.map((order) => ({
            id: order.id,
            version: order.version,
          })),
          vehicles: candidateVehicles.map((vehicle) => ({
            id: vehicle.id,
            updatedAt: vehicle.updatedAt.toISOString(),
          })),
          drivers: drivers.map((driver) => ({
            id: driver.id,
            updatedAt: driver.updatedAt.toISOString(),
          })),
        },
        vehicleLocationProvenance: candidateVehicles.map((vehicle) => ({
          vehicleId: vehicle.id,
          source: vehicle.planningStart.source,
          depotLocationId: vehicle.planningStart.locationId,
          depotLocationCode: vehicle.planningStart.locationCode,
          lastGpsMeasuredAt: vehicle.lastLocationAt?.toISOString() ?? null,
        })),
        matrixProvenance: {
          provider: 'MAPBOX',
          profile: 'mapbox/driving',
          queriedAt: matrixQueriedAt.toISOString(),
          indexes: [
            ...snapshot.vehicles.map((vehicle, index) => ({
              index,
              kind: 'VEHICLE_START',
              id: vehicle.id,
            })),
            ...snapshot.orders.flatMap((order, orderIndex) => [
              {
                index: vehicleCount + orderIndex * 2,
                kind: 'PICKUP',
                id: order.pickup_location.id,
                orderId: order.id,
              },
              {
                index: vehicleCount + orderIndex * 2 + 1,
                kind: 'DELIVERY',
                id: order.delivery_location.id,
                orderId: order.id,
              },
            ]),
          ],
        },
        optimizerPayload: payload,
      };
      await this.prisma.optimizationJob.update({
        where: { id: persistedJobId },
        data: {
          requestSnapshot: requestSnapshot as unknown as Prisma.InputJsonValue,
          requestHash: createHash('sha256')
            .update(JSON.stringify(requestSnapshot))
            .digest('hex'),
        },
      });
    }

    await reportProgress?.({
      stage: 'SEARCHING_SOLUTIONS',
      details: progressDetails,
    });

    let rankedResults;
    try {
      const response = await axios.post(
        `${this.optimizerUrl}/optimize-fleet/candidates`,
        payload,
        {
          timeout: Math.max(120000, (snapshot.max_time_seconds + 90) * 1000),
        },
      );
      assertFleetOptimizationBatchResult(response.data);
      rankedResults = response.data.candidates;
    } catch (error: any) {
      const detail = error.response?.data?.detail;
      const detailMsg = Array.isArray(detail)
        ? detail.map((d: any) => `${d.loc?.join('.')}: ${d.msg}`).join('; ')
        : typeof detail === 'string'
          ? detail
          : null;
      throw new ServiceUnavailableException(
        detailMsg ||
          error.response?.data?.message ||
          error.message ||
          'Không thể nhận chuỗi nghiệm từ Optimization Engine',
      );
    }

    await reportProgress?.({
      stage: 'BUILDING_ROUTE_GEOMETRY',
      details: {
        ...progressDetails,
        candidateCount: rankedResults.length,
      },
    });

    const expiresAt = new Date(
      Date.now() + OPTIMIZATION_PROPOSAL_TTL_MS,
    ).toISOString();
    const feasibleResults = rankedResults.filter((candidate) =>
      ['SUCCESS', 'PARTIAL'].includes(candidate.result.status),
    );
    if (feasibleResults.length === 0) {
      const fallback = rankedResults[0];
      if (fallback) {
        const proposal: OptimizationProposal = {
          branchId,
          planningEpochIso: planningEpoch.toISOString(),
          scheduleMode,
          expiresAt,
          resources: {
            orders: orders.map((order) => ({
              id: order.id,
              version: order.version,
            })),
            vehicles: candidateVehicles.map((vehicle) => ({
              id: vehicle.id,
              updatedAt: vehicle.updatedAt.toISOString(),
            })),
            drivers: drivers.map((driver) => ({
              id: driver.id,
              updatedAt: driver.updatedAt.toISOString(),
            })),
          },
          result: JSON.parse(JSON.stringify(fallback.result)),
        };
        const best: StoredOptimizationCandidate = {
          proposal,
          signature: signOptimizationProposal(
            proposal,
            this.optimizationProposalSecret,
          ),
          rank: fallback.rank ?? 1,
          searchStrategy: fallback.search_strategy ?? 'Khởi tạo',
          solverObjective: fallback.solver_objective,
          isBestFound: true,
        };
        return {
          best,
          candidates: [],
        } satisfies StoredOptimizationCandidateBatch;
      }
      throw new ServiceUnavailableException(
        'Optimization Engine không trả về nghiệm nào từ lần chạy solver',
      );
    }
    const candidates: StoredOptimizationCandidate[] = [];
    for (const candidate of feasibleResults) {
      const { result } = candidate;
      await Promise.all(
        result.routes.map(async (route) => {
          const vehicle = snapshot.vehicles.find(
            (item) => item.id === route.route_id,
          );
          if (!vehicle)
            throw new Error(`Optimizer trả route_id lạ: ${route.route_id}`);
          const routeCoordinates: [number, number][] = [
            [vehicle.depot.longitude, vehicle.depot.latitude],
            ...route.stops.map(
              (stop) => [stop.longitude, stop.latitude] as [number, number],
            ),
            [vehicle.depot.longitude, vehicle.depot.latitude],
          ];
          const routeDetails =
            await this.mapboxService.getRoute(routeCoordinates);
          route.depot = vehicle.depot;
          route.route_geometry = routeDetails.geometry;
        }),
      );
      const proposal: OptimizationProposal = {
        branchId,
        planningEpochIso: planningEpoch.toISOString(),
        scheduleMode,
        expiresAt,
        resources: {
          orders: orders.map((order) => ({
            id: order.id,
            version: order.version,
          })),
          vehicles: candidateVehicles.map((vehicle) => ({
            id: vehicle.id,
            updatedAt: vehicle.updatedAt.toISOString(),
          })),
          drivers: drivers.map((driver) => ({
            id: driver.id,
            updatedAt: driver.updatedAt.toISOString(),
          })),
        },
        result: JSON.parse(JSON.stringify(result)),
      };
      candidates.push({
        proposal,
        signature: signOptimizationProposal(
          proposal,
          this.optimizationProposalSecret,
        ),
        rank: candidate.rank,
        searchStrategy: candidate.search_strategy,
        solverObjective: candidate.solver_objective,
        isBestFound: candidate.is_best_found,
      });
    }

    return {
      best: candidates[0],
      candidates,
    } satisfies StoredOptimizationCandidateBatch;
  }

  async applyAutomaticOptimization(
    dto: ApplyAutomaticOptimizationDto,
    user: { id: string; branchId?: string; role: Role },
    sourceJobId?: string,
    sourceCandidateNumber?: number,
  ) {
    try {
      assertOptimizationProposal(dto.proposal);
    } catch (error) {
      throw new BadRequestException(
        error.message || 'Proposal tối ưu không hợp lệ',
      );
    }
    const proposal = dto.proposal;
    const branchId = resolveBranchScope(user, proposal.branchId);
    if (branchId !== proposal.branchId) {
      throw new ForbiddenException(
        'Không có quyền áp dụng kế hoạch ngoài chi nhánh',
      );
    }
    if (
      !verifyOptimizationProposalSignature(
        proposal,
        dto.signature,
        this.optimizationProposalSecret,
      )
    ) {
      throw new ForbiddenException(
        'Kết quả tối ưu đã bị thay đổi hoặc chữ ký không hợp lệ',
      );
    }
    if (Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new ConflictException(
        'Kết quả tối ưu đã hết hạn; hãy chạy tối ưu lại',
      );
    }
    if (!['SUCCESS', 'PARTIAL'].includes(proposal.result.status)) {
      throw new BadRequestException(
        `Không thể áp dụng kết quả ở trạng thái [${proposal.result.status}]`,
      );
    }
    if (proposal.result.routes.length === 0) {
      throw new BadRequestException(
        'Kết quả tối ưu không có tuyến nào để áp dụng',
      );
    }

    const orderIds = Array.from(
      new Set(
        proposal.result.routes.flatMap((route) =>
          route.stops.map((stop) => stop.order_id),
        ),
      ),
    );
    const vehicleIds = Array.from(
      new Set(proposal.result.routes.map((route) => route.vehicle_id)),
    );
    const driverIds = Array.from(
      new Set(
        proposal.result.routes
          .map((route) => route.driver_id)
          .filter(Boolean) as string[],
      ),
    );
    if (
      orderIds.length === 0 ||
      driverIds.length === 0 ||
      vehicleIds.length === 0 ||
      proposal.result.routes.some((route) => !route.driver_id)
    ) {
      throw new BadRequestException(
        'Mỗi tuyến phải có xe, tài xế và ít nhất một đơn hàng',
      );
    }

    const applied = await this.prisma.$transaction(
      async (tx) => {
        if (sourceJobId) {
          const claimedJob = await tx.optimizationJob.updateMany({
            where: {
              id: sourceJobId,
              branchId,
              status: { in: ['SUCCEEDED', 'PARTIAL'] },
            },
            data: { status: 'APPLYING' },
          });
          if (claimedJob.count !== 1) {
            throw new ConflictException(
              'Optimization job đang được áp dụng, đã áp dụng hoặc không còn hợp lệ',
            );
          }
        }
        await this.acquireApplicationLocks(tx, vehicleIds, driverIds, orderIds);

        const [orders, vehicles, drivers] = await Promise.all([
          tx.order.findMany({
            where: { id: { in: orderIds }, branchId },
            include: {
              stops: true,
              items: true,
              packages: {
                include: { items: true },
                orderBy: { packageCode: 'asc' },
              },
            },
          }),
          tx.vehicle.findMany({
            where: { id: { in: vehicleIds }, homeBranchId: branchId },
          }),
          tx.driver.findMany({
            where: { id: { in: driverIds }, homeBranchId: branchId },
          }),
        ]);

        this.assertProposalResourcesCurrent(
          proposal,
          orders,
          vehicles,
          drivers,
        );
        const plannedTrips = this.buildPlannedAutomaticTrips(
          proposal,
          orders,
          vehicles,
          drivers,
        );

        const packageIdByCargoUnit = await this.ensurePhysicalPackageMapping(
          tx,
          orders,
        );
        const cargoUnitIds = plannedTrips.flatMap((trip) => trip.cargoUnitIds);
        const packageIds = cargoUnitIds.map((cargoUnitId) => {
          const packageId = packageIdByCargoUnit.get(cargoUnitId);
          if (!packageId) {
            throw new ConflictException(
              `Không ánh xạ được kiện [${cargoUnitId}] sang Package vật lý`,
            );
          }
          return packageId;
        });
        if (new Set(packageIds).size !== packageIds.length) {
          throw new ConflictException(
            'Một Package vật lý bị phân công vào nhiều phần của phương án',
          );
        }

        await this.assertPackagesNotOnActiveTrip(tx, packageIds);
        for (const trip of plannedTrips) {
          await this.assertNoResourceOverlap(tx, trip);
        }

        const allocatedPackages = await tx.package.updateMany({
          where: {
            id: { in: packageIds },
            status: PackageStatus.READY,
          },
          data: {
            status: PackageStatus.ALLOCATED,
            version: { increment: 1 },
          },
        });
        if (allocatedPackages.count !== packageIds.length) {
          throw new ConflictException(
            'Trạng thái kiện đã thay đổi hoặc kiện đã được phân công; toàn bộ thao tác được rollback',
          );
        }

        const tripNumbers = await this.allocateTripNumbers(
          tx,
          plannedTrips.length,
        );
        const createdTrips: Array<{
          id: string;
          tripNumber: string;
          vehicleId: string;
          driverId: string;
          orderIds: string[];
          plannedStartTime: Date;
          plannedEndTime: Date;
        }> = [];
        for (let index = 0; index < plannedTrips.length; index++) {
          createdTrips.push(
            await this.persistAutomaticTrip(
              tx,
              plannedTrips[index],
              tripNumbers[index],
              branchId,
              sourceJobId,
              sourceCandidateNumber,
              packageIdByCargoUnit,
            ),
          );
        }
        const updatedOrders = await tx.order.updateMany({
          where: {
            id: { in: orderIds },
            status: OrderStatus.CONFIRMED,
          },
          data: { status: OrderStatus.ASSIGNED, version: { increment: 1 } },
        });
        if (updatedOrders.count !== orderIds.length) {
          throw new ConflictException(
            'Trạng thái đơn đã thay đổi trong lúc áp dụng; toàn bộ thao tác được rollback',
          );
        }
        if (sourceJobId) {
          const finalizedJob = await tx.optimizationJob.updateMany({
            where: {
              id: sourceJobId,
              branchId,
              status: 'APPLYING',
            },
            data: {
              status: 'APPLIED',
              completedAt: new Date(),
            },
          });
          if (finalizedJob.count !== 1) {
            throw new ConflictException(
              'Optimization job đã thay đổi trong lúc áp dụng; toàn bộ Trip sẽ được rollback',
            );
          }
        }
        return createdTrips;
      },
      { maxWait: 5000, timeout: 20000 },
    );

    return {
      appliedAt: new Date().toISOString(),
      trips: applied,
    };
  }

  private get optimizerUrl() {
    return process.env.OPTIMIZER_URL || 'http://localhost:8000';
  }

  private parsePlanningSnapshot(
    value: Prisma.JsonValue | null,
  ): TripPlanningSnapshot {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new ConflictException(
        'Chuyến chưa có planning snapshot; cần lập lại phương án trước khi publish',
      );
    }
    const candidate = value as Record<string, Prisma.JsonValue>;
    const orders = candidate.orders;
    const vehicle = candidate.vehicle;
    const driver = candidate.driver;
    if (
      !Array.isArray(orders) ||
      !vehicle ||
      Array.isArray(vehicle) ||
      typeof vehicle !== 'object' ||
      !driver ||
      Array.isArray(driver) ||
      typeof driver !== 'object'
    ) {
      throw new ConflictException('Planning snapshot sai cấu trúc');
    }
    const parsedOrders = orders.map((order) => {
      if (
        !order ||
        Array.isArray(order) ||
        typeof order !== 'object' ||
        typeof order.id !== 'string' ||
        typeof order.version !== 'number'
      ) {
        throw new ConflictException(
          'Planning snapshot chứa version đơn không hợp lệ',
        );
      }
      return { id: order.id, version: order.version };
    });
    if (
      parsedOrders.length === 0 ||
      typeof vehicle.id !== 'string' ||
      typeof vehicle.updatedAt !== 'string' ||
      typeof driver.id !== 'string' ||
      typeof driver.updatedAt !== 'string'
    ) {
      throw new ConflictException('Planning snapshot thiếu dữ liệu tài nguyên');
    }
    return {
      orders: parsedOrders,
      vehicle: { id: vehicle.id, updatedAt: vehicle.updatedAt },
      driver: { id: driver.id, updatedAt: driver.updatedAt },
    };
  }

  private assertTripAccess(
    trip: {
      managingBranchId: string | null;
      vehicle: { homeBranchId: string };
    },
    user: { branchId?: string; role: Role },
  ) {
    if (user.role === Role.ADMIN) return;
    const branchId = trip.managingBranchId ?? trip.vehicle.homeBranchId;
    if (!user.branchId || user.branchId !== branchId) {
      throw new ForbiddenException(
        'KhÃ´ng cÃ³ quyá»n truy cáº­p chuyáº¿n ngoÃ i chi nhÃ¡nh',
      );
    }
  }

  private async validateSpatialPlan(
    vehicle: VehicleRecord,
    stopsWithItems: DispatchStopWithItems[],
  ) {
    const cargoByOrderId = new Map<
      string,
      ReturnType<typeof expandOrderItemsToCargoUnits>
    >();
    for (const entry of stopsWithItems) {
      if (!cargoByOrderId.has(entry.order.id)) {
        cargoByOrderId.set(
          entry.order.id,
          expandOrderItemsToCargoUnits(entry.order.items),
        );
      }
    }
    const stops = stopsWithItems.map((entry, index) => {
      const cargo = cargoByOrderId.get(entry.order.id) ?? [];
      const isPickup = entry.orderStop.type === StopType.PICKUP;
      return {
        stop_id: entry.orderStop.id,
        sequence: index + 1,
        stop_type: entry.orderStop.type,
        address: entry.orderStop.address,
        latitude: entry.orderStop.latitude,
        longitude: entry.orderStop.longitude,
        items_to_load: isPickup ? cargo : [],
        items_to_unload: isPickup ? [] : cargo.map((item) => item.id),
      };
    });

    try {
      const response = await axios.post(
        `${this.optimizerUrl}/validate-spatial`,
        {
          vehicle: {
            id: vehicle.id,
            plate_number: vehicle.plateNumber,
            length_cm: vehicle.lengthCm,
            width_cm: vehicle.widthCm,
            height_cm: vehicle.heightCm,
            payload_limit_kg: vehicle.payloadCapacityKg,
            door_position: 'REAR',
          },
          stops,
        },
        { timeout: 10_000 },
      );
      if (
        !response.data ||
        typeof response.data.is_valid !== 'boolean' ||
        !Array.isArray(response.data.step_states)
      ) {
        throw new Error('Spatial validator trả response sai contract');
      }
      if (!response.data.is_valid) {
        throw new BadRequestException(
          response.data.error_message ||
            `Bố trí xếp/dỡ không hợp lệ (${response.data.violation_code || 'UNKNOWN'})`,
        );
      }
      return response.data;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(
        error.response?.data?.detail ||
          error.message ||
          'Không thể kiểm tra bố trí xếp/dỡ',
      );
    }
  }

  private get optimizationProposalSecret() {
    const secret =
      process.env.OPTIMIZATION_PROPOSAL_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Thiếu OPTIMIZATION_PROPOSAL_SECRET hoặc JWT_SECRET để ký kết quả tối ưu',
      );
    }
    return secret;
  }

  private assertProposalResourcesCurrent(
    proposal: OptimizationProposal,
    orders: OrderWithStopsAndItems[],
    vehicles: VehicleRecord[],
    drivers: DriverRecord[],
  ): void {
    const usedOrderIds = new Set(
      proposal.result.routes.flatMap((route) =>
        route.stops.map((stop) => stop.order_id),
      ),
    );
    const usedVehicleIds = new Set(
      proposal.result.routes.map((route) => route.vehicle_id),
    );
    const usedDriverIds = new Set(
      proposal.result.routes
        .map((route) => route.driver_id)
        .filter(Boolean) as string[],
    );
    if (
      orders.length !== usedOrderIds.size ||
      vehicles.length !== usedVehicleIds.size ||
      drivers.length !== usedDriverIds.size
    ) {
      throw new ConflictException(
        'Đơn hàng, xe hoặc tài xế của phương án không còn tồn tại trong chi nhánh',
      );
    }

    const orderVersions = new Map(
      proposal.resources.orders.map((item) => [item.id, item.version]),
    );
    for (const order of orders) {
      if (order.status !== OrderStatus.CONFIRMED) {
        throw new ConflictException(
          `Đơn ${order.orderNumber} không còn ở trạng thái CONFIRMED`,
        );
      }
      if (orderVersions.get(order.id) !== order.version) {
        throw new ConflictException(
          `Đơn ${order.orderNumber} đã thay đổi sau khi tối ưu; hãy chạy lại`,
        );
      }
    }

    const vehicleVersions = new Map(
      proposal.resources.vehicles.map((item) => [item.id, item.updatedAt]),
    );
    for (const vehicle of vehicles) {
      if (vehicle.status !== VehicleStatus.AVAILABLE) {
        throw new ConflictException(
          `Xe ${vehicle.plateNumber} không còn AVAILABLE`,
        );
      }
      if (vehicleVersions.get(vehicle.id) !== vehicle.updatedAt.toISOString()) {
        throw new ConflictException(
          `Xe ${vehicle.plateNumber} đã thay đổi sau khi tối ưu; hãy chạy lại`,
        );
      }
    }

    const driverVersions = new Map(
      proposal.resources.drivers.map((item) => [item.id, item.updatedAt]),
    );
    const now = new Date();
    for (const driver of drivers) {
      if (driver.status !== DriverStatus.AVAILABLE) {
        throw new ConflictException(
          `Tài xế ${driver.fullName} không còn AVAILABLE`,
        );
      }
      if (driver.licenseExpiry.getTime() <= now.getTime()) {
        throw new ConflictException(
          `Bằng lái của tài xế ${driver.fullName} đã hết hạn`,
        );
      }
      if (driverVersions.get(driver.id) !== driver.updatedAt.toISOString()) {
        throw new ConflictException(
          `Tài xế ${driver.fullName} đã thay đổi sau khi tối ưu; hãy chạy lại`,
        );
      }
    }
  }

  private buildPlannedAutomaticTrips(
    proposal: OptimizationProposal,
    orders: OrderWithStopsAndItems[],
    vehicles: VehicleRecord[],
    drivers: DriverRecord[],
  ): PlannedAutomaticTrip[] {
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    const planningEpoch = new Date(proposal.planningEpochIso);
    const globallyAssignedAllocations = new Set<string>();
    const globallyAssignedCargo = new Set<string>();
    const expectedCargoByOrder = new Map(
      orders.map((order) => [
        order.id,
        new Set(this.buildCargoUnitsForOrder(order).map((item) => item.id)),
      ]),
    );

    const plannedTrips = proposal.result.routes.map((route) => {
      const vehicle = vehicleById.get(route.vehicle_id);
      if (!vehicle) {
        throw new ConflictException(`Không tìm thấy xe [${route.vehicle_id}]`);
      }
      if (!route.driver_id) {
        throw new BadRequestException(
          `Tuyến xe ${vehicle.plateNumber} chưa có tài xế`,
        );
      }
      const driver = driverById.get(route.driver_id);
      if (!driver) {
        throw new ConflictException(
          `Không tìm thấy tài xế [${route.driver_id}]`,
        );
      }
      if (
        route.driver_license_class &&
        route.driver_license_class !== driver.licenseClass
      ) {
        throw new ConflictException(
          `Hạng bằng của tài xế ${driver.fullName} không còn khớp phương án`,
        );
      }
      if (
        !Number.isFinite(route.total_distance_km) ||
        route.total_distance_km < 0 ||
        !Number.isFinite(route.total_duration_minutes) ||
        route.total_duration_minutes <= 0
      ) {
        throw new BadRequestException(
          `Tuyến xe ${vehicle.plateNumber} có quãng đường hoặc thời gian không hợp lệ`,
        );
      }

      const routeAllocationCounts = new Map<
        string,
        {
          orderId: string;
          pickup: number;
          delivery: number;
          pickupSequence?: number;
          deliverySequence?: number;
          pickupCargo: Set<string>;
          deliveryCargo: Set<string>;
        }
      >();
      const seenStopIds = new Set<string>();
      const sortedStops = [...route.stops].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const plannedStops: PlannedAutomaticTrip['stops'] = [];
      const routeCargoUnitIds = new Set<string>();

      for (let index = 0; index < sortedStops.length; index++) {
        const stop = sortedStops[index];
        if (!Number.isInteger(stop.sequence) || stop.sequence !== index + 1) {
          throw new BadRequestException(
            `Tuyến xe ${vehicle.plateNumber} có thứ tự điểm dừng không liên tục`,
          );
        }
        if (seenStopIds.has(stop.location_id)) {
          throw new BadRequestException(
            `Tuyến xe ${vehicle.plateNumber} lặp điểm dừng [${stop.location_id}]`,
          );
        }
        seenStopIds.add(stop.location_id);

        const allocationId = stop.allocation_id;
        if (!allocationId) {
          throw new BadRequestException(
            `Điểm dừng [${stop.location_id}] thiếu allocation_id`,
          );
        }
        const order = orderById.get(stop.order_id);
        if (!order) {
          throw new ConflictException(
            `Không tìm thấy đơn [${stop.order_id}] trong chi nhánh`,
          );
        }
        const orderStop = order.stops.find(
          (item) => item.id === stop.order_stop_id,
        );
        if (!orderStop || orderStop.type !== stop.stop_type) {
          throw new BadRequestException(
            `Điểm dừng [${stop.location_id}] không thuộc đúng đơn hoặc sai loại thao tác`,
          );
        }
        if (
          !Number.isFinite(stop.arrival_time_sec) ||
          !Number.isFinite(stop.departure_time_sec) ||
          stop.arrival_time_sec < 0 ||
          stop.departure_time_sec < stop.arrival_time_sec
        ) {
          throw new BadRequestException(
            `Điểm dừng [${stop.location_id}] có thời gian không hợp lệ`,
          );
        }

        const cargoUnitIds =
          stop.stop_type === StopType.PICKUP
            ? stop.items_loaded
            : stop.items_unloaded;
        if (cargoUnitIds.length === 0) {
          throw new BadRequestException(
            `Điểm dừng [${stop.location_id}] không có kiện để xử lý`,
          );
        }
        const expectedCargo = expectedCargoByOrder.get(order.id);
        if (
          !expectedCargo ||
          cargoUnitIds.some((cargoUnitId) => !expectedCargo.has(cargoUnitId))
        ) {
          throw new BadRequestException(
            `Điểm dừng [${stop.location_id}] chứa kiện không thuộc đơn ${order.orderNumber}`,
          );
        }

        const counts = routeAllocationCounts.get(allocationId) ?? {
          orderId: order.id,
          pickup: 0,
          delivery: 0,
          pickupCargo: new Set<string>(),
          deliveryCargo: new Set<string>(),
        };
        if (counts.orderId !== order.id) {
          throw new BadRequestException(
            `Allocation [${allocationId}] tham chiếu nhiều đơn khác nhau`,
          );
        }
        if (stop.stop_type === StopType.PICKUP) {
          counts.pickup += 1;
          counts.pickupSequence = stop.sequence;
          cargoUnitIds.forEach((id) => counts.pickupCargo.add(id));
        } else {
          counts.delivery += 1;
          counts.deliverySequence = stop.sequence;
          cargoUnitIds.forEach((id) => counts.deliveryCargo.add(id));
        }
        routeAllocationCounts.set(allocationId, counts);
        plannedStops.push({
          optimizerStopId: stop.location_id,
          orderId: order.id,
          orderStopId: orderStop.id,
          cargoUnitIds,
          sequence: stop.sequence,
          stopType: orderStop.type,
          address: orderStop.address,
          latitude: orderStop.latitude,
          longitude: orderStop.longitude,
          contactName: orderStop.contactName,
          contactPhone: orderStop.contactPhone,
          plannedArrivalTime: new Date(
            planningEpoch.getTime() + stop.arrival_time_sec * 1000,
          ),
          plannedDepartureTime: new Date(
            planningEpoch.getTime() + stop.departure_time_sec * 1000,
          ),
        });
      }

      for (const [allocationId, counts] of routeAllocationCounts) {
        if (counts.pickup !== 1 || counts.delivery !== 1) {
          throw new BadRequestException(
            `Phần hàng [${allocationId}] phải có đúng một pickup và một delivery trong tuyến`,
          );
        }
        if (
          counts.pickupSequence === undefined ||
          counts.deliverySequence === undefined ||
          counts.pickupSequence >= counts.deliverySequence
        ) {
          throw new BadRequestException(
            `Phần hàng [${allocationId}] phải được lấy trước khi giao`,
          );
        }
        if (
          counts.pickupCargo.size !== counts.deliveryCargo.size ||
          [...counts.pickupCargo].some((id) => !counts.deliveryCargo.has(id))
        ) {
          throw new BadRequestException(
            `Phần hàng [${allocationId}] lấy và giao không cùng tập kiện`,
          );
        }
        if (globallyAssignedAllocations.has(allocationId)) {
          throw new BadRequestException(
            `Phần hàng [${allocationId}] xuất hiện trên nhiều tuyến`,
          );
        }
        globallyAssignedAllocations.add(allocationId);
        for (const cargoUnitId of counts.pickupCargo) {
          if (globallyAssignedCargo.has(cargoUnitId)) {
            throw new BadRequestException(
              `Kiện [${cargoUnitId}] bị phân công vào nhiều tuyến`,
            );
          }
          globallyAssignedCargo.add(cargoUnitId);
          routeCargoUnitIds.add(cargoUnitId);
        }
      }

      const lastDepartureSeconds = Math.max(
        0,
        ...sortedStops.map((stop) => stop.departure_time_sec),
      );
      const plannedEndSeconds = Math.max(
        lastDepartureSeconds,
        route.end_time_sec,
      );

      return {
        vehicleId: vehicle.id,
        driverId: driver.id,
        plannedStartTime: new Date(
          planningEpoch.getTime() + route.start_time_sec * 1000,
        ),
        plannedEndTime: new Date(
          planningEpoch.getTime() + plannedEndSeconds * 1000,
        ),
        totalDistanceKm: route.total_distance_km,
        totalDurationMinutes: route.total_duration_minutes,
        routeGeometry: route.route_geometry
          ? JSON.stringify(route.route_geometry)
          : null,
        spatialValidation: route.spatial_validation,
        orderIds: Array.from(
          new Set(
            [...routeAllocationCounts.values()].map((item) => item.orderId),
          ),
        ),
        cargoUnitIds: Array.from(routeCargoUnitIds),
        planningSnapshot: {
          orders: Array.from(
            new Set(
              [...routeAllocationCounts.values()].map((item) => item.orderId),
            ),
          ).map((id) => {
            const resource = proposal.resources.orders.find(
              (item) => item.id === id,
            );
            if (!resource) {
              throw new ConflictException(
                `Thiếu version của đơn [${id}] trong proposal`,
              );
            }
            return { id, version: resource.version + 1 };
          }),
          vehicle: {
            id: vehicle.id,
            updatedAt: vehicle.updatedAt.toISOString(),
          },
          driver: {
            id: driver.id,
            updatedAt: driver.updatedAt.toISOString(),
          },
        },
        stops: plannedStops,
      };
    });

    const assignedOrderIds = new Set(
      plannedTrips.flatMap((trip) => trip.orderIds),
    );
    for (const orderId of assignedOrderIds) {
      const expected = expectedCargoByOrder.get(orderId);
      if (
        !expected ||
        expected.size === 0 ||
        expected.size !==
          [...globallyAssignedCargo].filter((cargoId) => expected.has(cargoId))
            .length
      ) {
        throw new BadRequestException(
          `Đơn [${orderId}] chưa được phân công đủ mọi kiện; không áp dụng phương án một phần`,
        );
      }
    }

    return plannedTrips;
  }

  private async acquireApplicationLocks(
    tx: Prisma.TransactionClient,
    vehicleIds: string[],
    driverIds: string[],
    orderIds: string[],
  ): Promise<void> {
    const keys = [
      ...vehicleIds.map((id) => ({ namespace: LOCK_NAMESPACE_VEHICLE, id })),
      ...driverIds.map((id) => ({ namespace: LOCK_NAMESPACE_DRIVER, id })),
      ...orderIds.map((id) => ({ namespace: LOCK_NAMESPACE_ORDER, id })),
    ].sort(
      (left, right) =>
        left.namespace - right.namespace || left.id.localeCompare(right.id),
    );

    for (const key of keys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key.namespace}::int4, hashtext(${key.id})::int4)`;
    }
  }

  private async assertPackagesNotOnActiveTrip(
    tx: Prisma.TransactionClient,
    packageIds: string[],
  ): Promise<void> {
    const conflicting = await tx.stopTask.findFirst({
      where: {
        packageId: { in: packageIds },
        tripStop: { trip: { status: { in: ACTIVE_TRIP_STATUSES } } },
      },
      include: {
        tripStop: { include: { trip: true } },
        package: true,
      },
    });
    if (conflicting)
      throw new ConflictException(
        `Kiện ${conflicting.package?.packageCode} đã nằm trên chuyến ${conflicting.tripStop.trip.tripNumber}`,
      );
  }

  private async assertNoResourceOverlap(
    tx: Prisma.TransactionClient,
    plannedTrip: PlannedAutomaticTrip,
  ): Promise<void> {
    const vehicleOverlap = await tx.trip.findFirst({
      where: {
        vehicleId: plannedTrip.vehicleId,
        status: { in: ACTIVE_TRIP_STATUSES },
        plannedStartTime: { lt: plannedTrip.plannedEndTime },
        plannedEndTime: { gt: plannedTrip.plannedStartTime },
      },
      select: { tripNumber: true },
    });
    if (vehicleOverlap) {
      throw new ConflictException(
        `Xe đã có lịch chạy chuyến ${vehicleOverlap.tripNumber} trong thời gian này`,
      );
    }

    const driverOverlap = await tx.driverAssignment.findFirst({
      where: {
        driverId: plannedTrip.driverId,
        trip: { status: { in: ACTIVE_TRIP_STATUSES } },
        startTime: { lt: plannedTrip.plannedEndTime },
        endTime: { gt: plannedTrip.plannedStartTime },
      },
      include: { trip: { select: { tripNumber: true } } },
    });
    if (driverOverlap) {
      throw new ConflictException(
        `Tài xế đã có lịch chạy chuyến ${driverOverlap.trip.tripNumber} trong thời gian này`,
      );
    }
  }

  private async allocateTripNumbers(
    tx: Prisma.TransactionClient,
    count: number,
  ): Promise<string[]> {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_NUMBER}::int4, hashtext(${dateStr})::int4)`;
    const existing = await tx.trip.count({
      where: { tripNumber: { startsWith: `TRIP-${dateStr}` } },
    });
    return Array.from(
      { length: count },
      (_, index) =>
        `TRIP-${dateStr}-${String(existing + index + 1).padStart(3, '0')}`,
    );
  }

  private async persistAutomaticTrip(
    tx: Prisma.TransactionClient,
    plannedTrip: PlannedAutomaticTrip,
    tripNumber: string,
    branchId: string,
    sourceJobId?: string,
    sourceCandidateNumber?: number,
    packageIdByCargoUnit?: Map<string, string>,
  ) {
    if (!packageIdByCargoUnit) {
      throw new ConflictException(
        'Thiếu ánh xạ Package khi lưu chuyến tự động',
      );
    }
    const trip = await tx.trip.create({
      data: {
        tripNumber,
        vehicleId: plannedTrip.vehicleId,
        managingBranchId: branchId,
        status: TripStatus.PLANNED,
        plannedStartTime: plannedTrip.plannedStartTime,
        plannedEndTime: plannedTrip.plannedEndTime,
        totalDistanceKm: plannedTrip.totalDistanceKm,
        totalDurationMinutes: plannedTrip.totalDurationMinutes,
        routeGeometry: plannedTrip.routeGeometry,
        planningSnapshot: plannedTrip.planningSnapshot,
        notes: sourceJobId
          ? `Sinh từ optimization job ${sourceJobId}, phương án #${sourceCandidateNumber ?? 1}`
          : 'Sinh từ kết quả tối ưu tự động',
      },
    });

    const orders = await tx.order.findMany({
      where: { id: { in: plannedTrip.orderIds } },
      include: { items: true, stops: true },
    });
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const stopTaskIdByOptimizerStopId = new Map<string, string>();
    for (const stop of plannedTrip.stops) {
      const tripStop = await tx.tripStop.create({
        data: {
          tripId: trip.id,
          sequence: stop.sequence,
          stopType: stop.stopType,
          address: stop.address,
          latitude: stop.latitude,
          longitude: stop.longitude,
          contactName: stop.contactName,
          contactPhone: stop.contactPhone,
          plannedArrivalTime: stop.plannedArrivalTime,
          plannedDepartureTime: stop.plannedDepartureTime,
        },
      });
      const order = orderById.get(stop.orderId);
      if (!order) throw new Error(`Thiếu đơn [${stop.orderId}] khi lưu chuyến`);
      let firstStopTaskId: string | undefined;
      for (const cargoUnitId of stop.cargoUnitIds) {
        const packageId = packageIdByCargoUnit.get(cargoUnitId);
        if (!packageId) {
          throw new ConflictException(
            `Không ánh xạ được kiện [${cargoUnitId}] khi tạo StopTask`,
          );
        }
        const stopTask = await tx.stopTask.create({
          data: {
            tripStopId: tripStop.id,
            orderId: order.id,
            packageId,
            orderStopId: stop.orderStopId,
            action:
              stop.stopType === StopType.PICKUP
                ? TaskAction.LOAD
                : TaskAction.UNLOAD,
            plannedQuantity: 1,
          },
        });
        firstStopTaskId ??= stopTask.id;
      }
      if (!firstStopTaskId) {
        throw new ConflictException(
          `Điểm dừng [${stop.optimizerStopId}] không có StopTask kiện`,
        );
      }
      stopTaskIdByOptimizerStopId.set(stop.optimizerStopId, firstStopTaskId);
    }

    await this.persistValidatedLoadPlan(
      tx,
      trip.id,
      plannedTrip.vehicleId,
      orders,
      stopTaskIdByOptimizerStopId,
      plannedTrip.spatialValidation,
      1,
      packageIdByCargoUnit,
    );

    await tx.driverAssignment.create({
      data: {
        tripId: trip.id,
        driverId: plannedTrip.driverId,
        startTime: plannedTrip.plannedStartTime,
        endTime: plannedTrip.plannedEndTime,
        role: 'PRIMARY',
      },
    });
    await tx.resourceReservation.createMany({
      data: [
        {
          tripId: trip.id,
          vehicleId: plannedTrip.vehicleId,
          startsAt: plannedTrip.plannedStartTime,
          endsAt: plannedTrip.plannedEndTime,
          status: ReservationStatus.HELD,
        },
        {
          tripId: trip.id,
          driverId: plannedTrip.driverId,
          startsAt: plannedTrip.plannedStartTime,
          endsAt: plannedTrip.plannedEndTime,
          status: ReservationStatus.HELD,
        },
      ],
    });

    await this.outbox.enqueue(
      {
        aggregateType: 'Trip',
        aggregateId: trip.id,
        aggregateVersion: trip.version,
        eventType: 'OPTIMIZATION_TRIP_APPLIED',
        payload: {
          tripId: trip.id,
          branchId,
          optimizationJobId: sourceJobId ?? null,
          optimizationCandidateNumber: sourceCandidateNumber ?? null,
        },
      },
      tx,
    );

    return {
      id: trip.id,
      tripNumber,
      vehicleId: plannedTrip.vehicleId,
      driverId: plannedTrip.driverId,
      orderIds: plannedTrip.orderIds,
      plannedStartTime: plannedTrip.plannedStartTime,
      plannedEndTime: plannedTrip.plannedEndTime,
    };
  }

  private async persistValidatedLoadPlan(
    tx: Prisma.TransactionClient,
    tripId: string,
    vehicleId: string,
    orders: OrderWithStopsAndItems[],
    stopTaskIdByOrderStopId: Map<string, string>,
    spatialValidation: OptimizedRouteResult['spatial_validation'],
    revision = 1,
    packageIdByCargoUnit?: Map<string, string>,
  ) {
    if (
      !spatialValidation.is_valid ||
      spatialValidation.step_states.length === 0
    ) {
      throw new ConflictException(
        'Không thể lưu chuyến khi chưa có Load Plan hợp lệ',
      );
    }
    const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle)
      throw new ConflictException('Xe của Load Plan không còn tồn tại');
    const resolvedPackageIdByCargoUnit =
      packageIdByCargoUnit ??
      (await this.ensurePhysicalPackageMapping(tx, orders));
    const physicalPackages = await tx.package.findMany({
      where: {
        id: { in: Array.from(new Set(resolvedPackageIdByCargoUnit.values())) },
      },
    });
    const physicalPackageById = new Map(
      physicalPackages.map((physicalPackage) => [
        physicalPackage.id,
        physicalPackage,
      ]),
    );
    const inputHash = createHash('sha256')
      .update(JSON.stringify(spatialValidation))
      .digest('hex');
    const loadPlan = await tx.loadPlan.create({
      data: {
        tripId,
        revision,
        initialStateSnapshot: { placements: [] },
        geometrySnapshot: {
          vehicleId,
          lengthMm: this.cmToMm(vehicle.lengthCm),
          widthMm: this.cmToMm(vehicle.widthCm),
          heightMm: this.cmToMm(vehicle.heightCm),
          doorPosition: 'REAR',
          spatialValidation,
        } as unknown as Prisma.InputJsonValue,
        validationStatus: 'VALID',
        validatorVersion: 'spatial-validator-v1',
        inputHash,
      },
    });

    for (const state of spatialValidation.step_states) {
      const stopTaskId = stopTaskIdByOrderStopId.get(state.stop_id);
      if (!stopTaskId) {
        throw new ConflictException(
          `Không ánh xạ được spatial stop ${state.stop_id} sang StopTask`,
        );
      }
      await tx.loadPlanStep.create({
        data: {
          loadPlanId: loadPlan.id,
          stepNumber: state.step_index,
          stopTaskId,
          operationType: state.stop_type,
          handlingPath:
            state.package_access_paths as unknown as Prisma.InputJsonValue,
          validationResult: state as unknown as Prisma.InputJsonValue,
          placements: {
            create: state.placed_items.map((placed) => {
              const packageId = resolvedPackageIdByCargoUnit.get(
                placed.item_id,
              );
              if (!packageId) {
                throw new ConflictException(
                  `Không ánh xạ được cargo unit ${placed.item_id} sang Package vật lý`,
                );
              }
              const physicalPackage = physicalPackageById.get(packageId);
              if (
                !physicalPackage ||
                physicalPackage.lengthMm !== this.cmToMm(placed.length_cm) ||
                physicalPackage.widthMm !== this.cmToMm(placed.width_cm) ||
                physicalPackage.heightMm !== this.cmToMm(placed.height_cm) ||
                physicalPackage.weightG !==
                  BigInt(Math.round(placed.weight_kg * 1000))
              ) {
                throw new ConflictException(
                  `Package của cargo unit ${placed.item_id} đã thay đổi sau khi tối ưu`,
                );
              }
              return {
                packageId,
                xMm: this.cmToMm(placed.x),
                yMm: this.cmToMm(placed.y),
                zMm: 0,
                orientation: 'VALIDATED',
                effectiveLengthMm: this.cmToMm(placed.length_cm),
                effectiveWidthMm: this.cmToMm(placed.width_cm),
                effectiveHeightMm: this.cmToMm(placed.height_cm),
              };
            }),
          },
        },
      });
    }
  }

  private async ensurePhysicalPackageMapping(
    tx: Prisma.TransactionClient,
    orders: OrderWithStopsAndItems[],
  ): Promise<Map<string, string>> {
    const existingPackages = await tx.package.findMany({
      where: { orderId: { in: orders.map((order) => order.id) } },
      include: { items: true },
      orderBy: { packageCode: 'asc' },
    });
    const packagesByOrder = new Map<string, typeof existingPackages>();
    for (const physicalPackage of existingPackages) {
      const current = packagesByOrder.get(physicalPackage.orderId) ?? [];
      current.push(physicalPackage);
      packagesByOrder.set(physicalPackage.orderId, current);
    }
    const packagesByOrderItem = new Map<string, typeof existingPackages>();
    for (const pkg of existingPackages) {
      if (pkg.items.length !== 1 || pkg.items[0].quantity !== 1) continue;
      const orderItemId = pkg.items[0].orderItemId;
      const current = packagesByOrderItem.get(orderItemId) ?? [];
      current.push(pkg);
      packagesByOrderItem.set(orderItemId, current);
    }

    const mapping = new Map<string, string>();
    for (const order of orders) {
      const orderPackages = packagesByOrder.get(order.id) ?? [];
      const activePackages = orderPackages.filter(
        (physicalPackage) => physicalPackage.status !== PackageStatus.CANCELLED,
      );
      if (
        activePackages.some(
          (physicalPackage) => physicalPackage.status !== PackageStatus.READY,
        )
      ) {
        throw new ConflictException(
          `Một số Package của đơn ${order.orderNumber} không còn ở trạng thái READY`,
        );
      }
      if (orderPackages.length > 0 && activePackages.length === 0) {
        throw new ConflictException(
          `Đơn ${order.orderNumber} không còn Package khả dụng để phân công`,
        );
      }

      if (activePackages.length > 0) {
        for (const cargo of expandPhysicalPackagesToCargoUnits(
          order.id,
          activePackages,
        )) {
          const packageId = cargo.id.replace(/^package:/, '');
          const physicalPackage = activePackages.find(
            (candidate) => candidate.id === packageId,
          );
          if (!physicalPackage) {
            throw new ConflictException(
              `Không tìm thấy Package vật lý cho kiện [${cargo.id}]`,
            );
          }
          mapping.set(cargo.id, physicalPackage.id);
        }
        continue;
      }

      const cargoUnits = expandOrderItemsToCargoUnits(order.items);
      const usedByOrderItem = new Map<string, number>();
      for (const cargo of cargoUnits) {
        const used = usedByOrderItem.get(cargo.order_item_id) ?? 0;
        const existing = packagesByOrderItem.get(cargo.order_item_id)?.[used];
        let packageId: string;
        if (existing) {
          const dimensionsMatch =
            existing.lengthMm === this.cmToMm(cargo.length_cm) &&
            existing.widthMm === this.cmToMm(cargo.width_cm) &&
            existing.heightMm === this.cmToMm(cargo.height_cm) &&
            existing.weightG === BigInt(Math.round(cargo.weight_kg * 1000));
          if (!dimensionsMatch) {
            throw new ConflictException(
              `Package ${existing.packageCode} không còn khớp kích thước/khối lượng snapshot`,
            );
          }
          packageId = existing.id;
        } else {
          const unitNumber = cargo.id.split('#').pop() ?? String(used + 1);
          const created = await tx.package.create({
            data: {
              orderId: order.id,
              packageCode: `PKG-TMS-${order.orderNumber}-${cargo.order_item_id.slice(0, 8)}-${unitNumber}`,
              lengthMm: this.cmToMm(cargo.length_cm),
              widthMm: this.cmToMm(cargo.width_cm),
              heightMm: this.cmToMm(cargo.height_cm),
              weightG: BigInt(Math.round(cargo.weight_kg * 1000)),
              allowedOrientations: ['DEFAULT'],
              measurementSource: 'ORDER_ITEM_SNAPSHOT',
              status: PackageStatus.READY,
              items: {
                create: { orderItemId: cargo.order_item_id, quantity: 1 },
              },
            },
          });
          packageId = created.id;
        }
        mapping.set(cargo.id, packageId);
        usedByOrderItem.set(cargo.order_item_id, used + 1);
      }
    }
    return mapping;
  }

  private cmToMm(value: number): number {
    const millimeters = Math.round(value * 10);
    if (!Number.isSafeInteger(millimeters) || millimeters < 0) {
      throw new BadRequestException(
        `Giá trị hình học ${value} cm không thể đổi sang mm`,
      );
    }
    return millimeters;
  }

  private buildCargoUnitsForOrder(order: {
    id: string;
    orderNumber: string;
    items: Array<{
      id: string;
      orderId: string;
      description: string;
      quantity: number;
      weightKg: number;
      lengthCm: number;
      widthCm: number;
      heightCm: number;
    }>;
    packages?: PhysicalPackageRecord[];
  }) {
    if (order.packages && order.packages.length > 0) {
      const activePackages = order.packages.filter(
        (physicalPackage) => physicalPackage.status !== PackageStatus.CANCELLED,
      );
      if (activePackages.length === 0) {
        throw new BadRequestException(
          `Đơn ${order.orderNumber} không có Package khả dụng để tối ưu`,
        );
      }
      if (
        activePackages.some(
          (physicalPackage) => physicalPackage.status !== PackageStatus.READY,
        )
      ) {
        throw new ConflictException(
          `Một số Package của đơn ${order.orderNumber} không ở trạng thái READY`,
        );
      }
      return expandPhysicalPackagesToCargoUnits(order.id, activePackages);
    }
    return expandOrderItemsToCargoUnits(order.items);
  }

  private buildOptimizerOrders(
    orders: Array<{
      id: string;
      orderNumber: string;
      orderedAt: Date;
      totalAmount: { toString(): string };
      stops: Array<{
        id: string;
        type: StopType;
        address: string;
        latitude: number;
        longitude: number;
        serviceDurationMinutes: number;
      }>;
      items: Array<{
        id: string;
        orderId: string;
        description: string;
        quantity: number;
        weightKg: number;
        lengthCm: number;
        widthCm: number;
        heightCm: number;
      }>;
      packages?: PhysicalPackageRecord[];
    }>,
    planningEpoch: Date,
  ) {
    return orders.map((order) => {
      const pickup = order.stops.find((stop) => stop.type === StopType.PICKUP);
      const delivery = order.stops.find(
        (stop) => stop.type === StopType.DELIVERY,
      );
      if (!pickup || !delivery) {
        throw new BadRequestException(
          `Đơn ${order.orderNumber} thiếu pickup hoặc delivery`,
        );
      }
      let items;
      try {
        items = this.buildCargoUnitsForOrder(order);
      } catch (error) {
        if (
          error instanceof BadRequestException ||
          error instanceof ConflictException
        ) {
          throw error;
        }
        throw new BadRequestException(error.message);
      }
      return {
        id: order.id,
        source_order_id: order.id,
        source_order_number: order.orderNumber,
        order_number: order.orderNumber,
        pickup_location: {
          id: pickup.id,
          source_location_id: pickup.id,
          name: pickup.address,
          latitude: pickup.latitude,
          longitude: pickup.longitude,
        },
        delivery_location: {
          id: delivery.id,
          source_location_id: delivery.id,
          name: delivery.address,
          latitude: delivery.latitude,
          longitude: delivery.longitude,
        },
        items,
        ordered_at_sec: Math.round(
          (order.orderedAt.getTime() - planningEpoch.getTime()) / 1000,
        ),
        order_value_vnd: Math.round(Number(order.totalAmount)),
        service_time_sec:
          Math.max(
            pickup.serviceDurationMinutes,
            delivery.serviceDurationMinutes,
          ) * 60,
      };
    });
  }
}
