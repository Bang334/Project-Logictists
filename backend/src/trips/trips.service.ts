import { assertDispatchableOrder } from '../orders/order-contract';
import { isFloorRotationLocked } from '../orders/package-orientations';
import { assertNoDeliveryOrderHold, assertNoDeliveryResourceHold, DeliveryWindowConstraint, resolveDeliveryWindowConstraints } from './delivery-planning.rules';
import { Principal, tripFilter, requireBranch, assertPermission } from '../auth/access';
import { ResourceAccess } from '../auth/resource-access.service';
import { ZonesService } from '../zones/zones.service';
import { expandZoneCurfewsRelativeToEpoch, ZoneCurfewRecord } from '../zones/geo.utils';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService, RoadMatrixResult } from '../mapbox/mapbox.service';
import {
  isOptimizationAbortError,
  OptimizationCancelledError,
  OptimizationJobControlService,
  throwIfOptimizationAborted,
} from './optimization-job-control.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripsValidator } from './trips.validator';
import {
  DriverStatus,
  Driver as DriverRecord,
  LoadValidationStatus,
  LocationType,
  OrderStatus,
  OrderStop as OrderStopRecord,
  PackageStatus,
  Prisma,
  ReservationStatus,
  StopType,
  TaskAction,
  TripStatus,
  VehicleStatus,
  Vehicle as VehicleRecord,
  VehicleType,
} from "@prisma/client";
import { OptimizeTripDto } from "./dto/optimize-trip.dto";
import { packagesToCargoUnits, splitOversizedOrdersAcrossFleet } from "./optimizer-payload";
import { assertDemoStackSupports, matchesDemoStackingPolicy, readDemoStackingPolicy } from './demo-stacking';
import { SettingsService } from '../settings/settings.service';
import { COMPANY_SETTING_DEFAULTS } from '../settings/settings.types';
import { toResolvedStackingPolicy } from '../settings/settings.helpers';
import {
  assertFleetOptimizationBatchResult,
  extractCandidateCostBreakdown,
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
import { RunDemoOptimizationDto } from './dto/run-demo-optimization.dto';
import {
  buildServiceDayWindows,
  currentDispatchEarliest,
  getFullServiceDayPlanningEpoch,
  getNextDayPlanningEpoch,
  getPlanningEpoch,
  resolveCurrentDispatchStart,
  ServiceDayWindow,
} from './service-day';
import { OutboxService } from '../common/services/outbox.service';
import { PublishTripDto } from './dto/publish-trip.dto';
import { UpdateTripPlanDto } from './dto/update-trip-plan.dto';
import {
  resolveVehiclePlanningStart,
  VEHICLE_HOME_DEPOT_SELECT,
} from './vehicle-planning-start';
import {
  buildInterprovincialTollMatrix,
  DEFAULT_VN_2024_DRIVING_REST_POLICY,
  expectedWarehouseStopServiceSec,
  extractLocationConstraintFields,
  findMatchingWarehouseLocation,
  LocationConstraintSource,
  parseWorkPolicyToDrivingRest,
  startOfWeekInTimeZone,
  TollCorridorRecord,
  WorkPolicyRow,
} from './interprovincial-policy';
import { OptimizationProgressReporter } from './optimization-progress';
import {
  flattenVehicleType,
  vehicleCapabilities,
  vehicleTypeAllowsHazmat,
} from '../vehicles/vehicle-capabilities';

const ACTIVE_TRIP_STATUSES = [
  TripStatus.PLANNED,
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
];
const OPTIMIZATION_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const INITIAL_PLANNING_DAYS = 7;
const LOCK_NAMESPACE_VEHICLE = 4101;
const LOCK_NAMESPACE_DRIVER = 4102;
const LOCK_NAMESPACE_ORDER = 4103;
const LOCK_NAMESPACE_TRIP_COMMAND = 4105;

type StopLocationRecord = OrderStopRecord & {
  location?: LocationConstraintSource | null;
};

type CustodyLocationSummary = {
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
};

type BaseOrderWithStopsAndItems = Omit<
  Prisma.OrderGetPayload<{
    include: { stops: true; items: { include: { packages: true } } };
  }>,
  'stops'
> & {
  stops: StopLocationRecord[];
};

type OrderWithStopsAndItems = Omit<BaseOrderWithStopsAndItems, 'items'> & {
  packages?: any[];
  items: Array<
    Omit<BaseOrderWithStopsAndItems['items'][number], 'packages'> & {
      packages: Array<
        BaseOrderWithStopsAndItems['items'][number]['packages'][number] & {
          custodyLocation?: CustodyLocationSummary | null;
        }
      >;
    }
  >;
};

type DispatchStopWithItems = {
  orderStop: OrderWithStopsAndItems['stops'][number];
  order: OrderWithStopsAndItems;
};

type TripPlanningSnapshot = {
  orders: Array<{ id: string; version: number }>;
  vehicle: { id: string; updatedAt: string; vehicleTypeUpdatedAt: string };
  driver: { id: string; updatedAt: string };
};

type VehicleRecordWithType = VehicleRecord & { vehicleTypeRecord: VehicleType };

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
    vehicle: { id: string; updatedAt: string; vehicleTypeUpdatedAt: string };
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
    hubLocationId?: string | null;
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
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
    private outbox: OutboxService,
    private access: ResourceAccess,
    @Optional() private settingsService?: SettingsService,
    @Optional() private jobControl?: OptimizationJobControlService,
    @Optional() private zonesService?: ZonesService,
  ) {}

  private async resolveBranchStackingPolicy(
    branchId?: string | null,
    db?: Prisma.TransactionClient,
  ) {
    if (this.settingsService) {
      return this.settingsService.resolveStackingPolicy(branchId, db ?? this.prisma);
    }
    const policy = readDemoStackingPolicy(process.env);
    return {
      enabled: Boolean(policy),
      policy,
      ownerMode: (policy?.owner_mode ?? 'SAME_CUSTOMER') as 'SAME_CUSTOMER' | 'ANY_CUSTOMER',
      maxTiers: policy?.max_tiers ?? 2,
      liftClearanceMm: Math.round((policy?.lift_clearance_cm ?? 5) * 10),
      maxTopLoadPercent: policy?.max_top_load_percent ?? 30,
      policyVersion: 'env:fallback',
    };
  }

  async findAll(user: Principal, status?: TripStatus, branchId?: string) {
    const trips = await this.prisma.trip.findMany({
      where: {
        ...(status ? { status } : {}),
        ...tripFilter(user, 'trips.read', branchId),
      },
      include: {
        vehicle: {
          include: { homeBranch: true, vehicleTypeRecord: true },
        },
        assignments: {
          include: { driver: true },
        },
        stops: {
          orderBy: { sequence: "asc" },
          include: {
            hubLocation: {
              select: {
                id: true,
                code: true,
                name: true,
                address: true,
                latitude: true,
                longitude: true,
              },
            },
            tasks: true,
            deliveryAttempts: {
              where: { results: { some: { result: 'RETAINED_ON_VEHICLE', package: { status: 'LOADED' } } } },
              select: {
                id: true,
                occurredAt: true,
                failureReason: true,
                failureCategory: true,
                requestedRedeliveryAt: true,
              },
              orderBy: { occurredAt: 'desc' },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return trips.map((trip) => ({
      ...trip,
      vehicle: flattenVehicleType(trip.vehicle),
    }));
  }

  async findOne(id: string, user: Principal) {
    const trip = await this.prisma.trip.findFirst({
      where: { id, ...tripFilter(user) },
      include: {
        vehicle: { include: { homeBranch: true, vehicleTypeRecord: true } },
        assignments: { include: { driver: true } },
        stops: {
          orderBy: { sequence: "asc" },
          include: {
            hubLocation: {
              select: {
                id: true,
                code: true,
                name: true,
                address: true,
                latitude: true,
                longitude: true,
              },
            },
            deliveryAttempts: {
              orderBy: { occurredAt: 'desc' },
              select: {
                id: true,
                attemptNumber: true,
                occurredAt: true,
                result: true,
                failureReason: true,
                failureCategory: true,
                requestedRedeliveryAt: true,
              },
            },
            tasks: {
              include: {
                deliveryResults: {
                  select: { id: true, result: true, packageId: true },
                },
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

    return { ...trip, vehicle: flattenVehicleType(trip.vehicle), stops: trip.stops.map(stop => ({ ...stop, tasks: stop.tasks.map(task => ({ ...task, allocation: task.allocation ? { ...task.allocation, package: task.allocation.package ? { ...task.allocation.package, weightG: task.allocation.package.weightG.toString() } : null } : null })) })) };
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
        vehicleTypeRecord: true,
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
        items: {
          include: {
            packages: {
              include: {
                custodyLocation: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    address: true,
                    latitude: true,
                    longitude: true,
                  },
                },
              },
            },
          },
        },
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
    const hubLocationIdByOrderStopId = new Map<string, string>();
    const projectManualStop = (
      stop: OrderWithStopsAndItems['stops'][number],
      order: OrderWithStopsAndItems,
    ): DispatchStopWithItems => {
      if (stop.type === StopType.PICKUP) {
        const readyIds = order.items.flatMap((i) =>
          i.packages
            .filter((p) => p.status === PackageStatus.READY)
            .map((p) => p.id),
        );
        const hub = this.resolveOrderCustodyHubForCargo(order, readyIds);
        if (hub) {
          hubLocationIdByOrderStopId.set(stop.id, hub.id);
          return {
            orderStop: {
              ...stop,
              address: `${hub.name} — ${hub.address}`,
              latitude: hub.latitude,
              longitude: hub.longitude,
            },
            order,
          };
        }
      }
      return { orderStop: stop, order };
    };

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
            stopWithItemsList.push(projectManualStop(match, order));
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
            pickups.push(projectManualStop(stop, order));
          } else {
            deliveries.push(projectManualStop(stop, order));
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
            include: { vehicleTypeRecord: true },
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
      if (
        currentVehicle.updatedAt.getTime() !== vehicle.updatedAt.getTime() ||
        currentVehicle.vehicleTypeRecord.updatedAt.getTime() !==
          vehicle.vehicleTypeRecord.updatedAt.getTime()
      ) {
        throw new ConflictException(
          'Xe hoặc cấu hình loại xe đã thay đổi sau khi kiểm tra tuyến; hãy lập lại phương án',
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
              vehicleTypeUpdatedAt:
                currentVehicle.vehicleTypeRecord.updatedAt.toISOString(),
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
            hubLocationId: isPickup
              ? (hubLocationIdByOrderStopId.get(item.orderStop.id) ?? null)
              : null,
            address: item.orderStop.address,
            latitude: item.orderStop.latitude,
            longitude: item.orderStop.longitude,
            contactName: item.orderStop.contactName,
            contactPhone: item.orderStop.contactPhone,
            ...schedule[i],
          },
        });

        for (const line of item.order.items) {
          for (const pkg of line.packages.filter(
            (p) => p.status === PackageStatus.READY,
          )) {
            let allocation = await tx.allocation.findFirst({ where: { tripId: trip.id, packageId: pkg.id } });
            if (!allocation) allocation = await tx.allocation.create({ data: { tripId: trip.id, orderItemId: line.id, packageId: pkg.id, allocatedQuantity: 1, status: 'ACTIVE' } });
            await tx.stopTask.create({ data: { tripStopId: tripStop.id, allocationId: allocation.id, orderId: item.order.id, packageId: pkg.id, orderStopId: item.orderStop.id, action: isPickup ? TaskAction.LOAD : TaskAction.UNLOAD, plannedQuantity: 1 } });
          }
        }
      }
      const manualReadyPackageIds = orders.flatMap((order) =>
        order.items.flatMap((line) =>
          line.packages
            .filter((pkg) => pkg.status === PackageStatus.READY)
            .map((pkg) => pkg.id),
        ),
      );
      if (manualReadyPackageIds.length > 0) {
        await tx.package.updateMany({
          where: {
            id: { in: manualReadyPackageIds },
            status: PackageStatus.READY,
          },
          data: { status: 'ALLOCATED', version: { increment: 1 } },
        });
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
        include: {
          homeDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT },
          vehicleTypeRecord: true,
        },
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
        include: { stops: true, items: { include: { packages: true } }, packages: true },
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
      await this.assertConfirmedDeliveryVisits(tx, stopWithItems.flatMap((entry, index) => entry.orderStop.type === 'DELIVERY' ? [{ orderId: entry.order.id, arrival: schedule[index].plannedArrivalTime }] : []));
      const [currentTrip, currentVehicle, currentDriver, currentOrders] = await Promise.all([
        tx.trip.findUnique({ where: { id }, select: { version: true, status: true } }),
        tx.vehicle.findFirst({
          where: { id: dto.vehicleId, homeBranchId: branchId, status: VehicleStatus.AVAILABLE },
          include: { vehicleTypeRecord: true },
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
      if (
        currentVehicle.updatedAt.getTime() !== vehicle.updatedAt.getTime() ||
        currentVehicle.vehicleTypeRecord.updatedAt.getTime() !==
          vehicle.vehicleTypeRecord.updatedAt.getTime()
      ) {
        throw new ConflictException(
          'Xe hoặc cấu hình loại xe đã thay đổi trong lúc sửa chuyến; hãy thử lại',
        );
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
              vehicleTypeUpdatedAt:
                currentVehicle.vehicleTypeRecord.updatedAt.toISOString(),
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
          vehicle: { include: { vehicleTypeRecord: true } },
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
      await this.assertConfirmedDeliveryVisits(tx, trip.stops.filter(stop => stop.stopType === 'DELIVERY').flatMap(stop => stop.tasks.flatMap(task => task.orderId ? [{ orderId: task.orderId, arrival: stop.plannedArrivalTime ?? new Date(0) }] : [])));
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
        tx.vehicle.findUnique({
          where: { id: trip.vehicleId },
          include: { vehicleTypeRecord: true },
        }),
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
        currentVehicle.vehicleTypeRecord.updatedAt.toISOString() !==
          planningSnapshot.vehicle.vehicleTypeUpdatedAt ||
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
      if (loadPlan.validatorVersion === 'spatial-demo-stacking-v1') {
        const currentPolicy = (
          await this.resolveBranchStackingPolicy(
            trip.managingBranchId ?? trip.vehicle.homeBranchId,
            tx,
          )
        ).policy;
        const geometry = loadPlan.geometrySnapshot;
        const saved = geometry && typeof geometry === 'object' && !Array.isArray(geometry) ? geometry.demoStackingPolicy : null;
        if (!matchesDemoStackingPolicy(currentPolicy, saved)) {
          throw new ConflictException('Cấu hình xếp chồng đã đổi. Hãy kiểm tra lại bố trí trước khi phát hành chuyến');
        }
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
    const retained = await this.prisma.deliveryResult.findFirst({
      where: {
        result: 'RETAINED_ON_VEHICLE',
        package: { status: 'LOADED' },
        deliveryAttempt: { tripStop: { tripId: id } },
      },
      select: { id: true },
    });
    if (retained) throw new ConflictException({
      code: 'LOAD_PLAN_REVIEW_REQUIRED',
      message: 'Có kiện giao chưa thành công còn trên xe. Biểu đồ tải theo kế hoạch cần điều phối lại.',
    });
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
   * Gọi Optimization Engine (Packing-aware Hybrid ALNS + Dynamic 2D Spatial Packing)
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
        vehicleTypeRecord: true,
      },
    });
    if (!vehicle) {
      throw new NotFoundException("Không tìm thấy xe");
    }
    const planningStart = resolveVehiclePlanningStart(vehicle);

    const [orders, warehouses] = await Promise.all([
      this.prisma.order.findMany({
        where: { id: { in: body.orderIds }, orderType: 'B2B_TRANSPORT' },
        include: {
          stops: { orderBy: { sequence: 'asc' }, include: { location: true } },
          items: {
            include: {
              packages: {
                include: {
                  custodyLocation: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                      address: true,
                      latitude: true,
                      longitude: true,
                    },
                  },
                },
              },
            },
          },
          packages: true,
        },
      }),
      this.prisma.location?.findMany
        ? this.prisma.location.findMany({
            where: { active: true, type: LocationType.CENTRAL_WAREHOUSE },
            select: {
              id: true,
              latitude: true,
              longitude: true,
              provinceCode: true,
              provinceName: true,
              warehouseRole: true,
              dockingTimeSec: true,
              maxVehiclePayloadKg: true,
              maxVehicleLengthCm: true,
              hasForklift: true,
              operatingWindows: true,
              handlingSecPerTon: true,
              handlingSecPerPackage: true,
              capabilities: true,
            },
          })
        : Promise.resolve([]),
    ]);
    if (orders.length !== body.orderIds.length) {
      throw new BadRequestException("Một số đơn hàng tối ưu không tồn tại");
    }

    const orderedOrders = body.orderIds.map((id) =>
      orders.find((order) => order.id === id)!,
    );
    const planningEpoch = getPlanningEpoch(
      orderedOrders.map(order => order.orderedAt),
      vehicle.homeBranch.timezone,
    );
    const activeZones = this.zonesService
      ? await this.zonesService.findActiveByBranch(vehicle.homeBranchId)
      : [];
    const optimizerOrders = this.buildOptimizerOrders(
      orderedOrders,
      planningEpoch,
      new Map(),
      INITIAL_PLANNING_DAYS * 86400,
      activeZones,
      vehicle.homeBranch.timezone,
      warehouses,
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
        length_cm: vehicle.vehicleTypeRecord.lengthCm,
        width_cm: vehicle.vehicleTypeRecord.widthCm,
        height_cm: vehicle.vehicleTypeRecord.heightCm,
        payload_limit_kg: vehicle.vehicleTypeRecord.payloadCapacityKg,
        door_position: "REAR",
      },
      depot: {
        id: `depot:${planningStart.locationId}`,
        source_location_id: planningStart.locationId,
        name: planningStart.name,
        latitude: planningStart.latitude,
        longitude: planningStart.longitude,
        ...planningStart.locationConstraints,
      },
      orders: optimizerOrders,
      demo_stacking: (await this.resolveBranchStackingPolicy(branchId)).policy,
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
    const signal = persistedJobId ? this.jobControl?.getSignal(persistedJobId) : undefined;
    throwIfOptimizationAborted(signal);
    const requestedBranchId = typeof dto === 'string' ? dto : dto?.branchId;
    const scheduleMode =
      typeof dto === 'object' ? dto?.scheduleMode : undefined;
    const customStartTimeStr =
      typeof dto === 'object' ? dto?.customStartTime : undefined;
    const searchBudgetSeconds =
      typeof dto === 'object' ? dto?.searchBudgetSeconds : undefined;
    const branchId = resolveBranchScope(user, requestedBranchId);

    const deliveryBatchId = typeof dto === 'object' ? dto.deliveryBatchId : undefined;
    const replanWithFleet = typeof dto === 'object' ? Boolean(dto.replanWithFleet) : false;
    const deliveryBatch = deliveryBatchId ? await this.prisma.deliveryPlanningBatch.findUnique({
      where: { id: deliveryBatchId }, include: { appointments: true },
    }) : null;
    if (deliveryBatchId && (!deliveryBatch || deliveryBatch.branchId !== branchId || deliveryBatch.status !== 'OFFERING' || deliveryBatch.appointments.some(row => row.status === 'PENDING'))) throw new ConflictException('Đợt hẹn chưa sẵn sàng chốt');
    const confirmations = deliveryBatch?.appointments.filter(row => row.status === 'CONFIRMED') ?? [];
    const batchChangeRequests = deliveryBatch?.appointments.filter(row => row.status === 'CHANGE_REQUESTED') ?? [];
    const recipientBatch = Boolean(deliveryBatch?.appointments.some(row => row.recipientPhone));
    if (recipientBatch && batchChangeRequests.length > 0 && !replanWithFleet) {
      throw new ConflictException('Cần xếp lại theo giờ người nhận đã chọn');
    }
    const acknowledgedIds = [...confirmations, ...(replanWithFleet ? batchChangeRequests : [])].map(row => row.orderId);
    const batchDeclinedIds = deliveryBatch?.appointments.filter(row => row.status === 'DECLINED').map(row => row.orderId) ?? [];
    const otherOrderHolds = await this.prisma.deliveryAppointment.findMany({ where: {
      ...(deliveryBatchId ? { batchId: { not: deliveryBatchId } } : {}),
      batch: { branchId }, OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', expiresAt: { gt: new Date() } }],
    }, select: { orderId: true } });

    const [branch, vehicles, drivers, candidateOrders, workPolicies, tollCorridors, activeWarehouses] = await Promise.all([
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
          endDepotLocation: { select: VEHICLE_HOME_DEPOT_SELECT },
          vehicleTypeRecord: true,
        },
        orderBy: { plateNumber: 'asc' },
      }),
      this.prisma.driver.findMany({
        where: {
          homeBranchId: branchId,
          status: 'AVAILABLE',
          licenseExpiry: { gt: new Date() },
        },
        include: {
          homeLocation: {
            select: {
              id: true,
              code: true,
              name: true,
              provinceCode: true,
              provinceName: true,
              warehouseRole: true,
            },
          },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          branchId,
          orderType: 'B2B_TRANSPORT',
          status: OrderStatus.CONFIRMED,
          id: deliveryBatchId && (!replanWithFleet || recipientBatch)
            ? { in: acknowledgedIds }
            : { notIn: [...new Set([...otherOrderHolds.map(row => row.orderId), ...batchDeclinedIds])] },
        },
        include: {
          stops: { orderBy: { sequence: 'asc' }, include: { location: true } },
          items: {
            include: {
              packages: {
                include: {
                  custodyLocation: {
                    select: {
                      id: true,
                      code: true,
                      name: true,
                      address: true,
                      latitude: true,
                      longitude: true,
                    },
                  },
                },
              },
            },
          },
          packages: true,
        },
        orderBy: { orderedAt: "asc" },
      }),
      this.prisma.workPolicy?.findMany
        ? this.prisma.workPolicy.findMany({
            where: { jurisdiction: 'VN' },
            orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
            take: 10,
          })
        : Promise.resolve([] as WorkPolicyRow[]),
      this.prisma.tollCorridor?.findMany
        ? this.prisma.tollCorridor.findMany({
            where: { active: true },
            select: { fromProvinceCode: true, toProvinceCode: true, baseTollVnd: true, active: true },
          })
        : Promise.resolve([] as TollCorridorRecord[]),
      this.prisma.location?.findMany
        ? this.prisma.location.findMany({
            where: { active: true, type: LocationType.CENTRAL_WAREHOUSE },
            select: {
              id: true,
              latitude: true,
              longitude: true,
              provinceCode: true,
              provinceName: true,
              warehouseRole: true,
              dockingTimeSec: true,
              maxVehiclePayloadKg: true,
              maxVehicleLengthCm: true,
              hasForklift: true,
              operatingWindows: true,
              handlingSecPerTon: true,
              handlingSecPerPackage: true,
              capabilities: true,
            },
          })
        : Promise.resolve([] as Array<LocationConstraintSource & { latitude: number; longitude: number }>),
    ]);

    const orders = candidateOrders.filter((order) =>
      this.isOrderEligibleForAutomaticOptimization(order),
    );

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

    const effectiveSettings =
      typeof this.settingsService?.resolveEffectiveSettings === 'function'
        ? await this.settingsService.resolveEffectiveSettings(branchId)
        : null;
    const effectiveWorkStartTime =
      effectiveSettings?.costPenalty.workStartTime ?? branch.workStartTime;
    const effectiveWorkEndTime =
      effectiveSettings?.costPenalty.workEndTime ?? branch.workEndTime;

    const candidateVehicles = vehicles
      .slice(0, drivers.length)
      .map((vehicle) => ({
        ...vehicle,
        planningStart: resolveVehiclePlanningStart(vehicle),
      }));

    const resolvedSearchBudget =
      searchBudgetSeconds ?? effectiveSettings?.optimization.defaultSearchBudgetSeconds;
    const effectiveMaxTimeSeconds = effectiveSettings?.optimization.maxTimeSeconds ?? 120;
    const earlyStopPatience = effectiveSettings?.optimization.earlyStopPatience ?? 0;
    const largeBatchFloorSeconds = orders.length >= 50 ? 48 : 0;
    const boundedSearchBudgetSeconds =
      resolvedSearchBudget !== undefined || largeBatchFloorSeconds > 0
        ? Math.min(
            effectiveMaxTimeSeconds,
            Math.max(resolvedSearchBudget ?? largeBatchFloorSeconds, largeBatchFloorSeconds),
          )
        : undefined;
    const preparationMinutes =
      effectiveSettings?.optimization.dispatchPreparationMinutes ??
      COMPANY_SETTING_DEFAULTS.optimization.dispatchPreparationMinutes;
    const estimatedSolverSeconds =
      earlyStopPatience > 0
        ? effectiveMaxTimeSeconds
        : (boundedSearchBudgetSeconds ?? effectiveMaxTimeSeconds);
    const routingOverheadSeconds = 60;

    const now = new Date();
    let planningEpoch: Date;
    let effectiveStartTime: Date | undefined;

    if (deliveryBatch) {
      const witness = deliveryBatch.proposal;
      assertOptimizationProposal(witness);
      planningEpoch =
        recipientBatch && replanWithFleet
          ? new Date(
              Math.max(
                Date.parse(witness.planningEpochIso),
                getPlanningEpoch(
                  orders.map((order) => order.orderedAt),
                  branch.timezone,
                  now,
                ).getTime(),
              ),
            )
          : new Date(witness.planningEpochIso);
    } else if (scheduleMode === AutomaticDispatchScheduleMode.NEXT_DAY) {
      planningEpoch = getNextDayPlanningEpoch(
        orders.map(order => order.orderedAt),
        branch.timezone,
        now,
      );
    } else if (scheduleMode === AutomaticDispatchScheduleMode.CURRENT_TIME) {
      const requestedStart = customStartTimeStr ? Date.parse(customStartTimeStr) : 0;
      if (!Number.isFinite(requestedStart)) {
        throw new BadRequestException('customStartTime không hợp lệ');
      }
      const earliest = currentDispatchEarliest(
        now,
        preparationMinutes,
        estimatedSolverSeconds + routingOverheadSeconds,
      );
      try {
        ({ planningEpoch, effectiveStartTime } = resolveCurrentDispatchStart(
          new Date(Math.max(requestedStart, earliest.getTime())),
          branch.timezone,
          effectiveWorkStartTime,
          effectiveWorkEndTime,
        ));
      } catch (error: any) {
        throw new BadRequestException(error?.message || 'Không thể lập lịch trong ca');
      }
    } else {
      planningEpoch = getFullServiceDayPlanningEpoch(
        orders.map(order => order.orderedAt),
        branch.timezone,
        effectiveWorkStartTime,
        now,
      );
    }

    let replanDuringShift = false;
    if (recipientBatch && replanWithFleet && planningEpoch < now) {
      try {
        const [today] = buildServiceDayWindows(
          planningEpoch,
          branch.timezone,
          effectiveWorkStartTime,
          effectiveWorkEndTime,
          1,
        );
        if (today.endsAt.getTime() - now.getTime() < 15 * 60_000) {
          planningEpoch = getNextDayPlanningEpoch([], branch.timezone, now);
        } else {
          replanDuringShift = true;
        }
      } catch (error: any) {
        throw new BadRequestException(
          error?.message || 'Không thể tạo cửa sổ thời gian điều phối',
        );
      }
    }

    const weekStart = startOfWeekInTimeZone(planningEpoch, branch.timezone);
    const rawPriorDriverAssignments =
      drivers.length > 0 && this.prisma.driverAssignment?.findMany
        ? await this.prisma.driverAssignment.findMany({
            where: {
              driverId: { in: drivers.map((driver) => driver.id) },
              startTime: { lt: planningEpoch },
              endTime: { gt: weekStart },
              trip: {
                status: {
                  in: [...ACTIVE_TRIP_STATUSES, TripStatus.COMPLETED],
                },
              },
            },
            select: {
              driverId: true,
              startTime: true,
              endTime: true,
            },
          })
        : [];
    const priorWeeklyDrivingSecByDriver = new Map<string, number>();
    if (Array.isArray(rawPriorDriverAssignments)) {
      const epochMs = planningEpoch.getTime();
      const weekStartMs = weekStart.getTime();
      for (const row of rawPriorDriverAssignments) {
        const clippedStart = Math.max(weekStartMs, row.startTime.getTime());
        const clippedEnd = Math.min(epochMs, row.endTime.getTime());
        if (clippedEnd > clippedStart) {
          const addedSec = Math.round((clippedEnd - clippedStart) / 1000);
          priorWeeklyDrivingSecByDriver.set(
            row.driverId,
            (priorWeeklyDrivingSecByDriver.get(row.driverId) ?? 0) + addedSec,
          );
        }
      }
    }

    const baseVehicles = candidateVehicles.map((vehicle) => {
      const endDepotLoc =
        vehicle.endDepotLocation && vehicle.endDepotLocation.active
          ? vehicle.endDepotLocation
          : null;
      const allowsHazmat = vehicleTypeAllowsHazmat(vehicle.vehicleTypeRecord);
      return {
        id: vehicle.id,
        source_vehicle_id: vehicle.id,
        plate_number: vehicle.plateNumber,
        model: vehicle.model,
        vehicle_type: vehicle.vehicleTypeRecord.name,
        length_cm: vehicle.vehicleTypeRecord.lengthCm,
        width_cm: vehicle.vehicleTypeRecord.widthCm,
        height_cm: vehicle.vehicleTypeRecord.heightCm,
        payload_limit_kg: vehicle.vehicleTypeRecord.payloadCapacityKg,
        door_position: 'REAR',
        temperature_mode: vehicle.vehicleTypeRecord.temperatureMode ?? 'DRY',
        ...(allowsHazmat ? { allows_hazmat: true } : {}),
        has_tail_lift: vehicle.vehicleTypeRecord.hasTailLift ?? false,
        toll_factor: Number(vehicle.vehicleTypeRecord.tollFactor ?? 1),
        return_to_depot: vehicle.returnToDepot ?? true,
        ...(endDepotLoc
          ? {
              end_depot: {
                id: `end_depot:${endDepotLoc.id}`,
                source_location_id: endDepotLoc.id,
                warehouse_location_id: endDepotLoc.id,
                name: endDepotLoc.name,
                latitude: endDepotLoc.latitude,
                longitude: endDepotLoc.longitude,
                ...extractLocationConstraintFields(endDepotLoc),
              },
            }
          : {}),
        depot: {
          id: `depot:${vehicle.planningStart.locationId}`,
          source_location_id: vehicle.planningStart.locationId,
          warehouse_location_id: vehicle.planningStart.locationId,
          name: vehicle.planningStart.name,
          latitude: vehicle.planningStart.latitude,
          longitude: vehicle.planningStart.longitude,
          ...vehicle.planningStart.locationConstraints,
        },
        fuel_consumption_liters_per_100_km: Number(
          vehicle.vehicleTypeRecord.fuelConsumptionLitersPer100Km,
        ),
        load_fuel_surcharge_percent_at_full_payload: Number(
          vehicle.vehicleTypeRecord.loadFuelSurchargePercentAtFullPayload,
        ),
        fixed_operating_cost_vnd: Number(vehicle.vehicleTypeRecord.fixedOperatingCostPerTrip),
      };
    });
    const baseDrivers = drivers.map((driver) => {
      const homeProvince =
        driver.homeProvinceCode ?? driver.homeLocation?.provinceCode ?? null;
      const initialWeeklyDrivingSec = priorWeeklyDrivingSecByDriver.get(driver.id) ?? 0;
      return {
        source_driver_id: driver.id,
        full_name: driver.fullName,
        license_class: driver.licenseClass,
        fixed_salary_monthly_vnd: Number(driver.fixedSalaryMonthly),
        trip_base_pay_vnd: Number(driver.tripBasePay),
        per_km_pay_vnd: Number(driver.perKmPay),
        ...(driver.homeLocationId ? { home_location_id: driver.homeLocationId } : {}),
        ...(homeProvince ? { home_province_code: homeProvince } : {}),
        ...(driver.strictHomeLocation ? { strict_home_location: true } : {}),
        ...(initialWeeklyDrivingSec > 0
          ? { initial_weekly_driving_sec: initialWeeklyDrivingSec }
          : {}),
      };
    });
    const activeWorkPolicyRow = workPolicies.find(
      (policy) =>
        policy.effectiveFrom <= planningEpoch &&
        (!policy.effectiveTo || policy.effectiveTo >= planningEpoch),
    );
    const drivingRestPolicy = activeWorkPolicyRow
      ? parseWorkPolicyToDrivingRest(activeWorkPolicyRow)
      : workPolicies.length === 0
        ? DEFAULT_VN_2024_DRIVING_REST_POLICY
        : null;
    const deliveryHolds = await this.prisma.deliveryCapacityHold.findMany({ where: {
      status: 'HELD', ...(deliveryBatchId ? { batchId: { not: deliveryBatchId } } : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      batch: { branchId },
    } });
    const existingReservations = await this.prisma.resourceReservation.findMany({ where: {
      status: { in: [ReservationStatus.HELD, ReservationStatus.ACTIVE, ReservationStatus.COMMITTED] },
      OR: [{ vehicle: { homeBranchId: branchId } }, { driver: { homeBranchId: branchId } }],
    } });
    const heldResources = [...deliveryHolds, ...existingReservations];
    const freeInDay = (id: string, day: ServiceDayWindow, kind: 'vehicleId' | 'driverId') => !heldResources.some(hold => hold[kind] === id && hold.startsAt < day.endsAt && hold.endsAt > day.startsAt);
    const demoStacking = effectiveSettings
      ? toResolvedStackingPolicy(effectiveSettings.stacking)
      : readDemoStackingPolicy(process.env);
    const latestChangeRequests = (!deliveryBatchId || replanWithFleet) && orders.length > 0 && this.prisma.deliveryAppointment?.findMany
      ? await this.prisma.deliveryAppointment.findMany({
          where: {
            orderId: { in: orders.map((order) => order.id) },
            status: 'CHANGE_REQUESTED',
          },
          orderBy: [{ respondedAt: 'desc' }, { createdAt: 'desc' }],
        })
      : [];
    let cachedMatrix: { key: string; matrix: RoadMatrixResult; queriedAt: Date } | undefined;
    const runHorizon = async (dayCount: number, remainingSeconds: number) => {
      let serviceDays: ServiceDayWindow[];
      try {
        serviceDays = buildServiceDayWindows(
          planningEpoch,
          branch.timezone,
          effectiveWorkStartTime,
          effectiveWorkEndTime,
          dayCount,
          {
            scheduleMode: replanDuringShift ? AutomaticDispatchScheduleMode.CURRENT_TIME : scheduleMode,
            effectiveStartTime: replanDuringShift ? now : effectiveStartTime,
          },
        );
      } catch (error: any) {
        throw new BadRequestException(
          error.message || 'Không thể tạo cửa sổ thời gian điều phối',
        );
      }
      const horizonSeconds = Math.max(dayCount * 86400, serviceDays[serviceDays.length - 1].endSec);
      const windowConstraints = resolveDeliveryWindowConstraints({
        planningEpoch,
        horizonSeconds,
        confirmedAppointments: confirmations,
        changeRequestedAppointments: [
          ...batchChangeRequests.map((row) => ({ ...row, strict: true })),
          ...latestChangeRequests.map((row) => ({ ...row, strict: false })),
        ],
      });
      const activeZones = this.zonesService
        ? await this.zonesService.findActiveByBranch(branchId)
        : [];
      const optimizerOrders = this.buildOptimizerOrders(
        orders,
        planningEpoch,
        windowConstraints,
        horizonSeconds,
        activeZones,
        branch.timezone,
        activeWarehouses,
      );
      const snapshot = {
        vehicles: serviceDays.flatMap((day) =>
          baseVehicles.filter(vehicle => freeInDay(vehicle.source_vehicle_id, day, 'vehicleId')).slice(0, baseDrivers.filter(driver => freeInDay(driver.source_driver_id, day, 'driverId')).length).map((vehicle) => ({
            ...vehicle,
            id: `${vehicle.source_vehicle_id}::day:${day.serviceDayIndex}`,
            service_day_index: day.serviceDayIndex,
            available_start_sec: day.startSec,
            available_end_sec: day.endSec,
          })),
        ),
        drivers: serviceDays.flatMap((day) =>
          baseDrivers.filter(driver => freeInDay(driver.source_driver_id, day, 'driverId')).map((driver) => ({
            ...driver,
            id: `${driver.source_driver_id}::day:${day.serviceDayIndex}`,
            service_day_index: day.serviceDayIndex,
          })),
        ),
        orders: demoStacking ? optimizerOrders : splitOversizedOrdersAcrossFleet(optimizerOrders, baseVehicles),
        policy: {
          fuel_price_per_liter_vnd:
            effectiveSettings?.costPenalty.fuelPricePerLiter ?? Number(branch.fuelPricePerLiter),
          monthly_working_minutes:
            effectiveSettings?.costPenalty.monthlyWorkingMinutes ?? branch.monthlyWorkingMinutes,
          cargo_holding_cost_vnd_per_ton_hour:
            effectiveSettings?.costPenalty.cargoHoldingCostVndPerTonHour ??
            Number(branch.cargoHoldingCostVndPerTonHour),
          unassigned_order_penalty_vnd:
            effectiveSettings?.optimization.unassignedOrderPenaltyVnd ?? 1_000_000_000,
          delivery_grace_days:
            effectiveSettings?.costPenalty.deliveryGraceDays ?? branch.deliveryGraceDays,
          late_delivery_penalty_mode:
            effectiveSettings?.costPenalty.lateDeliveryPenaltyMode ?? branch.lateDeliveryPenaltyMode,
          late_delivery_penalty_value:
            effectiveSettings?.costPenalty.lateDeliveryPenaltyValue ??
            Number(branch.lateDeliveryPenaltyValue),
          ...(effectiveSettings?.optimization.maxRoutesPerDay != null
            ? { max_routes_per_day: effectiveSettings.optimization.maxRoutesPerDay }
            : {}),
          ...(drivingRestPolicy ? { driving_rest_policy: drivingRestPolicy } : {}),
        },
        planning_epoch_iso: planningEpoch.toISOString(),
        max_time_seconds: remainingSeconds,
        ...(earlyStopPatience > 0 ? { early_stop_patience: earlyStopPatience } : {}),
        ...(effectiveSettings?.optimization.hybridSeedCount
          ? { hybrid_seed_count: effectiveSettings.optimization.hybridSeedCount }
          : {}),
        ...(boundedSearchBudgetSeconds !== undefined
          ? { search_time_seconds: Math.min(remainingSeconds, boundedSearchBudgetSeconds) }
          : {}),
      };
      if (!snapshot.vehicles.length || !snapshot.drivers.length) return null;
      const vehicleCount = snapshot.vehicles.length;
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
      // Day slots at the same depot share one matrix node, including on retries.
      const depots: [number, number][] = [];
      const depotIndex = new Map<string, number>();
      const knownLocationKeys = new Set<string>();
      const nodeProvinceCodes: Array<string | null> = [];
      const indexes = snapshot.vehicles.map(({ depot }) => {
        knownLocationKeys.add(depot.id);
        if (depot.source_location_id) knownLocationKeys.add(depot.source_location_id);
        if ((depot as { warehouse_location_id?: string }).warehouse_location_id) {
          knownLocationKeys.add(
            String((depot as { warehouse_location_id?: string }).warehouse_location_id),
          );
        }
        nodeProvinceCodes.push(depot.province_code ?? null);
        const key = JSON.stringify([depot.longitude, depot.latitude]);
        const existing = depotIndex.get(key);
        if (existing !== undefined) return existing;
        const index = depots.length;
        depots.push([depot.longitude, depot.latitude]);
        depotIndex.set(key, index);
        return index;
      });
      const coordinates = [...depots];
      for (const order of snapshot.orders) {
        for (const point of [order.pickup_location, order.delivery_location]) {
          knownLocationKeys.add(point.id);
          if (point.source_location_id) knownLocationKeys.add(point.source_location_id);
          if (point.warehouse_location_id) knownLocationKeys.add(point.warehouse_location_id);
          nodeProvinceCodes.push(point.province_code ?? null);
          indexes.push(coordinates.length);
          coordinates.push([point.longitude, point.latitude]);
        }
      }
      const knownRoundedCoords = new Set(
        coordinates.map(([lng, lat]) => `${lat.toFixed(6)}:${lng.toFixed(6)}`),
      );
      const extraEndKeys = new Set<string>();
      for (const vehicle of snapshot.vehicles) {
        const endDepot = vehicle.end_depot;
        if (!endDepot) continue;
        const endKey =
          (endDepot as { warehouse_location_id?: string }).warehouse_location_id ??
          endDepot.source_location_id ??
          endDepot.id;
        const coordKey = `${endDepot.latitude.toFixed(6)}:${endDepot.longitude.toFixed(6)}`;
        if (
          !knownLocationKeys.has(endDepot.id) &&
          !knownLocationKeys.has(endKey) &&
          !knownRoundedCoords.has(coordKey) &&
          !extraEndKeys.has(endKey)
        ) {
          extraEndKeys.add(endKey);
          knownLocationKeys.add(endKey);
          knownRoundedCoords.add(coordKey);
          nodeProvinceCodes.push(endDepot.province_code ?? null);
          indexes.push(coordinates.length);
          coordinates.push([endDepot.longitude, endDepot.latitude]);
        }
      }
      const key = JSON.stringify(coordinates);
      if (cachedMatrix?.key !== key) {
        throwIfOptimizationAborted(signal);
        const matrix = signal
          ? await this.mapboxService.getRoadMatrix(coordinates, { signal })
          : await this.mapboxService.getRoadMatrix(coordinates);
        cachedMatrix = { key, matrix, queriedAt: new Date() };
      }
      const { matrix, queriedAt: matrixQueriedAt } = cachedMatrix;
      const expand = (values: number[][]) => indexes.map(i => indexes.map(j => values[i][j]));
      const fullDistances = expand(matrix.distancesMeters);
      const fullDurations = expand(matrix.durationsSeconds);
      const tollMatrixVnd = buildInterprovincialTollMatrix(
        nodeProvinceCodes,
        fullDistances,
        tollCorridors,
      );

      const payload = {
        job_id: persistedJobId ?? `request-${randomUUID()}`,
        vehicles: snapshot.vehicles,
        drivers: snapshot.drivers,
        orders: snapshot.orders,
        policy: snapshot.policy,
        demo_stacking: demoStacking,
        max_time_seconds: snapshot.max_time_seconds,
        ...(snapshot.early_stop_patience !== undefined ? { early_stop_patience: snapshot.early_stop_patience } : {}),
        ...(snapshot.hybrid_seed_count !== undefined ? { hybrid_seed_count: snapshot.hybrid_seed_count } : {}),
        ...(snapshot.search_time_seconds !== undefined
          ? { search_time_seconds: snapshot.search_time_seconds }
          : {}),
        distance_matrix_meters: fullDistances,
        duration_matrix_seconds: fullDurations,
        ...(tollMatrixVnd ? { toll_matrix_vnd: tollMatrixVnd } : {}),
      };

      if (persistedJobId) {
        const requestSnapshot = {
          ...(deliveryBatchId ? { deliveryBatchId, confirmedAppointments: confirmations.map(row => ({ id: row.id, version: row.version, orderId: row.orderId, windowStart: row.windowStart.toISOString(), windowEnd: row.windowEnd.toISOString() })) } : {}),
          branchId,
          planningEpochIso: planningEpoch.toISOString(),
          scheduleMode: scheduleMode ?? null,
          ...(effectiveStartTime ? { earliestDepartureAt: effectiveStartTime.toISOString() } : {}),
          searchBudgetSeconds: searchBudgetSeconds ?? null,
          resources: {
            orders: orders.map((order) => ({
              id: order.id,
              version: order.version,
            })),
            vehicles: candidateVehicles.map((vehicle) => ({
              id: vehicle.id,
              updatedAt: vehicle.updatedAt.toISOString(),
              vehicleTypeUpdatedAt: vehicle.vehicleTypeRecord.updatedAt.toISOString(),
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
            policyVersion: effectiveSettings?.policyVersion ?? null,
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

      throwIfOptimizationAborted(signal);
      let rankedResults;
      try {
        const response = await axios.post(
          `${this.optimizerUrl}/optimize-fleet/candidates`,
          payload,
          {
            timeout: Math.max(
              120000,
              ((snapshot.early_stop_patience
                ? snapshot.max_time_seconds
                : snapshot.search_time_seconds ?? snapshot.max_time_seconds) + 90) * 1000,
            ),
            ...(signal ? { signal } : {}),
          },
        );
        assertFleetOptimizationBatchResult(response.data);
        if (!response.data.candidates.length) return null;
        rankedResults = response.data.candidates;
        if (rankedResults.some(candidate => candidate.result.package_contract_version !== '1')) throw new Error('Optimizer chưa hỗ trợ hợp đồng Package v1');
      } catch (error: any) {
        if (isOptimizationAbortError(error, signal)) {
          throw new OptimizationCancelledError();
        }
        const detail = error.response?.data?.detail;
        const detailMsg = Array.isArray(detail)
          ? detail.map((d: any) => `${d.loc?.join('.')}: ${d.msg}`).join('; ')
          : typeof detail === 'string'
            ? detail
            : null;
        const message =
          detailMsg ||
          error.response?.data?.message ||
          error.message ||
          'Không thể nhận chuỗi nghiệm từ Optimization Engine';
        const isHttpTimeout =
          error?.code === 'ECONNABORTED' ||
          error?.code === 'ETIMEDOUT' ||
          error?.response?.status === 504 ||
          /timeout of \d+ms exceeded/i.test(String(error?.message ?? ''));
        if (isHttpTimeout) {
          throw new GatewayTimeoutException(message);
        }
        throw new ServiceUnavailableException(message);
      }

      return { rankedResults, snapshot, progressDetails };
    };

    // Grow the available shifts on the same orders and resource snapshot.
    // The worker's time budget limits search effort, not the delivery date.
    const searchDeadline = Date.now() + effectiveMaxTimeSeconds * 1000;
    const latestAppointment = [...confirmations.map(row => row.windowEnd), ...batchChangeRequests.map(row => row.requestedEnd), ...latestChangeRequests.map(row => row.requestedEnd)]
      .reduce((latest, date) => Math.max(latest, date?.getTime() ?? 0), planningEpoch.getTime());
    let dayCount = Math.max(INITIAL_PLANNING_DAYS, Math.ceil((latestAppointment - planningEpoch.getTime()) / 86_400_000) + 1);
    let attempt = await runHorizon(dayCount, effectiveMaxTimeSeconds);
    while (!attempt) {
      const remainingSeconds = Math.floor((searchDeadline - Date.now()) / 1000);
      if (remainingSeconds < 2) throw new GatewayTimeoutException('Chưa tìm được lịch giao đủ toàn bộ đơn và kiện trong thời gian tìm kiếm.');
      dayCount += INITIAL_PLANNING_DAYS;
      attempt = await runHorizon(dayCount, remainingSeconds);
    }
    const { rankedResults, snapshot, progressDetails } = attempt;
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
    const routeDetailsCache = new Map<
      string,
      ReturnType<MapboxService['getRoute']>
    >();
    const cloneRouteGeometry = <T>(geometry: T): T => {
      if (!geometry || typeof geometry !== 'object') {
        return geometry;
      }
      const record = geometry as Record<string, unknown>;
      return {
        ...record,
        ...(Array.isArray(record.coordinates)
          ? {
              coordinates: record.coordinates.map((pt) =>
                Array.isArray(pt) ? [...pt] : pt,
              ),
            }
          : {}),
        ...(Array.isArray(record.waypoint_indices)
          ? {
              waypoint_indices: [...record.waypoint_indices],
            }
          : {}),
      } as T;
    };
    const getDeduplicatedRoute = async (
      routeCoordinates: [number, number][],
    ) => {
      throwIfOptimizationAborted(signal);
      const cacheKey = routeCoordinates
        .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
        .join(';');
      let pending = routeDetailsCache.get(cacheKey);
      if (!pending) {
        pending = (
          signal
            ? this.mapboxService.getRoute(routeCoordinates, { signal })
            : this.mapboxService.getRoute(routeCoordinates)
        ).catch((err) => {
          routeDetailsCache.delete(cacheKey);
          throw err;
        });
        routeDetailsCache.set(cacheKey, pending);
      }
      const details = await pending;
      return {
        ...details,
        geometry: cloneRouteGeometry(details.geometry),
      };
    };
    const candidates: StoredOptimizationCandidate[] = [];
    for (const candidate of rankedResults) {
      const { result } = candidate;
      const pendingPickup = new Map(orders.flatMap(order => order.items.flatMap(item =>
        item.packages.map(pkg => [pkg.id, order.id] as const))));
      const pendingDelivery = new Map(pendingPickup);
      for (const route of result.routes) {
        for (const stop of route.stops) {
          const pickup = stop.stop_type === 'PICKUP';
          const pending = pickup ? pendingPickup : pendingDelivery;
          for (const id of pickup ? stop.items_loaded : stop.items_unloaded) {
            if (pending.get(id) !== stop.order_id) throw new ServiceUnavailableException('Optimizer trả kiện trùng hoặc sai đơn.');
            pending.delete(id);
          }
        }
      }
      if (pendingPickup.size || pendingDelivery.size) throw new ServiceUnavailableException('Optimizer trả phương án chưa đủ kiện.');
      await Promise.all(
        result.routes.map(async (route) => {
          const vehicle = snapshot.vehicles.find(
            (item) => item.id === route.route_id,
          );
          if (!vehicle)
            throw new Error(`Optimizer trả route_id lạ: ${route.route_id}`);
          const lastStop = route.stops[route.stops.length - 1];
          const routeEnd =
            route.end_location !== undefined
              ? route.end_location
              : vehicle.return_to_depot === false
                ? null
                : vehicle.depot;
          const shouldAppendEnd =
            Boolean(routeEnd) &&
            (!lastStop ||
              Math.abs(routeEnd!.latitude - lastStop.latitude) > 1e-6 ||
              Math.abs(routeEnd!.longitude - lastStop.longitude) > 1e-6);
          const routeCoordinates: [number, number][] = [
            [vehicle.depot.longitude, vehicle.depot.latitude],
            ...route.stops.map(
              (stop) => [stop.longitude, stop.latitude] as [number, number],
            ),
            ...(shouldAppendEnd
              ? [[routeEnd!.longitude, routeEnd!.latitude] as [number, number]]
              : []),
          ];
          const routeDetails = await getDeduplicatedRoute(routeCoordinates);
          route.depot = vehicle.depot;
          route.route_geometry = routeDetails.geometry;
        }),
      );
      const proposal: OptimizationProposal = {
        branchId,
        planningEpochIso: planningEpoch.toISOString(),
        scheduleMode: scheduleMode ?? (replanWithFleet && deliveryBatch ? AutomaticDispatchScheduleMode.NEXT_DAY : undefined),
        expiresAt,
        resources: {
          orders: orders.map((order) => ({
            id: order.id,
            version: order.version,
          })),
          vehicles: candidateVehicles.map((vehicle) => ({
            id: vehicle.id,
            updatedAt: vehicle.updatedAt.toISOString(),
            vehicleTypeUpdatedAt: vehicle.vehicleTypeRecord.updatedAt.toISOString(),
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

  async validateDeliveryPlanningCandidate(proposal: OptimizationProposal, signature: string, user: Principal, tx: Prisma.TransactionClient, ownDeliveryBatchId?: string) {
    if (Date.parse(proposal.expiresAt) <= Date.now() || !verifyOptimizationProposalSignature(proposal, signature, this.optimizationProposalSecret)) throw new ConflictException('Phương án hết hạn hoặc không có chữ ký hợp lệ; hãy chạy lại');
    await this.access.branch(user, 'trips.plan', proposal.branchId, tx);
    const orderIds = [...new Set(proposal.result.routes.flatMap(route => route.stops.map(stop => stop.order_id)))];
    const vehicleIds = [...new Set(proposal.result.routes.map(route => route.vehicle_id))];
    const driverIds = proposal.result.routes.map(route => route.driver_id).filter((id): id is string => Boolean(id));
    await this.acquireApplicationLocks(tx, vehicleIds, driverIds, orderIds, ownDeliveryBatchId);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`);
    const custodyPackageInclude = {
      custodyLocation: {
        select: {
          id: true,
          code: true,
          name: true,
          address: true,
          latitude: true,
          longitude: true,
        },
      },
    } as const;

    const [orders, vehicles, drivers, warehouses] = await Promise.all([
      tx.order.findMany({ where: { id: { in: orderIds }, branchId: proposal.branchId }, include: {
        stops: { include: { location: true } }, items: { include: { packages: { include: custodyPackageInclude } } }, packages: true,
      } }),
      tx.vehicle.findMany({ where: { id: { in: vehicleIds }, homeBranchId: proposal.branchId }, include: { vehicleTypeRecord: true } }),
      tx.driver.findMany({ where: { id: { in: driverIds }, homeBranchId: proposal.branchId } }),
      tx.location?.findMany
        ? tx.location.findMany({
            where: { active: true, type: LocationType.CENTRAL_WAREHOUSE },
            select: {
              id: true,
              latitude: true,
              longitude: true,
              provinceCode: true,
              provinceName: true,
              warehouseRole: true,
              dockingTimeSec: true,
              maxVehiclePayloadKg: true,
              maxVehicleLengthCm: true,
              hasForklift: true,
              operatingWindows: true,
              handlingSecPerTon: true,
              handlingSecPerPackage: true,
              capabilities: true,
            },
          })
        : Promise.resolve([]),
    ]);
    this.assertProposalResourcesCurrent(proposal, orders, vehicles, drivers);
    const planned = this.buildPlannedAutomaticTrips(proposal, orders, vehicles, drivers, warehouses);
    for (const trip of planned) {
      await this.access.tripInputs(user, proposal.branchId, { vehicleId: trip.vehicleId, driverId: trip.driverId, orderIds: trip.orderIds }, tx);
      await this.assertNoResourceOverlap(tx, trip, ownDeliveryBatchId);
      await this.assertOrdersNotOnActiveTrip(tx, trip.orderIds);
    }
    return planned;
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
    if (proposal.result.status !== 'SUCCESS' || proposal.result.unassigned_orders.length > 0) {
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

    const preparationMinutes =
      proposal.scheduleMode === AutomaticDispatchScheduleMode.CURRENT_TIME
        ? (typeof this.settingsService?.resolveEffectiveSettings === 'function'
            ? (await this.settingsService.resolveEffectiveSettings(branchId))?.optimization
                .dispatchPreparationMinutes
            : undefined) ?? COMPANY_SETTING_DEFAULTS.optimization.dispatchPreparationMinutes
        : undefined;

    const applied = await this.prisma.$transaction(
      async (tx) => {
        if (sourceJobId) {
          const claimedJob = await tx.optimizationJob.updateMany({
            where: {
              id: sourceJobId,
              branchId,
              status: 'SUCCEEDED',
            },
            data: { status: 'APPLYING' },
          });
          if (claimedJob.count !== 1) {
            throw new ConflictException(
              'Optimization job đang được áp dụng, đã áp dụng hoặc không còn hợp lệ',
            );
          }
        }
        const deliveryBatch = sourceJobId ? await tx.deliveryPlanningBatch.findUnique({ where: { finalOptimizationJobId: sourceJobId }, include: { appointments: true } }) : null;
        const sourceJobRecord = sourceJobId && deliveryBatch ? await tx.optimizationJob.findUnique({ where: { id: sourceJobId }, select: { parameters: true } }) : null;
        const isReplanBatchJob = Boolean(
          sourceJobRecord?.parameters &&
          typeof sourceJobRecord.parameters === 'object' &&
          !Array.isArray(sourceJobRecord.parameters) &&
          (sourceJobRecord.parameters as Record<string, unknown>).replanWithFleet === true,
        );
        if (deliveryBatch) {
          await tx.$queryRaw`SELECT id FROM delivery_planning_batches WHERE id = ${deliveryBatch.id} FOR UPDATE`;
          const recipientBatch = deliveryBatch.appointments.some(row => row.recipientPhone);
          const acknowledgedIds = deliveryBatch.appointments
            .filter(row => row.status === 'CONFIRMED' || row.status === 'CHANGE_REQUESTED')
            .map(row => row.orderId);
          const confirmedIds = deliveryBatch.appointments.filter(row => row.status === 'CONFIRMED').map(row => row.orderId);
          const declinedIds = deliveryBatch.appointments.filter(row => row.status === 'DECLINED').map(row => row.orderId);
          if (
            deliveryBatch.status !== 'OFFERING' ||
            deliveryBatch.appointments.some(row => row.status === 'PENDING') ||
            confirmedIds.some(id => !orderIds.includes(id)) ||
            declinedIds.some(id => orderIds.includes(id)) ||
            (recipientBatch &&
              (orderIds.some(id => !acknowledgedIds.includes(id)) ||
                acknowledgedIds.some(id => !orderIds.includes(id)))) ||
            (!isReplanBatchJob && confirmedIds.length !== orderIds.length)
          ) {
            throw new ConflictException('Phương án phải giao đủ và chỉ gồm các đơn đã xác nhận của đợt này');
          }
        }
        await this.acquireApplicationLocks(tx, vehicleIds, driverIds, orderIds, deliveryBatch?.id);
        await this.assertConfirmedDeliveryVisits(
          tx,
          proposal.result.routes.flatMap(route =>
            route.stops.filter(stop => stop.stop_type === 'DELIVERY').map(stop => ({
              orderId: stop.order_id,
              arrival: new Date(Date.parse(proposal.planningEpochIso) + stop.arrival_time_sec * 1000),
            })),
          ),
          deliveryBatch?.id,
        );
        await tx.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id IN (${Prisma.join(orderIds)}) ORDER BY id FOR UPDATE`);
        for (const route of proposal.result.routes) {
          await this.access.tripInputs(user, branchId, {
            vehicleId: route.vehicle_id,
            driverId: route.driver_id || undefined,
            orderIds: [...new Set(route.stops.map(stop => stop.order_id))],
            orderedStopIds: route.stops.map(stop => stop.order_stop_id),
          }, tx);
        }

        const [orders, vehicles, drivers, warehouses] = await Promise.all([
          tx.order.findMany({
            where: { id: { in: orderIds }, branchId },
            include: {
              stops: { include: { location: true } },
              items: {
                include: {
                  packages: {
                    include: {
                      custodyLocation: {
                        select: {
                          id: true,
                          code: true,
                          name: true,
                          address: true,
                          latitude: true,
                          longitude: true,
                        },
                      },
                    },
                  },
                },
              },
              packages: true,
            },
          }),
          tx.vehicle.findMany({
            where: { id: { in: vehicleIds }, homeBranchId: branchId },
            include: { vehicleTypeRecord: true },
          }),
          tx.driver.findMany({
            where: { id: { in: driverIds }, homeBranchId: branchId },
          }),
          tx.location?.findMany
            ? tx.location.findMany({
                where: { active: true, type: LocationType.CENTRAL_WAREHOUSE },
                select: {
                  id: true,
                  latitude: true,
                  longitude: true,
                  provinceCode: true,
                  provinceName: true,
                  warehouseRole: true,
                  dockingTimeSec: true,
                  maxVehiclePayloadKg: true,
                  maxVehicleLengthCm: true,
                  hasForklift: true,
                  operatingWindows: true,
                  handlingSecPerTon: true,
                  handlingSecPerPackage: true,
                },
              })
            : Promise.resolve([]),
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
          warehouses,
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
          await this.assertNoResourceOverlap(tx, trip, deliveryBatch?.id);
        }

        if (preparationMinutes !== undefined) {
          const earliest = currentDispatchEarliest(new Date(), preparationMinutes);
          if (plannedTrips.some(trip => trip.plannedStartTime < earliest)) {
            const departure = new Intl.DateTimeFormat('vi-VN', {
              timeZone: 'Asia/Ho_Chi_Minh',
              dateStyle: 'short',
              timeStyle: 'short',
            }).format(earliest);
            throw new ConflictException(
              `Lịch cần đủ thời gian chuẩn bị. Giờ xuất phát sớm nhất là ${departure} (giờ Việt Nam). Hãy chạy tối ưu lại.`,
            );
          }
        }

        if (deliveryBatch) await tx.deliveryCapacityHold.updateMany({ where: { batchId: deliveryBatch.id, status: 'HELD' }, data: { status: 'RELEASED' } });

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
        if (deliveryBatch) {
          await tx.deliveryPlanningBatch.update({ where: { id: deliveryBatch.id }, data: { status: 'APPLIED', version: { increment: 1 } } });
          const scheduledAppointments = deliveryBatch.appointments.filter(
            row => orderIds.includes(row.orderId) && (row.status === 'CONFIRMED' || row.status === 'CHANGE_REQUESTED'),
          );
          for (const appointment of scheduledAppointments) {
            const window =
              appointment.status === 'CHANGE_REQUESTED' &&
              appointment.requestedStart &&
              appointment.requestedEnd
                ? {
                    windowStart: appointment.requestedStart,
                    windowEnd: appointment.requestedEnd,
                  }
                : {};
            await tx.deliveryAppointment.update({
              where: { id: appointment.id },
              data: {
                status: 'SCHEDULED',
                version: { increment: 1 },
                ...window,
              },
            });
            await this.outbox.enqueue(
              {
                aggregateType: 'DeliveryAppointment',
                aggregateId: appointment.id,
                aggregateVersion: appointment.version + 1,
                eventType: 'DELIVERY_APPOINTMENT_UPDATED',
                payload: {
                  appointmentId: appointment.id,
                  customerId: appointment.customerId,
                },
              },
              tx,
            );
            if (appointment.recipientPhone && process.env.DELIVERY_SMS_WEBHOOK_URL) {
              await this.outbox.enqueue(
                {
                  aggregateType: 'DeliveryAppointment',
                  aggregateId: appointment.id,
                  aggregateVersion: appointment.version + 1,
                  eventType: 'DELIVERY_SMS_SCHEDULED',
                  payload: {},
                },
                tx,
              );
            }
          }
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
    const schedule = stops.map(({ orderStop, order }, index) => {
      const arrival = departure + travel(index + 1, index + 2);
      const serviceStart = Math.max(arrival, order.orderedAt.getTime());
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
      typeof vehicle.vehicleTypeUpdatedAt !== 'string' ||
      typeof driver.id !== 'string' ||
      typeof driver.updatedAt !== 'string'
    ) {
      throw new ConflictException('Planning snapshot thiếu dữ liệu tài nguyên');
    }
    return {
      orders: parsedOrders,
      vehicle: {
        id: vehicle.id,
        updatedAt: vehicle.updatedAt,
        vehicleTypeUpdatedAt: vehicle.vehicleTypeUpdatedAt,
      },
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
    vehicle: VehicleRecord & { vehicleTypeRecord: VehicleType },
    stopsWithItems: DispatchStopWithItems[],
  ) {
    const cargoByOrderId = new Map<string, ReturnType<typeof packagesToCargoUnits>>();
    for (const entry of stopsWithItems) {
      if (!cargoByOrderId.has(entry.order.id)) {
        const orderCargo = packagesToCargoUnits(
          entry.order.items,
          entry.order.customerId,
          { readyOnly: true },
        );
        cargoByOrderId.set(entry.order.id, orderCargo);
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

    const capabilities = vehicleCapabilities(vehicle);
    try {
      const response = await axios.post(
        `${this.optimizerUrl}/validate-spatial`,
        {
          vehicle: {
            id: vehicle.id,
            plate_number: vehicle.plateNumber,
            length_cm: capabilities.lengthCm,
            width_cm: capabilities.widthCm,
            height_cm: capabilities.heightCm,
            payload_limit_kg: capabilities.payloadCapacityKg,
            door_position: 'REAR',
          },
          stops,
          demo_stacking: (await this.resolveBranchStackingPolicy(vehicle.homeBranchId)).policy,
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
    vehicles: VehicleRecordWithType[],
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
      proposal.resources.vehicles.map((item) => [item.id, item]),
    );
    for (const vehicle of vehicles) {
      if (vehicle.status !== VehicleStatus.AVAILABLE) {
        throw new ConflictException(
          `Xe ${vehicle.plateNumber} không còn AVAILABLE`,
        );
      }
      const expectedVehicle = vehicleVersions.get(vehicle.id);
      if (
        expectedVehicle?.updatedAt !== vehicle.updatedAt.toISOString() ||
        expectedVehicle.vehicleTypeUpdatedAt !==
          vehicle.vehicleTypeRecord.updatedAt.toISOString()
      ) {
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
    vehicles: VehicleRecordWithType[],
    drivers: DriverRecord[],
    warehouses: readonly (LocationConstraintSource & { latitude: number; longitude: number })[] = [],
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
        new Set(
          packagesToCargoUnits(order.items, order.customerId, {
            readyOnly: true,
          }).map((item) => item.id),
        ),
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
      let previousStopLocationKey: string | null = null;

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
        const arrival = planningEpoch.getTime() + stop.arrival_time_sec * 1000;
        const isPickupStop = orderStop.type === StopType.PICKUP;
        const custodyHub = isPickupStop
          ? this.resolveOrderCustodyHubForCargo(order, cargoUnitIds)
          : null;
        const stopLocation = custodyHub
          ? (warehouses.find((w) => w.id === custodyHub.id) ??
            findMatchingWarehouseLocation(
              custodyHub.latitude,
              custodyHub.longitude,
              warehouses,
            ))
          : (orderStop.location ??
            (warehouses.length > 0
              ? findMatchingWarehouseLocation(
                  orderStop.latitude,
                  orderStop.longitude,
                  warehouses,
                )
              : null));
        const orderItemsCargo = packagesToCargoUnits(order.items, order.customerId);
        const stopCargo = orderItemsCargo.filter((unit) =>
          cargoUnitIds.includes(unit.id),
        );
        const activeStopCargo = stopCargo.length > 0 ? stopCargo : orderItemsCargo;
        const stopOrderWeightKg = activeStopCargo.reduce(
          (sum, unit) => sum + unit.weight_kg,
          0,
        );
        const { expectedSec, locationKey } = expectedWarehouseStopServiceSec({
          baseServiceSec: orderStop.serviceDurationMinutes * 60,
          location: stopLocation,
          previousLocationKey: previousStopLocationKey,
          totalWeightKg: stopOrderWeightKg,
          packageCount: activeStopCargo.length,
        });
        previousStopLocationKey = locationKey;
        const actualServiceSec = stop.departure_time_sec - stop.arrival_time_sec;
        if (
          arrival < order.orderedAt.getTime() ||
          (actualServiceSec !== orderStop.serviceDurationMinutes * 60 &&
            actualServiceSec !== expectedSec) ||
          (stop.service_time_sec !== undefined &&
            stop.service_time_sec !== actualServiceSec)
        ) {
          throw new BadRequestException('Optimizer vi phạm ngày đặt/thời lượng phục vụ đã xác nhận');
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
          hubLocationId: custodyHub?.id ?? null,
          address: custodyHub
            ? `${custodyHub.name} — ${custodyHub.address}`
            : orderStop.address,
          latitude: custodyHub ? custodyHub.latitude : orderStop.latitude,
          longitude: custodyHub ? custodyHub.longitude : orderStop.longitude,
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
            vehicleTypeUpdatedAt:
              vehicle.vehicleTypeRecord.updatedAt.toISOString(),
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
    if (proposal.resources.orders.some(order => !assignedOrderIds.has(order.id))) {
      throw new BadRequestException('Phương án chưa giao đủ toàn bộ đơn đã yêu cầu.');
    }
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

  private async assertConfirmedDeliveryVisits(tx: Prisma.TransactionClient, visits: Array<{ orderId: string; arrival: Date }>, deliveryBatchId?: string) {
    const appointments = await tx.deliveryAppointment.findMany({ where: { orderId: { in: [...new Set(visits.map(visit => visit.orderId))] }, status: { in: ['CONFIRMED','SCHEDULED'] } } });
    for (const visit of visits) for (const appointment of appointments.filter(row => row.orderId === visit.orderId)) {
      if (visit.arrival < appointment.windowStart || visit.arrival > appointment.windowEnd) throw new ConflictException('Lịch giao vi phạm khung khách đã xác nhận; không được ghi đè cam kết');
    }
    if (!deliveryBatchId && visits.length > 0 && typeof tx.deliveryAppointment?.findFirst === 'function') {
      const unfinished = await tx.deliveryAppointment.findFirst({
        where: {
          orderId: { in: [...new Set(visits.map(visit => visit.orderId))] },
          recipientPhone: { not: null },
          status: { in: ['PENDING', 'CONFIRMED', 'CHANGE_REQUESTED', 'EXPIRED'] },
          batch: { status: 'OFFERING' },
        },
      });
      if (unfinished) {
        throw new ConflictException('Hãy chốt đơn từ đợt hẹn của người nhận');
      }
    }
    if (deliveryBatchId) {
      const requested = await tx.deliveryAppointment.findMany({ where: { batchId: deliveryBatchId, orderId: { in: [...new Set(visits.map(visit => visit.orderId))] }, status: 'CHANGE_REQUESTED' } });
      for (const visit of visits) for (const appointment of requested.filter(row => row.orderId === visit.orderId && row.requestedStart && row.requestedEnd)) {
        if (appointment.requestedStart && appointment.requestedEnd && (visit.arrival < appointment.requestedStart || visit.arrival > appointment.requestedEnd)) {
          throw new ConflictException('Lịch giao vi phạm khung giờ khách yêu cầu đổi');
        }
      }
    }
  }

  private async acquireApplicationLocks(
    tx: Prisma.TransactionClient,
    vehicleIds: string[],
    driverIds: string[],
    orderIds: string[],
    ownDeliveryBatchId?: string,
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
    await assertNoDeliveryOrderHold(tx, orderIds, ownDeliveryBatchId);
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
    ownDeliveryBatchId?: string,
  ): Promise<void> {
    await assertNoDeliveryResourceHold(tx, { vehicleId: plannedTrip.vehicleId, driverId: plannedTrip.driverId, startsAt: plannedTrip.plannedStartTime, endsAt: plannedTrip.plannedEndTime }, ownDeliveryBatchId);
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

    const activeWorkPolicies = tx.workPolicy?.findMany
      ? await tx.workPolicy.findMany({
          where: { jurisdiction: 'VN' },
          orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
          take: 5,
        })
      : [];
    const activePolicy = activeWorkPolicies.find(
      (policy) =>
        policy.effectiveFrom <= plannedTrip.plannedStartTime &&
        (!policy.effectiveTo || policy.effectiveTo >= plannedTrip.plannedStartTime),
    );
    const parsedRestPolicy = activePolicy
      ? parseWorkPolicyToDrivingRest(activePolicy)
      : activeWorkPolicies.length === 0
        ? DEFAULT_VN_2024_DRIVING_REST_POLICY
        : null;
    const minInterTripRestMs =
      parsedRestPolicy?.enabled && parsedRestPolicy.min_inter_trip_rest_sec > 0
        ? parsedRestPolicy.min_inter_trip_rest_sec * 1000
        : 0;
    const driverStartWithRest = new Date(
      plannedTrip.plannedStartTime.getTime() - minInterTripRestMs,
    );
    const driverEndWithRest = new Date(
      plannedTrip.plannedEndTime.getTime() + minInterTripRestMs,
    );
    const driverOverlap = await tx.driverAssignment.findFirst({
      where: {
        driverId: plannedTrip.driverId,
        trip: { status: { in: ACTIVE_TRIP_STATUSES } },
        startTime: { lt: driverEndWithRest },
        endTime: { gt: driverStartWithRest },
      },
      include: { trip: { select: { tripNumber: true } } },
    });
    if (driverOverlap) {
      throw new ConflictException(
        minInterTripRestMs > 0
          ? `Tài xế trùng lịch hoặc chưa đủ thời gian nghỉ bắt buộc giữa các chuyến với ${driverOverlap.trip.tripNumber}`
          : `Tài xế đã có lịch chạy chuyến ${driverOverlap.trip.tripNumber} trong thời gian này`,
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
      include: {
        stops: true,
        items: { include: { packages: true } },
        packages: true,
      },
    });
    const allocationIdByPackageId = new Map<string, string>();
    for (const order of orders) {
      assertDispatchableOrder(order);
      for (const item of order.items) {
        for (const pkg of item.packages.filter((pkg) => plannedTrip.cargoUnitIds.includes(pkg.id))) {
          const allocation = await tx.allocation.create({
            data: {
              tripId: trip.id,
              orderItemId: item.id,
              packageId: pkg.id,
              allocatedQuantity: 1,
              status: 'ACTIVE',
            },
          });
          allocationIdByPackageId.set(pkg.id, allocation.id);
        }
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
          hubLocationId: stop.hubLocationId ?? null,
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
    const vehicle = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      include: { vehicleTypeRecord: true },
    });
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
    const packageByCargoId = new Map([...resolvedPackageIdByCargoUnit].flatMap(([cargoId, packageId]) => {
      const pkg = physicalPackageById.get(packageId);
      return pkg ? [[cargoId, pkg] as const] : [];
    }));
    const customerByPackageId = new Map(orders.flatMap(order => order.items.flatMap(item => item.packages.map(pkg => [pkg.id, order.customerId] as const))));
    const hasStackedCargo = spatialValidation.step_states.some(state => state.placed_items.some(item => (item.z ?? 0) > 0));
    const stackingPolicy = (await this.resolveBranchStackingPolicy(vehicle.homeBranchId, tx)).policy;
    if (hasStackedCargo && !matchesDemoStackingPolicy(stackingPolicy, spatialValidation.demo_stacking)) {
      throw new ConflictException('Cấu hình nâng kiện đã đổi. Hãy chạy lại phương án xếp chồng');
    }
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
          lengthMm: this.cmToMm(vehicle.vehicleTypeRecord.lengthCm),
          widthMm: this.cmToMm(vehicle.vehicleTypeRecord.widthCm),
          heightMm: this.cmToMm(vehicle.vehicleTypeRecord.heightCm),
          doorPosition: 'REAR',
          ...(hasStackedCargo ? { demoStackingPolicy: stackingPolicy } : {}),
          spatialValidation,
        } as unknown as Prisma.InputJsonValue,
        validationStatus: 'VALID',
        validatorVersion: hasStackedCargo ? 'spatial-demo-stacking-v1' : 'spatial-validator-v1',
        inputHash,
      },
    });

    const tasks = await tx.stopTask.findMany({ where: { tripStop: { tripId } }, select: { id: true, orderStopId: true } });
    for (const state of spatialValidation.step_states) {
      assertDemoStackSupports(state.placed_items, packageByCargoId, customerByPackageId, this.cmToMm(vehicle.vehicleTypeRecord.heightCm), stackingPolicy);
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
              const placedLengthMm = this.cmToMm(placed.length_cm);
              const placedWidthMm = this.cmToMm(placed.width_cm);
              const placedHeightMm = this.cmToMm(placed.height_cm);
              const alignedMatch = Boolean(
                physicalPackage &&
                  physicalPackage.lengthMm === placedLengthMm &&
                  physicalPackage.widthMm === placedWidthMm,
              );
              const rotatedMatch = Boolean(
                physicalPackage &&
                  physicalPackage.lengthMm === placedWidthMm &&
                  physicalPackage.widthMm === placedLengthMm,
              );
              if (
                !physicalPackage ||
                (!alignedMatch && !rotatedMatch) ||
                physicalPackage.heightMm !== placedHeightMm ||
                physicalPackage.weightG !==
                  BigInt(Math.round(placed.weight_kg * 1000))
              ) {
                throw new ConflictException(
                  `Package của cargo unit ${placed.item_id} đã thay đổi sau khi tối ưu`,
                );
              }
              if (isFloorRotationLocked(physicalPackage.allowedOrientations) && !alignedMatch) {
                throw new ConflictException(
                  `Kiện ${placed.item_id} bị khóa xoay 90 độ (LWH) nhưng kết quả bố trí đã xoay hướng`,
                );
              }
              return {
                packageId,
                xMm: this.cmToMm(placed.x),
                yMm: this.cmToMm(placed.y),
                zMm: this.cmToMm(placed.z ?? 0),
                orientation: alignedMatch ? 'ALIGNED_0' : 'ROTATED_90',
                effectiveLengthMm: placedLengthMm,
                effectiveWidthMm: placedWidthMm,
                effectiveHeightMm: placedHeightMm,
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
      where: { id: { in: orders.map((order) => order.id) } },
      include: { stops: true, items: { include: { packages: true } }, packages: true },
    });
    const requestedIds = new Set(
      orders.flatMap((order) => order.items.flatMap((item) => item.packages.map((pkg) => pkg.id))),
    );
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

  private isOrderEligibleForAutomaticOptimization(
    order: OrderWithStopsAndItems,
  ): boolean {
    if (order.packageDataStatus !== 'COMPLETE' || order.items.length === 0) {
      return false;
    }
    const packages = order.items.flatMap((item) => item.packages);
    return (
      order.items.every(
        (item) =>
          item.packages.length > 0 &&
          item.packages.every(
            (pkg) =>
              pkg.status === PackageStatus.READY ||
              pkg.status === PackageStatus.DELIVERED,
          ),
      ) && packages.some((pkg) => pkg.status === PackageStatus.READY)
    );
  }

  private resolveOrderCustodyHubForCargo(
    order: OrderWithStopsAndItems,
    cargoUnitIds?: string[],
  ): CustodyLocationSummary | null {
    const idFilter = cargoUnitIds ? new Set(cargoUnitIds) : null;
    for (const item of order.items) {
      for (const pkg of item.packages) {
        if (idFilter && !idFilter.has(pkg.id)) continue;
        if (pkg.custodyLocation) {
          return pkg.custodyLocation;
        }
      }
    }
    return null;
  }

  async detachUnpickedOrders(
    tripId: string,
    dto: { orderIds: string[]; expectedVersion: number; reason?: string },
    user: Principal,
  ) {
    const now = new Date();
    const orderIds = [...new Set(dto.orderIds)];
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trips WHERE id = ${tripId} FOR UPDATE`;
      const trip = await tx.trip.findUnique({
        where: { id: tripId },
        include: {
          stops: {
            include: {
              tasks: {
                include: {
                  allocation: {
                    include: {
                      package: { select: { id: true, status: true } },
                      orderItem: { select: { orderId: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!trip) {
        throw new NotFoundException(`Không tìm thấy chuyến đi [${tripId}]`);
      }
      if (trip.managingBranchId) {
        resolveBranchScope(user, trip.managingBranchId);
      }
      if (trip.version !== dto.expectedVersion) {
        throw new ConflictException(
          'Phiên bản chuyến đã thay đổi; hãy tải lại trước khi tách đơn.',
        );
      }
      if (
        trip.status !== TripStatus.IN_PROGRESS &&
        trip.status !== TripStatus.DISPATCHED
      ) {
        throw new ConflictException(
          'Chỉ tách đơn chưa lấy trên chuyến đang điều phối hoặc đang chạy.',
        );
      }

      const targetAllocs = await tx.allocation.findMany({
        where: {
          tripId,
          releasedAt: null,
          orderItem: { orderId: { in: orderIds } },
        },
        include: {
          package: { select: { id: true, status: true } },
          orderItem: { select: { orderId: true } },
        },
      });
      if (targetAllocs.length === 0) {
        throw new ConflictException(
          'Không tìm thấy phân bổ đang hoạt động cho các đơn được chọn.',
        );
      }
      const alreadyLoaded = targetAllocs.filter(
        (a) => a.package && a.package.status !== PackageStatus.ALLOCATED,
      );
      if (alreadyLoaded.length > 0) {
        throw new ConflictException({
          code: 'CANNOT_DETACH_LOADED_CARGO',
          message:
            'Không thể tách đơn đã bốc lên xe; hàng đã lấy phải chở về kho hoặc giao nốt.',
        });
      }

      const allocIds = targetAllocs.map((a) => a.id);
      const packageIds = targetAllocs
        .map((a) => a.packageId)
        .filter((pid): pid is string => Boolean(pid));

      await tx.allocation.updateMany({
        where: { id: { in: allocIds } },
        data: { status: 'RELEASED', releasedAt: now },
      });
      if (packageIds.length > 0) {
        await tx.package.updateMany({
          where: { id: { in: packageIds } },
          data: { status: PackageStatus.READY },
        });
      }

      for (const stop of trip.stops) {
        const belongs = stop.tasks.some((t) => {
          const oid = t.orderId ?? t.allocation?.orderItem.orderId;
          return oid ? orderIds.includes(oid) : false;
        });
        if (belongs && stop.status === 'PENDING') {
          await tx.tripStop.update({
            where: { id: stop.id },
            data: {
              status: 'SKIPPED',
              skipReason: 'DISPATCHER_DETACHED_TO_FREE_VEHICLE',
            },
          });
        }
      }

      for (const orderId of orderIds) {
        const orderRow = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            status: true,
            items: {
              select: {
                packages: {
                  select: {
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
        if (!orderRow) continue;
        const pkgs = orderRow.items.flatMap((i) => i.packages);
        const stillAllocated = pkgs.some(
          (p) =>
            p.status === PackageStatus.LOADED ||
            p.status === PackageStatus.ALLOCATED ||
            p.allocations.length > 0,
        );
        if (!stillAllocated && pkgs.some((p) => p.status === PackageStatus.READY)) {
          await tx.order.update({
            where: { id: orderId },
            data: { status: OrderStatus.CONFIRMED },
          });
          await tx.orderEvent.create({
            data: {
              orderId,
              eventType: 'ORDER_DETACHED_FOR_FREE_VEHICLE',
              fromStatus: orderRow.status,
              toStatus: OrderStatus.CONFIRMED,
              actorUserId: user.id,
              commandId: `detach:${tripId}:${orderId}:${now.getTime()}`,
              payload: {
                tripId,
                reason:
                  dto.reason?.trim() ||
                  'Điều phối viên tách đơn chưa lấy để bố trí xe rảnh',
              },
            },
          });
        }
      }

      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data: { version: { increment: 1 } },
        select: { id: true, version: true, status: true },
      });
      await this.outbox.enqueue(
        {
          aggregateType: 'Trip',
          aggregateId: trip.id,
          aggregateVersion: updatedTrip.version,
          eventType: 'TRIP_PLAN_UPDATED',
          payload: { tripId: trip.id, detachedOrderIds: orderIds },
        },
        tx,
      );
      return {
        tripId: trip.id,
        tripVersion: updatedTrip.version,
        detachedOrderIds: orderIds,
      };
    });
  }

  private buildOptimizerOrders(
    orders: OrderWithStopsAndItems[],
    planningEpoch: Date,
    confirmedWindows = new Map<string, DeliveryWindowConstraint>(),
    horizonSeconds = INITIAL_PLANNING_DAYS * 86400,
    restrictionZones: readonly ZoneCurfewRecord[] = [],
    timeZone = 'Asia/Ho_Chi_Minh',
    warehouses: readonly (LocationConstraintSource & { latitude: number; longitude: number })[] = [],
  ) {
    // A negative offset preserves the waiting time before this planning day.
    const orderedSeconds = (value: Date) => Math.floor((value.getTime() - planningEpoch.getTime()) / 1000);
    const totalDays = Math.max(1, Math.ceil(horizonSeconds / 86400));

    return orders.flatMap((order) => {
      assertDispatchableOrder(order);
      if (order.status !== 'CONFIRMED') throw new ConflictException('Chỉ tối ưu đơn đã xác nhận');
      const commitment = confirmedWindows.get(order.id);
      const deliveryStart = commitment ? Math.max(0, Math.ceil((commitment.windowStart.getTime() - planningEpoch.getTime()) / 1000)) : Math.max(0, Math.ceil((order.orderedAt.getTime() - planningEpoch.getTime()) / 1000));
      const deliveryEnd = commitment ? Math.min(horizonSeconds, Math.floor((commitment.windowEnd.getTime() - planningEpoch.getTime()) / 1000)) : horizonSeconds;
      if (deliveryEnd < deliveryStart) {
        throw new ConflictException(
          commitment?.kind === 'CHANGE_REQUESTED'
            ? 'Khung giờ khách yêu cầu đổi nằm ngoài lịch đang lập; hãy kiểm tra lại thời gian yêu cầu'
            : 'Khung giao khách đã xác nhận nằm ngoài lịch đang lập; không được tự dời cam kết',
        );
      }

      const pickup = order.stops.find((stop) => stop.type === StopType.PICKUP);
      const delivery = order.stops.find(
        (stop) => stop.type === StopType.DELIVERY,
      );
      if (!pickup || !delivery) {
        throw new BadRequestException(
          `Đơn ${order.orderNumber} thiếu pickup hoặc delivery`,
        );
      }
      const pickupLocationSource =
        pickup.location ??
        (warehouses.length > 0
          ? findMatchingWarehouseLocation(pickup.latitude, pickup.longitude, warehouses)
          : null);
      const deliveryLocationSource =
        delivery.location ??
        (warehouses.length > 0
          ? findMatchingWarehouseLocation(delivery.latitude, delivery.longitude, warehouses)
          : null);
      let readyCargo: ReturnType<typeof packagesToCargoUnits>;
      try {
        readyCargo = packagesToCargoUnits(order.items, order.customerId, {
          readyOnly: true,
        });
      } catch (error: any) {
        throw new BadRequestException(error.message);
      }
      if (readyCargo.length === 0) {
        throw new BadRequestException(
          `Đơn ${order.orderNumber} không còn kiện READY để tối ưu`,
        );
      }

      const packageById = new Map(
        order.items.flatMap((item) => item.packages.map((p) => [p.id, p])),
      );
      const grouped = new Map<
        string,
        {
          hub: CustodyLocationSummary | null;
          items: typeof readyCargo;
          latestReturnedAtMs: number;
        }
      >();
      for (const unit of readyCargo) {
        const pkg = packageById.get(unit.id);
        const hub = pkg?.custodyLocation ?? null;
        const key = hub ? `hub:${hub.id}` : 'ORIGINAL_PICKUP';
        const bucket = grouped.get(key) ?? {
          hub,
          items: [],
          latestReturnedAtMs: 0,
        };
        bucket.items.push(unit);
        if (pkg?.returnedToHubAt) {
          bucket.latestReturnedAtMs = Math.max(
            bucket.latestReturnedAtMs,
            pkg.returnedToHubAt.getTime(),
          );
        }
        grouped.set(key, bucket);
      }

      const dCurfews =
        restrictionZones.length > 0
          ? expandZoneCurfewsRelativeToEpoch(
              restrictionZones,
              delivery.latitude,
              delivery.longitude,
              planningEpoch,
              totalDays,
              timeZone,
            )
          : [];

      const entries = [...grouped.entries()];
      return entries.map(([groupKey, bucket]) => {
        const optimizerOrderId =
          entries.length === 1 ? order.id : `${order.id}::${groupKey}`;
        const hub = bucket.hub;
        const hubWarehouseSource = hub
          ? (warehouses.find((w) => w.id === hub.id) ??
            findMatchingWarehouseLocation(hub.latitude, hub.longitude, warehouses))
          : null;
        const effectivePickupSource = hub ? hubWarehouseSource : pickupLocationSource;
        const pickupWarehouseId =
          effectivePickupSource?.id ?? (hub ? undefined : pickup.locationId ?? undefined);
        const pickupLocation = hub
          ? {
              id: `hub:${hub.id}:${order.id}`,
              source_location_id: pickup.id,
              ...(pickupWarehouseId ? { warehouse_location_id: pickupWarehouseId } : {}),
              name: `${hub.name} — ${hub.address}`,
              latitude: hub.latitude,
              longitude: hub.longitude,
              ...extractLocationConstraintFields(effectivePickupSource),
            }
          : {
              id: pickup.id,
              source_location_id: pickup.id,
              ...(pickupWarehouseId ? { warehouse_location_id: pickupWarehouseId } : {}),
              name: pickup.address,
              latitude: pickup.latitude,
              longitude: pickup.longitude,
              ...extractLocationConstraintFields(pickupLocationSource),
            };
        const readyBaseMs = hub
          ? Math.max(order.orderedAt.getTime(), bucket.latestReturnedAtMs)
          : order.orderedAt.getTime();
        const pCurfews =
          restrictionZones.length > 0
            ? expandZoneCurfewsRelativeToEpoch(
                restrictionZones,
                pickupLocation.latitude,
                pickupLocation.longitude,
                planningEpoch,
                totalDays,
                timeZone,
              )
            : [];

        const deliveryWarehouseId =
          deliveryLocationSource?.id ?? delivery.locationId ?? undefined;
        return {
          id: optimizerOrderId,
          ...(entries.length > 1 || hub
            ? {
                source_order_id: order.id,
                source_order_number: order.orderNumber,
              }
            : {}),
          order_number:
            entries.length === 1
              ? order.orderNumber
              : `${order.orderNumber} (${hub?.code ?? 'GỐC'})`,
          pickup_location: pickupLocation,
          delivery_location: {
            id: delivery.id,
            source_location_id: delivery.id,
            ...(deliveryWarehouseId ? { warehouse_location_id: deliveryWarehouseId } : {}),
            name: delivery.address,
            latitude: delivery.latitude,
            longitude: delivery.longitude,
            ...extractLocationConstraintFields(deliveryLocationSource),
          },
          items: bucket.items,
          pickup_window_start_sec: Math.max(
            0,
            Math.ceil((readyBaseMs - planningEpoch.getTime()) / 1000),
          ),
          pickup_window_end_sec: horizonSeconds,
          delivery_window_start_sec: deliveryStart,
          delivery_window_end_sec: deliveryEnd,
          pickup_service_time_sec: pickup.serviceDurationMinutes * 60,
          delivery_service_time_sec: delivery.serviceDurationMinutes * 60,
          ...(pCurfews.length > 0 ? { pickup_curfew_windows: pCurfews } : {}),
          ...(dCurfews.length > 0 ? { delivery_curfew_windows: dCurfews } : {}),
          time_window_basis: 'SERVICE_START' as const,
          package_contract_version: '1' as const,
          ordered_at_sec: orderedSeconds(order.orderedAt),
          order_value_vnd: Math.round(Number(order.totalAmount)),
          service_time_sec:
            Math.max(
              pickup.serviceDurationMinutes,
              delivery.serviceDurationMinutes,
            ) * 60,
        };
      });
    });
  }

  async getDemoCases() {
    try {
      const res = await axios.get(`${this.optimizerUrl}/demo/cases`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `Không thể kết nối tới Optimizer Service để lấy danh sách demo: ${err.message}`,
      );
    }
  }

  async getDemoCasePayload(caseId: string) {
    try {
      const res = await axios.get(`${this.optimizerUrl}/demo/cases/${caseId}`, { timeout: 10000 });
      return res.data;
    } catch (err: any) {
      throw new ServiceUnavailableException(
        `Không thể nạp dữ liệu kịch bản demo ${caseId}: ${err.message}`,
      );
    }
  }

  async runDemoOptimization(dto: RunDemoOptimizationDto) {
    if (!dto.caseId && !dto.customRequest) {
      throw new BadRequestException('Cần cung cấp caseId hoặc customRequest để chạy demo');
    }
    const effectiveSettings = this.settingsService
      ? await this.settingsService.resolveEffectiveSettings(dto.branchId ?? null)
      : null;
    const allowDemoOverride = effectiveSettings?.optimization.demoAllowOverride ?? true;
    const demoStackingEnabled = allowDemoOverride
      ? (dto.demoStackingEnabled ?? effectiveSettings?.stacking.enabled)
      : effectiveSettings?.stacking.enabled;
    const demoStackingOwnerMode = allowDemoOverride
      ? (dto.demoStackingOwnerMode ?? effectiveSettings?.stacking.ownerMode)
      : effectiveSettings?.stacking.ownerMode;
    const maxTimeSeconds = effectiveSettings?.optimization.maxTimeSeconds ?? 240;
    const resolvedBudget =
      dto.timeBudgetSeconds ??
      effectiveSettings?.optimization.defaultSearchBudgetSeconds ??
      60;
    const earlyStopPatience = effectiveSettings?.optimization.earlyStopPatience ?? 0;
    const timeBudgetSeconds = allowDemoOverride && dto.timeBudgetSeconds !== undefined
      ? resolvedBudget
      : Math.min(resolvedBudget, maxTimeSeconds);
    const timeoutMs = Math.max(
      60000,
      ((earlyStopPatience > 0 ? maxTimeSeconds : timeBudgetSeconds) + 90) * 1000,
    );
    const policyOverrides = effectiveSettings
      ? {
          fuel_price_per_liter_vnd: effectiveSettings.costPenalty.fuelPricePerLiter,
          monthly_working_minutes: effectiveSettings.costPenalty.monthlyWorkingMinutes,
          cargo_holding_cost_vnd_per_ton_hour:
            effectiveSettings.costPenalty.cargoHoldingCostVndPerTonHour,
          unassigned_order_penalty_vnd: effectiveSettings.optimization.unassignedOrderPenaltyVnd,
          delivery_grace_days: effectiveSettings.costPenalty.deliveryGraceDays,
          late_delivery_penalty_mode: effectiveSettings.costPenalty.lateDeliveryPenaltyMode,
          late_delivery_penalty_value: effectiveSettings.costPenalty.lateDeliveryPenaltyValue,
          ...(effectiveSettings.optimization.maxRoutesPerDay != null
            ? { max_routes_per_day: effectiveSettings.optimization.maxRoutesPerDay }
            : {}),
        }
      : undefined;
    try {
      const res = await axios.post(
        `${this.optimizerUrl}/demo/run`,
        {
          case_id: dto.caseId,
          demo_stacking_enabled: demoStackingEnabled,
          demo_stacking_owner_mode: demoStackingOwnerMode,
          ...(effectiveSettings?.stacking.maxTiers != null
            ? { demo_stacking_max_tiers: effectiveSettings.stacking.maxTiers }
            : {}),
          ...(effectiveSettings?.stacking.liftClearanceMm != null
            ? { demo_stacking_lift_clearance_cm: effectiveSettings.stacking.liftClearanceMm / 10 }
            : {}),
          ...(effectiveSettings?.stacking.maxTopLoadPercent != null
            ? { demo_stacking_max_top_load_percent: effectiveSettings.stacking.maxTopLoadPercent }
            : {}),
          time_budget_seconds: timeBudgetSeconds,
          ...(effectiveSettings ? { max_time_seconds: maxTimeSeconds } : {}),
          ...(earlyStopPatience > 0 ? { early_stop_patience: earlyStopPatience } : {}),
          hybrid_seed_count: effectiveSettings?.optimization.hybridSeedCount ?? 0,
          ...(policyOverrides ? { policy_overrides: policyOverrides } : {}),
          custom_request: dto.customRequest,
        },
        { timeout: timeoutMs },
      );
      const batch = res.data;
      assertFleetOptimizationBatchResult(batch);

      // Thẩm định và sinh route_geometry thực tế (Mapbox Directions API) cho từng tuyến xe
      const routeGeometryCache = new Map<string, any>();
      for (const candidate of batch.candidates || []) {
        if (!candidate.result?.routes) continue;
        await Promise.all(
          candidate.result.routes.map(async (route: any) => {
            const waypoints: [number, number][] = [];
            if (route.depot) {
              waypoints.push([route.depot.longitude, route.depot.latitude]);
            }
            (route.stops || []).forEach((stop: any) => {
              waypoints.push([stop.longitude, stop.latitude]);
            });
            const endPoint = route.end_location ?? route.depot;
            if (endPoint) {
              const last = waypoints[waypoints.length - 1];
              if (!last || last[0] !== endPoint.longitude || last[1] !== endPoint.latitude) {
                waypoints.push([endPoint.longitude, endPoint.latitude]);
              }
            }

            if (waypoints.length >= 2) {
              const cacheKey = JSON.stringify(waypoints);
              try {
                if (process.env.MAPBOX_ACCESS_TOKEN) {
                  let geometry = routeGeometryCache.get(cacheKey);
                  if (!geometry) {
                    const routeDetails = await this.mapboxService.getRoute(waypoints);
                    geometry = routeDetails?.geometry;
                    if (geometry) {
                      routeGeometryCache.set(cacheKey, geometry);
                    }
                  }
                  if (geometry) {
                    route.route_geometry = geometry;
                  }
                }
              } catch (mapErr: any) {
                this.logger.warn(
                  `Không lấy được Mapbox Directions cho demo (${dto.caseId || 'custom'}): ${mapErr?.message || mapErr}`,
                );
              }
              if (!route.route_geometry) {
                route.route_geometry = {
                  type: 'LineString',
                  coordinates: waypoints,
                };
              }
            }
          }),
        );
      }

      const candidates = (batch.candidates || []).map((c: any, index: number) => {
        const costBreakdown = extractCandidateCostBreakdown(c.result);
        return {
          candidateNumber: index + 1,
          rank: c.rank ?? index + 1,
          searchStrategy: c.search_strategy || `Phương án ${index + 1}`,
          improvementSequence: index + 1,
          solverObjective:
            c.result?.planning_objective?.selection_score_vnd ??
            c.solver_objective ??
            0,
          planningSpanDays: c.result?.planning_objective?.planning_span_days ?? 1,
          driverCalendarSalaryVnd:
            c.result?.planning_objective?.driver_calendar_salary_vnd ?? 0,
          driverIdleSalaryAllocationVnd:
            c.result?.planning_objective?.driver_idle_salary_allocation_vnd ?? 0,
          operationalLatePenaltyVnd:
            c.result?.planning_objective?.operational_late_penalty_vnd ?? 0,
          physicalVehicleCount:
            c.result?.planning_objective?.physical_vehicle_count ??
            c.result?.routes?.length ??
            0,
          activeRouteCount:
            c.result?.planning_objective?.active_route_count ??
            c.result?.routes?.length ??
            0,
          isBestFound: c.is_best_found ?? (index === 0),
          feasibilityStatus: c.result?.status ?? 'SUCCESS',
          totalCostVnd: c.result?.total_cost_vnd ?? 0,
          totalDistanceKm: c.result?.total_distance_km ?? 0,
          totalDurationMinutes: c.result?.total_duration_minutes ?? 0,
          routeCount: c.result?.routes?.length ?? 0,
          unassignedOrderCount: c.result?.unassigned_orders?.length ?? 0,
          ...(costBreakdown ? { costBreakdown } : {}),
        };
      });

      const candidateResults: Record<number, any> = {};
      (batch.candidates || []).forEach((c: any, idx: number) => {
        candidateResults[idx + 1] = c.result;
      });

      const demoJobId = `demo-${dto.caseId || 'custom'}-${Date.now()}`;
      const bestCandidate = batch.candidates?.[0]?.result ?? null;

      return {
        id: demoJobId,
        branchId: 'demo-branch',
        status: bestCandidate?.status === 'SUCCESS' ? 'SUCCEEDED' : (bestCandidate?.status || 'TIMEOUT'),
        schemaVersion: '1.0',
        planningEpochIso: new Date().toISOString(),
        scheduleMode: 'CURRENT_TIME',
        searchBudgetSeconds: timeBudgetSeconds,
        progress: null,
        result: bestCandidate,
        candidates,
        candidateResults,
        error: bestCandidate ? null : { code: "NO_COMPLETE_PLAN", message: "Chưa tìm được lịch giao đủ toàn bộ đơn và kiện." },
        attemptCount: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isDemo: true,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new ServiceUnavailableException(
        `Không thể thực thi tối ưu demo: ${err.response?.data?.detail || err.message}`,
      );
    }
  }
}
