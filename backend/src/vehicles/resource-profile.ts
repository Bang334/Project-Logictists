import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Same lock namespaces as Trip create/apply/publish. Always lock before reading. */
export async function lockResourceProfile(tx: Prisma.TransactionClient, kind: 'vehicle' | 'driver', id: string) {
  const namespace = kind === 'vehicle' ? 4101 : 4102;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${namespace}::int4, hashtext(${id})::int4)`;
  if (kind === 'vehicle') await tx.$queryRaw`SELECT id FROM vehicles WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${id} FOR UPDATE`;
}

export function assertProfileVersion(updatedAt: Date, expectedUpdatedAt: string) {
  if (updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new ConflictException({ code: 'RESOURCE_VERSION_CONFLICT', message: 'Hồ sơ đã thay đổi. Tải lại và đối chiếu trước khi lưu.' });
  }
}

export async function assertStatusChangeAllowed(tx: Prisma.TransactionClient, kind: 'vehicle' | 'driver', id: string) {
  const resource = kind === 'vehicle' ? { vehicleId: id } : { driverId: id };
  const reservation = await tx.resourceReservation.findFirst({ where: { ...resource, status: { in: ['HELD', 'ACTIVE'] } }, select: { id: true } });
  const trip = kind === 'vehicle'
    ? await tx.trip.findFirst({ where: { vehicleId: id, status: { in: ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'] } }, select: { id: true } })
    : await tx.driverAssignment.findFirst({ where: { driverId: id, trip: { status: { in: ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'] } } }, select: { id: true } });
  if (reservation || trip) throw new ConflictException({ code: 'RESOURCE_IN_USE', message: 'Tài nguyên còn reservation hoặc chuyến hiệu lực; không thể đổi trạng thái thủ công.' });
}

export function nextProfileTimestamp(previous: Date): Date {
  // Preserve the existing timestamp version contract used by planning snapshots,
  // including two updates occurring within the same millisecond.
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}
