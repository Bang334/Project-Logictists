import { VehicleType } from '@prisma/client';

export type VehicleCapabilities = Pick<
  VehicleType,
  | 'payloadCapacityKg'
  | 'volumeCapacityM3'
  | 'lengthCm'
  | 'widthCm'
  | 'heightCm'
  | 'fuelConsumptionLitersPer100Km'
  | 'loadFuelSurchargePercentAtFullPayload'
  | 'fixedOperatingCostPerTrip'
  | 'requiredLicenseCategory'
  | 'handlingCapabilities'
  | 'temperatureMode'
  | 'hasTailLift'
  | 'tollFactor'
>;

export type VehicleWithType = {
  vehicleTypeId: string;
  vehicleTypeRecord: VehicleType;
};

export function vehicleCapabilities(vehicle: VehicleWithType): VehicleCapabilities {
  return vehicle.vehicleTypeRecord;
}

export function vehicleTypeAllowsHazmat(type: {
  temperatureMode?: string | null;
  handlingCapabilities?: unknown;
}): boolean {
  if ((type.temperatureMode ?? '').toUpperCase() === 'HAZMAT') {
    return true;
  }
  const raw = type.handlingCapabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const record = raw as Record<string, unknown>;
  if (record.allowsHazmat === true || record.allows_hazmat === true) {
    return true;
  }
  return Array.isArray(record.modes) && record.modes.includes('HAZMAT');
}

/**
 * Keep the existing flat HTTP contract while VehicleType becomes the only
 * persistence source for shared capacity, geometry, fuel, and cost values.
 */
export function flattenVehicleType<T extends VehicleWithType>(vehicle: T) {
  const type = vehicle.vehicleTypeRecord;
  return {
    ...vehicle,
    vehicleType: type.name,
    payloadCapacityKg: type.payloadCapacityKg,
    volumeCapacityM3: type.volumeCapacityM3,
    lengthCm: type.lengthCm,
    widthCm: type.widthCm,
    heightCm: type.heightCm,
    fuelConsumptionLitersPer100Km: type.fuelConsumptionLitersPer100Km,
    loadFuelSurchargePercentAtFullPayload:
      type.loadFuelSurchargePercentAtFullPayload,
    fixedOperatingCostPerTrip: type.fixedOperatingCostPerTrip,
    temperatureMode: type.temperatureMode ?? 'DRY',
    hasTailLift: type.hasTailLift ?? false,
    tollFactor: type.tollFactor ?? 1.0,
  };
}
