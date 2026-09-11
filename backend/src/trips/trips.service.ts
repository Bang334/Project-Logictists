import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripsValidator, StopWithItems } from './trips.validator';
import { TripStatus, OrderStatus, TaskAction, StopType, Role } from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { expandOrderItemsToCargoUnits } from './optimizer-payload';
import { assertFleetOptimizationResult } from './optimizer-contract';
import { resolveBranchScope } from '../auth/branch-scope';

@Injectable()
export class TripsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
  ) {}

  async onModuleInit() {
    await this.prisma.optimizationJob.updateMany({
      where: { status: 'RUNNING' },
      data: {
        status: 'FAILED',
        errorCode: 'WORKER_RESTARTED',
        errorMessage: 'Backend khởi động lại trong khi optimizer đang chạy',
        completedAt: new Date(),
      },
    });
  }

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

  async createAutomaticOptimizationJob(user: {
    id: string;
    branchId?: string;
    role: Role;
  }, requestedBranchId?: string) {
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
    const plainSnapshot = JSON.parse(JSON.stringify(snapshot));
    const requestHash = createHash('sha256')
      .update(JSON.stringify(plainSnapshot))
      .digest('hex');
    const job = await this.prisma.optimizationJob.create({
      data: {
        branchId,
        createdById: user.id,
        requestHash,
        requestSnapshot: plainSnapshot,
      },
    });

    setImmediate(() => {
      void this.processAutomaticOptimizationJob(job.id);
    });
    return job;
  }

  async findOptimizationJob(
    jobId: string,
    user: { id: string; branchId?: string; role?: string },
  ) {
    const job = await this.prisma.optimizationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Không tìm thấy optimization job');
    if (user.role !== 'ADMIN' && job.branchId !== user.branchId) {
      throw new ForbiddenException('Không có quyền xem optimization job ngoài chi nhánh');
    }
    return job;
  }

  private async processAutomaticOptimizationJob(jobId: string) {
    const claimed = await this.prisma.optimizationJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    try {
      const job = await this.prisma.optimizationJob.findUniqueOrThrow({ where: { id: jobId } });
      const snapshot = job.requestSnapshot as Record<string, any>;
      const vehicleCount = snapshot.vehicles.length;
      const orderCount = snapshot.orders.length;

      const firstDepot = snapshot.vehicles[0]?.depot;
      const allSameDepot =
        firstDepot &&
        snapshot.vehicles.every(
          (v: any) =>
            v.depot.longitude === firstDepot.longitude &&
            v.depot.latitude === firstDepot.latitude,
        );

      let fullDistances: number[][];
      let fullDurations: number[][];

      if (allSameDepot && vehicleCount > 1) {
        const compactCoordinates: [number, number][] = [
          [firstDepot.longitude, firstDepot.latitude],
          ...snapshot.orders.flatMap((order: any) => [
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
            if (i < vehicleCount && j < vehicleCount) {
              fullDistances[i][j] = 0;
              fullDurations[i][j] = 0;
            } else {
              fullDistances[i][j] = matrix.distancesMeters[mapboxI][mapboxJ];
              fullDurations[i][j] = matrix.durationsSeconds[mapboxI][mapboxJ];
            }
          }
        }
      } else {
        const coordinates: [number, number][] = [
          ...snapshot.vehicles.map((vehicle: any) => [
            vehicle.depot.longitude,
            vehicle.depot.latitude,
          ] as [number, number]),
          ...snapshot.orders.flatMap((order: any) => [
            [order.pickup_location.longitude, order.pickup_location.latitude] as [number, number],
            [order.delivery_location.longitude, order.delivery_location.latitude] as [number, number],
          ]),
        ];
        const matrix = await this.mapboxService.getRoadMatrix(coordinates);
        fullDistances = matrix.distancesMeters;
        fullDurations = matrix.durationsSeconds;
      }

      const payload = {
        job_id: job.id,
        vehicles: snapshot.vehicles,
        drivers: snapshot.drivers,
        orders: snapshot.orders,
        policy: snapshot.policy,
        max_time_seconds: snapshot.max_time_seconds,
        distance_matrix_meters: fullDistances,
        duration_matrix_seconds: fullDurations,
      };
      const response = await axios.post(`${this.optimizerUrl}/optimize-fleet`, payload, {
        timeout: Math.max(120000, (snapshot.max_time_seconds + 60) * 1000),
      });
      assertFleetOptimizationResult(response.data);

      for (const route of response.data.routes) {
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
      }

      await this.prisma.optimizationJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          result: JSON.parse(JSON.stringify(response.data)),
          completedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.optimizationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorCode: error.response ? 'EXTERNAL_SERVICE_ERROR' : 'OPTIMIZATION_ERROR',
          errorMessage:
            error.response?.data?.detail || error.message || 'Optimization job thất bại',
          completedAt: new Date(),
        },
      });
    }
  }

  private get optimizerUrl() {
    return process.env.OPTIMIZER_URL || 'http://localhost:8000';
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
