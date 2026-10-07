import { OrderInput, OrderQuery, parseOrder, parseOrderPage } from '../types/orders';
import axios, { CanceledError, InternalAxiosRequestConfig } from 'axios';
import { AccountQuery, CreateAccount, parseAccount, parseAccountList } from '../types/accounts';
import {
  Branch,
  ApplyOptimizationResponseUI,
  AutomaticOptimizationResponseUI,
  Driver,
  LoadProfileResult,
  Location,
  OptimizationResultUI,
  OptimizationCandidateDetailUI,
  RunAutomaticOptimizationPayloadUI,
  Trip,
  Vehicle,
} from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const apiClient = axios.create({
  baseURL: API_URL,
});

const client = apiClient;

let currentToken: string | null = sessionStorage.getItem('tms_token');
let currentBranch: string | undefined;
let generation = 0;
let abort = new AbortController();
const requests = new WeakMap<InternalAxiosRequestConfig, { generation: number; token: string | null }>();
export function setApiSession(token: string | null, branchId?: string) { currentToken = token; currentBranch = branchId; }
export function resetRequests() { generation++; abort.abort(); abort = new AbortController(); }
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Không kết nối được backend. Vui lòng kiểm tra kết nối và thử lại.';
    const message: unknown = error.response.data?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every(m => typeof m === 'string')) return message.join('. ');
    if (error.response.status === 403) return 'Bạn không có quyền thực hiện thao tác này.';
    if (error.response.status === 401) return 'Phiên không hợp lệ hoặc đã hết hạn.';
  }
  return 'Không xử lý được yêu cầu. Vui lòng thử lại.';
}
client.interceptors.request.use(config => {
  if (currentToken && !config.headers.Authorization) config.headers.Authorization = `Bearer ${currentToken}`;
  if (currentBranch) config.headers['X-Branch-Id'] = currentBranch;
  if (!config.url?.startsWith('/auth/')) config.signal = abort.signal;
  requests.set(config, { generation, token: currentToken });
  return config;
});
client.interceptors.response.use(response => {
  const request = requests.get(response.config);
  if (!response.config.url?.startsWith('/auth/') && request?.generation !== generation) throw new CanceledError('Phạm vi đã thay đổi');
  return response;
}, (error: unknown) => {
  if (axios.isAxiosError(error) && error.config && !error.config.url?.endsWith('/login') && !error.config.url?.endsWith('/logout')) {
    const request = requests.get(error.config);
    if (request?.token === currentToken && request?.generation === generation) {
      if (error.response?.status === 401) window.dispatchEvent(new Event('tms:unauthorized'));
      if (error.response?.status === 403) window.dispatchEvent(new Event('tms:forbidden'));
    }
  }
  return Promise.reject(error);
});
export const authApi = {
  login: (username: string, password: string) => client.post('/auth/login', { username, password }, { timeout: 10000 }),
  getProfile: () => client.get<unknown>('/auth/profile', { timeout: 10000 }),
  logout: () => client.post('/auth/logout', {}, { timeout: 10000, headers: { Authorization: `Bearer ${currentToken}` } }),
};

export const accountsApi = {
  list: async (params: AccountQuery) => parseAccountList((await client.get<unknown>('/users', { params, timeout: 10000 })).data),
  create: async (data: CreateAccount) => parseAccount((await client.post<unknown>('/users', data, { timeout: 15000 })).data),
  lock: async (id: string) => parseAccount((await client.patch<unknown>(`/users/${id}/lock`, {}, { timeout: 10000 })).data),
};

export const branchesApi = {
  getAll: () => apiClient.get<Branch[]>('/branches'),
  getById: (id: string) => apiClient.get<Branch>(`/branches/${id}`),
  update: (id: string, data: Partial<Branch>) =>
    apiClient.patch<Branch>(`/branches/${id}`, data),
};

export const customersApi = {
  getAll: (branchId?: string) => client.get<Array<{ id: string; code: string; name: string }>>('/customers', { params: { branchId } }),
};

export const vehiclesApi = {
  getAll: (branchId?: string, status?: string) =>
    apiClient.get<Vehicle[]>('/vehicles', { params: { branchId, status } }),
  getAvailable: (branchId?: string) =>
    apiClient.get<Vehicle[]>('/vehicles/available', { params: { branchId } }),
  getById: (id: string) => apiClient.get<Vehicle>(`/vehicles/${id}`),
  update: (id: string, data: Partial<Vehicle>) =>
    apiClient.patch<Vehicle>(`/vehicles/${id}`, data),
};

export const driversApi = {
  getAll: (branchId?: string, status?: string) =>
    apiClient.get<Driver[]>('/drivers', { params: { branchId, status } }),
  getAvailable: (branchId?: string) =>
    apiClient.get<Driver[]>('/drivers/available', { params: { branchId } }),
  getById: (id: string) => apiClient.get<Driver>(`/drivers/${id}`),
  update: (id: string, data: Partial<Driver>) =>
    apiClient.patch<Driver>(`/drivers/${id}`, data),
};

export const ordersApi = {
  list: async (params: OrderQuery = {}) => parseOrderPage((await client.get<unknown>('/orders', { params })).data),
  getOne: async (id: string) => parseOrder((await client.get<unknown>(`/orders/${id}`)).data),
  getAvailableForDispatch: async (branchId?: string) => {
    const res = await client.get<unknown>('/orders/available-for-dispatch', { params: { branchId } });
    if (!Array.isArray(res.data)) throw new Error('Danh sách điều phối không hợp lệ');
    return { ...res, data: res.data.map(parseOrder) };
  },
  create: async (data: OrderInput, key: string) => parseOrder((await client.post<unknown>('/orders', data, { headers: { 'Idempotency-Key': key }, timeout: 25000 })).data),
  update: async (id: string, data: OrderInput & { version: number }, key: string) => parseOrder((await client.patch<unknown>(`/orders/${id}`, data, { headers: { 'Idempotency-Key': key }, timeout: 25000 })).data),
  confirm: async (id: string, version: number, key: string) => parseOrder((await client.post<unknown>(`/orders/${id}/confirm`, { version }, { headers: { 'Idempotency-Key': key }, timeout: 25000 })).data),
};

export const tripsApi = {
  getAll: (status?: string) =>
    apiClient.get<Trip[]>('/trips', { params: { status } }),
  getOne: (id: string) => apiClient.get<Trip>(`/trips/${id}`),
  create: (data: {
    idempotencyKey: string;
    vehicleId: string;
    driverId: string;
    plannedStartTime: string;
    plannedEndTime: string;
    startLocation: { address: string; latitude: number; longitude: number };
    endLocation: { address: string; latitude: number; longitude: number };
    orderIds: string[];
    orderedStopIds?: string[];
    notes?: string;
  }) => apiClient.post<Trip>('/trips', data),
  updatePlan: (id: string, data: {
    expectedVersion: number;
    vehicleId: string;
    driverId: string;
    plannedStartTime: string;
    plannedEndTime: string;
    startLocation: { address: string; latitude: number; longitude: number };
    endLocation: { address: string; latitude: number; longitude: number };
    orderedStopIds: string[];
    notes?: string;
  }) => apiClient.patch<Trip>(`/trips/${id}/plan`, data),
  publish: (id: string, expectedVersion: number) =>
    apiClient.patch<Trip>(`/trips/${id}/publish`, { expectedVersion }),
  getLoadProfile: (id: string) =>
    apiClient.get<LoadProfileResult>(`/trips/${id}/load-profile`),
  optimize: (data: { vehicleId: string; orderIds: string[] }) =>
    apiClient.post<OptimizationResultUI>('/trips/optimize', data),
  runAutomaticOptimization: (
    param: string | RunAutomaticOptimizationPayloadUI,
  ) => {
    const data = typeof param === 'string'
      ? { branchId: param, idempotencyKey: crypto.randomUUID() }
      : param;
    return apiClient.post<AutomaticOptimizationResponseUI>(
      '/trips/automatic-optimization',
      data,
    );
  },
  getAutomaticOptimizationJob: (jobId: string) =>
    apiClient.get<AutomaticOptimizationResponseUI>(
      `/trips/automatic-optimization/jobs/${jobId}`,
    ),
  listAutomaticOptimizationJobs: (branchId: string) =>
    apiClient.get<AutomaticOptimizationResponseUI[]>(
      '/trips/automatic-optimization/jobs',
      { params: { branchId } },
    ),
  cancelAutomaticOptimization: (jobId: string) =>
    apiClient.post<AutomaticOptimizationResponseUI>(
      `/trips/automatic-optimization/jobs/${jobId}/cancel`,
    ),
  getAutomaticOptimizationCandidate: (jobId: string, candidateNumber: number) =>
    apiClient.get<OptimizationCandidateDetailUI>(
      `/trips/automatic-optimization/jobs/${jobId}/candidates/${candidateNumber}`,
    ),
  exportAutomaticOptimizationCandidates: (jobId: string) =>
    apiClient.get<Blob>(
      `/trips/automatic-optimization/jobs/${jobId}/export`,
      { responseType: 'blob' },
    ),
  applyAutomaticOptimization: (jobId: string, candidateNumber: number) =>
    apiClient.post<ApplyOptimizationResponseUI>(
      `/trips/automatic-optimization/jobs/${jobId}/apply`,
      { candidateNumber },
    ),
};

export const locationsApi = {
  getAll: () => apiClient.get<Location[]>('/locations'),
};

export const mapboxApi = {
  geocode: async (query: string) => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token || !query.trim()) return [];
    try {
      const res = await axios.get(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
          query.trim(),
        )}.json?access_token=${token}&country=vn&limit=5`,
      );
      return (res.data.features || []).map((f: any) => ({
        address: f.place_name,
        latitude: f.center[1],
        longitude: f.center[0],
      }));
    } catch {
      return [];
    }
  },
  reverseGeocode: async (longitude: number, latitude: number) => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) return null;
    try {
      const res = await axios.get(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${longitude},${latitude}.json?access_token=${token}&country=vn&limit=1`,
      );
      if (res.data.features && res.data.features.length > 0) {
        return res.data.features[0].place_name as string;
      }
      return null;
    } catch {
      return null;
    }
  },
  getDrivingRoute: async (startLng: number, startLat: number, endLng: number, endLat: number) => {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) return null;
    try {
      const res = await axios.get(
        `https://api.mapbox.com/directions/v5/mapbox/driving/${startLng},${startLat};${endLng},${endLat}?geometries=geojson&overview=full&access_token=${token}`,
      );
      if (res.data.routes && res.data.routes.length > 0) {
        const route = res.data.routes[0];
        return {
          coordinates: route.geometry.coordinates as [number, number][],
          distanceMeters: route.distance as number,
          durationSeconds: route.duration as number,
        };
      }
      return null;
    } catch {
      return null;
    }
  },
};
