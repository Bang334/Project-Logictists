import { App } from 'antd';
import { AxiosHeaders } from 'axios';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { branchesApi, settingsApi } from '../api/client';
import SettingsPage from '../pages/SettingsPage';
import { canOpenTab } from '../utils/navigationAccess';
import type { ScopedSettingsResponse, SettingAuditLogsResponse } from '../types/settings';
import type { Branch, User } from '../types';

let mockPermissions = new Set<string>(['settings.read', 'settings.manage']);
let mockUser: User = {
  id: 'u-admin',
  username: 'admin',
  fullName: 'Quản trị viên',
  role: 'ADMIN',
  companyScope: true,
  branches: [],
  grants: [],
  permissions: ['settings.read', 'settings.manage'],
};

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    branchesApi: {
      ...original.branchesApi,
      getAll: vi.fn(),
    },
    settingsApi: {
      ...original.settingsApi,
      getCompany: vi.fn(),
      updateCompany: vi.fn(),
      getBranch: vi.fn(),
      updateBranch: vi.fn(),
      resetBranchOverrides: vi.fn(),
      getAuditLogs: vi.fn(),
    },
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    can: (permission: string) => mockPermissions.has(permission),
  }),
}));

beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => getStyle(el));
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

afterEach(() => {
  cleanup();
});

const axiosMeta = {
  status: 200,
  statusText: 'OK',
  headers: {},
  config: { headers: new AxiosHeaders() },
};

const sampleBranches: Branch[] = [
  {
    id: 'branch-hcm',
    code: 'HCM',
    name: 'Chi nhánh TP.HCM',
    address: 'Quận 1, TP.HCM',
    latitude: 10.77,
    longitude: 106.7,
    phone: '028123456',
    timezone: 'Asia/Ho_Chi_Minh',
    deliveryGraceDays: 2,
    lateDeliveryPenaltyMode: 'NONE',
    lateDeliveryPenaltyValue: '0',
  },
];

function makeCompanyResponse(overrides: Partial<ScopedSettingsResponse['company']> = {}): ScopedSettingsResponse {
  const company = {
    version: 1,
    updatedAt: '2026-11-14T10:00:00.000Z',
    stacking: {
      enabled: false,
      ownerMode: 'SAME_CUSTOMER' as const,
      maxTiers: 2,
      liftClearanceMm: 50,
    },
    optimization: {
      defaultSearchBudgetSeconds: 10,
      maxTimeSeconds: 120,
      hybridSeedCount: 0,
      earlyStopPatience: 30,
      unassignedOrderPenaltyVnd: 1_000_000_000,
      maxRoutesPerDay: null,
      demoAllowOverride: true,
    },
    costPenalty: {
      fuelPricePerLiter: 23_500,
      monthlyWorkingMinutes: 10_560,
      cargoHoldingCostVndPerTonHour: 0,
      workStartTime: '08:00',
      workEndTime: '17:00',
      deliveryGraceDays: 2,
      lateDeliveryPenaltyMode: 'NONE' as const,
      lateDeliveryPenaltyValue: 0,
    },
    ...overrides,
  };
  return {
    company,
    branch: null,
    effective: {
      scopeType: 'COMPANY',
      branchId: null,
      branchCode: null,
      branchName: null,
      companyVersion: company.version,
      branchVersion: 0,
      policyVersion: `company:v${company.version}`,
      updatedAt: company.updatedAt ?? '2026-11-14T10:00:00.000Z',
      overrides: { stacking: false, optimization: false, costPenalty: false },
      sources: { stacking: 'COMPANY', optimization: 'COMPANY', costPenalty: 'COMPANY' },
      stacking: company.stacking,
      optimization: company.optimization,
      costPenalty: company.costPenalty,
    },
  };
}

const sampleAuditLogs: SettingAuditLogsResponse = {
  items: [
    {
      id: 'audit-1',
      entityId: 'COMPANY',
      action: 'UPDATE_COMPANY_SETTINGS',
      performedBy: 'admin',
      actorFullName: 'Quản trị viên',
      timestamp: '2026-11-14T10:05:00.000Z',
      details: { scopeType: 'COMPANY', branchId: null },
      changeSummary: {
        versionFrom: 1,
        versionTo: 2,
        changes: {
          'stacking.enabled': { from: false, to: true },
          'stacking.ownerMode': { from: 'SAME_CUSTOMER', to: 'ANY_CUSTOMER' },
        },
      },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPermissions = new Set(['settings.read', 'settings.manage']);
  mockUser = {
    id: 'u-admin',
    username: 'admin',
    fullName: 'Quản trị viên',
    role: 'ADMIN',
    companyScope: true,
    branches: [],
    grants: [],
    permissions: ['settings.read', 'settings.manage'],
  };
  vi.mocked(branchesApi.getAll).mockResolvedValue({ ...axiosMeta, data: sampleBranches });
  vi.mocked(settingsApi.getCompany).mockResolvedValue({
    ...axiosMeta,
    data: makeCompanyResponse(),
  });
  vi.mocked(settingsApi.getAuditLogs).mockResolvedValue({
    ...axiosMeta,
    data: sampleAuditLogs,
  });
});

it('cho phép Admin lưu cấu hình xếp chồng và số seed toàn công ty', async () => {
  const saved = makeCompanyResponse({
    version: 2,
    stacking: { enabled: true, ownerMode: 'ANY_CUSTOMER', maxTiers: 2, liftClearanceMm: 50 },
    optimization: {
      ...makeCompanyResponse().company.optimization,
      hybridSeedCount: 20,
      maxTimeSeconds: 1000,
      earlyStopPatience: 35,
    },
  });
  vi.mocked(settingsApi.updateCompany).mockResolvedValue({ ...axiosMeta, data: saved });

  render(<App><SettingsPage /></App>);

  await waitFor(() => expect(screen.getByLabelText('Bật xếp chồng hàng hóa')).toBeInTheDocument());
  expect(screen.getByText('Quyền chỉnh sửa (Admin)')).toBeInTheDocument();
  expect(screen.getByText('Lưu thay đổi').closest('button')).toBeDisabled();

  const stackSwitch = screen.getByLabelText('Bật xếp chồng hàng hóa');
  fireEvent.click(stackSwitch);
  const seedCount = screen.getByRole('combobox', { name: 'Số seed Hybrid ALNS' });
  fireEvent.mouseDown(seedCount);
  fireEvent.change(seedCount, { target: { value: '20' } });
  fireEvent.click(await screen.findByText('20 seed'));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Trần thời gian tối ưu tối đa' }), {
    target: { value: '1000' },
  });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Ngưỡng dừng sớm' }), {
    target: { value: '35' },
  });

  await waitFor(() => expect(screen.getByText('Lưu thay đổi').closest('button')).not.toBeDisabled());
  fireEvent.click(screen.getByText('Lưu thay đổi'));

  await waitFor(() =>
    expect(settingsApi.updateCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        stacking: expect.objectContaining({ enabled: true }),
        optimization: expect.objectContaining({ hybridSeedCount: 20, maxTimeSeconds: 1000, earlyStopPatience: 35 }),
      }),
    ),
  );
  await waitFor(() => expect(screen.getByText('company:v2')).toBeInTheDocument());
}, 15_000);

it('lưu hạn giao và tỷ lệ phạt theo ngày', async () => {
  const costPenalty = {
    ...makeCompanyResponse().company.costPenalty,
    deliveryGraceDays: 14,
    lateDeliveryPenaltyMode: 'PERCENT_ORDER_VALUE_PER_DAY' as const,
    lateDeliveryPenaltyValue: 1.5,
  };
  vi.mocked(settingsApi.updateCompany).mockResolvedValue({
    ...axiosMeta,
    data: makeCompanyResponse({ version: 2, costPenalty }),
  });

  render(<App><SettingsPage /></App>);
  const deadline = await screen.findByRole('spinbutton', { name: 'Số ngày ân hạn giao hàng' });
  fireEvent.change(deadline, { target: { value: '14' } });
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Hình thức phạt giao trễ' }));
  fireEvent.click(await screen.findByText('Phần trăm giá trị đơn mỗi ngày trễ'));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Tỷ lệ phạt mỗi ngày trễ' }), {
    target: { value: '1.5' },
  });
  fireEvent.click(screen.getByText('Lưu thay đổi'));

  await waitFor(() => expect(settingsApi.updateCompany).toHaveBeenCalledWith(
    expect.objectContaining({ costPenalty }),
  ));
}, 15_000);

it('hiển thị cảnh báo xung đột phiên bản 409 Conflict khi có người cập nhật trước', async () => {
  vi.mocked(settingsApi.updateCompany).mockRejectedValue({ response: { status: 409 } });

  render(<App><SettingsPage /></App>);
  await waitFor(() => expect(screen.getByLabelText('Bật xếp chồng hàng hóa')).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText('Bật xếp chồng hàng hóa'));
  fireEvent.click(screen.getByText('Lưu thay đổi'));

  await waitFor(() =>
    expect(screen.getByText(/Xung đột phiên bản cập nhật \(409 Conflict\)/)).toBeInTheDocument(),
  );
  expect(screen.getByText('Tải lại bản mới')).toBeInTheDocument();
}, 15_000);

it('chặn lưu khi giờ bắt đầu ca >= giờ kết thúc ca', async () => {
  render(<App><SettingsPage /></App>);
  await waitFor(() => expect(screen.getByLabelText('Giờ bắt đầu ca')).toBeInTheDocument());

  const startInput = screen.getByLabelText('Giờ bắt đầu ca');
  fireEvent.change(startInput, { target: { value: '18:00' } });
  fireEvent.click(screen.getByText('Lưu thay đổi'));

  await waitFor(() => expect(screen.getByText('Dữ liệu chưa hợp lệ')).toBeInTheDocument());
  expect(settingsApi.updateCompany).not.toHaveBeenCalled();
}, 15_000);

it('hiển thị chế độ chỉ xem cho Điều phối viên và không hiện nút Lưu', async () => {
  mockPermissions = new Set(['settings.read']);
  mockUser = {
    id: 'u-disp',
    username: 'disp1',
    fullName: 'Điều phối viên 1',
    role: 'DISPATCHER',
    companyScope: false,
    branches: [{ id: 'branch-hcm', code: 'HCM', name: 'Chi nhánh TP.HCM' }],
    grants: [],
    permissions: ['settings.read'],
  };

  render(<App><SettingsPage /></App>);
  await waitFor(() => expect(screen.getByText('Bạn đang ở chế độ chỉ xem')).toBeInTheDocument());

  expect(screen.queryByText('Lưu thay đổi')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Bật xếp chồng hàng hóa')).toBeDisabled();
  expect(screen.getByText('Cập nhật mặc định công ty')).toBeInTheDocument();
  expect(screen.getByText(/Cho phép kiện khác khách hàng/)).toBeInTheDocument();
}, 15_000);

it('kiểm tra quyền điều hướng tab settings cho tài khoản có settings.read', () => {
  expect(canOpenTab(mockUser, 'settings', (p) => p === 'settings.read')).toBe(true);
  expect(canOpenTab(mockUser, 'settings', () => false)).toBe(false);
});
