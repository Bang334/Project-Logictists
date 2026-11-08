import { App } from 'antd';
import { AxiosHeaders } from 'axios';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mapboxApi, tripsApi } from '../api/client';
import AutomaticDispatchPage from '../pages/AutomaticDispatchPage';
import type { FleetOptimizationResultUI, OptimizationCandidateSummaryUI, OptimizedRouteUI } from '../types';

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    branchesApi: { ...original.branchesApi, getAll: vi.fn().mockResolvedValue({ data: [] }) },
    mapboxApi: { ...original.mapboxApi, getDrivingRouteThrough: vi.fn() },
    tripsApi: { ...original.tripsApi, getDemoCases: vi.fn().mockResolvedValue({ data: [] }), runDemoOptimization: vi.fn() },
  };
});
vi.mock('../api/realtime', () => ({ getRealtimeSocket: () => null }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../components/FloorPackingVisualizer', () => ({ default: () => null }));
vi.mock('../components/BenchmarkCostComparisonCard', () => ({ BenchmarkCostComparisonCard: () => null }));
vi.mock('../components/DemoScenarioControlCard', () => ({
  DemoScenarioControlCard: ({ onRunDemo }: { onRunDemo: () => void }) => <button onClick={onRunDemo}>Chạy tối ưu Demo</button>,
}));
vi.mock('../components/MapboxMap', () => ({
  MAP_ROUTE_COLORS: ['#1677ff'],
  default: ({ vehiclePlate, enableSimulation, routeGeometry }: {
    vehiclePlate: string; enableSimulation: boolean;
    routeGeometry: { features: { geometry: { coordinates: [number, number][] } }[] };
  }) => (
    <output aria-label="Trạng thái bản đồ" data-coordinates={JSON.stringify(routeGeometry.features[0]?.geometry.coordinates ?? [])}>
      {vehiclePlate} {enableSimulation ? 'đang chạy' : 'đang xem'}
    </output>
  ),
}));

beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
});
afterEach(cleanup);

it('chọn Chuyến đơn lẻ trong Demo và mô phỏng đúng xe của phương án đã chọn', async () => {
  const hybridRoute: OptimizedRouteUI = {
    route_id: 'hybrid-1', vehicle_id: 'vehicle-1', plate_number: 'HYBRID-01',
    driver_name: 'Tài xế A', service_day_index: 0, start_time_sec: 28_800, end_time_sec: 29_400,
    total_distance_km: 3, total_duration_minutes: 10, stops: [], vehicle_length_cm: 400, vehicle_width_cm: 200,
    depot: { id: 'depot', name: 'Kho', longitude: 105, latitude: 21 },
    spatial_validation: { is_valid: true, step_states: [], max_area_cm2: 0, max_weight_kg: 0 },
  };
  const directRoute: OptimizedRouteUI = {
    ...hybridRoute, route_id: 'direct:vehicle-2', vehicle_id: 'vehicle-2', plate_number: 'DIRECT-02',
    end_location: { id: 'delivery', name: 'Điểm giao hàng', longitude: 105.02, latitude: 21.02 },
    return_travel_time_sec: 0,
    stops: [
      { sequence: 1, location_id: 'pickup', location_name: 'Kho lấy hàng', stop_type: 'PICKUP', longitude: 105.01, latitude: 21.01,
        arrival_time_sec: 28_900, departure_time_sec: 28_910, items_loaded: ['kiện'], items_unloaded: [], current_weight_kg: 10 },
      { sequence: 2, location_id: 'delivery', location_name: 'Điểm giao hàng', stop_type: 'DELIVERY', longitude: 105.02, latitude: 21.02,
        arrival_time_sec: 29_100, departure_time_sec: 29_110, items_loaded: [], items_unloaded: ['kiện'], current_weight_kg: 0 },
    ],
  };
  const waypoints = [[105, 21], [105.01, 21.01], [105.02, 21.02]];
  const roadCoordinates: [number, number][] = [[105, 21], [105.009, 21], [105.01, 21.01], [105.012, 21.019], [105.02, 21.02]];
  vi.mocked(mapboxApi.getDrivingRouteThrough).mockResolvedValueOnce(null).mockResolvedValueOnce({
    coordinates: roadCoordinates, distanceMeters: 5100, durationSeconds: 450,
  });
  const metric = {
    method_name: 'Đối chuẩn', description: 'Đối chuẩn trong demo',
    total_cost_vnd: 200, total_distance_km: 3, total_duration_minutes: 10, vehicles_used: 1,
    fuel_cost_vnd: 100, driver_cost_vnd: 100, vehicle_fixed_cost_vnd: 0, cargo_holding_cost_vnd: 0,
    late_delivery_penalty_vnd: 0, is_feasible: true, violations: [],
  };
  const result: FleetOptimizationResultUI = {
    job_id: 'demo-1', status: 'SUCCESS', routes: [hybridRoute], unassigned_orders: [], diagnostics: [],
    total_cost_vnd: 200, total_distance_km: 3, total_duration_minutes: 10,
    benchmarks: { or_tools: metric, direct_dedicated: { ...metric, routes: [directRoute] }, savings_vs_direct_vnd: 0, savings_vs_direct_percent: 0 },
  };
  const candidate: OptimizationCandidateSummaryUI = {
    candidateNumber: 1, solverObjective: 200, totalCostVnd: 200, planningSpanDays: 1,
    driverCalendarSalaryVnd: 0, driverIdleSalaryAllocationVnd: 0, operationalLatePenaltyVnd: 0,
    totalDistanceKm: 3, totalDurationMinutes: 10, routeCount: 1, unassignedOrderCount: 0,
    improvementSequence: 1, isBestFound: true, feasibilityStatus: 'SUCCESS',
  };
  vi.mocked(tripsApi.runDemoOptimization).mockResolvedValue({
    status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
    data: {
      id: 'demo-1', branchId: 'demo-branch', status: 'SUCCEEDED', planningEpochIso: '2026-11-08T00:00:00Z',
      schemaVersion: '1', scheduleMode: null, searchBudgetSeconds: null, progress: null, error: null,
      attemptCount: 1, startedAt: null, completedAt: null,
      createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z',
      candidates: [candidate], candidateResults: { 1: result }, result,
    },
  });

  render(<App><AutomaticDispatchPage /></App>);
  fireEvent.click(screen.getByText(/Thử nghiệm Demo Kịch bản mẫu/));
  await act(async () => { fireEvent.click(screen.getByText('Chạy tối ưu Demo')); });
  await act(async () => { fireEvent.click(screen.getByLabelText('So sánh Chuyến đơn lẻ')); });
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveTextContent('DIRECT-02 đang xem');
  expect(screen.getByText('Không tải được tuyến đường từ Mapbox.')).toBeInTheDocument();
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveAttribute('data-coordinates', '[]');
  expect(screen.getByText('Mô phỏng xe').closest('button')).toBeDisabled();
  expect(mapboxApi.getDrivingRouteThrough).toHaveBeenCalledWith(waypoints, expect.any(AbortSignal));

  await act(async () => { fireEvent.click(screen.getByText('Thử lại')); });
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveAttribute('data-coordinates', JSON.stringify(roadCoordinates));

  fireEvent.click(screen.getByText('Mô phỏng xe'));
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveTextContent('DIRECT-02 đang chạy');
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveAttribute('data-coordinates', JSON.stringify(roadCoordinates));

  fireEvent.click(screen.getByLabelText('So sánh phương án #1'));
  expect(screen.getByLabelText('Trạng thái bản đồ')).toHaveTextContent('HYBRID-01 đang xem');
}, 20_000);
