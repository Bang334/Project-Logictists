import { App } from 'antd';
import { AxiosError, AxiosHeaders } from 'axios';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ordersApi, tripsApi } from '../api/client';
import AutomaticDispatchPage from '../pages/AutomaticDispatchPage';
import type { MapMarker } from '../components/MapboxMap';
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
      cancelAutomaticOptimization: vi.fn(),
      runAutomaticOptimization: vi.fn(),
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
vi.mock('../components/FloorPackingVisualizer', () => ({
  default: ({ selectedStepIndex }: { selectedStepIndex: number }) => (
    <output aria-label="Bước xếp dỡ">{selectedStepIndex}</output>
  ),
}));
vi.mock('../components/BenchmarkCostComparisonCard', () => ({ BenchmarkCostComparisonCard: () => null }));
vi.mock('../components/MapboxMap', () => ({
  MAP_ROUTE_COLORS: ['#1677ff'],
  default: ({
    markers, simulationMilestonesKm, onSimulationProgress, autoPlaySimulation,
  }: {
    markers: MapMarker[];
    simulationMilestonesKm: number[];
    onSimulationProgress: (progress: number, coordinate: [number, number], speed: number, km: number, source: 'animation') => void;
    autoPlaySimulation: boolean;
  }) => (
    <div data-testid="mapbox-map" data-pickups={JSON.stringify(markers
      .filter(marker => marker.type === 'PICKUP')
      .map(marker => [marker.longitude, marker.latitude]))}>
      {autoPlaySimulation && (
        <>
          <button onClick={() => onSimulationProgress(0.4, [108.209, 16.06], 40, simulationMilestonesKm[0] - 0.01, 'animation')}>
            Trước điểm nhận
          </button>
          <button onClick={(event) => {
            onSimulationProgress(0.5, [108.21, 16.06], 40, simulationMilestonesKm[0], 'animation');
            event.currentTarget.dataset.cargoStepInFrame = screen.getByLabelText('Bước xếp dỡ').textContent ?? '';
          }}>
            Tới điểm nhận
          </button>
        </>
      )}
    </div>
  ),
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
  it('keeps the job on failed cancellation and enables a new run only after cancellation completes', async () => {
    const running = makeJob({ status: 'RUNNING', result: null, candidates: [], completedAt: null });
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(running));
    vi.mocked(tripsApi.getAutomaticOptimizationJob).mockResolvedValue(axiosResponse(running));
    vi.mocked(tripsApi.cancelAutomaticOptimization)
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce(axiosResponse({ ...running, status: 'CANCEL_REQUESTED' }));
    vi.mocked(tripsApi.runAutomaticOptimization).mockResolvedValue(axiosResponse({
      ...running, id: 'job-dad-2', status: 'PENDING', createdAt: '2026-11-20T03:12:00.000Z',
    }));
    vi.mocked(ordersApi.getAvailableForDispatch).mockResolvedValueOnce(axiosResponse([{
      id: 'order-1', orderNumber: 'ORDER-1', customerId: 'customer-1', branchId: 'branch-dad',
      customer: { id: 'customer-1', code: 'CUSTOMER-1', name: 'Test customer' },
      status: 'CONFIRMED', totalWeightKg: 1, totalVolumeM3: 1, totalPackages: 1, version: 1,
      packageDataStatus: 'COMPLETE', totalWeightG: '1000', totalVolumeMm3: '1000000000',
      operationalTimezone: 'Asia/Bangkok', orderedAt: running.createdAt, totalAmount: '0',
      stops: [], items: [], createdAt: running.createdAt,
    }]));

    render(<App><AutomaticDispatchPage /></App>);
    const confirmDeletion = async () => {
      const [trigger] = await screen.findAllByText('Xóa phương án');
      fireEvent.click(trigger);
      const choices = screen.getAllByText('Xóa phương án');
      const confirm = choices[choices.length - 1];
      if (!confirm) throw new Error('Missing cancellation confirmation');
      fireEvent.click(confirm);
    };
    await confirmDeletion();
    await screen.findByText('Chưa hủy được lượt tối ưu. Vui lòng thử lại.');
    expect(getAutoDispatchState('branch-dad')?.optimizationJobId).toBe(running.id);

    await confirmDeletion();
    const canceling = await screen.findByText('Đang hủy lượt tối ưu…');
    expect(canceling.closest('button')).toBeDisabled();
    expect(tripsApi.cancelAutomaticOptimization).toHaveBeenCalledTimes(2);

    vi.mocked(tripsApi.getAutomaticOptimizationJob).mockResolvedValue(axiosResponse({ ...running, status: 'CANCELLED' }));
    const optimize = await screen.findByText('Tối ưu toàn bộ', {}, { timeout: 5000 });
    expect(optimize.closest('button')).toBeEnabled();
    expect(screen.queryByText('Xóa phương án lỗi')).not.toBeInTheDocument();
    fireEvent.click(optimize);
    expect(tripsApi.runAutomaticOptimization).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('uses the same road waypoint for the pickup marker and the cargo arrival', async () => {
    const job = makeJob();
    const route = job.result!.routes[0];
    route.route_geometry = {
      type: 'LineString', coordinates: [[108.2, 16.05], [108.21, 16.06], [108.22, 16.06]],
      waypoint_indices: [0, 1, 2],
    };
    route.stops = [{
      sequence: 1, location_id: 'pickup', location_name: 'Kho lấy hàng', stop_type: 'PICKUP',
      longitude: 108.212, latitude: 16.06, arrival_time_sec: 29_000, departure_time_sec: 29_100,
      items_loaded: ['kiện'], items_unloaded: [], current_weight_kg: 10,
    }];
    vi.mocked(tripsApi.getLatestAutomaticOptimizationJob).mockResolvedValue(axiosResponse(job));

    render(<App><AutomaticDispatchPage /></App>);
    fireEvent.click(await screen.findByText('Xem trên bản đồ ↑'));
    fireEvent.click(screen.getByText('Mô phỏng xe'));
    expect(screen.getByTestId('mapbox-map')).toHaveAttribute('data-pickups', '[[108.21,16.06]]');
    fireEvent.click(screen.getByText('Trước điểm nhận'));
    expect(screen.getByLabelText('Bước xếp dỡ')).toHaveTextContent('0');
    const arrival = screen.getByText('Tới điểm nhận');
    fireEvent.click(arrival);
    expect(arrival).toHaveAttribute('data-cargo-step-in-frame', '1');
    expect(screen.getByLabelText('Bước xếp dỡ')).toHaveTextContent('1');
  }, 20_000);

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
