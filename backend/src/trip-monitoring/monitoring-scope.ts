import { Prisma } from '@prisma/client';
import { Principal, branchFilter, tripFilter } from '../auth/access';

// Shared by monitoring and dashboard totals: all nested manifest references
// must remain inside the viewer's authorized scope.
export function monitoringScope(user: Principal, branchId?: string): Prisma.TripWhereInput {
  const scope = branchFilter(user, 'trips.read');
  return { AND: [tripFilter(user, 'trips.read', branchId), { stops: { every: { tasks: { every: { AND: [
    { OR: [{ orderId: null }, { order: { branchId: scope } }] },
    { OR: [{ packageId: null }, { package: { orderItem: { order: { branchId: scope } } } }] },
    { OR: [{ allocationId: null }, { allocation: { packageId: null } }, { allocation: { package: { orderItem: { order: { branchId: scope } } } } }] },
    { OR: [{ orderStopId: null }, { orderStop: { order: { branchId: scope } } }] },
  ] } } } } }] };
}
