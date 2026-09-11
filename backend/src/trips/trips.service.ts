import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripsValidator, StopWithItems } from './trips.validator';
import {
  DriverStatus,
  Driver as DriverRecord,
  OrderStatus,
  Prisma,
  Role,
  StopType,
  TaskAction,
  TripStatus,
  VehicleStatus,
  Vehicle as VehicleRecord,
} from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { expandOrderItemsToCargoUnits } from './optimizer-payload';
import { assertFleetOptimizationResult } from './optimizer-contract';
import { resolveBranchScope } from '../auth/branch-scope';
import { ApplyAutomaticOptimizationDto } from './dto/apply-automatic-optimization.dto';
import {
  assertOptimizationProposal,
  OptimizationProposal,
  signOptimizationProposal,
  verifyOptimizationProposalSignature,
} from './optimization-proposal';

const ACTIVE_TRIP_STATUSES = [
  TripStatus.PLANNED,
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
];
const OPTIMIZATION_PROPOSAL_TTL_MS = 30 * 60 * 1000;
const LOCK_NAMESPACE_VEHICLE = 4101;
const LOCK_NAMESPACE_DRIVER = 4102;
const LOCK_NAMESPACE_ORDER = 4103;
const LOCK_NAMESPACE_TRIP_NUMBER = 4104;

type OrderWithStopsAndItems = Prisma.OrderGetPayload<{
  include: { stops: true; items: true };
}>;

type PlannedAutomaticTrip = {
  vehicleId: string;
  driverId: string;
  plannedStartTime: Date;
  plannedEndTime: Date;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  routeGeometry: string | null;
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
  ) {}

  async findAll(status?: TripStatus) {
    return this.prisma.trip.findMany({
      where: {
        ...(status ? { status } : {}),
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
        allocations: {
          include: {
            orderItem: {
              include: { order: { include: { customer: true } } },
            },
          },
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
                allocation: {
                  include: { orderItem: { include: { order: true } } },
                },
              },
            },
          },
        },
        allocations: {
          include: {
            orderItem: {
              include: { order: { include: { customer: true } } },
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

  /**
   * Tạo chuyến đi mới (Lập kế hoạch Trip)
   */
  async create(dto: CreateTripDto) {
    const plannedStart = new Date(dto.plannedStartTime);
    const plannedEnd = new Date(dto.plannedEndTime);

    if (plannedStart >= plannedEnd) {
      throw new BadRequestException('Thời gian bắt đầu chuyến đi phải trước thời gian kết thúc');
    }

    // 1. Kiểm tra Xe và kiểm tra trùng lịch (BR06)
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: dto.vehicleId },
      include: { homeBranch: true },
    });
    if (!vehicle) {
      throw new NotFoundException(`Không tìm thấy xe [${dto.vehicleId}]`);
    }

    const vehicleOverlap = await this.prisma.trip.findFirst({
      where: {
        vehicleId: dto.vehicleId,
        status: { in: [TripStatus.PLANNED, TripStatus.DISPATCHED, TripStatus.IN_PROGRESS] },
        OR: [
          {
            plannedStartTime: { lte: plannedEnd },
            plannedEndTime: { gte: plannedStart },
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
    const driver = await this.prisma.driver.findUnique({
      where: { id: dto.driverId },
    });
    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế [${dto.driverId}]`);
    }
    if (driver.licenseExpiry <= new Date()) {
      throw new BadRequestException(`Bằng lái của tài xế ${driver.fullName} đã hết hạn!`);
    }

    const driverOverlap = await this.prisma.driverAssignment.findFirst({
      where: {
        driverId: dto.driverId,
        trip: {
          status: { in: [TripStatus.PLANNED, TripStatus.DISPATCHED, TripStatus.IN_PROGRESS] },
        },
        startTime: { lte: plannedEnd },
        endTime: { gte: plannedStart },
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
      where: { id: { in: dto.orderIds } },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
    });

    if (orders.length !== dto.orderIds.length) {
      throw new BadRequestException('Một số đơn hàng không tồn tại trong hệ thống');
    }

    // 4. Sắp xếp thứ tự các điểm dừng (Ordered Stops)
    const stopWithItemsList: StopWithItems[] = [];

    if (dto.orderedStopIds && dto.orderedStopIds.length > 0) {
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
      const pickups: StopWithItems[] = [];
      const deliveries: StopWithItems[] = [];

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
    const loadValidation = TripsValidator.calculateAndValidateLoad(vehicle, stopWithItemsList);

    // 6. Tích hợp Mapbox Directions API để tính cự ly, thời gian và lộ trình thực tế
    // Điểm bắt đầu là Chi nhánh quản lý xe (Home Branch Depot)
    const routeCoords: [number, number][] = [
      [vehicle.homeBranch.longitude, vehicle.homeBranch.latitude],
      ...stopWithItemsList.map((s) => [s.orderStop.longitude, s.orderStop.latitude] as [number, number]),
    ];

    const routeResult = await this.mapboxService.getRoute(routeCoords);

    // 7. Tạo mã chuyến đi tự động: TRIP-YYYYMMDD-XXXX
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const countToday = await this.prisma.trip.count({
      where: { tripNumber: { startsWith: `TRIP-${dateStr}` } },
    });
    const seq = String(countToday + 1).padStart(3, '0');
    const tripNumber = `TRIP-${dateStr}-${seq}`;

    // 8. Thực thi Transaction lưu toàn bộ vào PostgreSQL
    const createdTrip = await this.prisma.$transaction(async (tx) => {
      const trip = await tx.trip.create({
        data: {
          tripNumber,
          vehicleId: dto.vehicleId,
          status: TripStatus.PLANNED,
          plannedStartTime: plannedStart,
          plannedEndTime: plannedEnd,
          totalDistanceKm: routeResult.distanceKm,
          totalDurationMinutes: routeResult.durationMinutes,
          routeGeometry: routeResult.geometry ? JSON.stringify(routeResult.geometry) : null,
          notes: dto.notes,
        },
      });

      // Tạo TripStops & StopTasks
      for (let i = 0; i < stopWithItemsList.length; i++) {
        const item = stopWithItemsList[i];
        const isPickup = item.orderStop.type === StopType.PICKUP;

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
        for (const orderItem of item.order.items) {
          // Tìm allocation đã tạo cho orderItem này trong chuyến chưa
          let allocation = await tx.allocation.findFirst({
            where: { tripId: trip.id, orderItemId: orderItem.id },
          });

          if (!allocation) {
            allocation = await tx.allocation.create({
              data: {
                tripId: trip.id,
                orderItemId: orderItem.id,
                allocatedQuantity: orderItem.quantity,
              },
            });
          }

          // Tạo StopTask
          await tx.stopTask.create({
            data: {
              tripStopId: tripStop.id,
              allocationId: allocation.id,
              action: isPickup ? TaskAction.LOAD : TaskAction.UNLOAD,
              plannedQuantity: orderItem.quantity,
            },
          });
        }
      }

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

      // Cập nhật trạng thái các đơn hàng sang ASSIGNED
      await tx.order.updateMany({
        where: { id: { in: dto.orderIds } },
        data: { status: OrderStatus.ASSIGNED },
      });

      return trip;
    });

    return this.findOne(createdTrip.id);
  }

  /**
   * Phát hành chuyến đi (Publish Trip)
   */
  async publish(id: string) {
    const trip = await this.findOne(id);
    if (trip.status !== TripStatus.PLANNED && trip.status !== TripStatus.DRAFT) {
      throw new BadRequestException(`Chuyến đi ở trạng thái [${trip.status}] không thể phát hành`);
    }

    return this.prisma.trip.update({
      where: { id },
      data: { status: TripStatus.DISPATCHED },
      include: {
        vehicle: true,
        assignments: { include: { driver: true } },
        stops: true,
      },
    });
  }

  /**
   * Lấy biểu đồ phân tích tải trọng xe qua từng điểm dừng (Load Profile)
   */
  async getLoadProfile(id: string) {
    const trip = await this.findOne(id);
    const stopsWithItems: StopWithItems[] = [];

    for (const stop of trip.stops) {
      // Mock StopWithItems từ dữ liệu lưu trong DB để tính profile
      const items = trip.allocations.map((a) => a.orderItem);
      stopsWithItems.push({
        orderStop: {
          id: stop.id,
          orderId: '',
          type: stop.stopType,
          sequence: stop.sequence,
          address: stop.address,
          latitude: stop.latitude,
          longitude: stop.longitude,
          contactName: stop.contactName || '',
          contactPhone: stop.contactPhone || '',
          windowStart: null,
          windowEnd: null,
          serviceDurationMinutes: 20,
          createdAt: new Date(),
        },
        order: {
          id: '',
          orderNumber: '',
          customerId: '',
          branchId: '',
          status: OrderStatus.ASSIGNED,
          totalWeightKg: 0,
          totalVolumeM3: 0,
          totalPackages: 0,
          version: 1,
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          items: items as any,
        },
      });
    }

    return TripsValidator.calculateAndValidateLoad(trip.vehicle, stopsWithItems);
  }

  /**
   * Gọi Optimization Engine (Google OR-Tools + Dynamic 2D Spatial Packing)
   */
  async runOptimization(body: OptimizeTripDto) {
    if (new Set(body.orderIds).size !== body.orderIds.length) {
      throw new BadRequestException('Danh sách orderIds không được chứa ID trùng');
    }
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: body.vehicleId },
      include: { homeBranch: true },
    });
    if (!vehicle) {
      throw new NotFoundException('Không tìm thấy xe');
    }

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

    const orderedOrders = body.orderIds.map((id) => orders.find((order) => order.id === id)!);
    const planningEpoch = this.getPlanningEpoch(orderedOrders);
    const optimizerOrders = this.buildOptimizerOrders(orderedOrders, planningEpoch);
    const matrixCoordinates: [number, number][] = [
      [vehicle.homeBranch.longitude, vehicle.homeBranch.latitude],
      ...optimizerOrders.flatMap((order) => [
        [order.pickup_location.longitude, order.pickup_location.latitude] as [number, number],
        [order.delivery_location.longitude, order.delivery_location.latitude] as [number, number],
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
      const res = await axios.post(`${this.optimizerUrl}/optimize`, payload, { timeout: 10000 });
      if (!res.data || typeof res.data.job_id !== 'string' || !Array.isArray(res.data.stops)) {
        throw new Error('Optimization Engine trả response sai contract');
      }
      return res.data;
    } catch (error) {
      throw new BadRequestException(
        error.response?.data?.detail || error.message || 'Lỗi khi gọi Optimization Engine',
      );
    }
  }

  async runAutomaticOptimization(
    user: { id: string; branchId?: string; role: Role },
    requestedBranchId?: string,
  ) {
    const branchId = resolveBranchScope(user, requestedBranchId);

    const [branch, vehicles, drivers, orders] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: branchId, active: true } }),
      this.prisma.vehicle.findMany({
        where: { homeBranchId: branchId, status: 'AVAILABLE' },
        include: { homeBranch: true },
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
        include: { stops: { orderBy: { sequence: 'asc' } }, items: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!branch) throw new NotFoundException('Không tìm thấy chi nhánh đang hoạt động');
    if (vehicles.length === 0) throw new BadRequestException('Không có xe khả dụng trong chi nhánh');
    if (drivers.length === 0) throw new BadRequestException('Không có tài xế khả dụng trong chi nhánh');
    if (orders.length === 0) throw new BadRequestException('Không có đơn CONFIRMED để tối ưu');

    const candidateVehicles = vehicles.slice(0, drivers.length);

    const planningEpoch = this.getPlanningEpoch(orders);
    const snapshot = {
      vehicles: candidateVehicles.map((vehicle) => ({
        id: vehicle.id,
        plate_number: vehicle.plateNumber,
        model: vehicle.model,
        vehicle_type: vehicle.vehicleType,
        length_cm: vehicle.lengthCm,
        width_cm: vehicle.widthCm,
        height_cm: vehicle.heightCm,
        payload_limit_kg: vehicle.payloadCapacityKg,
        door_position: 'REAR',
        depot: {
          id: vehicle.homeBranch.id,
          name: vehicle.homeBranch.name,
          latitude: vehicle.homeBranch.latitude,
          longitude: vehicle.homeBranch.longitude,
        },
        fuel_consumption_liters_per_100_km: Number(
          vehicle.fuelConsumptionLitersPer100Km,
        ),
        load_fuel_surcharge_percent_at_full_payload: Number(
          vehicle.loadFuelSurchargePercentAtFullPayload,
        ),
        fixed_operating_cost_vnd: Number(vehicle.fixedOperatingCostPerTrip),
      })),
      drivers: drivers.map((driver) => ({
        id: driver.id,
        full_name: driver.fullName,
        license_class: driver.licenseClass,
        fixed_salary_monthly_vnd: Number(driver.fixedSalaryMonthly),
        trip_base_pay_vnd: Number(driver.tripBasePay),
        per_km_pay_vnd: Number(driver.perKmPay),
      })),
      orders: this.buildOptimizerOrders(orders, planningEpoch),
      policy: {
        fuel_price_per_liter_vnd: Number(branch.fuelPricePerLiter),
        monthly_working_minutes: branch.monthlyWorkingMinutes,
        cargo_holding_cost_vnd_per_ton_hour: Number(
          branch.cargoHoldingCostVndPerTonHour,
        ),
        unassigned_order_penalty_vnd: 1_000_000_000,
      },
      planning_epoch_iso: planningEpoch.toISOString(),
      max_time_seconds: Math.min(30, Math.max(12, Math.round(orders.length * 0.8))),
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

    let fullDistances: number[][];
    let fullDurations: number[][];

    if (allSameDepot && vehicleCount > 1) {
      const compactCoordinates: [number, number][] = [
        [firstDepot.longitude, firstDepot.latitude],
        ...snapshot.orders.flatMap((order) => [
          [order.pickup_location.longitude, order.pickup_location.latitude] as [number, number],
          [order.delivery_location.longitude, order.delivery_location.latitude] as [number, number],
        ]),
      ];
      const matrix = await this.mapboxService.getRoadMatrix(compactCoordinates);
      const fullSize = vehicleCount + orderCount * 2;
      fullDistances = Array.from({ length: fullSize }, () => Array(fullSize).fill(0));
      fullDurations = Array.from({ length: fullSize }, () => Array(fullSize).fill(0));

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
            [vehicle.depot.longitude, vehicle.depot.latitude] as [number, number],
        ),
        ...snapshot.orders.flatMap((order) => [
          [order.pickup_location.longitude, order.pickup_location.latitude] as [number, number],
          [order.delivery_location.longitude, order.delivery_location.latitude] as [number, number],
        ]),
      ];
      const matrix = await this.mapboxService.getRoadMatrix(coordinates);
      fullDistances = matrix.distancesMeters;
      fullDurations = matrix.durationsSeconds;
    }

    const payload = {
      job_id: `request-${randomUUID()}`,
      vehicles: snapshot.vehicles,
      drivers: snapshot.drivers,
      orders: snapshot.orders,
      policy: snapshot.policy,
      max_time_seconds: snapshot.max_time_seconds,
      distance_matrix_meters: fullDistances,
      duration_matrix_seconds: fullDurations,
    };

    let result;
    try {
      const response = await axios.post(`${this.optimizerUrl}/optimize-fleet`, payload, {
        timeout: Math.max(120000, (snapshot.max_time_seconds + 60) * 1000),
      });
      assertFleetOptimizationResult(response.data);
      result = response.data;
    } catch (error) {
      throw new ServiceUnavailableException(
        error.response?.data?.detail ||
          error.message ||
          'Không thể nhận kết quả từ Optimization Engine',
      );
    }

    await Promise.all(
      result.routes.map(async (route) => {
        const vehicle = snapshot.vehicles.find((item) => item.id === route.vehicle_id);
        if (!vehicle) throw new Error(`Optimizer trả vehicle_id lạ: ${route.vehicle_id}`);
        const routeCoordinates: [number, number][] = [
          [vehicle.depot.longitude, vehicle.depot.latitude],
          ...route.stops.map(
            (stop) => [stop.longitude, stop.latitude] as [number, number],
          ),
          [vehicle.depot.longitude, vehicle.depot.latitude],
        ];
        const routeDetails = await this.mapboxService.getRoute(routeCoordinates);
        route.depot = vehicle.depot;
        route.route_geometry = routeDetails.geometry;
      }),
    );

    const proposal: OptimizationProposal = {
      branchId,
      planningEpochIso: planningEpoch.toISOString(),
      expiresAt: new Date(Date.now() + OPTIMIZATION_PROPOSAL_TTL_MS).toISOString(),
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
      result: JSON.parse(JSON.stringify(result)),
    };

    return {
      proposal,
      signature: signOptimizationProposal(proposal, this.optimizationProposalSecret),
    };
  }

  async applyAutomaticOptimization(
    dto: ApplyAutomaticOptimizationDto,
    user: { id: string; branchId?: string; role: Role },
  ) {
    try {
      assertOptimizationProposal(dto.proposal);
    } catch (error) {
      throw new BadRequestException(error.message || 'Proposal tối ưu không hợp lệ');
    }
    const proposal = dto.proposal;
    const branchId = resolveBranchScope(user, proposal.branchId);
    if (branchId !== proposal.branchId) {
      throw new ForbiddenException('Không có quyền áp dụng kế hoạch ngoài chi nhánh');
    }
    if (
      !verifyOptimizationProposalSignature(
        proposal,
        dto.signature,
        this.optimizationProposalSecret,
      )
    ) {
      throw new ForbiddenException('Kết quả tối ưu đã bị thay đổi hoặc chữ ký không hợp lệ');
    }
    if (Date.parse(proposal.expiresAt) <= Date.now()) {
      throw new ConflictException('Kết quả tối ưu đã hết hạn; hãy chạy tối ưu lại');
    }
    if (!['SUCCESS', 'PARTIAL'].includes(proposal.result.status)) {
      throw new BadRequestException(
        `Không thể áp dụng kết quả ở trạng thái [${proposal.result.status}]`,
      );
    }
    if (proposal.result.routes.length === 0) {
      throw new BadRequestException('Kết quả tối ưu không có tuyến nào để áp dụng');
    }

    const orderIds = Array.from(
      new Set(proposal.result.routes.flatMap((route) => route.stops.map((stop) => stop.order_id))),
    );
    const vehicleIds = Array.from(
      new Set(proposal.result.routes.map((route) => route.vehicle_id)),
    );
    const driverIds = Array.from(
      new Set(
        proposal.result.routes.map((route) => route.driver_id).filter(Boolean) as string[],
      ),
    );
    if (
      orderIds.length === 0 ||
      driverIds.length !== proposal.result.routes.length ||
      vehicleIds.length !== proposal.result.routes.length
    ) {
      throw new BadRequestException(
        'Mỗi tuyến phải có xe, tài xế riêng và ít nhất một đơn hàng',
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
          tx.vehicle.findMany({ where: { id: { in: vehicleIds }, homeBranchId: branchId } }),
          tx.driver.findMany({ where: { id: { in: driverIds }, homeBranchId: branchId } }),
        ]);

        this.assertProposalResourcesCurrent(proposal, orders, vehicles, drivers);
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

        const tripNumbers = await this.allocateTripNumbers(tx, plannedTrips.length);
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
    return process.env.OPTIMIZER_URL || 'http://localhost:8000';
  }

  private get optimizationProposalSecret() {
    const secret = process.env.OPTIMIZATION_PROPOSAL_SECRET || process.env.JWT_SECRET;
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
      proposal.result.routes.flatMap((route) => route.stops.map((stop) => stop.order_id)),
    );
    const usedVehicleIds = new Set(proposal.result.routes.map((route) => route.vehicle_id));
    const usedDriverIds = new Set(
      proposal.result.routes.map((route) => route.driver_id).filter(Boolean) as string[],
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
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    const planningEpoch = new Date(proposal.planningEpochIso);
    const globallyAssignedOrders = new Set<string>();

    return proposal.result.routes.map((route) => {
      const vehicle = vehicleById.get(route.vehicle_id);
      if (!vehicle) {
        throw new ConflictException(`Không tìm thấy xe [${route.vehicle_id}]`);
      }
      if (!route.driver_id) {
        throw new BadRequestException(`Tuyến xe ${vehicle.plateNumber} chưa có tài xế`);
      }
      const driver = driverById.get(route.driver_id);
      if (!driver) {
        throw new ConflictException(`Không tìm thấy tài xế [${route.driver_id}]`);
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
      const sortedStops = [...route.stops].sort((left, right) => left.sequence - right.sequence);
      const plannedStops: PlannedAutomaticTrip['stops'] = [];
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
          throw new ConflictException(`Không tìm thấy đơn [${stop.order_id}] trong chi nhánh`);
        }
        const orderStop = order.stops.find((item) => item.id === stop.location_id);
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

        const counts = routeOrderCounts.get(order.id) ?? { pickup: 0, delivery: 0 };
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
          throw new BadRequestException(`Đơn [${orderId}] xuất hiện trên nhiều tuyến`);
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
        Math.round(route.total_duration_minutes * 60),
      );

      return {
        vehicleId: vehicle.id,
        driverId: driver.id,
        plannedStartTime: planningEpoch,
        plannedEndTime: new Date(planningEpoch.getTime() + plannedEndSeconds * 1000),
        totalDistanceKm: route.total_distance_km,
        totalDurationMinutes: route.total_duration_minutes,
        routeGeometry: route.route_geometry
          ? JSON.stringify(route.route_geometry)
          : null,
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
    const conflicting = await tx.allocation.findFirst({
      where: {
        orderItem: { orderId: { in: orderIds } },
        trip: { status: { in: ACTIVE_TRIP_STATUSES } },
      },
      include: {
        trip: { select: { tripNumber: true } },
        orderItem: { select: { order: { select: { orderNumber: true } } } },
      },
    });
    if (conflicting) {
      throw new ConflictException(
        `Đơn ${conflicting.orderItem.order.orderNumber} đã nằm trên chuyến ${conflicting.trip.tripNumber}`,
      );
    }
  }

  private async assertNoResourceOverlap(
    tx: Prisma.TransactionClient,
    plannedTrip: PlannedAutomaticTrip,
  ): Promise<void> {
    const vehicleOverlap = await tx.trip.findFirst({
      where: {
        vehicleId: plannedTrip.vehicleId,
        status: { in: ACTIVE_TRIP_STATUSES },
        plannedStartTime: { lte: plannedTrip.plannedEndTime },
        plannedEndTime: { gte: plannedTrip.plannedStartTime },
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
        startTime: { lte: plannedTrip.plannedEndTime },
        endTime: { gte: plannedTrip.plannedStartTime },
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
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE_TRIP_NUMBER}::int4, hashtext(${dateStr})::int4)`;
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
        notes: 'Sinh từ kết quả tối ưu tự động không lưu job',
      },
    });

    const orders = await tx.order.findMany({
      where: { id: { in: plannedTrip.orderIds } },
      include: { items: true },
    });
    const allocationIdByItemId = new Map<string, string>();
    for (const order of orders) {
      for (const item of order.items) {
        const allocation = await tx.allocation.create({
          data: {
            tripId: trip.id,
            orderItemId: item.id,
            allocatedQuantity: item.quantity,
          },
        });
        allocationIdByItemId.set(item.id, allocation.id);
      }
    }

    const orderById = new Map(orders.map((order) => [order.id, order]));
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
      for (const item of order.items) {
        const allocationId = allocationIdByItemId.get(item.id);
        if (!allocationId) throw new Error(`Thiếu allocation cho dòng hàng [${item.id}]`);
        await tx.stopTask.create({
          data: {
            tripStopId: tripStop.id,
            allocationId,
            orderStopId: stop.orderStopId,
            action:
              stop.stopType === StopType.PICKUP
                ? TaskAction.LOAD
                : TaskAction.UNLOAD,
            plannedQuantity: item.quantity,
          },
        });
      }
    }

    await tx.driverAssignment.create({
      data: {
        tripId: trip.id,
        driverId: plannedTrip.driverId,
        startTime: plannedTrip.plannedStartTime,
        endTime: plannedTrip.plannedEndTime,
        role: 'PRIMARY',
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
        'Trạng thái đơn đã thay đổi trong lúc áp dụng; toàn bộ thao tác đã rollback',
      );
    }

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

  private getPlanningEpoch(orders: Array<{ stops: Array<{ windowStart: Date | null }> }>) {
    const windowStarts = orders
      .flatMap((order) => order.stops.map((stop) => stop.windowStart))
      .filter((value): value is Date => value instanceof Date);
    const epoch = windowStarts.length > 0
      ? new Date(Math.min(...windowStarts.map((value) => value.getTime())))
      : new Date();
    epoch.setUTCHours(0, 0, 0, 0);
    return epoch;
  }

  private buildOptimizerOrders(
    orders: Array<{
      id: string;
      orderNumber: string;
      stops: Array<{
        id: string;
        type: StopType;
        address: string;
        latitude: number;
        longitude: number;
        windowStart: Date | null;
        windowEnd: Date | null;
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
    const secondsFromEpoch = (value: Date | null, fallback: number) =>
      value ? Math.max(0, Math.round((value.getTime() - planningEpoch.getTime()) / 1000)) : fallback;

    return orders.map((order) => {
      const pickup = order.stops.find((stop) => stop.type === StopType.PICKUP);
      const delivery = order.stops.find((stop) => stop.type === StopType.DELIVERY);
      if (!pickup || !delivery) {
        throw new BadRequestException(`Đơn ${order.orderNumber} thiếu pickup hoặc delivery`);
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
        pickup_window_start_sec: secondsFromEpoch(pickup.windowStart, 0),
        pickup_window_end_sec: secondsFromEpoch(pickup.windowEnd, 7 * 86400),
        delivery_window_start_sec: secondsFromEpoch(delivery.windowStart, 0),
        delivery_window_end_sec: secondsFromEpoch(delivery.windowEnd, 7 * 86400),
        service_time_sec: Math.max(
          pickup.serviceDurationMinutes,
          delivery.serviceDurationMinutes,
        ) * 60,
      };
    });
  }
}
