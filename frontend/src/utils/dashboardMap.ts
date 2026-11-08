import type { MapMarker } from '../components/MapboxMap';
import type { Branch, Driver, Location, Trip, Vehicle } from '../types';

export type NetworkPointFilter = 'ALL' | 'DEPOT';
export type TripStatusFilter = 'ALL' | 'ACTIVE' | 'PLANNED' | 'COMPLETED';

export interface NetworkPointItem {
  id: string;
  entityId: string;
  code: string;
  name: string;
  pointType: 'DEPOT';
  typeLabel: string;
  tagColor: string;
  badgeClass: 'branch';
  address: string;
  latitude: number;
  longitude: number;
  branch?: Branch;
  vehicleCount?: number;
  driverCount?: number;
  totalHoldingSlots?: number;
  availableHoldingSlots?: number;
}

export interface DashboardKpiSummary {
  vehicles: {
    total: number;
    available: number;
    onTrip: number;
    maintenance: number;
    decommissioned: number;
    availablePercent: number;
  };
  drivers: {
    total: number;
    available: number;
    onDuty: number;
    restingOrLeave: number;
    availablePercent: number;
  };
  orders: {
    pendingCount: number;
  };
  trips: {
    total: number;
    active: number;
    planned: number;
    completed: number;
    cancelled: number;
    activePercent: number;
  };
}

const hasValidCoordinates = (latitude: number, longitude: number): boolean =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

export const buildNetworkMarkers = (
  branches: Branch[],
  _locations?: Location[],
): MapMarker[] => {
  return branches
    .filter((branch) => hasValidCoordinates(branch.latitude, branch.longitude))
    .map((branch) => ({
      id: `branch:${branch.id}`,
      latitude: branch.latitude,
      longitude: branch.longitude,
      title: branch.name,
      subtitle: `Chi nhánh vận tải · ${branch.address}`,
      type: 'DEPOT',
    }));
};

export const buildNetworkPointItems = (
  branches: Branch[],
  _locations?: Location[],
): NetworkPointItem[] => {
  return branches.map((branch) => ({
    id: `branch:${branch.id}`,
    entityId: branch.id,
    code: branch.code,
    name: branch.name,
    pointType: 'DEPOT',
    typeLabel: 'Chi nhánh',
    tagColor: 'geekblue',
    badgeClass: 'branch',
    address: branch.address,
    latitude: branch.latitude,
    longitude: branch.longitude,
    branch,
    vehicleCount: branch._count?.vehicles ?? 0,
    driverCount: branch._count?.drivers ?? 0,
  }));
};

export const filterNetworkPointItems = (
  items: NetworkPointItem[],
  _typeFilter: NetworkPointFilter,
  searchQuery: string,
): NetworkPointItem[] => {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => {
    return (
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.code.toLowerCase().includes(normalizedQuery) ||
      item.address.toLowerCase().includes(normalizedQuery) ||
      item.typeLabel.toLowerCase().includes(normalizedQuery)
    );
  });
};

export const scopeDashboardEntities = (params: {
  branches: Branch[];
  locations: Location[];
  trips: Trip[];
  branchId?: string;
}): {
  scopedBranches: Branch[];
  scopedLocations: Location[];
  scopedTrips: Trip[];
} => {
  const { branches, locations, trips, branchId } = params;
  if (!branchId) {
    return {
      scopedBranches: branches,
      scopedLocations: locations,
      scopedTrips: trips,
    };
  }

  return {
    scopedBranches: branches.filter((branch) => branch.id === branchId),
    scopedLocations: locations.filter(
      (location) => !location.managingBranchId || location.managingBranchId === branchId,
    ),
    scopedTrips: trips.filter(
      (trip) => !trip.vehicle?.homeBranchId || trip.vehicle.homeBranchId === branchId,
    ),
  };
};

const toSafePercent = (numerator: number, denominator: number): number => {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
};

export const computeDashboardKpis = (
  vehicles: Vehicle[],
  drivers: Driver[],
  pendingOrders: number,
  trips: Trip[],
): DashboardKpiSummary => {
  const availableVehicles = vehicles.filter((v) => v.status === 'AVAILABLE').length;
  const onTripVehicles = vehicles.filter((v) => v.status === 'ON_TRIP').length;
  const maintenanceVehicles = vehicles.filter((v) => v.status === 'MAINTENANCE').length;
  const decommissionedVehicles = vehicles.filter((v) => v.status === 'DECOMMISSIONED').length;

  const availableDrivers = drivers.filter((d) => d.status === 'AVAILABLE').length;
  const onDutyDrivers = drivers.filter((d) => d.status === 'ON_DUTY').length;
  const restingOrLeaveDrivers = drivers.filter(
    (d) => d.status === 'RESTING' || d.status === 'ON_LEAVE',
  ).length;

  const activeTrips = trips.filter(
    (t) => t.status === 'DISPATCHED' || t.status === 'IN_PROGRESS',
  ).length;
  const plannedTrips = trips.filter((t) => t.status === 'PLANNED' || t.status === 'DRAFT').length;
  const completedTrips = trips.filter((t) => t.status === 'COMPLETED').length;
  const cancelledTrips = trips.filter((t) => t.status === 'CANCELLED').length;

  return {
    vehicles: {
      total: vehicles.length,
      available: availableVehicles,
      onTrip: onTripVehicles,
      maintenance: maintenanceVehicles,
      decommissioned: decommissionedVehicles,
      availablePercent: toSafePercent(availableVehicles, vehicles.length),
    },
    drivers: {
      total: drivers.length,
      available: availableDrivers,
      onDuty: onDutyDrivers,
      restingOrLeave: restingOrLeaveDrivers,
      availablePercent: toSafePercent(availableDrivers, drivers.length),
    },
    orders: {
      pendingCount: pendingOrders,
    },
    trips: {
      total: trips.length,
      active: activeTrips,
      planned: plannedTrips,
      completed: completedTrips,
      cancelled: cancelledTrips,
      activePercent: toSafePercent(activeTrips, trips.length),
    },
  };
};

export const filterDashboardTrips = (
  trips: Trip[],
  statusFilter: TripStatusFilter,
): Trip[] => {
  if (statusFilter === 'ALL') return trips;
  if (statusFilter === 'ACTIVE') {
    return trips.filter((t) => t.status === 'DISPATCHED' || t.status === 'IN_PROGRESS');
  }
  if (statusFilter === 'PLANNED') {
    return trips.filter((t) => t.status === 'PLANNED' || t.status === 'DRAFT');
  }
  return trips.filter((t) => t.status === 'COMPLETED');
};

const tripStatusPresentationMap: Record<
  Trip['status'],
  { label: string; color: string }
> = {
  DRAFT: { label: 'Bản nháp', color: 'default' },
  PLANNED: { label: 'Đã lên lịch', color: 'gold' },
  DISPATCHED: { label: 'Đã điều lệnh', color: 'cyan' },
  IN_PROGRESS: { label: 'Đang vận chuyển', color: 'blue' },
  COMPLETED: { label: 'Hoàn thành', color: 'green' },
  CANCELLED: { label: 'Đã hủy', color: 'red' },
};

export const getTripStatusPresentation = (
  status: Trip['status'] | string,
): { label: string; color: string } => {
  if (status in tripStatusPresentationMap) {
    return tripStatusPresentationMap[status as Trip['status']];
  }
  return { label: status, color: 'default' };
};

export const formatTripWindow = (
  plannedStartTime?: string,
  plannedEndTime?: string,
  totalDurationMinutes?: number,
): { timeRange: string; durationLabel: string } => {
  if (!plannedStartTime || !plannedEndTime) {
    return { timeRange: 'Chưa xếp giờ', durationLabel: '—' };
  }
  const start = new Date(plannedStartTime);
  const end = new Date(plannedEndTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { timeRange: 'Chưa xếp giờ', durationLabel: '—' };
  }

  const timeFormatter = new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  });
  const timeRange = `${timeFormatter.format(start)} → ${timeFormatter.format(end)}`;
  const durationLabel =
    typeof totalDurationMinutes === 'number' && totalDurationMinutes > 0
      ? `${Math.round(totalDurationMinutes)} phút`
      : '—';

  return { timeRange, durationLabel };
};
