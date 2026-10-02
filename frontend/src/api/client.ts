import axios from 'axios';
import {
  Branch,
  ApplyOptimizationResponseUI,
  AutomaticOptimizationResponseUI,
  Driver,
  LoadProfileResult,
  Location,
  OptimizationResultUI,
  Order,
  RunAutomaticOptimizationPayloadUI,
  Trip,
  Vehicle,
} from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const apiClient = axios.create({
  baseURL: API_URL,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('tms_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const authApi = {
  login: (username: string, pass: string) =>
    apiClient.post('/auth/login', { username, pass }),
  getProfile: () => apiClient.get('/auth/profile'),
};

export const branchesApi = {
  getAll: () => apiClient.get<Branch[]>('/branches'),
  getById: (id: string) => apiClient.get<Branch>(`/branches/${id}`),
  update: (id: string, data: Partial<Branch>) =>
    apiClient.patch<Branch>(`/branches/${id}`, data),
};

export const customersApi = {
  getAll: () => apiClient.get<Array<{ id: string; code: string; name: string }>>('/customers'),
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
  getAll: (params?: { status?: string; customerId?: string; branchId?: string } | string) => {
    if (typeof params === 'string') {
      return apiClient.get<Order[]>('/orders', { params: { status: params } });
    }
    return apiClient.get<Order[]>('/orders', { params });
  },
  getAvailableForDispatch: (branchId?: string) =>
    apiClient.get<Order[]>('/orders/available-for-dispatch', { params: { branchId } }),
  create: (data: any) => apiClient.post<Order>('/orders', data),
  update: (id: string, data: any) => apiClient.patch<Order>(`/orders/${id}`, data),
};

export const tripsApi = {
  getAll: (status?: string) =>
    apiClient.get<Trip[]>('/trips', { params: { status } }),
  getOne: (id: string) => apiClient.get<Trip>(`/trips/${id}`),
  create: (data: {
    vehicleId: string;
    driverId: string;
    plannedStartTime: string;
    plannedEndTime: string;
    orderIds: string[];
    orderedStopIds?: string[];
    notes?: string;
  }) => apiClient.post<Trip>('/trips', data),
  publish: (id: string) => apiClient.patch<Trip>(`/trips/${id}/publish`),
  getLoadProfile: (id: string) =>
    apiClient.get<LoadProfileResult>(`/trips/${id}/load-profile`),
  optimize: (data: { vehicleId: string; orderIds: string[] }) =>
    apiClient.post<OptimizationResultUI>('/trips/optimize', data),
  runAutomaticOptimization: (
    param: string | RunAutomaticOptimizationPayloadUI,
  ) => {
    const data = typeof param === 'string' ? { branchId: param } : param;
    return apiClient.post<AutomaticOptimizationResponseUI>(
      '/trips/automatic-optimization',
      data,
    );
  },
  applyAutomaticOptimization: (data: AutomaticOptimizationResponseUI) =>
    apiClient.post<ApplyOptimizationResponseUI>(
      '/trips/automatic-optimization/apply',
      data,
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

