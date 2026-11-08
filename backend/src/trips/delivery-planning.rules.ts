import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
export interface DeliveryWindowWitness {
  planningEpochIso: string;
  result: { status: string; unassigned_orders: unknown[]; routes: Array<{ stops: Array<{ stop_type: string; order_id: string; arrival_time_sec: number }> }> };
}

export function proposedDeliveryWindows(proposal: DeliveryWindowWitness, minutes: number, expiresAt: Date, openSec: number, closeSec: number, now = new Date()) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new BadRequestException('Độ rộng khung và hạn phản hồi không hợp lệ');
  }
  if (proposal.result.status !== 'SUCCESS' || proposal.result.unassigned_orders.length || !proposal.result.routes.length) {
    throw new BadRequestException('Chỉ gửi đề xuất từ phương án đã kiểm định và giao đủ mọi đơn');
  }
  const epoch = Date.parse(proposal.planningEpochIso);
  const visits = new Map<string, number[]>();
  for (const route of proposal.result.routes) for (const stop of route.stops) {
    if (stop.stop_type !== 'DELIVERY') continue;
    const seconds = visits.get(stop.order_id) ?? [];
    seconds.push(stop.arrival_time_sec);
    visits.set(stop.order_id, seconds);
  }
  return [...visits].map(([orderId, times]) => {
    const earliest = Math.min(...times), latest = Math.max(...times), width = minutes * 60;
    const day = Math.floor(earliest / 86400) * 86400;
    if (Math.floor(latest / 86400) * 86400 !== day || latest - earliest > width) {
      throw new BadRequestException(`Các lần giao của đơn ${orderId} không nằm trong một khung ${minutes} phút; cần tối ưu lại hoặc chọn khung rộng hơn`);
    }
    const start = Math.max(day + openSec, Math.min(earliest, latest - width / 2));
    const end = Math.min(day + closeSec, start + width);
    if (earliest < start || latest > end || start >= end) throw new BadRequestException('Tuyến không nằm trong giờ giao phục vụ của ngày đã chọn');
    const windowStart = new Date(epoch + start * 1000), windowEnd = new Date(epoch + end * 1000);
    if (expiresAt >= windowStart) throw new BadRequestException('Hạn phản hồi phải trước mọi khung giao đề xuất');
    return { orderId, windowStart, windowEnd };
  });
}

export async function lockDeliveryResources(tx: Prisma.TransactionClient, vehicleIds: string[], driverIds: string[], orderIds: string[]) {
  const keys = [
    ...vehicleIds.map(id => ({ ns: 4101, id })),
    ...driverIds.map(id => ({ ns: 4102, id })),
    ...orderIds.map(id => ({ ns: 4103, id })),
  ].sort((a, b) => a.ns - b.ns || a.id.localeCompare(b.id));
  for (const { ns, id } of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ns}::int4, hashtext(${id})::int4)`;
}

export async function assertNoDeliveryOrderHold(tx: Prisma.TransactionClient, orderIds: string[], ownBatchId?: string) {
  const held = await tx.deliveryAppointment.findFirst({ where: {
    orderId: { in: orderIds }, ...(ownBatchId ? { batchId: { not: ownBatchId } } : {}),
    OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', expiresAt: { gt: new Date() } }],
  } });
  if (held) throw new ConflictException('Đơn đang được giữ chỗ cho khách xác nhận; cần hoàn tất đợt hẹn giao trước khi phân công riêng');
}

export async function assertNoDeliveryResourceHold(tx: Prisma.TransactionClient, input: { vehicleId: string; driverId?: string; startsAt: Date; endsAt: Date }, ownBatchId?: string) {
  const held = await tx.deliveryCapacityHold.findFirst({ where: {
    status: 'HELD', startsAt: { lt: input.endsAt }, endsAt: { gt: input.startsAt },
    ...(ownBatchId ? { batchId: { not: ownBatchId } } : {}),
    AND: [
      { OR: [{ vehicleId: input.vehicleId }, ...(input.driverId ? [{ driverId: input.driverId }] : [])] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    ],
  } });
  if (held) throw new ConflictException('Xe hoặc tài xế đang giữ năng lực cho một đợt hẹn giao');
}

export async function refreshBatchHolds(tx: Prisma.TransactionClient, batchId: string) {
  const active = await tx.deliveryAppointment.findMany({ where: { batchId, OR: [
    { status: 'CONFIRMED' }, { status: 'PENDING', expiresAt: { gt: new Date() } },
  ] }, select: { orderId: true, status: true } });
  const holds = await tx.deliveryCapacityHold.findMany({ where: { batchId, status: 'HELD' } });
  for (const hold of holds) {
    const remaining = active.filter(appointment => hold.orderIds.includes(appointment.orderId));
    await tx.deliveryCapacityHold.update({ where: { id: hold.id }, data: remaining.length === 0
      ? { status: 'RELEASED' }
      : remaining.some(appointment => appointment.status === 'CONFIRMED') ? { expiresAt: null } : {} });
  }
}
