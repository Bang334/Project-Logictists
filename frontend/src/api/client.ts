import axios from 'axios';
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

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('tms_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const authApi = {
  login: (username: string, pass: string) =>
    client.post('/auth/login', { username, pass }),
  getProfile: () => client.get('/auth/profile'),
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

