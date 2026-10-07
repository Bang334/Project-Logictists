type UnknownRecord = Record<string, unknown>;

export interface FinancialSummary {
  orderCount: number;
  grossSales: number;
  payments: number;
  refunds: number;
  netRevenue: number;
}

export interface FunnelSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface FulfillmentPerformance {
  totalFulfillments: number;
  totalTasks: number;
  completedTasks: number;
  shortPickTasks: number;
  completionRate: number;
}

export interface OccupancySummary {
  locationId: string;
  totalSlots: number;
  occupiedSlots: number;
  availableSlots: number;
  occupancyRate: number;
}

const asRecord = (value: unknown, label: string): UnknownRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} phải là object`);
  }
  return value as UnknownRecord;
};

const asNumber = (value: unknown, label: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} phải là số hữu hạn`);
  }
  return parsed;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} phải là chuỗi không rỗng`);
  }
  return value;
};

export const parseFinancialSummary = (value: unknown): FinancialSummary => {
  const data = asRecord(value, 'financial-summary');
  return {
    orderCount: asNumber(data.orderCount, 'financial-summary.orderCount'),
    grossSales: asNumber(data.grossSales, 'financial-summary.grossSales'),
    payments: asNumber(data.payments, 'financial-summary.payments'),
    refunds: asNumber(data.refunds, 'financial-summary.refunds'),
    netRevenue: asNumber(data.netRevenue, 'financial-summary.netRevenue'),
  };
};

export const parseFunnelSummary = (value: unknown): FunnelSummary => {
  const data = asRecord(value, 'funnel');
  const statuses = asRecord(data.byStatus, 'funnel.byStatus');
  return {
    total: asNumber(data.total, 'funnel.total'),
    byStatus: Object.fromEntries(
      Object.entries(statuses).map(([status, count]) => [status, asNumber(count, `funnel.byStatus.${status}`)]),
    ),
  };
};

export const parseFulfillmentPerformance = (value: unknown): FulfillmentPerformance => {
  const data = asRecord(value, 'fulfillment-performance');
  return {
    totalFulfillments: asNumber(data.totalFulfillments, 'fulfillment-performance.totalFulfillments'),
    totalTasks: asNumber(data.totalTasks, 'fulfillment-performance.totalTasks'),
    completedTasks: asNumber(data.completedTasks, 'fulfillment-performance.completedTasks'),
    shortPickTasks: asNumber(data.shortPickTasks, 'fulfillment-performance.shortPickTasks'),
    completionRate: asNumber(data.completionRate, 'fulfillment-performance.completionRate'),
  };
};

const parseOccupancyItem = (value: unknown): OccupancySummary => {
  const data = asRecord(value, 'occupancy');
  return {
    locationId: asString(data.locationId, 'occupancy.locationId'),
    totalSlots: asNumber(data.totalSlots, 'occupancy.totalSlots'),
    occupiedSlots: asNumber(data.occupiedSlots, 'occupancy.occupiedSlots'),
    availableSlots: asNumber(data.availableSlots, 'occupancy.availableSlots'),
    occupancyRate: asNumber(data.occupancyRate, 'occupancy.occupancyRate'),
  };
};

export const parseOccupancyRows = (value: unknown): OccupancySummary[] => {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map(parseOccupancyItem);
};
