import { apiClient } from './client';
import axios from 'axios';
import { availability, employee, FleetKind, page, profile, schedule } from '../types/fleet';
export type FleetQuery = { branchId?: string; page?: number; pageSize?: number; search?: string; status?: string; startsAt?: string; endsAt?: string };
const options = (key: string) => ({ headers: { 'Idempotency-Key': key }, timeout: 25000 });
export function fleetFieldErrors(error: unknown) {
  if (!axios.isAxiosError(error)) return [];
  const fields: unknown = error.response?.data?.fieldErrors;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('field' in item) || !('message' in item) || typeof item.field !== 'string' || typeof item.message !== 'string') return [];
    return [{ name: ['startsAt', 'endsAt'].includes(item.field) ? 'range' : item.field, errors: [item.message] }];
  });
}
export const fleetApi = {
  resourceWindow: async (kind: FleetKind, id: string, params: FleetQuery) => availability((await apiClient.get<unknown>(`/fleet/${kind}/${id}/availability`, { params })).data),
  list: async (kind: FleetKind, params: FleetQuery) => page((await apiClient.get<unknown>(`/fleet/${kind}`, { params })).data, profile),
  detail: async (kind: FleetKind, id: string) => (await apiClient.get<unknown>(`/fleet/${kind}/${id}`)).data,
  create: async (kind: FleetKind, data: Record<string, unknown>, key: string) => profile((await apiClient.post<unknown>(`/fleet/${kind}`, data, options(key))).data),
  employees: async (params: FleetQuery) => page((await apiClient.get<unknown>('/fleet/employees', { params })).data, employee),
  link: async (id: string, data: Record<string, unknown>, key: string) => profile((await apiClient.post<unknown>(`/fleet/drivers/${id}/employee`, data, options(key))).data),
  schedules: async (kind: FleetKind, id: string, params: FleetQuery) => page((await apiClient.get<unknown>(`/fleet/${kind}/${id}/schedules`, { params })).data, schedule),
  saveSchedule: async (kind: FleetKind, id: string, data: Record<string, unknown>, key: string, scheduleId?: string, source?: string) => {
    if (scheduleId) await apiClient.patch(`/fleet/${kind}/${id}/schedules/${source}/${scheduleId}`, data, options(key));
    else await apiClient.post(`/fleet/${kind}/${id}/schedules`, data, options(key));
  },
  cancelSchedule: async (kind: FleetKind, id: string, scheduleId: string, source: string, data: Record<string, unknown>, key: string) => { await apiClient.post(`/fleet/${kind}/${id}/schedules/${source}/${scheduleId}/cancel`, data, options(key)); },
  availability: async (kind: FleetKind, params: FleetQuery) => page((await apiClient.get<unknown>(`/fleet/${kind}/availability`, { params })).data, availability),
};
