export interface User {
  id: string;
  username: string;
  fullName: string;
  role: 'ADMIN' | 'DISPATCHER' | 'DRIVER';
  branchId?: string;
  branch?: Branch;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  phone?: string;
  timezone: string;
  _count?: {
    vehicles: number;
    drivers: number;
  };
}

export interface Vehicle {
  id: string;
  plateNumber: string;
  model: string;
  vehicleType: string;
  homeBranchId: string;
  homeBranch?: Branch;
  payloadCapacityKg: number;
  volumeCapacityM3: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  status: 'AVAILABLE' | 'MAINTENANCE' | 'ON_TRIP' | 'DECOMMISSIONED';
  currentLatitude?: number;
  currentLongitude?: number;
}

export interface Driver {
  id: string;
  fullName: string;
  citizenId: string;
  phone: string;
  licenseNumber: string;
  licenseClass: string;
  licenseExpiry: string;
  homeBranchId: string;
  homeBranch?: Branch;
  status: 'AVAILABLE' | 'ON_DUTY' | 'ON_LEAVE' | 'RESTING';
}

export interface OrderItem {
  id: string;
  sku?: string;
  description: string;
  packageType: string;
  quantity: number;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  volumeM3: number;
}

export interface OrderStop {
  id: string;
  orderId: string;
  type: 'PICKUP' | 'DELIVERY';
  sequence: number;
  address: string;
  latitude: number;
  longitude: number;
  contactName: string;
  contactPhone: string;
  windowStart?: string;
  windowEnd?: string;
  serviceDurationMinutes: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customer: {
    id: string;
    code: string;
    name: string;
    phone?: string;
  };
  status: 'DRAFT' | 'CONFIRMED' | 'ASSIGNED' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED';
  totalWeightKg: number;
  totalVolumeM3: number;
  totalPackages: number;
  version: number;
  notes?: string;
  stops: OrderStop[];
  items: OrderItem[];
  createdAt: string;
}

export interface TripStop {
  id: string;
  sequence: number;
  stopType: 'DEPOT_START' | 'PICKUP' | 'DELIVERY' | 'DEPOT_END';
  address: string;
  latitude: number;
  longitude: number;
  contactName?: string;
  contactPhone?: string;
  plannedArrivalTime?: string;
  plannedDepartureTime?: string;
  status: string;
  tasks: Array<{
    id: string;
    action: 'LOAD' | 'UNLOAD';
    plannedQuantity: number;
    actualQuantity?: number;
  }>;
}

export interface Trip {
  id: string;
  tripNumber: string;
  vehicleId: string;
  vehicle: Vehicle;
  status: 'DRAFT' | 'PLANNED' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  plannedStartTime: string;
  plannedEndTime: string;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  routeGeometry?: string;
  notes?: string;
  stops: TripStop[];
  assignments: Array<{
    id: string;
    driver: Driver;
    role: string;
  }>;
  createdAt: string;
}

export interface LegLoadStatus {
  stopIndex: number;
  stopAddress: string;
  stopType: 'PICKUP' | 'DELIVERY';
  action: 'LOAD' | 'UNLOAD';
  deltaWeightKg: number;
  deltaVolumeM3: number;
  currentWeightKg: number;
  currentVolumeM3: number;
  weightUtilizationPercent: number;
  volumeUtilizationPercent: number;
}

export interface LoadProfileResult {
  isValid: boolean;
  loadProfile: LegLoadStatus[];
  maxWeightKg: number;
  maxVolumeM3: number;
  errors: string[];
}
