import * as dotenv from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { createDriverDemoTrip, seedDriverMobile } from './seed-driver-mobile';
import { assertFixedLoadingPath } from '../src/driver-mobile/pickup-loading-guard';

// Explicit two-cube demo, not a production publish/optimizer bypass. Only call on
// a newly created DEMO fixture before start. Never rewrite an execution snapshot.
export async function preparePickupFixture(tx: Prisma.TransactionClient, tripId: string) {
  const trip = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, include: { vehicle: true, executionSnapshot: true,
    stops: { orderBy: { sequence: 'asc' }, include: { tasks: { include: { allocation: { include: { package: true } } } } } }, LoadPlan: true } });
  if (trip.notes !== '[DEMO MOBILE] Execution fixture; not a solver validation') throw new Error('Only demo fixture allowed');
  if (trip.LoadPlan.length) return;
  if (trip.executionSnapshot || trip.status !== 'DISPATCHED') throw new Error('Cannot modify an executed fixture');
  const original = trip.stops[0]?.tasks[0]?.allocation;
  if (!original?.package || trip.stops.length !== 2 || trip.stops.some(s => s.tasks.length !== 1)) throw new Error('Unexpected fixture');
  const first = original.package;
  const second = await tx.package.create({ data: { orderItemId: first.orderItemId, orderId: first.orderId, packageCode: first.packageCode + '-K02',
    lengthMm: 200, widthMm: 200, heightMm: 200, weightG: 10000n, allowedOrientations: ['DEFAULT'], measurementSource: 'DEMO', status: 'ALLOCATED' } });
  await tx.orderItem.update({ where: { id: original.orderItemId }, data: { quantity: 2 } });
  if (first.orderId) await tx.order.update({ where: { id: first.orderId }, data: { totalPackages: 2, totalWeightKg: 20, totalVolumeM3: 0.016 } });
  const allocation = await tx.allocation.create({ data: { tripId, orderItemId: original.orderItemId, packageId: second.id, allocatedQuantity: 1 } });
  const plan = await tx.loadPlan.create({ data: { tripId, revision: 1, initialStateSnapshot: { placements: [] },
    geometrySnapshot: { vehicleId: trip.vehicleId, lengthMm: trip.vehicle.lengthCm * 10, widthMm: trip.vehicle.widthCm * 10, heightMm: trip.vehicle.heightCm * 10, doorPosition: 'REAR', demo: true },
    validationStatus: 'VALID', validatorVersion: 'DEMO-fixed-cubes-check-v1', inputHash: 'DEMO-only-not-optimizer' } });
  const placements = [first, second].map((p, i) => ({ packageId: p.id, xMm: i * 200, yMm: 0, zMm: 0, orientation: 'VALIDATED', effectiveLengthMm: 200, effectiveWidthMm: 200, effectiveHeightMm: 200 }));
  placements.forEach((p, i) => assertFixedLoadingPath(p, placements.slice(0, i), trip.vehicle));
  if (trip.vehicle.payloadCapacityKg < 20) throw new Error('Fixture payload too small');
  for (const [i, stop] of trip.stops.entries()) {
    const added = await tx.stopTask.create({ data: { tripStopId: stop.id, allocationId: allocation.id, orderStopId: stop.tasks[0].orderStopId, action: stop.tasks[0].action, plannedQuantity: 1 } });
    await tx.loadPlanStep.create({ data: { loadPlanId: plan.id, stepNumber: i + 1, operationType: i === 0 ? 'PICKUP' : 'DELIVERY',
      tasks: { connect: [{ id: stop.tasks[0].id }, { id: added.id }] }, validationResult: { is_valid: true, demo: true },
      placements: { create: i === 0 ? placements : [] } } });
  }
}

export async function seedDriverPickup(db: PrismaClient) {
  const drivers = await seedDriverMobile(db);
  for (const [index, driver] of drivers.entries()) {
    await db.$transaction(async tx => {
      const base = await tx.trip.findUniqueOrThrow({ where: { id: driver.tripId } });
      const trip = await createDriverDemoTrip(tx, `PICKUP-${index === 0 ? 'A' : 'B'}`, base.managingBranchId ?? '', base.vehicleId, driver.driverId);
      await preparePickupFixture(tx, trip.id);
    }, { timeout: 30000 });
  }
}
if (require.main === module) {
  dotenv.config(); const db = new PrismaClient();
  seedDriverPickup(db).then(() => console.log('Pickup demo ready; existing accounts, grants and results preserved.'))
    .catch(() => { console.error('Pickup seed failed; check demo collisions and execution state.'); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
