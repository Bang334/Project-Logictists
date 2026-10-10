import { assertDispatchableOrder } from '../orders/order-contract';
import { Principal, tripFilter, requireBranch, assertPermission } from '../auth/access';
import { ResourceAccess } from '../auth/resource-access.service';
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
import { TripsValidator } from './trips.validator';
import {
  DriverStatus,
  Driver as DriverRecord,
  LoadValidationStatus,
  OrderStatus,
  PackageStatus,
  Prisma,
  ReservationStatus,
  StopType,
  TaskAction,
  TripStatus,
  VehicleStatus,
  Vehicle as VehicleRecord,
} from "@prisma/client";
import { OptimizeTripDto } from "./dto/optimize-trip.dto";
import { packagesToCargoUnits, splitOversizedOrdersAcrossFleet } from "./optimizer-payload";
import {
  assertFleetOptimizationBatchResult,
  OptimizedRouteResult,
} from "./optimizer-contract";
import { resolveBranchScope } from "../auth/branch-scope";
import { ApplyAutomaticOptimizationDto } from "./dto/apply-automatic-optimization.dto";
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
const LOCK_NAMESPACE_TRIP_COMMAND = 4105;

type OrderWithStopsAndItems = Prisma.OrderGetPayload<{
  include: { stops: true; items: { include: { packages: true } } };
}>;

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
    private access: ResourceAccess,
  ) {}

  async findAll(user: Principal, status?: TripStatus, branchId?: string) {
    return this.prisma.trip.findMany({
      where: {
        ...(status ? { status } : {}),
        ...tripFilter(user, 'trips.read', branchId),
      },
      include: {
        vehicle: {
          include: { homeBranch: true },
        },
        assignments: {
          include: { driver: true },
        },
        stops: {
          orderBy: { sequence: "asc" },
          include: { tasks: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string, user: Principal) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, ...tripFilter(user) },
      include: {
        vehicle: { include: { homeBranch: true } },
        assignments: { include: { driver: true } },
        stops: {
          orderBy: { sequence: "asc" },
          include: {
            tasks: {
              include: {
                allocation: {
                  include: { package: true, orderItem: { include: { order: true } } },
                },
                order: { include: { items: { include: { packages: true } }, customer: true } },
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

    return { ...trip, stops: trip.stops.map(stop => ({ ...stop, tasks: stop.tasks.map(task => ({ ...task, allocation: task.allocation ? { ...task.allocation, package: task.allocation.package ? { ...task.allocation.package, weightG: task.allocation.package.weightG.toString() } : null } : null })) })) };
  }

  async findOneAuthorized(
    id: string,
    user: Principal,
  ) {
    const trip = await this.findOne(id, user);
    this.assertTripAccess(trip, user);
    return trip;
  }

  async getLoadPlan(
    tripId: string,
    user: Principal,
  ) {
    const trip = await this.findOne(tripId, user);
    this.assertTripAccess(trip, user);
    const loadPlan = await this.prisma.loadPlan.findFirst({
      where: { tripId },
      orderBy: { revision: 'desc' },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            tasks: { select: { id: true, orderId: true, packageId: true, orderStopId: true, action: true } },
            placements: {
              include: { package: true },
              orderBy: { packageId: 'asc' },
            },
          },
        },
      },
    });
    if (!loadPlan) {
      throw new NotFoundException(`Chuyến ${trip.tripNumber} chưa có Load Plan`);
    }
    return loadPlan;
  }

  /**
   * Tạo chuyến đi mới (Lập kế hoạch Trip)
   */
  async create(dto: CreateTripDto, user: Principal) {
    const branchId = requireBranch(user, 'trips.plan', dto.branchId);
    await this.access.tripInputs(user, branchId, dto);
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
      if (existingCommand.status === 'COMPLETED' && typeof result?.tripId === 'string') {
        return this.findOne(result.tripId, user);
      }
      throw new ConflictException('Lệnh tạo chuyến với idempotency key này đang xử lý');
    }
    const plannedStart = new Date(dto.plannedStartTime);
    const plannedEnd = new Date(dto.plannedEndTime);

    if (plannedStart >= plannedEnd) {
      throw new BadRequestException(
        "Thời gian bắt đầu chuyến đi phải trước thời gian kết thúc",
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
        items: { include: { packages: true } },
      },
    });

    if (orders.length !== dto.orderIds.length) {
      throw new BadRequestException(
        "Một số đơn hàng không tồn tại trong hệ thống",
      );
    }

    for (const order of orders) {
      assertDispatchableOrder(order);
      if (order.status !== 'CONFIRMED') throw new ConflictException('Chỉ điều phối đơn đã xác nhận');
    }
    if (dto.orderedStopIds && (new Set(dto.orderedStopIds).size !== orders.length * 2 || dto.orderedStopIds.length !== orders.length * 2)) throw new BadRequestException('Phải chọn đủ mỗi điểm lấy/giao đúng một lần');
    // 4. Sắp xếp thứ tự các điểm dừng (Ordered Stops)
    const stopWithItemsList: Array<{ orderStop: OrderWithStopsAndItems['stops'][number]; order: OrderWithStopsAndItems }> = [];

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
      const pickups: typeof stopWithItemsList = [];
      const deliveries: typeof stopWithItemsList = [];

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

    const [routeResult, roadMatrix] = await Promise.all([
      this.mapboxService.getRoute(routeCoords), this.mapboxService.getRoadMatrix(routeCoords),
    ]);
    const schedule = this.serviceSchedule(stopWithItemsList, roadMatrix.durationsSeconds, plannedStart, plannedEnd);

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
        if (command.status === 'COMPLETED' && typeof result?.tripId === 'string') {
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
      await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id IN (${Prisma.join(dto.orderIds)}) ORDER BY id FOR UPDATE`);
      await this.access.tripInputs(user, branchId, dto, tx);
      await this.assertOrdersNotOnActiveTrip(tx, dto.orderIds);
      const [
        currentVehicle,
        currentDriver,
        currentOrders,
        lockedVehicleOverlap,
        lockedDriverOverlap,
      ] =
        await Promise.all([
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
      if (!currentVehicle || !currentDriver || currentOrders.length !== dto.orderIds.length) {
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
          managingBranchId: branchId,
          vehicleId: dto.vehicleId,

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
        if (item.orderStop.latitude === undefined || item.orderStop.longitude === undefined) {
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
            ...schedule[i],
          },
        });

        for (const line of item.order.items) {
          for (const pkg of line.packages) {
            let allocation = await tx.allocation.findFirst({ where: { tripId: trip.id, packageId: pkg.id } });
            if (!allocation) allocation = await tx.allocation.create({ data: { tripId: trip.id, orderItemId: line.id, packageId: pkg.id, allocatedQuantity: 1, status: 'ACTIVE' } });
            await tx.stopTask.create({ data: { tripStopId: tripStop.id, allocationId: allocation.id, orderId: item.order.id, packageId: pkg.id, orderStopId: item.orderStop.id, action: isPickup ? TaskAction.LOAD : TaskAction.UNLOAD, plannedQuantity: 1 } });
          }
        }
      }
      await tx.package.updateMany({ where: { orderItem: { orderId: { in: dto.orderIds } } }, data: { status: 'ALLOCATED', version: { increment: 1 } } });

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
        spatialValidation,
      );

      // Phân công tài xế
      await tx.driverAssignment.create({
        data: {
          tripId: trip.id,
          driverId: dto.driverId,
          startTime: plannedStart,
          endTime: plannedEnd,
          role: "PRIMARY",
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

    return this.findOne(createdTripId, user);
  }

  async updatePlan(
    id: string,
    dto: UpdateTripPlanDto,
    user: Principal,
  ) {
    const existing = await this.findOne(id, user);
    this.assertTripAccess(existing, user);
    if (
      existing.status !== TripStatus.DRAFT &&
      existing.status !== TripStatus.PLANNED
    ) {
      throw new ConflictException('Chỉ được chỉnh kế hoạch của chuyến DRAFT/PLANNED');
    }
    if (existing.version !== dto.expectedVersion) {
      throw new ConflictException('Trip Plan đã thay đổi; hãy tải lại trước khi sửa');
    }
    const plannedStart = new Date(dto.plannedStartTime);
    const plannedEnd = new Date(dto.plannedEndTime);
    if (plannedStart >= plannedEnd) {
      throw new BadRequestException('Thời gian bắt đầu phải trước thời gian kết thúc');
    }
    const branchId = existing.managingBranchId ?? existing.vehicle.homeBranchId;
    resolveBranchScope(user, branchId);
    const orderIds = Array.from(
      new Set(
        existing.stops.flatMap((stop) =>
          stop.tasks
            .map((task) => task.orderId)
            .filter((orderId): orderId is string => typeof orderId === 'string'),
        ),
      ),
    );
    const [vehicle, driver, fullOrders] = await Promise.all([
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
        include: { stops: true, items: { include: { packages: true } } },
      }),
    ]);
    if (!vehicle || !driver || fullOrders.length !== orderIds.length) {
      throw new ConflictException('Xe, tài xế hoặc đơn không còn hợp lệ để sửa kế hoạch');
    }
    // A split Trip owns a subset of the Order. Project its manifest for validation only;
    // never rewrite OrderItem.quantity or include packages assigned to another Trip.
    const packageIds = new Set(existing.stops.flatMap(stop => stop.tasks.flatMap(task => task.packageId ? [task.packageId] : [])));
    const orders = fullOrders.map(order => {
      const items = order.items.flatMap(item => {
        const packages = item.packages.filter(pkg => packageIds.has(pkg.id));
        return packages.length ? [{ ...item, packages, quantity: packages.length }] : [];
      });
      if (!items.length) throw new ConflictException('Trip cần đối soát Package trước khi sửa kế hoạch');
      return { ...order, items };
    });
    const planningStart = resolveVehiclePlanningStart(vehicle);
    const requiredStopIds = orders.flatMap((order) => order.stops.map((stop) => stop.id));
    if (
      dto.orderedStopIds.length !== requiredStopIds.length ||
      new Set(dto.orderedStopIds).size !== requiredStopIds.length ||
      dto.orderedStopIds.some((stopId) => !requiredStopIds.includes(stopId))
    ) {
      throw new BadRequestException(
        'orderedStopIds phải chứa đúng mỗi pickup/delivery một lần',
      );
    }
    const stopWithItems: DispatchStopWithItems[] = dto.orderedStopIds.map((stopId) => {
      for (const order of orders) {
        const orderStop = order.stops.find((stop) => stop.id === stopId);
        if (orderStop) return { orderStop, order };
      }
      throw new BadRequestException(`Không tìm thấy điểm dừng [${stopId}]`);
    });
    TripsValidator.validatePickupBeforeDelivery(stopWithItems);
    TripsValidator.calculateAndValidateLoad(vehicle, stopWithItems);
    const routeCoordinates: [number, number][] = [
      [planningStart.longitude, planningStart.latitude],
      [dto.startLocation.longitude, dto.startLocation.latitude],
      ...stopWithItems.map(
        (item) => [item.orderStop.longitude, item.orderStop.latitude] as [number, number],
      ),
      [dto.endLocation.longitude, dto.endLocation.latitude],
    ];
    const [route, matrix] = await Promise.all([this.mapboxService.getRoute(routeCoordinates), this.mapboxService.getRoadMatrix(routeCoordinates)]);
    const schedule = this.serviceSchedule(stopWithItems, matrix.durationsSeconds, plannedStart, plannedEnd);
    const spatial = await this.validateSpatialPlan(vehicle, stopWithItems);
    const requiredDurationMinutes =
      route.durationMinutes +
      stopWithItems.reduce(
        (sum, item) => sum + item.orderStop.serviceDurationMinutes,
        0,
      );
    if (plannedStart.getTime() + requiredDurationMinutes * 60_000 > plannedEnd.getTime()) {
      throw new BadRequestException('Khung giờ mới không đủ cho tuyến và thời gian phục vụ');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`UPDATE_TRIP:${id}`})::int4)`;
      await this.acquireApplicationLocks(tx, [dto.vehicleId], [dto.driverId], orderIds);
      const [currentTrip, currentVehicle, currentDriver, currentOrders] = await Promise.all([
        tx.trip.findUnique({ where: { id }, select: { version: true, status: true } }),
        tx.vehicle.findFirst({
          where: { id: dto.vehicleId, homeBranchId: branchId, status: VehicleStatus.AVAILABLE },
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
          where: { id: { in: orderIds }, branchId, status: OrderStatus.ASSIGNED },
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
        throw new ConflictException('Trip Plan hoặc tài nguyên đã thay đổi trong lúc sửa');
      }
      const originalVersions = new Map(orders.map((order) => [order.id, order.version]));
      if (currentOrders.some((order) => originalVersions.get(order.id) !== order.version)) {
        throw new ConflictException('Đơn hàng đã thay đổi trong lúc sửa Trip Plan');
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
        throw new ConflictException('Lịch xe hoặc tài xế bị trùng với chuyến khác');
      }

      const tripStopIdByOrderStopId = new Map<string, string>();
      for (const stop of existing.stops) {
        for (const task of stop.tasks) {
          if (task.orderStopId) {
            tripStopIdByOrderStopId.set(task.orderStopId, stop.id);
          }
        }
      }
      await tx.tripStop.updateMany({
        where: { tripId: id },
        data: { sequence: { increment: 10_000 } },
      });
      const startStop = existing.stops.find((stop) => stop.stopType === StopType.DEPOT_START);
      const endStop = existing.stops.find((stop) => stop.stopType === StopType.DEPOT_END);
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
        const tripStopId = tripStopIdByOrderStopId.get(dto.orderedStopIds[index]);
        if (!tripStopId) throw new ConflictException('Trip Stop không còn khớp Order Stop');
        await tx.tripStop.update({
          where: { id: tripStopId },
          data: { sequence: index + 2, ...schedule[index] },
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
    return this.findOne(id, user);
  }

  /**
   * Phát hành chuyến đi (Publish Trip)
   */
  async publish(
    id: string,
    dto: PublishTripDto,
    user: Principal,
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
      if (!trip.assignments.some((assignment) => assignment.role === 'PRIMARY')) {
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
      const planningSnapshot = this.parsePlanningSnapshot(trip.planningSnapshot);
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
      const [currentOrders, currentVehicle, currentDriver, vehicleOverlap, driverOverlap] =
        await Promise.all([
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
        currentVehicle.updatedAt.toISOString() !== planningSnapshot.vehicle.updatedAt ||
        !currentDriver ||
        currentDriver.status !== DriverStatus.AVAILABLE ||
        currentDriver.licenseExpiry <= trip.plannedEndTime ||
        currentDriver.updatedAt.toISOString() !== planningSnapshot.driver.updatedAt
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
        include: { steps: { select: { stopTaskId: true, tasks: { select: { id: true } } } } },
      });
      if (!loadPlan || loadPlan.validationStatus !== LoadValidationStatus.VALID) {
        throw new ConflictException(
          'Chuyến đi chưa có Load Plan hợp lệ nên không thể phát hành',
        );
      }
      const requiredTaskIds = new Set(
        trip.stops.flatMap((stop) => stop.tasks.map((task) => task.id)),
      );
      const plannedTaskIds = new Set(
        loadPlan.steps
          .flatMap((step) => [step.stopTaskId, ...(step.tasks ?? []).map(task => task.id)])
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
      if (activatedReservations.count > 0 && activatedReservations.count !== 2) {
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
  async getLoadProfile(id: string, user: Principal) {
    const trip = await this.findOne(id, user);
    let weightG = 0n, volumeMm3 = 0n, maxWeightG = 0n, maxVolumeMm3 = 0n;
    const loadProfile = trip.stops.map((stop, stopIndex) => {
      let deltaG = 0n, deltaMm3 = 0n;
      for (const task of stop.tasks) {
        const pkg = task.allocation?.package ?? task.package;
        if (!pkg) throw new ConflictException({ code: 'LEGACY_LOAD_REVIEW_REQUIRED', message: 'Phân công cũ chưa có số đo từng kiện; cần đối soát để tính tải, không tự chia tổng dòng' });
        const sign = task.action === 'LOAD' ? 1n : -1n;
        deltaG += sign * BigInt(pkg.weightG);
        deltaMm3 += sign * BigInt(pkg.lengthMm) * BigInt(pkg.widthMm) * BigInt(pkg.heightMm);
      }
      weightG += deltaG; volumeMm3 += deltaMm3;
      if (weightG > maxWeightG) maxWeightG = weightG;
      if (volumeMm3 > maxVolumeMm3) maxVolumeMm3 = volumeMm3;
      const currentWeightKg = Number(weightG) / 1000, currentVolumeM3 = Number(volumeMm3) / 1e9;
      return { stopIndex: stopIndex + 1, stopAddress: stop.address, stopType: stop.stopType, action: stop.stopType === 'PICKUP' ? 'LOAD' : 'UNLOAD', deltaWeightKg: Number(deltaG) / 1000, deltaVolumeM3: Number(deltaMm3) / 1e9, currentWeightKg, currentVolumeM3, weightUtilizationPercent: currentWeightKg / trip.vehicle.payloadCapacityKg * 100, volumeUtilizationPercent: currentVolumeM3 / trip.vehicle.volumeCapacityM3 * 100 };
    });
    const errors = maxWeightG > BigInt(Math.floor(trip.vehicle.payloadCapacityKg * 1000)) || maxVolumeMm3 > BigInt(Math.floor(trip.vehicle.volumeCapacityM3 * 1e9)) ? ['Tải vượt giới hạn xe'] : [];
    return { isValid: !errors.length, errors, loadProfile, maxWeightKg: Number(maxWeightG) / 1000, maxVolumeM3: Number(maxVolumeMm3) / 1e9 };
  }

  /**
   * Gọi Optimization Engine (Google OR-Tools + Dynamic 2D Spatial Packing)
   */
  async runOptimization(body: OptimizeTripDto, user: Principal) {
    const branchId = requireBranch(user, 'trips.plan', body.branchId);
    await this.access.tripInputs(user, branchId, body);
    if (new Set(body.orderIds).size !== body.orderIds.length) {
      throw new BadRequestException(
        "Danh sách orderIds không được chứa ID trùng",
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
      throw new NotFoundException("Không tìm thấy xe");
    }
    const planningStart = resolveVehiclePlanningStart(vehicle);

    const orders = await this.prisma.order.findMany({
      where: { id: { in: body.orderIds } },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        items: { include: { packages: true } },
      },
    });
    if (orders.length !== body.orderIds.length) {
      throw new BadRequestException("Một số đơn hàng tối ưu không tồn tại");
    }

    const orderedOrders = body.orderIds.map((id) =>
      orders.find((order) => order.id === id)!,
    );
    const planningEpoch = getPlanningEpoch(
      orderedOrders.flatMap(order => order.stops.map(stop => stop.windowStart ?? order.orderedAt)),
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
        door_position: "REAR",
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
      const res = await axios.post(`${this.optimizerUrl}/optimize`, payload, { timeout: 10000 });
      if (res.data?.package_contract_version !== '1') throw new Error('Optimizer chưa hỗ trợ hợp đồng Package v1');
      if (!res.data || typeof res.data.job_id !== 'string' || !Array.isArray(res.data.stops)) {
        throw new Error('Optimization Engine trả response sai contract');
      }
      return res.data;
    } catch (error) {
      throw new BadRequestException(
        error.response?.data?.detail ||
          error.message ||
          "Lỗi khi gọi Optimization Engine",
      );
    }
  }

  async executeAutomaticOptimization(
    user: Principal,
    dto?: RunAutomaticOptimizationDto | string,
    persistedJobId?: string,
    reportProgress?: OptimizationProgressReporter,
  ) {
    const requestedBranchId = typeof dto === 'string' ? dto : dto?.branchId;
    const scheduleMode =
      typeof dto === 'object' ? dto?.scheduleMode : undefined;
    const customStartTimeStr =
      typeof dto === 'object' ? dto?.customStartTime : undefined;
    const searchBudgetSeconds =
      typeof dto === 'object' ? dto?.searchBudgetSeconds : undefined;
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
        include: { stops: { orderBy: { sequence: "asc" } }, items: { include: { packages: true } } },
        orderBy: { orderedAt: "asc" },
      }),
    ]);

    const orders = candidateOrders.filter(order => order.orderType === 'B2B_TRANSPORT' && order.packageDataStatus === 'COMPLETE' && order.items.every(item => item.packages.length > 0 && item.packages.every(pkg => pkg.status === PackageStatus.READY)));

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
        orders.flatMap(order => order.stops.map(stop => stop.windowStart ?? order.orderedAt)),
        branch.timezone,
        now,
      );
    } else if (scheduleMode === AutomaticDispatchScheduleMode.CURRENT_TIME) {
      planningEpoch = getPlanningEpoch(
        orders.flatMap(order => order.stops.map(stop => stop.windowStart ?? order.orderedAt)),
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
        orders.flatMap(order => order.stops.map(stop => stop.windowStart ?? order.orderedAt)),
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
      ...(searchBudgetSeconds !== undefined
        ? { search_time_seconds: searchBudgetSeconds }
        : {}),
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
        searchBudgetSeconds: searchBudgetSeconds ?? null,
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
          timeout: Math.max(
            120000,
            ((snapshot.search_time_seconds ?? snapshot.max_time_seconds) + 90) * 1000,
          ),
        },
      );
      assertFleetOptimizationBatchResult(response.data);
      rankedResults = response.data.candidates;
      if (rankedResults.some(candidate => candidate.result.package_contract_version !== '1')) throw new Error('Optimizer chưa hỗ trợ hợp đồng Package v1');
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
    user: Principal,
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
        await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`);
        for (const route of proposal.result.routes) {
          await this.access.tripInputs(user, branchId, {
            vehicleId: route.vehicle_id,
            driverId: route.driver_id || undefined,
            orderIds: [...new Set(route.stops.map(stop => stop.order_id))],
            orderedStopIds: route.stops.map(stop => stop.order_stop_id),
          }, tx);
        }

        const [orders, vehicles, drivers] = await Promise.all([
          tx.order.findMany({
            where: { id: { in: orderIds }, branchId },
            include: { stops: true, items: { include: { packages: true } } },
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

  private serviceSchedule(stops: DispatchStopWithItems[], durations: number[][], start: Date, end: Date) {
    const travel = (from: number, to: number) => {
      const seconds = durations[from]?.[to];
      if (!Number.isFinite(seconds) || seconds < 0) throw new BadRequestException('Thiếu thời gian di chuyển hợp lệ');
      return seconds * 1000;
    };
    let departure = start.getTime() + travel(0, 1);
    const schedule = stops.map(({ orderStop }, index) => {
      if (!orderStop.windowStart || !orderStop.windowEnd || orderStop.windowBasis !== 'SERVICE_START') throw new BadRequestException('Đơn thiếu khung giờ bắt đầu phục vụ');
      const arrival = departure + travel(index + 1, index + 2);
      const serviceStart = Math.max(arrival, orderStop.windowStart.getTime());
      if (serviceStart > orderStop.windowEnd.getTime()) throw new BadRequestException('Lịch chuyến không đáp ứng khung giờ bắt đầu phục vụ');
      departure = serviceStart + orderStop.serviceDurationMinutes * 60_000;
      return { plannedArrivalTime: new Date(arrival), plannedDepartureTime: new Date(departure) };
    });
    if (departure + travel(stops.length + 1, stops.length + 2) > end.getTime()) throw new BadRequestException('Khung giờ chuyến không đủ cho phục vụ và di chuyển tới điểm cuối');
    return schedule;
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
    trip: { managingBranchId: string | null; vehicle: { homeBranchId: string } },
    user: Principal,
  ) {
    assertPermission(user, 'trips.read', trip.managingBranchId ?? trip.vehicle.homeBranchId);
  }

  private async validateSpatialPlan(
    vehicle: VehicleRecord,
    stopsWithItems: DispatchStopWithItems[],
  ) {
    const cargoByOrderId = new Map<string, ReturnType<typeof packagesToCargoUnits>>();
    for (const entry of stopsWithItems) {
      if (!cargoByOrderId.has(entry.order.id)) {
        cargoByOrderId.set(
          entry.order.id,
          packagesToCargoUnits(entry.order.items),
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
      assertDispatchableOrder(order);
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
        new Set(packagesToCargoUnits(order.items).map((item) => item.id)),
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

        assertDispatchableOrder(order);
        const arrival = planningEpoch.getTime() + stop.arrival_time_sec * 1000;
        if (!orderStop.windowStart || !orderStop.windowEnd || arrival < orderStop.windowStart.getTime() || arrival > orderStop.windowEnd.getTime() || stop.departure_time_sec - stop.arrival_time_sec !== orderStop.serviceDurationMinutes * 60) {
          throw new BadRequestException('Optimizer vi phạm khung giờ/thời lượng phục vụ đã xác nhận');
        }
        const cargoUnitIds =
          stop.stop_type === StopType.PICKUP
            ? stop.items_loaded
            : stop.items_unloaded;
        if (new Set(cargoUnitIds).size !== cargoUnitIds.length || (stop.stop_type === StopType.PICKUP ? stop.items_unloaded : stop.items_loaded).length > 0) throw new BadRequestException('Package trùng hoặc sai thao tác tại stop');
        if (index > 0 && stop.arrival_time_sec < sortedStops[index - 1].departure_time_sec) throw new BadRequestException('Thời gian điểm dừng không đúng thứ tự');
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
            `Điểm dừng [${stop.location_id}] chứa Package không thuộc đơn ${order.orderNumber}`,
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

  private async assertOrdersNotOnActiveTrip(
    tx: Prisma.TransactionClient,
    orderIds: string[],
  ): Promise<void> {
    const conflicting = await tx.stopTask.findFirst({
      where: {
        orderId: { in: orderIds },
        tripStop: { trip: { status: { in: ACTIVE_TRIP_STATUSES } } },
      },
      include: { tripStop: { include: { trip: true } }, order: true },
    });
    if (conflicting)
      throw new ConflictException(
        `Đơn ${conflicting.order?.orderNumber} đã nằm trên chuyến ${conflicting.tripStop.trip.tripNumber}`,
      );
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
    plannedTrip: Pick<PlannedAutomaticTrip, 'vehicleId' | 'driverId' | 'plannedStartTime' | 'plannedEndTime'>,
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
    return Array.from({ length: count }, () => 'TRIP-' + randomUUID().toUpperCase());
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
      include: { stops: true, items: { include: { packages: true } } },
    });
    const allocationIdByPackageId = new Map<string, string>();
    for (const order of orders) {
      assertDispatchableOrder(order);
      for (const item of order.items) for (const pkg of item.packages.filter(pkg => plannedTrip.cargoUnitIds.includes(pkg.id))) {
        const allocation = await tx.allocation.create({ data: { tripId: trip.id, orderItemId: item.id, packageId: pkg.id, allocatedQuantity: 1, status: 'ACTIVE' } });
        allocationIdByPackageId.set(pkg.id, allocation.id);
      }
    }


    const orderById = new Map(orders.map((order) => [order.id, order]));
    const orderStopIdByOptimizerStopId = new Map<string, string>();
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
      for (const packageId of stop.cargoUnitIds) {
        const allocationId = allocationIdByPackageId.get(packageId);
        if (!allocationId) throw new ConflictException('Package không thuộc phần hàng của chuyến');
        await tx.stopTask.create({ data: { tripStopId: tripStop.id, orderId: order.id, orderStopId: stop.orderStopId, packageId, allocationId, action: stop.stopType === StopType.PICKUP ? TaskAction.LOAD : TaskAction.UNLOAD, plannedQuantity: 1 } });
      }
      orderStopIdByOptimizerStopId.set(stop.optimizerStopId, stop.orderStopId);
    }

    await this.persistValidatedLoadPlan(
      tx,
      trip.id,
      plannedTrip.vehicleId,
      orders,
      plannedTrip.spatialValidation,
      1,
      new Map([...packageIdByCargoUnit].filter(([id]) => plannedTrip.cargoUnitIds.includes(id))),
      orderStopIdByOptimizerStopId,
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
    spatialValidation: OptimizedRouteResult['spatial_validation'],
    revision = 1,
    packageIdByCargoUnit?: Map<string, string>,
    orderStopIdByOptimizerStopId = new Map<string, string>(),
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

    const tasks = await tx.stopTask.findMany({ where: { tripStop: { tripId } }, select: { id: true, orderStopId: true } });
    for (const state of spatialValidation.step_states) {
      const matchingTasks = tasks.filter(task => task.orderStopId === (orderStopIdByOptimizerStopId.get(state.stop_id) ?? state.stop_id));
      if (!matchingTasks.length) throw new ConflictException(`Spatial stop ${state.stop_id} has no tasks`);
      await tx.loadPlanStep.create({
        data: {
          loadPlanId: loadPlan.id,
          stepNumber: state.step_index,
          tasks: { connect: matchingTasks.map(task => ({ id: task.id })) },
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
    const current = await tx.order.findMany({
      where: { id: { in: orders.map(order => order.id) } },
      include: { stops: true, items: { include: { packages: true } } },
    });
    const requestedIds = new Set(orders.flatMap(order => order.items.flatMap(item => item.packages.map(pkg => pkg.id))));
    const mapping = new Map<string, string>();
    for (const order of current) {
      for (const cargo of packagesToCargoUnits(order.items)) {
        if (requestedIds.has(cargo.id)) mapping.set(cargo.id, cargo.id);
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

  private buildOptimizerOrders(
    orders: OrderWithStopsAndItems[],
    planningEpoch: Date,
  ) {
    // Integer-second solver: tighten, never widen, a millisecond window.
    const secondsFromEpoch = (value: Date, boundary: 'start' | 'end') => {
      const seconds = (value.getTime() - planningEpoch.getTime()) / 1000;
      return boundary === 'start' ? Math.ceil(seconds) : Math.floor(seconds);
    };

    return orders.map((order) => {
      assertDispatchableOrder(order);
      if (order.status !== 'CONFIRMED') throw new ConflictException('Chỉ tối ưu đơn đã xác nhận');
      const pickup = order.stops.find((stop) => stop.type === StopType.PICKUP);
      const delivery = order.stops.find(
        (stop) => stop.type === StopType.DELIVERY,
      );
      if (!pickup || !delivery) {
        throw new BadRequestException(
          `Đơn ${order.orderNumber} thiếu pickup hoặc delivery`,
        );
      }
      if (!pickup.windowStart || !pickup.windowEnd || !delivery.windowStart || !delivery.windowEnd || pickup.windowBasis !== 'SERVICE_START' || delivery.windowBasis !== 'SERVICE_START') throw new BadRequestException('Thiếu khung giờ bắt đầu phục vụ đã xác nhận');
      let items;
      try {
        items = packagesToCargoUnits(order.items);
      } catch (error) {
        throw new BadRequestException(error.message);
      }
      return {
        id: order.id,
        order_number: order.orderNumber,
        pickup_location: {
          id: pickup.id,
          name: pickup.address,
          latitude: pickup.latitude,
          longitude: pickup.longitude,
        },
        delivery_location: {
          id: delivery.id,
          name: delivery.address,
          latitude: delivery.latitude,
          longitude: delivery.longitude,
        },
        items,
        pickup_window_start_sec: secondsFromEpoch(pickup.windowStart, 'start'),
        pickup_window_end_sec: secondsFromEpoch(pickup.windowEnd, 'end'),
        delivery_window_start_sec: secondsFromEpoch(delivery.windowStart, 'start'),
        delivery_window_end_sec: secondsFromEpoch(delivery.windowEnd, 'end'),
        pickup_service_time_sec: pickup.serviceDurationMinutes * 60,
        delivery_service_time_sec: delivery.serviceDurationMinutes * 60,
        time_window_basis: 'SERVICE_START',
        package_contract_version: '1',
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
