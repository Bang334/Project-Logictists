import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MapboxService } from '../mapbox/mapbox.service';

export async function driverArrivalEvidence(
  db: Prisma.TransactionClient,
  mapbox: MapboxService,
  driverId: string,
  departureAt: Date,
  depot: { latitude: number; longitude: number },
) {
  const shift = await db.driverShift.findFirst({ where: {
    driverId, status: 'ACTIVE', startsAt: { lte: departureAt }, endsAt: { gt: departureAt },
  }, orderBy: { startsAt: 'desc' } });
  if (!shift || !shift.readyAt || shift.readyLatitude === null || shift.readyLongitude === null || !shift.readyAddress) {
    throw new ConflictException({ code: 'DRIVER_READY_LOCATION_MISSING', message: 'Ca tài xế chưa có điểm và thời gian sẵn sàng nhận việc.' });
  }
  const route = await mapbox.getRoute([
    [shift.readyLongitude, shift.readyLatitude], [depot.longitude, depot.latitude],
  ]);
  if (!Number.isFinite(route.durationMinutes) || route.durationMinutes < 0) {
    throw new ServiceUnavailableException('Không xác minh được thời gian tài xế đến nhận xe');
  }
  const travelSeconds = Math.ceil(route.durationMinutes * 60);
  if (shift.readyAt.getTime() + travelSeconds * 1000 > departureAt.getTime()) {
    throw new ConflictException({ code: 'DRIVER_CANNOT_REACH_START', message: 'Tài xế không đủ thời gian đi từ điểm sẵn sàng đến nhận xe.' });
  }
  return { shiftId: shift.id, shiftVersion: shift.version, readyAt: shift.readyAt.toISOString(),
    readyLatitude: shift.readyLatitude, readyLongitude: shift.readyLongitude,
    depotLatitude: depot.latitude, depotLongitude: depot.longitude,
    travelSeconds, provider: 'MAPBOX', checkedAt: new Date().toISOString() };
}

export async function assertDriverArrivalCurrent(db: Prisma.TransactionClient,
  evidence: Awaited<ReturnType<typeof driverArrivalEvidence>>) {
  const shift = await db.driverShift.findUnique({ where: { id: evidence.shiftId } });
  if (!shift || shift.status !== 'ACTIVE' || shift.version !== evidence.shiftVersion ||
      shift.readyAt?.toISOString() !== evidence.readyAt || shift.readyLatitude !== evidence.readyLatitude || shift.readyLongitude !== evidence.readyLongitude) {
    throw new ConflictException('Điểm hoặc thời gian sẵn sàng đã thay đổi; hãy lập lại phương án');
  }
}
