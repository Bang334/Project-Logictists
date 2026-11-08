import React from 'react';
import { App as AntdApp } from 'antd';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import OrdersPage from '../pages/OrdersPage';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ can: () => true, branchId: 'branch-1' }) }));
vi.mock('../api/client', () => ({
  branchesApi: { getAll: async () => ({ data: [{ id: 'branch-1', name: 'Chi nhánh thử' }] }) },
  customersApi: { getAll: async () => ({ data: [] }) },
  ordersApi: { list: async () => ({ items: [], total: 0 }) },
  apiErrorMessage: () => 'Lỗi thử',
}));
vi.mock('../components/MapLocationPickerModal', () => ({ MapLocationPickerModal: () => null }));
vi.mock('../components/OrderDetailDrawer', () => ({ OrderDetailDrawer: () => null }));

beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element) => getStyle(element) });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
});
afterEach(cleanup);

it('form đơn không yêu cầu hạn giao và vẫn có thời lượng lấy/giao', async () => {
  render(<AntdApp><OrdersPage /></AntdApp>);
  fireEvent.click(await screen.findByText('Tạo đơn nháp'));
  const explanation = await screen.findByText(/Không cần chọn hạn giao/);
  const modal = explanation.closest('.ant-modal-content');
  if (!modal) throw new Error('Thiếu form tạo đơn');
  const dialog = within(modal as HTMLElement);
  expect(dialog.getByText(/Không cần chọn hạn giao/)).toBeInTheDocument();
  expect(dialog.queryByLabelText(/khung giờ giao|khung giờ lấy/i)).not.toBeInTheDocument();
  expect(dialog.getAllByLabelText('Thời gian phục vụ (phút)')).toHaveLength(2);
  expect(dialog.getByText('Lưu nháp')).toBeInTheDocument();
  const cargoKind = dialog.getByLabelText('Loại hàng');
  expect(dialog.queryByText('Được đặt ở tầng trên')).not.toBeInTheDocument();
  fireEvent.mouseDown(cargoKind);
  fireEvent.click(await screen.findByText('Thông thường'));
  expect(dialog.getByLabelText('Được đặt ở tầng trên')).not.toBeChecked();
  expect(dialog.getByLabelText('Khách yêu cầu không đặt hàng lên trên')).not.toBeChecked();
}, 15000);
