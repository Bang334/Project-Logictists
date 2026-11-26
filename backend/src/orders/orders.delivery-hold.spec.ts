import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccess } from '../auth/resource-access.service';
import { Principal } from '../auth/access';

describe('Order cancellation with delivery appointments', () => {
  it.each(['CONFIRMED', 'PENDING'])('blocks cancellation of a %s delivery hold without changing packages', async status => {
    const tx = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      processedCommand: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-1', status: 'CONFIRMED', version: 1 }), update: jest.fn() },
      package: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
      allocation: { findFirst: jest.fn().mockResolvedValue(null) },
      stopTask: { findFirst: jest.fn().mockResolvedValue(null) },
      orderEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      packageItem: { findFirst: jest.fn().mockResolvedValue(null) },
      deliveryAppointment: { findFirst: jest.fn().mockResolvedValue({ id: 'appointment-1', status }) },
    };
    const prisma = { $transaction: jest.fn(async fn => fn(tx)) };
    const user: Principal = {
      id: 'user-1', username: 'scheduler', fullName: 'Scheduler', sessionId: 'session-1',
      grants: [{ role: 'TRANSPORT_DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['orders.write'] }],
    };
    const service = new OrdersService(prisma as unknown as PrismaService, {} as ResourceAccess);
    await expect(service.cancel('order-1', { version: 1, reason: 'Customer request' }, user, 'cancel-command-0001'))
      .rejects.toMatchObject({ response: { code: 'ORDER_DELIVERY_HOLD_EXISTS' } });
    expect(tx.deliveryAppointment.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-1', OR: [{ status: 'CONFIRMED' }, { status: 'PENDING', expiresAt: { gt: expect.any(Date) } }] },
      select: { id: true },
    });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.package.updateMany).not.toHaveBeenCalled();
  });
});
