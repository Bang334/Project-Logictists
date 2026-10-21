import React from 'react';
import { App } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditDriverModal } from '../components/EditDriverModal';
import { driversApi } from '../api/client';
import type { Driver } from '../types';

vi.mock('../api/client', () => ({ driversApi: { update: vi.fn() } }));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(query => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const driver: Driver = { id: 'driver', updatedAt: '2026-10-17T00:00:00.000Z', fullName: 'Test Driver', phone: '100', citizenId: 'test-id', licenseNumber: 'test-license', licenseClass: 'C', licenseExpiry: '2035-01-01', homeBranchId: 'branch', status: 'AVAILABLE', fixedSalaryMonthly: '0', tripBasePay: '0', perKmPay: '0' };

describe('EditDriverModal regression', () => {
  it('preserves zero compensation and submits the version read with the profile', async () => {
    vi.mocked(driversApi.update).mockResolvedValue({ data: driver } as Awaited<ReturnType<typeof driversApi.update>>);
    const onCancel = vi.fn(), onSuccess = vi.fn();
    render(<App><EditDriverModal open driver={driver} branches={[]} onCancel={onCancel} onSuccess={onSuccess} /></App>);
    await waitFor(() => expect(screen.getByLabelText('Lương Cứng Cơ Bản')).toHaveValue('0'));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu Hồ Sơ' }));
    await waitFor(() => expect(driversApi.update).toHaveBeenCalledWith('driver', expect.objectContaining({ expectedUpdatedAt: driver.updatedAt, fixedSalaryMonthly: 0, tripBasePay: 0, perKmPay: 0 })));
    expect(onSuccess).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps input and the modal open after a version conflict', async () => {
    vi.mocked(driversApi.update).mockRejectedValue({ response: { data: { message: 'Hồ sơ đã thay đổi' } } });
    const onCancel = vi.fn(), onSuccess = vi.fn();
    render(<App><EditDriverModal open driver={driver} branches={[]} onCancel={onCancel} onSuccess={onSuccess} /></App>);
    fireEvent.change(await screen.findByLabelText('Họ và Tên Tài Xế'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu Hồ Sơ' }));
    await screen.findByText('Hồ sơ đã thay đổi');
    expect(screen.getByLabelText('Họ và Tên Tài Xế')).toHaveValue('Unsaved name');
    expect(onCancel).not.toHaveBeenCalled(); expect(onSuccess).not.toHaveBeenCalled();
  });
});
