export const ORDER_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'ASSIGNED',
  'IN_TRANSIT',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderStatusFilter = OrderStatus | 'ALL';

export const PACKAGE_TYPES = ['CARTON', 'CRATE', 'PALLET'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export interface CustomerBranch {
  id: string;
  code: string;
  name: string;
}

export interface CustomerOrderStop {
  id: string;
  type: 'PICKUP' | 'DELIVERY';
  sequence: number;
  address: string;
  latitude: number;
  longitude: number;
  contactName: string;
  contactPhone: string;
  serviceDurationMinutes: number;
}

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  version: number;
  notes: string | null;
  totalPackages: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  orderedAt: string;
  createdAt: string;
  updatedAt: string;
  stops: CustomerOrderStop[];
}

export interface CustomerOrderItem {
  id: string;
  description: string;
  packageType: string;
  quantity: number;
  lineWeightKg: number;
  unitWeightKg: number | null;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  lineVolumeM3: number;
  unitVolumeM3: number | null;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  items: CustomerOrderItem[];
}

export interface CustomerOrderPage {
  items: CustomerOrderSummary[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface CreateOrderStopRequest {
  address: string;
  latitude: number;
  longitude: number;
  contactName: string;
  contactPhone: string;
}

export interface CreateOrderItemRequest {
  description: string;
  packageType: PackageType;
  quantity: number;
  unitWeightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface CreateCustomerOrderPayload {
  branchId: string;
  pickup: CreateOrderStopRequest;
  delivery: CreateOrderStopRequest;
  items: CreateOrderItemRequest[];
  notes?: string;
}

export interface CreateCustomerOrderRequest
  extends CreateCustomerOrderPayload {
  idempotencyKey: string;
}

export interface CreatedCustomerOrder {
  id: string;
  orderNumber: string;
  status: 'DRAFT';
  version: number;
  totalPackages: number;
  totalWeightKg: number;
  totalVolumeM3: number;
  createdAt: string;
  orderedAt: string;
  branch: CustomerBranch;
}

export interface OrderStopFormValues {
  address: string;
  latitude: string;
  longitude: string;
  contactName: string;
  contactPhone: string;
}

export interface OrderItemFormValues {
  clientId: string;
  description: string;
  packageType: PackageType;
  quantity: string;
  unitWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface CreateOrderFormValues {
  branchId: string;
  pickup: OrderStopFormValues;
  delivery: OrderStopFormValues;
  items: OrderItemFormValues[];
  notes: string;
}

export type CreateOrderFormErrors = Record<string, string>;

export type CreateOrderValidationResult =
  | { success: true; data: CreateCustomerOrderPayload }
  | { success: false; errors: CreateOrderFormErrors };
