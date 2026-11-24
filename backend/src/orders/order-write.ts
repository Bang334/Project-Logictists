import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';

export const customerDraftOrigin: Prisma.OrderEventWhereInput = {
  eventType: 'ORDER_CREATED',
  toStatus: OrderStatus.DRAFT,
  payload: { path: ['source'], equals: 'CUSTOMER_APP' },
};

export function orderVersionConflict() {
  return new ConflictException({
    errorCode: 'ORDER_VERSION_CONFLICT',
    message: 'Đơn hàng đã thay đổi. Hãy tải lại trước khi tiếp tục.',
  });
}

// Matches TripsService's ORDER application lock so apply cannot race a PATCH.
const ORDER_APPLICATION_LOCK_NAMESPACE = 4103;

export async function lockOrder(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${ORDER_APPLICATION_LOCK_NAMESPACE}::int4, hashtext(${id}))
  `;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${id} FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new NotFoundException(`Không tìm thấy đơn hàng với ID ${id}`);
  }
}
