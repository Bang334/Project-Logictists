import { apiClient } from './client';

type Decoder<T> = (value: unknown) => T;
const str: Decoder<string> = v => { if (typeof v !== 'string') throw new Error('Contract chuyến: cần chuỗi'); return v; };
const num: Decoder<number> = v => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Contract chuyến: cần số'); return v; };
const nullable = <T,>(read: Decoder<T>): Decoder<T | null> => v => v === null ? null : read(v);
const array = <T,>(read: Decoder<T>): Decoder<T[]> => v => { if (!Array.isArray(v)) throw new Error('Contract chuyến: cần danh sách'); return v.map(read); };
function object<S extends Record<string, Decoder<unknown>>>(shape: S): Decoder<{ [K in keyof S]: ReturnType<S[K]> }> {
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Contract chuyến không hợp lệ');
    // Each field is decoded at this boundary; assertion only reconstructs the mapped generic.
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(shape).map(([key, read]) => [key, read(input[key])])) as { [K in keyof S]: ReturnType<S[K]> };
  };
}
const named = object({ id: str, name: str });
const event = object({ id: str, eventType: str, tripStopId: nullable(str), stopTaskId: nullable(str), occurredAt: str, receivedAt: str, sourceSnapshotId: nullable(str) });
const pod = object({ id: str, uploadStatus: str, mediaType: str, sizeBytes: nullable(num), capturedAt: nullable(str), uploadedAt: nullable(str), discardedAt: nullable(str) });
const header = {
  id: str, tripNumber: str, status: str, version: num, updatedAt: str,
  plannedStartTime: str, plannedEndTime: str, actualStartTime: nullable(str), actualEndTime: nullable(str),
  managingBranch: nullable(named), vehicle: object({ id: str, plateNumber: str }),
  assignments: array(object({ id: str, status: str, role: str, startTime: str, endTime: str, actualEndTime: nullable(str), respondedAt: nullable(str), rejectionReason: nullable(str), startStopId: nullable(str), endStopId: nullable(str), driver: object({ id: str, fullName: str }) })),
};
const row = object({ ...header, stopCount: num, completedStopCount: num, packageCount: num, deliveredCount: num });
const page = object({ items: array(row), total: num, page: num, pageSize: num, fetchedAt: str });
const detail = object({ ...header, fetchedAt: str, routeGeometry: nullable(str),
  snapshot: nullable(object({ id: str, sourceTripVersion: num, createdAt: str })),
  stops: array(object({ id: str, sequence: num, stopType: str, address: str, status: str,
    plannedArrivalTime: nullable(str), plannedDepartureTime: nullable(str), actualArrivalTime: nullable(str), actualDepartureTime: nullable(str),
    tasks: array(object({ id: str, action: str, plannedQuantity: num, actualQuantity: nullable(num),
      package: nullable(object({ id: str, packageCode: str })),
      order: nullable(object({ id: str, orderNumber: str })),
      orderStop: nullable(object({ windowStart: nullable(str), windowEnd: nullable(str), windowBasis: nullable(str), serviceDurationMinutes: num })),
      pickupResult: nullable(object({ outcome: str, reason: nullable(str), packageId: str, event })),
      deliveryState: nullable(object({ state: str, lastEvent: event })),
      deliveryResults: array(object({ id: str, result: str, reason: nullable(str), packageId: str,
        deliveryAttempt: object({ id: str, tripStopId: str, attemptNumber: num, occurredAt: str, recipientName: nullable(str), podFiles: array(pod) }),
      })),
    })),
  })),
  loadPlan: nullable(object({ id: str, revision: num, validationStatus: str, validatorVersion: str,
    steps: array(object({ id: str, stepNumber: num, operationType: str, tasks: array(object({ id: str })),
      placements: array(object({ packageId: str, xMm: num, yMm: num, zMm: num, orientation: str, effectiveLengthMm: num, effectiveWidthMm: num, effectiveHeightMm: num })),
    })),
  })),
});
const events = object({ items: array(event), total: num, page: num, pageSize: num, version: num });
export type MonitoringRow = ReturnType<typeof row>;
export type MonitoringDetail = ReturnType<typeof detail>;
export type MonitoringPage = ReturnType<typeof page>;
export type MonitoringEvents = ReturnType<typeof events>;
export type MonitoringPod = ReturnType<typeof pod>;
export const monitoringApi = {
  resources: async (search = '') => object({ vehicles: array(object({ id: str, plateNumber: str })), drivers: array(object({ id: str, fullName: str })) })((await apiClient.get<unknown>('/trip-monitoring/resources', { params: { search }, timeout: 12000 })).data),
  list: async (params: Record<string, string | number | undefined>) => page((await apiClient.get<unknown>('/trip-monitoring', { params, timeout: 12000 })).data),
  detail: async (id: string) => detail((await apiClient.get<unknown>(`/trip-monitoring/${encodeURIComponent(id)}`, { timeout: 12000 })).data),
  events: async (id: string, pageNumber: number) => events((await apiClient.get<unknown>(`/trip-monitoring/${encodeURIComponent(id)}/events`, { params: { page: pageNumber, pageSize: 20 }, timeout: 12000 })).data),
  pod: async (tripId: string, id: string): Promise<Blob> => {
    const response = await apiClient.get<Blob>(`/trip-monitoring/${encodeURIComponent(tripId)}/pod/${encodeURIComponent(id)}`, { responseType: 'blob', timeout: 15000 });
    if (!(response.data instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(response.data.type)) throw new Error('POD: Nội dung không hợp lệ');
    return response.data;
  },
};
