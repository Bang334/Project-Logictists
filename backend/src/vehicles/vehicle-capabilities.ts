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
>;

export type VehicleWithType = {
  vehicleTypeId: string;
  vehicleTypeRecord: VehicleType;
};

export function vehicleCapabilities(vehicle: VehicleWithType): VehicleCapabilities {
  return vehicle.vehicleTypeRecord;
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
  };
}
