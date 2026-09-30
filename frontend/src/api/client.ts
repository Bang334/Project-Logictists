import axios, { CanceledError, InternalAxiosRequestConfig } from 'axios';
import { AccountQuery, CreateAccount, parseAccount, parseAccountList } from '../types/accounts';
import {
  Branch,
  ApplyOptimizationResponseUI,
  AutomaticOptimizationResponseUI,
  Driver,
  LoadProfileResult,
  OptimizationResultUI,
  Order,
  Trip,
  Vehicle,
} from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const client = axios.create({
  baseURL: API_URL,
});

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
  getAll: () => client.get<Branch[]>('/branches'),
  getById: (id: string) => client.get<Branch>(`/branches/${id}`),
  update: (id: string, data: Partial<Branch>) =>
    client.patch<Branch>(`/branches/${id}`, data),
};

export const customersApi = {
  getAll: () => client.get<Array<{ id: string; code: string; name: string }>>('/customers'),
};

export const vehiclesApi = {
  getAll: (branchId?: string, status?: string) =>
    client.get<Vehicle[]>('/vehicles', { params: { branchId, status } }),
  getAvailable: (branchId?: string) =>
    client.get<Vehicle[]>('/vehicles/available', { params: { branchId } }),
  getById: (id: string) => client.get<Vehicle>(`/vehicles/${id}`),
  update: (id: string, data: Partial<Vehicle>) =>
    client.patch<Vehicle>(`/vehicles/${id}`, data),
};

export const driversApi = {
  getAll: (branchId?: string, status?: string) =>
    client.get<Driver[]>('/drivers', { params: { branchId, status } }),
  getAvailable: (branchId?: string) =>
    client.get<Driver[]>('/drivers/available', { params: { branchId } }),
  getById: (id: string) => client.get<Driver>(`/drivers/${id}`),
  update: (id: string, data: Partial<Driver>) =>
    client.patch<Driver>(`/drivers/${id}`, data),
};

export const ordersApi = {
  getAll: (params?: { status?: string; customerId?: string; branchId?: string } | string) => {
    if (typeof params === 'string') {
      return client.get<Order[]>('/orders', { params: { status: params } });
    }
    return client.get<Order[]>('/orders', { params });
  },
  getAvailableForDispatch: (branchId?: string) =>
    client.get<Order[]>('/orders/available-for-dispatch', { params: { branchId } }),
  create: (data: any) => client.post<Order>('/orders', data),
  update: (id: string, data: any) => client.patch<Order>(`/orders/${id}`, data),
};

export const tripsApi = {
  getAll: (status?: string) =>
    client.get<Trip[]>('/trips', { params: { status } }),
  getOne: (id: string) => client.get<Trip>(`/trips/${id}`),
  create: (data: {
    vehicleId: string;
    driverId: string;
    plannedStartTime: string;
    plannedEndTime: string;
    orderIds: string[];
    orderedStopIds?: string[];
    notes?: string;
  }) => client.post<Trip>('/trips', data),
  publish: (id: string) => client.patch<Trip>(`/trips/${id}/publish`),
  getLoadProfile: (id: string) =>
    client.get<LoadProfileResult>(`/trips/${id}/load-profile`),
  optimize: (data: { vehicleId: string; orderIds: string[] }) =>
    client.post<OptimizationResultUI>('/trips/optimize', data),
  runAutomaticOptimization: (branchId: string) =>
    client.post<AutomaticOptimizationResponseUI>('/trips/automatic-optimization', {
      branchId,
    }),
  applyAutomaticOptimization: (data: AutomaticOptimizationResponseUI) =>
    client.post<ApplyOptimizationResponseUI>(
      '/trips/automatic-optimization/apply',
      data,
    ),
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

