import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertPermission, PermissionCode, Principal, tripFilter } from './access';

@Injectable()
export class ResourceAccess {
  constructor(private readonly prisma: PrismaService) {}
  async branch(user: Principal, permission: PermissionCode, id: string, db: Prisma.TransactionClient = this.prisma) {
    assertPermission(user, permission, id);
    if (!await db.branch.findFirst({ where: { id, active: true } })) throw new NotFoundException('Chi nhánh không tồn tại hoặc ngừng hoạt động');
  }
  async customer(user: Principal, id: string, branchId: string, db: Prisma.TransactionClient = this.prisma) {
    assertPermission(user, 'customers.read', branchId);
    const company = user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.permissions.includes('customers.read'));
    const customer = await db.customer.findFirst({ where: { id, ...(company ? {} : { orders: { some: { branchId } } }) } });
    if (!customer) throw new ForbiddenException('Khách hàng không nằm trong quan hệ chi nhánh được phép');
  }
  async trip(user: Principal, id: string, permission: PermissionCode, db: Prisma.TransactionClient = this.prisma) {
    const trip = await db.trip.findFirst({ where: { id, ...tripFilter(user, permission) } });
    if (!trip) throw new NotFoundException('Chuyến không tồn tại hoặc ngoài phạm vi được cấp');
    return trip;
  }
  async tripInputs(user: Principal, branchId: string, input: { vehicleId: string; driverId?: string; orderIds: string[]; orderedStopIds?: string[] }, db: Prisma.TransactionClient = this.prisma) {
    // Hold ownership stable until the enclosing write commits. Outside a transaction these
    // locks are advisory checks only; create/apply call again in their write transaction.
    await db.$queryRaw(Prisma.sql`SELECT id FROM vehicles WHERE id = ${input.vehicleId} FOR SHARE`);
    if (input.driverId) await db.$queryRaw(Prisma.sql`SELECT id FROM drivers WHERE id = ${input.driverId} FOR SHARE`);
    if (input.orderIds.length) await db.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id IN (${Prisma.join(input.orderIds)}) ORDER BY id FOR SHARE`);
    await this.branch(user, 'trips.plan', branchId, db);
    const [vehicle, driver, orders] = await Promise.all([
      db.vehicle.findFirst({ where: { id: input.vehicleId, homeBranchId: branchId } }),
      input.driverId ? db.driver.findFirst({ where: { id: input.driverId, homeBranchId: branchId } }) : Promise.resolve(true),
      db.order.findMany({ where: { id: { in: input.orderIds }, branchId }, select: { id: true, stops: { select: { id: true } } } }),
    ]);
    if (!vehicle || !driver || orders.length !== new Set(input.orderIds).size) throw new ForbiddenException('Xe, tài xế hoặc đơn hàng ngoài phạm vi được cấp');
    const stopIds = new Set(orders.flatMap(o => o.stops.map(s => s.id)));
    if (input.orderedStopIds?.some(id => !stopIds.has(id))) throw new ForbiddenException('Điểm dừng không thuộc các đơn được chọn');
  }
}
