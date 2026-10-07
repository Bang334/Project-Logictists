import { BadRequestException } from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';

/**
 * Quyết định nghiệp vụ: khi lập lịch, xe luôn xuất phát từ kho đỗ được gán.
 * Vị trí GPS hiện tại chỉ dùng cho theo dõi, không dùng làm điểm xuất phát.
 */
export const VEHICLE_HOME_DEPOT_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  managingBranchId: true,
  latitude: true,
  longitude: true,
  active: true,
} satisfies Prisma.LocationSelect;

type HomeDepotLocation = Prisma.LocationGetPayload<{
  select: typeof VEHICLE_HOME_DEPOT_SELECT;
}>;

export type VehicleWithHomeDepot = {
  plateNumber: string;
  homeBranchId: string;
  homeDepotLocation: HomeDepotLocation | null;
};

export type VehiclePlanningStart = {
  source: 'HOME_DEPOT';
  locationId: string;
  locationCode: string;
  name: string;
  latitude: number;
  longitude: number;
};

export function resolveVehiclePlanningStart(
  vehicle: VehicleWithHomeDepot,
): VehiclePlanningStart {
  const depot = vehicle.homeDepotLocation;
  if (!depot) {
    throw new BadRequestException(
      `Xe ${vehicle.plateNumber} chưa được gán kho đỗ; không thể xác định điểm xuất phát`,
    );
  }
  if (!depot.active || depot.type !== LocationType.CENTRAL_WAREHOUSE) {
    throw new BadRequestException(
      `Kho đỗ ${depot.code} của xe ${vehicle.plateNumber} không còn là kho trung tâm đang hoạt động`,
    );
  }
  if (depot.managingBranchId !== vehicle.homeBranchId) {
    throw new BadRequestException(
      `Kho đỗ ${depot.code} không thuộc chi nhánh gốc của xe ${vehicle.plateNumber}`,
    );
  }
  return {
    source: 'HOME_DEPOT',
    locationId: depot.id,
    locationCode: depot.code,
    name: depot.name,
    latitude: depot.latitude,
    longitude: depot.longitude,
  };
}
