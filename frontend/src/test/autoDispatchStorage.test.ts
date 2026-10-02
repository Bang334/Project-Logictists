import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAutoDispatchState,
  getAutoDispatchState,
  getLastSelectedBranch,
  saveAutoDispatchState,
  saveLastSelectedBranch,
  StoredAutoDispatchState,
} from '../utils/autoDispatchStorage';

describe('autoDispatchStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const mockState: StoredAutoDispatchState = {
    branchId: 'branch-hn-01',
    optimization: {
      proposal: {
        branchId: 'branch-hn-01',
        planningEpochIso: '2026-10-02T08:00:00.000Z',
        expiresAt: '2026-10-02T18:00:00.000Z',
        scheduleMode: 'CURRENT_TIME',
        resources: { orders: [], vehicles: [], drivers: [] },
        result: {
          job_id: 'job-mock-123',
          status: 'SUCCESS',
          routes: [],
          unassigned_orders: [],
          total_distance_km: 15.5,
          total_duration_minutes: 120,
          total_cost_vnd: 250000,
          diagnostics: [],
        },
      },
      signature: 'mock-sig-abc',
    },
    appliedTripCount: null,
    scheduleMode: 'CURRENT_TIME',
    customStartTimeStr: '2026-10-02T12:00:00.000Z',
    useCustomTime: true,
    selectedVehicleForMap: 'ALL',
    savedAt: '2026-10-02T12:05:00.000Z',
  };

  it('saves and retrieves auto dispatch state for a branch', () => {
    saveAutoDispatchState(mockState);
    const retrieved = getAutoDispatchState('branch-hn-01');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.branchId).toBe('branch-hn-01');
    expect(retrieved?.optimization.proposal.result.job_id).toBe('job-mock-123');
    expect(retrieved?.useCustomTime).toBe(true);
    expect(getLastSelectedBranch()).toBe('branch-hn-01');
  });

  it('returns null for nonexistent branch state', () => {
    expect(getAutoDispatchState('nonexistent-branch')).toBeNull();
  });

  it('clears auto dispatch state for a branch', () => {
    saveAutoDispatchState(mockState);
    clearAutoDispatchState('branch-hn-01');
    expect(getAutoDispatchState('branch-hn-01')).toBeNull();
  });

  it('saves and gets last selected branch independently', () => {
    saveLastSelectedBranch('branch-sg-02');
    expect(getLastSelectedBranch()).toBe('branch-sg-02');
  });

  it('handles invalid or corrupted JSON safely without crashing', () => {
    localStorage.setItem('tms_auto_dispatch_state_corrupt', '{not-a-valid-json}');
    expect(getAutoDispatchState('corrupt')).toBeNull();
  });
});
