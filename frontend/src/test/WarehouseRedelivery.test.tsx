import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import { WarehousesTab } from '../components/WarehousesTab';
import { locationsApi } from '../api/client';

const stubMatchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: stubMatchMedia,
  });
});

afterEach(() => {
  cleanup();
});

vi.mock('../components/MapLocationPickerModal', () => ({
  MapLocationPickerModal: () => null,
}));

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    locationsApi: {
      ...actual.locationsApi,
      getWarehouses: vi.fn(),
      createWarehouse: vi.fn(),
      updateWarehouse: vi.fn(),
    },
  };
});

describe('WarehousesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: stubMatchMedia,
    });
  });

  it('displays branch warehouses and custody package totals from server', async () => {
    vi.mocked(locationsApi.getWarehouses).mockResolvedValue({
      data: [
        {
          id: 'wh-1',
          code: 'WH-DAD-01',
          name: 'Kho Trung Chuyển Đà Nẵng',
          address: '123 Tôn Đức Thắng, Liên Chiểu, Đà Nẵng',
          latitude: 16.06,
          longitude: 108.15,
          active: true,
          type: 'CENTRAL_WAREHOUSE',
          managingBranchId: 'branch-dad',
          managingBranch: {
            id: 'branch-dad',
            code: 'BRANCH-DAD',
            name: 'Chi nhánh Đà Nẵng',
          },
          custodyPackageCount: 2,
          custodyTotalWeightKg: 42.5,
          custodyPackages: [
            {
              id: 'pkg-1',
              packageCode: 'PKG-RET-01',
              weightKg: 42.5,
              lengthMm: 1000,
              widthMm: 800,
              heightMm: 600,
              cargoKind: 'STANDARD',
              returnedToHubAt: '2026-11-25T10:00:00.000Z',
              deliveryAttemptCount: 1,
              description: 'Thiết bị điện',
              orderId: 'ord-1',
              orderNumber: 'ORD-RET-001',
              orderStatus: 'CONFIRMED',
              customer: { id: 'c1', name: 'Công ty ABC', phone: '0905123456' },
              deliveryStop: {
                id: 's1',
                address: '45 Nguyễn Văn Linh, Đà Nẵng',
                latitude: 16.061,
                longitude: 108.21,
              },
            },
          ],
        },
      ],
    } as never);

    render(
      <ConfigProvider>
        <AntdApp>
          <WarehousesTab
            branches={[
              {
                id: 'branch-dad',
                code: 'BRANCH-DAD',
                name: 'Chi nhánh Đà Nẵng',
                address: 'Đà Nẵng',
                latitude: 16.06,
                longitude: 108.15,
                timezone: 'Asia/Ho_Chi_Minh',
              },
            ]}
            selectedBranchId="ALL"
            canManage
          />
        </AntdApp>
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('WH-DAD-01')).toBeInTheDocument();
      expect(screen.getByText('Kho Trung Chuyển Đà Nẵng')).toBeInTheDocument();
      expect(screen.getByText(/2 kiện · 42\.5 kg/)).toBeInTheDocument();
    });
  });

  it('shows retry error state when loading warehouses fails', async () => {
    vi.mocked(locationsApi.getWarehouses).mockRejectedValueOnce(new Error('Network down'));

    render(
      <ConfigProvider>
        <AntdApp>
          <WarehousesTab branches={[]} selectedBranchId="ALL" canManage={false} />
        </AntdApp>
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Thử lại/i })).toBeInTheDocument();
    });
  });
});
