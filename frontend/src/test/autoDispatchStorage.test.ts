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
    optimizationJobId: 'job-mock-123',
    appliedTripCount: null,
    scheduleMode: 'CURRENT_TIME',
    customStartTimeStr: '2026-10-02T12:00:00.000Z',
    useCustomTime: true,
    searchBudgetSeconds: 30,
    selectedVehicleForMap: 'ALL',
    savedAt: '2026-10-02T12:05:00.000Z',
  };

  it('saves and retrieves auto dispatch state for a branch', () => {
    saveAutoDispatchState(mockState);
    const retrieved = getAutoDispatchState('branch-hn-01');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.branchId).toBe('branch-hn-01');
    expect(retrieved?.optimizationJobId).toBe('job-mock-123');
    expect(retrieved?.useCustomTime).toBe(true);
    expect(retrieved?.searchBudgetSeconds).toBe(30);
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
