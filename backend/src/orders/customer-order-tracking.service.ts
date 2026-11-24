import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const GPS_STALE_THRESHOLD_MS = 2 * 60 * 1000;

@Injectable()
export class CustomerOrderTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async findForUser(userId: string, orderId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!customer) {
      throw new ConflictException({
        errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
        message: 'Tài khoản CUSTOMER chưa được liên kết với hồ sơ khách hàng',
      });
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: customer.id },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn vận chuyển');
    }

    const trips = await this.prisma.trip.findMany({
      where: {
        stops: {
          some: { tasks: { some: { orderId: order.id } } },
        },
      },
      select: {
        id: true,
        tripNumber: true,
        status: true,
        version: true,
        plannedStartTime: true,
        stops: {
          where: {
            tasks: {
              some: { orderId: order.id, action: TaskAction.UNLOAD },
            },
          },
          select: { plannedArrivalTime: true },
          orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
          take: 1,
        },
        gpsEvents: {
          select: {
            latitude: true,
            longitude: true,
            accuracyM: true,
            measuredAt: true,
            receivedAt: true,
          },
          orderBy: [
            { measuredAt: 'desc' },
            { receivedAt: 'desc' },
            { id: 'desc' },
          ],
          take: 1,
        },
      },
      orderBy: [{ plannedStartTime: 'asc' }, { id: 'asc' }],
    });

    return {
      orderId: order.id,
      orderStatus: order.status,
      trackingStatus: trips.length === 0 ? 'NOT_ASSIGNED' : 'AVAILABLE',
      trips: trips.map((trip) => {
        const latest = trip.gpsEvents[0];
        const plannedDeliveryAt = trip.stops[0]?.plannedArrivalTime ?? null;
        return {
          id: trip.id,
          tripNumber: trip.tripNumber,
          status: trip.status,
          version: trip.version,
          plannedDeliveryAt: plannedDeliveryAt?.toISOString() ?? null,
          etaSource: 'PLANNED' as const,
          vehicleLocation: latest
            ? {
                latitude: Number(latest.latitude),
                longitude: Number(latest.longitude),
                accuracyM:
                  latest.accuracyM === null
                    ? null
                    : Number(latest.accuracyM),
                measuredAt: latest.measuredAt.toISOString(),
                receivedAt: latest.receivedAt.toISOString(),
                isStale:
                  Date.now() - latest.measuredAt.getTime() >
                  GPS_STALE_THRESHOLD_MS,
              }
            : null,
        };
      }),
    };
  }
}

export type CustomerOrderTrackingResponse = Prisma.PromiseReturnType<
  CustomerOrderTrackingService['findForUser']
>;
