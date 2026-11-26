import { App } from 'antd';
import { AxiosError, AxiosHeaders } from 'axios';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tripsApi } from '../api/client';
import AutomaticDispatchPage from '../pages/AutomaticDispatchPage';
import { dismissAutoDispatchState, getAutoDispatchState, saveAutoDispatchState } from '../utils/autoDispatchStorage';
import type { AutomaticOptimizationResponseUI, FleetOptimizationResultUI, OptimizedRouteUI } from '../types';

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    branchesApi: {
      ...original.branchesApi,
      getAll: vi.fn().mockResolvedValue({
        data: [{ id: 'branch-dad', code: 'BRANCH-DAD', name: 'Kho Vận Miền Trung - Chi nhánh Đà Nẵng', active: true }],
      }),
    },
    ordersApi: { ...original.ordersApi, getAvailableForDispatch: vi.fn().mockResolvedValue({ data: [] }) },
    vehiclesApi: { ...original.vehiclesApi, getAvailable: vi.fn().mockResolvedValue({ data: [] }) },
    driversApi: { ...original.driversApi, getAvailable: vi.fn().mockResolvedValue({ data: [] }) },
    settingsApi: { ...original.settingsApi, getEffective: vi.fn().mockRejectedValue(new Error('skip')) },
    tripsApi: {
      ...original.tripsApi,
      getAutomaticOptimizationJob: vi.fn(),
      getLatestAutomaticOptimizationJob: vi.fn(),
    },
  };
});
vi.mock('../api/realtime', () => ({ getRealtimeSocket: () => null }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', username: 'admin', fullName: 'Admin', role: 'ADMIN', companyScope: true, branches: [], grants: [] },
    branchId: 'branch-dad',
    setBranchId: vi.fn(),
    scopeVersion: 1,
    can: () => true,
  }),
}));
vi.mock('../components/DeliveryAppointments', () => ({ DispatcherDeliveryPlanning: () => null }));
vi.mock('../components/FloorPackingVisualizer', () => ({ default: () => null }));
vi.mock('../components/BenchmarkCostComparisonCard', () => ({ BenchmarkCostComparisonCard: () => null }));
vi.mock('../components/MapboxMap', () => ({
  MAP_ROUTE_COLORS: ['#1677ff'],
  default: () => <div data-testid="mapbox-map" />,
}));

beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

function makeJob(overrides: Partial<AutomaticOptimizationResponseUI> = {}): AutomaticOptimizationResponseUI {
  const route: OptimizedRouteUI = {
    route_id: 'route-dad-1',
    vehicle_id: 'veh-1',
    plate_number: '43C-123.45',
    driver_name: 'Nguyễn Văn A',
    service_day_index: 0,
    start_time_sec: 28_800,
    end_time_sec: 32_400,
    total_distance_km: 12.5,
    total_duration_minutes: 60,
    stops: [],
    vehicle_length_cm: 400,
    vehicle_width_cm: 200,
    depot: { id: 'depot', name: 'Kho Đà Nẵng', longitude: 108.2, latitude: 16.05 },
    route_geometry: { type: 'LineString', coordinates: [[108.2, 16.05], [108.21, 16.06]] },
    spatial_validation: { is_valid: true, step_states: [], max_area_cm2: 0, max_weight_kg: 0 },
  };
  const result: FleetOptimizationResultUI = {
    job_id: 'job-dad-1',
    status: 'SUCCESS',
    routes: [route],
    unassigned_orders: [],
    diagnostics: [],
    total_cost_vnd: 64_920_618,
    total_distance_km: 12.5,
    total_duration_minutes: 60,
  };
  return {
    id: 'job-dad-1',
    branchId: 'branch-dad',
    status: 'SUCCEEDED',
    schemaVersion: '2',
    planningEpochIso: '2026-11-20T00:00:00.000Z',
    scheduleMode: 'CURRENT_TIME',
    searchBudgetSeconds: 20,
    progress: { stage: 'COMPLETED', details: {}, updatedAt: '2026-11-20T03:10:45.870Z' },
    result,
    candidates: [
      {
        candidateNumber: 1,
        solverObjective: 174_116_243,
        totalCostVnd: 64_920_618,
        planningSpanDays: 3,
        driverCalendarSalaryVnd: 39_454_433,
        driverIdleSalaryAllocationVnd: 24_262_673,
        operationalLatePenaltyVnd: 84_932_952,
        totalDistanceKm: 12.5,
        totalDurationMinutes: 60,
        routeCount: 1,
        unassignedOrderCount: 0,
        improvementSequence: 1,
        isBestFound: true,
        feasibilityStatus: 'SUCCESS',
      },
    ],
    error: null,
    attemptCount: 1,
    startedAt: '2026-11-20T03:05:27.000Z',
    completedAt: '2026-11-20T03:10:45.870Z',
    createdAt: '2026-11-20T03:05:26.812Z',
    updatedAt: '2026-11-20T03:10:45.870Z',
    ...overrides,
  };
}

function axiosResponse<T>(data: T) {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  };
}

describe('AutomaticDispatchPage reload restore', () => {
  it('restores the latest branch job from the server when localStorage is empty', async () => {
    const job = makeJob();
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(job));

    render(<App><AutomaticDispatchPage /></App>);

    await waitFor(() => {
      expect(screen.getByText('Đã khôi phục từ phiên trước')).toBeInTheDocument();
    });
    expect(tripsApi.getLatestAutomaticOptimizationJob).toHaveBeenCalledWith('branch-dad');
    expect(screen.getAllByText(/43C-123\.45/).length).toBeGreaterThan(0);
    expect(getAutoDispatchState('branch-dad')?.optimizationJobId).toBe('job-dad-1');
  });

  it('keeps localStorage pointer on transient errors and falls back to the latest job', async () => {
    const job = makeJob();
    saveAutoDispatchState({
      branchId: 'branch-dad',
      optimizationJobId: 'job-dad-1',
      appliedTripCount: null,
      scheduleMode: 'CURRENT_TIME',
      customStartTimeStr: null,
      useCustomTime: false,
      savedAt: '2026-11-20T03:10:46.000Z',
    });
    vi.mocked(tripsApi.getAutomaticOptimizationJob).mockRejectedValue(new Error('Network glitch'));
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockRejectedValue(new Error('Server restarting'));

    render(<App><AutomaticDispatchPage /></App>);

    await waitFor(() => {
      expect(tripsApi.getLatestAutomaticOptimizationJob).toHaveBeenCalledWith('branch-dad');
    });
    expect(getAutoDispatchState('branch-dad')?.optimizationJobId).toBe('job-dad-1');

    cleanup();
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(job));
    render(<App><AutomaticDispatchPage /></App>);
    await waitFor(() => {
      expect(screen.getByText('Đã khôi phục từ phiên trước')).toBeInTheDocument();
    });
  });

  it('does not resurrect a job after the user dismissed it', async () => {
    const job = makeJob();
    dismissAutoDispatchState('branch-dad', job.createdAt);
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(job));

    render(<App><AutomaticDispatchPage /></App>);

    await waitFor(() => {
      expect(tripsApi.getLatestAutomaticOptimizationJob).toHaveBeenCalledWith('branch-dad');
    });
    expect(screen.queryByText('Đã khôi phục từ phiên trước')).not.toBeInTheDocument();
    expect(screen.queryByText(/43C-123\.45/)).not.toBeInTheDocument();
  });

  it('clears stale localStorage pointer when server reports 404 and no restorable job exists', async () => {
    saveAutoDispatchState({
      branchId: 'branch-dad',
      optimizationJobId: 'deleted-job',
      appliedTripCount: null,
      scheduleMode: 'CURRENT_TIME',
      customStartTimeStr: null,
      useCustomTime: false,
      savedAt: '2026-11-20T03:10:46.000Z',
    });
    const notFound = new AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    });
    vi.mocked(tripsApi.getAutomaticOptimizationJob).mockRejectedValue(notFound);
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(null));

    render(<App><AutomaticDispatchPage /></App>);

    await waitFor(() => {
      expect(tripsApi.getLatestAutomaticOptimizationJob).toHaveBeenCalledWith('branch-dad');
    });
    expect(getAutoDispatchState('branch-dad')).toBeNull();
  });

  it('displays applied actions when an APPLIED job is restored without localStorage', async () => {
    const job = makeJob({ status: 'APPLIED' });
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(job));

    render(<App><AutomaticDispatchPage /></App>);

    await waitFor(() => {
      expect(screen.getByText('Đã áp dụng phương án')).toBeInTheDocument();
    });
    expect(screen.getByText('Mở Bàn điều phối để Phát hành')).toBeInTheDocument();
    const resetBtn = screen.getByText('Bắt đầu đợt điều phối mới');
    expect(resetBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(getAutoDispatchState('branch-dad')).toBeNull();
  });
});
