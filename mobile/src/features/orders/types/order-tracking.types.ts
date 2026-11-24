import type { OrderStatus } from './order.types';

export const CUSTOMER_TRACKING_STATUSES = [
  'NOT_ASSIGNED',
  'AVAILABLE',
] as const;

export type CustomerTrackingStatus =
  (typeof CUSTOMER_TRACKING_STATUSES)[number];

export interface CustomerVehicleLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  measuredAt: string;
  receivedAt: string;
  isStale: boolean;
}

export interface CustomerTrackedTrip {
  id: string;
  tripNumber: string;
  status: string;
  version: number;
  plannedDeliveryAt: string | null;
  etaSource: 'PLANNED';
  vehicleLocation: CustomerVehicleLocation | null;
}

export interface CustomerOrderTracking {
  orderId: string;
  orderStatus: OrderStatus;
  trackingStatus: CustomerTrackingStatus;
  trips: CustomerTrackedTrip[];
}
