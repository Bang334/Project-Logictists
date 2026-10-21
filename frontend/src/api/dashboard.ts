import { apiClient } from './client';

function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Contract Dashboard không hợp lệ');
  return v as Record<string, unknown>;
}
function text(v: unknown): string { if (typeof v !== 'string') throw new Error('Contract Dashboard: thiếu chuỗi'); return v; }
function count(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Contract Dashboard: số đếm sai'); return v; }
export const metricLabels = {
  candidateOrders: 'Đơn chờ kiểm tra điều phối',
  plannedTrips: 'Chuyến đã lập kế hoạch',
  dispatchedTrips: 'Chuyến đã phát hành',
  activeTrips: 'Chuyến đang thực hiện',
  availableVehicles: 'Xe có trạng thái AVAILABLE',
  availableDrivers: 'Tài xế có trạng thái AVAILABLE',
  departedTrips: 'Chuyến có mốc khởi hành thực tế trong kỳ',
  completedTrips: 'Chuyến hoàn tất có mốc kết thúc trong kỳ',
};
export const issueLabels = {
  reviewOrders: 'Đơn xác nhận cần đối soát kiện',
  expiredDrivers: 'Bằng lái đã hết hạn',
  blockedVehicles: 'Xe có lịch không khả dụng hiện tại',
};
export type Metric = keyof typeof metricLabels;
export type Issue = keyof typeof issueLabels;
export type ItemMetric = 'candidateOrders' | 'availableVehicles' | 'availableDrivers' | Issue;
function counts<K extends string>(value: unknown, labels: Record<K, string>): Record<K, number | null> {
  const input = record(value);
  // Keys come from the closed contract; every value is validated here.
  return Object.fromEntries(Object.keys(labels).map(k => [k, input[k] === null ? null : count(input[k])])) as Record<K, number | null>;
}
export function parseSummary(v: unknown) {
  const r = record(v);
  return { fetchedAt: text(r.fetchedAt), timezone: text(r.timezone), branchId: r.branchId === null ? null : text(r.branchId),
    from: text(r.from), to: text(r.to), metrics: counts(r.metrics, metricLabels), issues: counts(r.issues, issueLabels),
    missingCompletionTime: r.missingCompletionTime === null ? null : count(r.missingCompletionTime) };
}
function parseItem(v: unknown) {
  const r = record(v), kind = text(r.kind);
  if (!['order', 'vehicle', 'driver'].includes(kind)) throw new Error('Contract Dashboard: đối tượng sai');
  return { id: text(r.id), label: text(r.label), status: text(r.status), branch: text(r.branch), updatedAt: text(r.updatedAt),
    evidence: text(r.evidence), evidenceAt: text(r.evidenceAt), kind };
}
function parseItems(v: unknown) {
  const r = record(v);
  if (!Array.isArray(r.items)) throw new Error('Contract Dashboard: thiếu danh sách');
  return { items: r.items.map(parseItem), total: count(r.total), page: count(r.page), pageSize: count(r.pageSize), fetchedAt: text(r.fetchedAt) };
}
export type DashboardSummary = ReturnType<typeof parseSummary>;
export type DashboardItems = ReturnType<typeof parseItems>;
export type DashboardItem = DashboardItems['items'][number];
export const dashboardApi = {
  summary: async (params: { from: string; to: string; branchId?: string }) => parseSummary((await apiClient.get<unknown>('/dashboard/summary', { params, timeout: 12000 })).data),
  items: async (params: { metric: ItemMetric; page: number; branchId?: string }) => parseItems((await apiClient.get<unknown>('/dashboard/items', { params, timeout: 12000 })).data),
};
