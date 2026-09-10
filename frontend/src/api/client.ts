import axios from 'axios';
import {
  Branch,
  Driver,
  LoadProfileResult,
  OptimizationJobUI,
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
};

export const customersApi = {
  getAll: () => client.get<Array<{ id: string; code: string; name: string }>>('/customers'),
};

export const vehiclesApi = {
  getAll: (branchId?: string) =>
    client.get<Vehicle[]>('/vehicles', { params: { branchId } }),
  getAvailable: (branchId?: string) =>
    client.get<Vehicle[]>('/vehicles/available', { params: { branchId } }),
};

export const driversApi = {
  getAll: (branchId?: string) =>
    client.get<Driver[]>('/drivers', { params: { branchId } }),
  getAvailable: (branchId?: string) =>
    client.get<Driver[]>('/drivers/available', { params: { branchId } }),
};

export const ordersApi = {
  getAll: (status?: string) =>
    client.get<Order[]>('/orders', { params: { status } }),
  getAvailableForDispatch: () =>
    client.get<Order[]>('/orders/available-for-dispatch'),
  create: (data: any) => client.post<Order>('/orders', data),
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
  createAutomaticOptimizationJob: () =>
    client.post<OptimizationJobUI>('/trips/optimization-jobs'),
  getOptimizationJob: (jobId: string) =>
    client.get<OptimizationJobUI>(`/trips/optimization-jobs/${jobId}`),
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
};
