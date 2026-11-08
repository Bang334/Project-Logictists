import React from 'react';
import { App as AntdApp } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../pages/DashboardPage';
import {
  branchesApi,
  driversApi,
  locationsApi,
  ordersApi,
  tripsApi,
  vehiclesApi,
} from '../api/client';

const mockAuthState = {
  user: {
    id: 'u-1',
    username: 'dispatcher_han',
    fullName: 'Điều phối Hà Nội',
    companyScope: true,
    permissions: ['orders.read', 'vehicles.read', 'trips.plan', 'branches.manage'],
    branches: [{ id: 'branch-1', code: 'HAN', name: 'Chi nhánh Hà Nội' }],
    grants: [
      {
        role: 'DISPATCHER',
        scopeType: 'COMPANY' as const,
        branchId: null,
        permissions: ['orders.read', 'vehicles.read', 'trips.plan', 'branches.manage'],
      },
    ],
  },
  branchId: undefined as string | undefined,
  can: (perm: string) => mockAuthState.user.permissions.includes(perm),
};

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../components/MapboxMap', () => ({
  default: ({ markers = [], onMarkerClick }: any) => (
    <div data-testid="mock-mapbox">
      {markers.map((m: any) => (
        <button
          key={m.id}
          type="button"
          data-testid={`marker-${m.id}`}
          onClick={() => onMarkerClick?.(m)}
        >
          {m.title}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../components/EditBranchModal', () => ({
  EditBranchModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-branch-modal">Edit Branch Modal</div> : null,
}));

vi.mock('../api/client', () => ({
  apiErrorMessage: () => 'Không kết nối được máy chủ vận hành.',
  branchesApi: { getAll: vi.fn() },
  vehiclesApi: { getAll: vi.fn() },
  driversApi: { getAll: vi.fn() },
  locationsApi: { getAll: vi.fn() },
  ordersApi: { list: vi.fn() },
  tripsApi: { getAll: vi.fn() },
}));

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => getComputedStyle(element),
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(branchesApi.getAll).mockResolvedValue({
      data: [
        {
          id: 'branch-1',
          code: 'HAN',
          name: 'Chi nhánh Hà Nội',
          address: 'Số 18 Phạm Hùng, Hà Nội',
          latitude: 21.02,
          longitude: 105.84,
          timezone: 'Asia/Ho_Chi_Minh',
          _count: { vehicles: 2, drivers: 2 },
        },
      ],
    } as any);
    vi.mocked(vehiclesApi.getAll).mockResolvedValue({
      data: [
        { id: 'v-1', plateNumber: '29H-123.45', model: 'Isuzu 2.5T', status: 'AVAILABLE' },
        { id: 'v-2', plateNumber: '29C-888.99', model: 'Hino 5T', status: 'ON_TRIP' },
      ],
    } as any);
    vi.mocked(driversApi.getAll).mockResolvedValue({
      data: [
        { id: 'd-1', fullName: 'Nguyễn Văn A', status: 'AVAILABLE' },
        { id: 'd-2', fullName: 'Trần Văn B', status: 'ON_DUTY' },
      ],
    } as any);
    vi.mocked(locationsApi.getAll).mockResolvedValue({
      data: [
        {
          id: 'loc-wh',
          code: 'WH-01',
          name: 'Kho Trung Tâm Long Biên',
          type: 'CENTRAL_WAREHOUSE',
          address: 'Long Biên, Hà Nội',
          latitude: 21.04,
          longitude: 105.89,
          totalHoldingSlots: 0,
          availableHoldingSlots: 0,
        },
        {
          id: 'loc-pp',
          code: 'PP-01',
          name: 'Điểm Nhận Cầu Giấy',
          type: 'PICKUP_POINT',
          address: '85 Xuân Thủy, Hà Nội',
          latitude: 21.03,
          longitude: 105.79,
          totalHoldingSlots: 20,
          availableHoldingSlots: 15,
        },
      ],
    } as any);
    vi.mocked(ordersApi.list).mockResolvedValue({
      items: [],
      total: 14,
      page: 1,
      pageSize: 1,
    } as any);
    vi.mocked(tripsApi.getAll).mockResolvedValue({
      data: [
        {
          id: 'trip-1',
          tripNumber: 'TRIP-001',
          status: 'IN_PROGRESS',
          totalDistanceKm: 42.5,
          totalDurationMinutes: 180,
          plannedStartTime: '2026-11-08T01:00:00.000Z',
          plannedEndTime: '2026-11-08T04:00:00.000Z',
          vehicle: { plateNumber: '29C-888.99', model: 'Hino 5T', homeBranchId: 'branch-1' },
          assignments: [{ id: 'a-1', driver: { fullName: 'Trần Văn B' }, role: 'PRIMARY' }],
          stops: [{ id: 's-1' }, { id: 's-2' }],
        },
      ],
    } as any);
  });

  it('renders multi-tier KPI breakdown, Vietnamese trip status, and syncs point selection', async () => {
    const onNavigate = vi.fn();
    render(
      <AntdApp>
        <DashboardPage onNavigate={onNavigate} />
      </AntdApp>,
    );

    await waitFor(() => {
      expect(screen.getByText('Tổng Quan Vận Hành & Mạng Lưới')).toBeInTheDocument();
    });

    // Multi-tier KPI breakdown
    expect(screen.getByText('1 đang chạy')).toBeInTheDocument();
    expect(screen.getByText('1 đang chạy ca')).toBeInTheDocument();

    // Vietnamese trip status label
    expect(screen.getByText('Đang vận chuyển')).toBeInTheDocument();
    expect(screen.getByText('42.5 km')).toBeInTheDocument();

    // Select a network point from the map marker -> shows summary banner
    fireEvent.click(screen.getByTestId('marker-location:loc-pp'));
    expect(screen.getByText(/Còn 15\/20 chỗ lưu giữ trống/)).toBeInTheDocument();

    // Filter network points by type (updates both map markers and point list)
    fireEvent.click(screen.getByRole('tab', { name: 'Kho (1)' }));
    expect(screen.getAllByText('Kho Trung Tâm Long Biên')).toHaveLength(2);
    expect(screen.queryByText('Điểm Nhận Cầu Giấy')).not.toBeInTheDocument();
  }, 20_000);

  it('displays an explicit error alert with retry button when API fails', async () => {
    vi.mocked(branchesApi.getAll).mockRejectedValueOnce(new Error('Network error'));

    render(
      <AntdApp>
        <DashboardPage onNavigate={vi.fn()} />
      </AntdApp>,
    );

    await waitFor(() => {
      expect(
        screen.getByText('Không thể đồng bộ đầy đủ dữ liệu vận hành'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  }, 20_000);
});
