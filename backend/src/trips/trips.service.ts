import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripsValidator, StopWithItems } from './trips.validator';
import { TripStatus, OrderStatus, TaskAction, StopType } from '@prisma/client';

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
}
