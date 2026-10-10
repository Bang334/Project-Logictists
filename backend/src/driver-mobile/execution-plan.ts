import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';

// Deliberately excludes mutable execution projections (status, actuals, version).
const routeSelect = {
  id: true, vehicleId: true, plannedStartTime: true, plannedEndTime: true,
  stops: { orderBy: { sequence: 'asc' }, select: {
    id: true, sequence: true, stopType: true, address: true, latitude: true, longitude: true,
    plannedArrivalTime: true, plannedDepartureTime: true,
    tasks: { orderBy: { id: 'asc' }, select: {
      id: true, action: true, plannedQuantity: true, allocationId: true, orderStopId: true,
    } },
  } },
  assignments: { orderBy: { id: 'asc' }, select: {
    id: true, driverId: true, startStopId: true, endStopId: true, startTime: true, endTime: true, role: true,
  } },
} satisfies Prisma.TripSelect;

export function supportsPickup(plan: Prisma.JsonValue) {
  return !!plan && typeof plan === 'object' && !Array.isArray(plan) && plan.schemaVersion === 2;
}
export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item));
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
  return value;
}
export function planHash(value: unknown, version2 = true) {
  const json = jsonValue(value);
  return createHash('sha256').update(JSON.stringify(version2 ? sorted(json) : json)).digest('hex');
}
export async function readExecutionPlan(tx: Prisma.TransactionClient, tripId: string, version2: boolean) {
  const route = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: routeSelect });
  if (!version2) return route;
  const cargo = await tx.trip.findUniqueOrThrow({ where: { id: tripId }, select: {
    vehicle: { select: { lengthCm: true, widthCm: true, heightCm: true, payloadCapacityKg: true } },
    allocations: { orderBy: { id: 'asc' }, select: {
      id: true, packageId: true, orderItemId: true, allocatedQuantity: true, legNumber: true,
      package: { select: { id: true, orderItemId: true, packageCode: true, lengthMm: true, widthMm: true, heightMm: true, weightG: true, allowedOrientations: true } },
    } },
    LoadPlan: { orderBy: { revision: 'desc' }, take: 1, include: {
      steps: { orderBy: { stepNumber: 'asc' }, include: { tasks: { orderBy: { id: 'asc' }, select: { id: true } }, placements: { orderBy: { packageId: 'asc' } } } },
    } },
  } });
  return { ...route, schemaVersion: 2, pickupPlan: cargo };
}
