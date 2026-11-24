import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, TripStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { driverTripDateRange } from "./dto/driver-trip-date-range";
import { QueryDriverTripHistoryDto } from "./dto/query-driver-trip-history.dto";
import { readDriverTripHistory } from "./driver-trip-history.query";
import {
  DRIVER_VISIBLE_TRIP_STATUSES,
  QueryDriverTripsDto,
} from "./dto/query-driver-trips.dto";

const ACTIVE_ASSIGNMENT_STATUS = "ASSIGNED";

const DRIVER_VEHICLE_SELECT = Prisma.validator<Prisma.VehicleSelect>()({
  id: true,
  plateNumber: true,
  model: true,
  vehicleType: true,
});

const DRIVER_ASSIGNMENT_SELECT =
  Prisma.validator<Prisma.DriverAssignmentSelect>()({
    id: true,
    role: true,
    status: true,
    startTime: true,
    endTime: true,
  });

const DRIVER_TRIP_SUMMARY_SELECT = Prisma.validator<Prisma.TripSelect>()({
  id: true,
  tripNumber: true,
  status: true,
  version: true,
  plannedStartTime: true,
  plannedEndTime: true,
  actualStartTime: true,
  actualEndTime: true,
  totalDistanceKm: true,
  totalDurationMinutes: true,
  vehicle: { select: DRIVER_VEHICLE_SELECT },
  assignments: {
    select: DRIVER_ASSIGNMENT_SELECT,
    where: { status: ACTIVE_ASSIGNMENT_STATUS },
    orderBy: [
      { createdAt: Prisma.SortOrder.asc },
      { id: Prisma.SortOrder.asc },
    ],
  },
  _count: { select: { stops: true } },
});

const DRIVER_TRIP_DETAIL_SELECT = Prisma.validator<Prisma.TripSelect>()({
  ...DRIVER_TRIP_SUMMARY_SELECT,
  vehicle: {
    select: {
      ...DRIVER_VEHICLE_SELECT,
      payloadCapacityKg: true,
      volumeCapacityM3: true,
      lengthCm: true,
      widthCm: true,
      heightCm: true,
    },
  },
  stops: {
    select: {
      id: true,
      sequence: true,
      stopType: true,
      status: true,
      address: true,
      latitude: true,
      longitude: true,
      contactName: true,
      contactPhone: true,
      plannedArrivalTime: true,
      plannedDepartureTime: true,
      actualArrivalTime: true,
      actualDepartureTime: true,
      tasks: {
        select: {
          id: true,
          action: true,
          plannedQuantity: true,
          actualQuantity: true,
          order: { select: { id: true, orderNumber: true } },
          package: {
            select: {
              id: true,
              packageCode: true,
              weightG: true,
              lengthMm: true,
              widthMm: true,
              heightMm: true,
              status: true,
            },
          },
        },
        orderBy: { id: Prisma.SortOrder.asc },
      },
      deliveryAttempts: {
        select: {
          id: true,
          attemptNumber: true,
          result: true,
          recipientName: true,
        },
        orderBy: { attemptNumber: Prisma.SortOrder.desc },
        take: 1,
      },
    },
    orderBy: [{ sequence: Prisma.SortOrder.asc }, { id: Prisma.SortOrder.asc }],
  },
});

type DriverTripSummaryRecord = Prisma.TripGetPayload<{
  select: typeof DRIVER_TRIP_SUMMARY_SELECT;
}>;

type DriverTripDetailRecord = Prisma.TripGetPayload<{
  select: typeof DRIVER_TRIP_DETAIL_SELECT;
}>;

@Injectable()
export class DriverTripsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(userId: string, query: QueryDriverTripsDto) {
    const driverId = await this.resolveDriverId(userId);
    const range = query.from !== undefined || query.to !== undefined
      ? driverTripDateRange(query.from, query.to, 31)
      : undefined;
    const assignmentWhere: Prisma.DriverAssignmentWhereInput = {
      driverId,
      status: ACTIVE_ASSIGNMENT_STATUS,
      ...(range && { startTime: { lt: range.end }, endTime: { gt: range.start } }),
    };
    const where: Prisma.TripWhereInput = {
      status: query.status
        ? query.status
        : { in: [...DRIVER_VISIBLE_TRIP_STATUSES] },
      assignments: {
        some: assignmentWhere,
      },
    };
    const skip = (query.page - 1) * query.limit;

    const [trips, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        select: {
          ...DRIVER_TRIP_SUMMARY_SELECT,
          assignments: {
            ...DRIVER_TRIP_SUMMARY_SELECT.assignments,
            where: assignmentWhere,
            ...(!range && { take: 1 }),
          },
        },
        orderBy: [
          { plannedStartTime: Prisma.SortOrder.asc },
          { id: Prisma.SortOrder.asc },
        ],
        skip,
        take: query.limit,
      }),
      this.prisma.trip.count({ where }),
    ]);

    return {
      items: trips.map((trip) => ({
        ...this.toSummary(trip),
        ...(range && { calendarAssignments: trip.assignments }),
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    };
  }

  async findHistoryForUser(userId: string, query: QueryDriverTripHistoryDto) {
    const driverId = await this.resolveDriverId(userId);
    const range = driverTripDateRange(query.from, query.to, 93);
    return readDriverTripHistory(this.prisma, driverId, range, query);
  }

  async findOneForUser(userId: string, tripId: string) {
    const driverId = await this.resolveDriverId(userId);
    const trip = await this.prisma.trip.findFirst({
      where: {
        id: tripId,
        status: { in: [...DRIVER_VISIBLE_TRIP_STATUSES] },
        assignments: {
          some: { driverId, status: ACTIVE_ASSIGNMENT_STATUS },
        },
      },
      select: {
        ...DRIVER_TRIP_DETAIL_SELECT,
        assignments: {
          ...DRIVER_TRIP_DETAIL_SELECT.assignments,
          where: { driverId, status: ACTIVE_ASSIGNMENT_STATUS },
          take: 1,
        },
      },
    });

    if (!trip) {
      throw new NotFoundException("Không tìm thấy chuyến được phân công");
    }

    return this.toDetail(trip);
  }

  private async resolveDriverId(userId: string): Promise<string> {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!driver) {
      throw new ConflictException({
        errorCode: "DRIVER_PROFILE_NOT_FOUND",
        message: "Tài khoản DRIVER chưa được liên kết với hồ sơ tài xế",
      });
    }
    return driver.id;
  }

  private toSummary(trip: DriverTripSummaryRecord) {
    const { assignments, _count, ...summary } = trip;
    return {
      ...summary,
      assignment: assignments[0],
      stopCount: _count.stops,
    };
  }

  private toDetail(trip: DriverTripDetailRecord) {
    const { stops, ...summary } = trip;
    const canReadContactPhone =
      trip.status === TripStatus.DISPATCHED || trip.status === TripStatus.IN_PROGRESS;
    return {
      ...this.toSummary(summary),
      vehicle: trip.vehicle,
      stops: stops.map(({ deliveryAttempts, contactPhone, ...stop }) => ({
        ...stop,
        contactPhone: canReadContactPhone ? contactPhone : null,
        deliveryAttempt: deliveryAttempts[0] ?? null,
        tasks: stop.tasks.map((task) => ({
          ...task,
          package: task.package
            ? {
                id: task.package.id,
                packageCode: task.package.packageCode,
                weightKg: Number(task.package.weightG) / 1_000,
                lengthCm: task.package.lengthMm / 10,
                widthCm: task.package.widthMm / 10,
                heightCm: task.package.heightMm / 10,
                status: task.package.status,
              }
            : null,
        })),
      })),
    };
  }
}
