import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import axios from "axios";
import { createHash, randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MapboxService } from "../mapbox/mapbox.service";
import { CreateTripDto } from "./dto/create-trip.dto";
import { TripsValidator, StopWithItems } from "./trips.validator";
import {
  DriverStatus,
  Driver as DriverRecord,
  LoadValidationStatus,
  OrderStatus,
  PackageStatus,
  Prisma,
  Role,
  StopType,
  TaskAction,
  TripStatus,
  VehicleStatus,
  Vehicle as VehicleRecord,
} from "@prisma/client";
import { OptimizeTripDto } from "./dto/optimize-trip.dto";
import { expandOrderItemsToCargoUnits } from "./optimizer-payload";
import {
  assertFleetOptimizationResult,
  OptimizedRouteResult,
} from "./optimizer-contract";
import { resolveBranchScope } from "../auth/branch-scope";
import { ApplyAutomaticOptimizationDto } from "./dto/apply-automatic-optimization.dto";
import {
  assertOptimizationProposal,
  OptimizationProposal,
  signOptimizationProposal,
  verifyOptimizationProposalSignature,
} from "./optimization-proposal";
import {
  AutomaticDispatchScheduleMode,
  RunAutomaticOptimizationDto,
} from "./dto/run-automatic-optimization.dto";
import {
  buildServiceDayWindows,
  getFullServiceDayPlanningEpoch,
  getNextDayPlanningEpoch,
  getPlanningEpoch,
  ServiceDayWindow,
} from "./service-day";
import { OutboxService } from '../common/services/outbox.service';
import { PublishTripDto } from './dto/publish-trip.dto';

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

type OrderWithStopsAndItems = Prisma.OrderGetPayload<{
  include: { stops: true; items: true };
}>;

type DispatchStopWithItems = {
  orderStop: OrderWithStopsAndItems['stops'][number];
  order: OrderWithStopsAndItems;
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
  stops: Array<{
    orderId: string;
    orderStopId: string;
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

@Injectable()
export class TripsService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
    private outbox: OutboxService,
  ) {}

  async findAll(
    status?: TripStatus,
    user?: { branchId?: string; role: Role },
  ) {
    return this.prisma.trip.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(user && user.role !== Role.ADMIN
          ? {
              OR: [
                { managingBranchId: user.branchId },
                { managingBranchId: null, vehicle: { homeBranchId: user.branchId } },
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
          orderBy: { sequence: "asc" },
          include: { tasks: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: {
        vehicle: { include: { homeBranch: true } },
        assignments: { include: { driver: true } },
        stops: {
          orderBy: { sequence: "asc" },
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

  async findOneAuthorized(
    id: string,
    user: { branchId?: string; role: Role },
  ) {
    const trip = await this.findOne(id);
    this.assertTripAccess(trip, user);
    return trip;
  }

  async getLoadPlan(
    tripId: string,
    user: { branchId?: string; role: Role },
  ) {
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
      throw new NotFoundException(`Chuyến ${trip.tripNumber} chưa có Load Plan`);
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
      if (existingCommand.status === 'COMPLETED' && typeof result?.tripId === 'string') {
        return this.findOne(result.tripId);
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
      include: { homeBranch: true },
    });
    if (!vehicle) {
      throw new NotFoundException(`Không tìm thấy xe [${dto.vehicleId}]`);
    }

    resolveBranchScope(user, vehicle.homeBranchId);

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
        stops: { orderBy: { sequence: "asc" } },
        items: true,
      },
    });

    if (orders.length !== dto.orderIds.length) {
      throw new BadRequestException(
        "Một số đơn hàng không tồn tại trong hệ thống",
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
    // Điểm bắt đầu là Chi nhánh quản lý xe (Home Branch Depot)
    const routeCoords: [number, number][] = [
      [
        vehicle.currentLongitude ?? vehicle.homeBranch.longitude,
        vehicle.currentLatitude ?? vehicle.homeBranch.latitude,
      ],
      ...stopWithItemsList.map(
        (s) =>
          [s.orderStop.longitude, s.orderStop.latitude] as [number, number],
      ),
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
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`${user.id}:CREATE_TRIP:${dto.idempotencyKey}`})::int4)`;
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
      const [currentVehicle, currentDriver, lockedVehicleOverlap, lockedDriverOverlap] =
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
      if (!currentVehicle || !currentDriver) {
        throw new ConflictException(
          'Xe hoặc tài xế không còn khả dụng trong chi nhánh',
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
          notes: dto.notes,
        },
      });
      const stopTaskIdByOrderStopId = new Map<string, string>();

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
            sequence: i + 1,
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
          role: "PRIMARY",
        },
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

  /**
   * Phát hành chuyến đi (Publish Trip)
   */
  async publish(
    id: string,
    dto: PublishTripDto,
    user: { id: string; branchId?: string; role: Role },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_COMMAND}::int4, hashtext(${`PUBLISH_TRIP:${id}`})::int4)`;
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

      const loadPlan = await tx.loadPlan.findFirst({
        where: { tripId: id },
        orderBy: { revision: 'desc' },
        include: { steps: { select: { stopTaskId: true } } },
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
  async getLoadProfile(
    id: string,
    user?: { branchId?: string; role: Role },
  ) {
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
        "Danh sách orderIds không được chứa ID trùng",
      );
    }
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: body.vehicleId },
      include: { homeBranch: true },
    });
    if (!vehicle) {
      throw new NotFoundException("Không tìm thấy xe");
    }

    const orders = await this.prisma.order.findMany({
      where: { id: { in: body.orderIds } },
      include: {
        stops: { orderBy: { sequence: "asc" } },
        items: true,
      },
    });
    if (orders.length !== body.orderIds.length) {
      throw new BadRequestException("Một số đơn hàng tối ưu không tồn tại");
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
      [vehicle.homeBranch.longitude, vehicle.homeBranch.latitude],
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
        id: vehicle.homeBranch.id,
        name: vehicle.homeBranch.name,
        latitude: vehicle.homeBranch.latitude,
        longitude: vehicle.homeBranch.longitude,
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
        typeof res.data.job_id !== "string" ||
        !Array.isArray(res.data.stops)
      ) {
        throw new Error("Optimization Engine trả response sai contract");
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
    user: { id: string; branchId?: string; role: Role },
    dto?: RunAutomaticOptimizationDto | string,
    persistedJobId?: string,
  ) {
    const requestedBranchId = typeof dto === "string" ? dto : dto?.branchId;
    const scheduleMode =
      typeof dto === "object" ? dto?.scheduleMode : undefined;
    const customStartTimeStr =
      typeof dto === "object" ? dto?.customStartTime : undefined;
    const branchId = resolveBranchScope(user, requestedBranchId);

    const [branch, vehicles, drivers, orders] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: branchId, active: true } }),
      this.prisma.vehicle.findMany({
        where: { homeBranchId: branchId, status: "AVAILABLE" },
        include: { homeBranch: true },
        orderBy: { plateNumber: "asc" },
      }),
      this.prisma.driver.findMany({
        where: {
          homeBranchId: branchId,
          status: "AVAILABLE",
          licenseExpiry: { gt: new Date() },
        },
        orderBy: { fullName: "asc" },
      }),
      this.prisma.order.findMany({
        where: { branchId, status: OrderStatus.CONFIRMED },
        include: { stops: { orderBy: { sequence: "asc" } }, items: true },
        orderBy: { orderedAt: "asc" },
      }),
    ]);

    if (!branch)
      throw new NotFoundException("Không tìm thấy chi nhánh đang hoạt động");
    if (vehicles.length === 0)
      throw new BadRequestException("Không có xe khả dụng trong chi nhánh");
    if (drivers.length === 0)
      throw new BadRequestException("Không có tài xế khả dụng trong chi nhánh");
    if (orders.length === 0)
      throw new BadRequestException("Không có đơn CONFIRMED để tối ưu");

    const candidateVehicles = vehicles.slice(0, drivers.length);

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
          throw new BadRequestException("customStartTime không hợp lệ");
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
        error.message || "Không thể tạo cửa sổ thời gian điều phối",
      );
    }
    const baseVehicles = candidateVehicles.map((vehicle) => ({
      source_vehicle_id: vehicle.id,
      plate_number: vehicle.plateNumber,
      model: vehicle.model,
      vehicle_type: vehicle.vehicleType,
      length_cm: vehicle.lengthCm,
      width_cm: vehicle.widthCm,
      height_cm: vehicle.heightCm,
      payload_limit_kg: vehicle.payloadCapacityKg,
      door_position: "REAR",
      depot: {
        id:
          vehicle.currentLatitude != null && vehicle.currentLongitude != null
            ? `vehicle-current:${vehicle.id}`
            : vehicle.homeBranch.id,
        name:
          vehicle.currentLatitude != null && vehicle.currentLongitude != null
            ? `Vị trí hiện tại ${vehicle.plateNumber}`
            : vehicle.homeBranch.name,
        latitude: vehicle.currentLatitude ?? vehicle.homeBranch.latitude,
        longitude: vehicle.currentLongitude ?? vehicle.homeBranch.longitude,
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
      orders: this.buildOptimizerOrders(
        orders,
        planningEpoch,
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
      max_time_seconds: Math.min(
        30,
        Math.max(12, Math.round(orders.length * 0.8)),
      ),
    };
    const vehicleCount = snapshot.vehicles.length;
    const orderCount = snapshot.orders.length;
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
      const fullSize = vehicleCount + orderCount * 2;
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
          orders: orders.map((order) => ({ id: order.id, version: order.version })),
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
          source:
            vehicle.currentLatitude != null && vehicle.currentLongitude != null
              ? 'CURRENT_GPS'
              : 'HOME_BRANCH_FALLBACK',
          measuredAt: vehicle.lastLocationAt?.toISOString() ?? null,
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

    let result;
    try {
      const response = await axios.post(
        `${this.optimizerUrl}/optimize-fleet`,
        payload,
        {
          timeout: Math.max(120000, (snapshot.max_time_seconds + 60) * 1000),
        },
      );
      assertFleetOptimizationResult(response.data);
      result = response.data;
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
          "Không thể nhận kết quả từ Optimization Engine",
      );
    }

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
      expiresAt: new Date(
        Date.now() + OPTIMIZATION_PROPOSAL_TTL_MS,
      ).toISOString(),
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

    return {
      proposal,
      signature: signOptimizationProposal(
        proposal,
        this.optimizationProposalSecret,
      ),
    };
  }

  async applyAutomaticOptimization(
    dto: ApplyAutomaticOptimizationDto,
    user: { id: string; branchId?: string; role: Role },
    sourceJobId?: string,
  ) {
    try {
      assertOptimizationProposal(dto.proposal);
    } catch (error) {
      throw new BadRequestException(
        error.message || "Proposal tối ưu không hợp lệ",
      );
    }
    const proposal = dto.proposal;
    const branchId = resolveBranchScope(user, proposal.branchId);
    if (branchId !== proposal.branchId) {
      throw new ForbiddenException(
        "Không có quyền áp dụng kế hoạch ngoài chi nhánh",
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
        "Kết quả tối ưu đã bị thay đổi hoặc chữ ký không hợp lệ",
      );
    }
    if (Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new ConflictException(
        "Kết quả tối ưu đã hết hạn; hãy chạy tối ưu lại",
      );
    }
    if (!["SUCCESS", "PARTIAL"].includes(proposal.result.status)) {
      throw new BadRequestException(
        `Không thể áp dụng kết quả ở trạng thái [${proposal.result.status}]`,
      );
    }
    if (proposal.result.routes.length === 0) {
      throw new BadRequestException(
        "Kết quả tối ưu không có tuyến nào để áp dụng",
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
        "Mỗi tuyến phải có xe, tài xế và ít nhất một đơn hàng",
      );
    }

    const applied = await this.prisma.$transaction(
      async (tx) => {
        await this.acquireApplicationLocks(tx, vehicleIds, driverIds, orderIds);

        const [orders, vehicles, drivers] = await Promise.all([
          tx.order.findMany({
            where: { id: { in: orderIds }, branchId },
            include: { stops: true, items: true },
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

        await this.assertOrdersNotOnActiveTrip(tx, orderIds);
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
            ),
          );
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
    return process.env.OPTIMIZER_URL || "http://localhost:8000";
  }

  private assertTripAccess(
    trip: { managingBranchId: string | null; vehicle: { homeBranchId: string } },
    user: { branchId?: string; role: Role },
  ) {
    if (user.role === Role.ADMIN) return;
    const branchId = trip.managingBranchId ?? trip.vehicle.homeBranchId;
    if (!user.branchId || user.branchId !== branchId) {
      throw new ForbiddenException('KhÃ´ng cÃ³ quyá»n truy cáº­p chuyáº¿n ngoÃ i chi nhÃ¡nh');
    }
  }

  private async validateSpatialPlan(
    vehicle: VehicleRecord,
    stopsWithItems: DispatchStopWithItems[],
  ) {
    const cargoByOrderId = new Map<string, ReturnType<typeof expandOrderItemsToCargoUnits>>();
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
        "Thiếu OPTIMIZATION_PROPOSAL_SECRET hoặc JWT_SECRET để ký kết quả tối ưu",
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
        "Đơn hàng, xe hoặc tài xế của phương án không còn tồn tại trong chi nhánh",
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
    const globallyAssignedOrders = new Set<string>();

    return proposal.result.routes.map((route) => {
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

      const routeOrderCounts = new Map<
        string,
        { pickup: number; delivery: number }
      >();
      const seenStopIds = new Set<string>();
      const sortedStops = [...route.stops].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const plannedStops: PlannedAutomaticTrip["stops"] = [];
      const stopsWithItems: StopWithItems[] = [];

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

        const order = orderById.get(stop.order_id);
        if (!order) {
          throw new ConflictException(
            `Không tìm thấy đơn [${stop.order_id}] trong chi nhánh`,
          );
        }
        const orderStop = order.stops.find(
          (item) => item.id === stop.location_id,
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

        const counts = routeOrderCounts.get(order.id) ?? {
          pickup: 0,
          delivery: 0,
        };
        if (stop.stop_type === StopType.PICKUP) counts.pickup += 1;
        else counts.delivery += 1;
        routeOrderCounts.set(order.id, counts);
        stopsWithItems.push({ orderStop, order });
        plannedStops.push({
          orderId: order.id,
          orderStopId: orderStop.id,
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

      for (const [orderId, counts] of routeOrderCounts) {
        if (counts.pickup !== 1 || counts.delivery !== 1) {
          throw new BadRequestException(
            `Đơn [${orderId}] phải có đúng một pickup và một delivery trong tuyến`,
          );
        }
        if (globallyAssignedOrders.has(orderId)) {
          throw new BadRequestException(
            `Đơn [${orderId}] xuất hiện trên nhiều tuyến`,
          );
        }
        globallyAssignedOrders.add(orderId);
      }

      TripsValidator.validatePickupBeforeDelivery(stopsWithItems);
      TripsValidator.calculateAndValidateLoad(vehicle, stopsWithItems);

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
        orderIds: Array.from(routeOrderCounts.keys()),
        stops: plannedStops,
      };
    });
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
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key.namespace}::int4, hashtext(${key.id})::int4)`;
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
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_NUMBER}::int4, hashtext(${dateStr})::int4)`;
    const existing = await tx.trip.count({
      where: { tripNumber: { startsWith: `TRIP-${dateStr}` } },
    });
    return Array.from(
      { length: count },
      (_, index) =>
        `TRIP-${dateStr}-${String(existing + index + 1).padStart(3, "0")}`,
    );
  }

  private async persistAutomaticTrip(
    tx: Prisma.TransactionClient,
    plannedTrip: PlannedAutomaticTrip,
    tripNumber: string,
    branchId: string,
    sourceJobId?: string,
  ) {
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
        notes: sourceJobId
          ? `Sinh từ optimization job ${sourceJobId}`
          : 'Sinh từ kết quả tối ưu tự động',
      },
    });

    const orders = await tx.order.findMany({
      where: { id: { in: plannedTrip.orderIds } },
      include: { items: true, stops: true },
    });
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const stopTaskIdByOrderStopId = new Map<string, string>();
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
      const stopTask = await tx.stopTask.create({
        data: {
          tripStopId: tripStop.id,
          orderId: order.id,
          orderStopId: stop.orderStopId,
          action:
            stop.stopType === StopType.PICKUP
              ? TaskAction.LOAD
              : TaskAction.UNLOAD,
          plannedQuantity: order.items.reduce(
            (sum, item) => sum + item.quantity,
            0,
          ),
        },
      });
      stopTaskIdByOrderStopId.set(stop.orderStopId, stopTask.id);
    }

    await this.persistValidatedLoadPlan(
      tx,
      trip.id,
      plannedTrip.vehicleId,
      orders,
      stopTaskIdByOrderStopId,
      plannedTrip.spatialValidation,
    );

    await tx.driverAssignment.create({
      data: {
        tripId: trip.id,
        driverId: plannedTrip.driverId,
        startTime: plannedTrip.plannedStartTime,
        endTime: plannedTrip.plannedEndTime,
        role: "PRIMARY",
      },
    });

    const updatedOrders = await tx.order.updateMany({
      where: {
        id: { in: plannedTrip.orderIds },
        status: OrderStatus.CONFIRMED,
      },
      data: { status: OrderStatus.ASSIGNED, version: { increment: 1 } },
    });
    if (updatedOrders.count !== plannedTrip.orderIds.length) {
      throw new ConflictException(
        "Trạng thái đơn đã thay đổi trong lúc áp dụng; toàn bộ thao tác đã rollback",
      );
    }

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
  ) {
    if (!spatialValidation.is_valid || spatialValidation.step_states.length === 0) {
      throw new ConflictException(
        'Không thể lưu chuyến khi chưa có Load Plan hợp lệ',
      );
    }
    const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw new ConflictException('Xe của Load Plan không còn tồn tại');
    const packageIdByCargoUnit = await this.ensurePhysicalPackageMapping(
      tx,
      orders,
    );
    const inputHash = createHash('sha256')
      .update(JSON.stringify(spatialValidation))
      .digest('hex');
    const loadPlan = await tx.loadPlan.create({
      data: {
        tripId,
        revision: 1,
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
              const packageId = packageIdByCargoUnit.get(placed.item_id);
              if (!packageId) {
                throw new ConflictException(
                  `Không ánh xạ được cargo unit ${placed.item_id} sang Package vật lý`,
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
      throw new BadRequestException(`Giá trị hình học ${value} cm không thể đổi sang mm`);
    }
    return millimeters;
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
        items = expandOrderItemsToCargoUnits(order.items);
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
