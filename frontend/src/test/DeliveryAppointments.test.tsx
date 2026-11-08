import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CustomerDeliveryInbox, DispatcherDeliveryPlanning } from '../components/DeliveryAppointments';
import { apiClient } from '../api/client';

vi.mock('../api/client', () => ({ apiClient: { get: vi.fn(), post: vi.fn() }, apiErrorMessage: () => 'Không thể gửi phản hồi; hãy thử lại' }));
vi.mock('../api/realtime', () => ({ getRealtimeSocket: () => null }));
beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: (element: Element) => getStyle(element) });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
beforeEach(() => { vi.mocked(apiClient.get).mockReset(); vi.mocked(apiClient.post).mockReset(); });
afterEach(cleanup);
const appointment = { id: 'offer', batchId: 'batch', orderId: 'order', version: 1, status: 'PENDING',
  order: { orderNumber: 'ORDER-TEST' }, windowStart: '2031-01-03T02:00:00Z', windowEnd: '2031-01-03T04:00:00Z', expiresAt: '2031-01-02T13:00:00Z' };

it('khách xác nhận đúng đề xuất/version; API lỗi cho thử lại với cùng idempotency key', async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [appointment], total: 1 } });
  vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ data: {} });
  render(<CustomerDeliveryInbox />);
  await screen.findByText('ORDER-TEST');
  fireEvent.click(screen.getByText('Tôi nhận được trong khung này'));
  await screen.findByText('Không thể gửi phản hồi; hãy thử lại');
  const first = vi.mocked(apiClient.post).mock.calls[0];
  expect(first[0]).toBe('/delivery-planning/appointments/offer/respond');
  expect(first[1]).toMatchObject({ version: 1, decision: 'CONFIRMED' });
  fireEvent.click(screen.getByText('Tôi nhận được trong khung này'));
  await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiClient.post).mock.calls[1][1]).toEqual(first[1]);
}, 15000);

it('đề xuất hết hạn không còn nút xác nhận', async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: { items: [{ ...appointment, expiresAt: '2020-01-01T00:00:00Z' }], total: 1 } });
  render(<CustomerDeliveryInbox />);
  await screen.findByText('ORDER-TEST');
  expect(screen.getByText('Hết hạn phản hồi')).toBeInTheDocument();
  expect(screen.queryByText('Tôi nhận được trong khung này')).not.toBeInTheDocument();
});

it('điều phối không thể chốt khi còn khách đang chờ', async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'batch', status: 'OFFERING', expiresAt: appointment.expiresAt, appointments: [appointment] }] });
  render(<DispatcherDeliveryPlanning branchId="branch" candidateNumber={1} canPropose={false} onJob={async () => undefined} />);
  expect(await screen.findByText('0 đơn đã xác nhận · 1 đơn đang chờ')).toBeInTheDocument();
  expect(screen.queryByText(/ORDER-TEST:/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Xem phản hồi' }));
  await screen.findByText(/ORDER-TEST:/);
  expect(screen.getByText('Tối ưu chốt các đơn đã xác nhận').closest('button')).toBeDisabled();
  expect(apiClient.post).not.toHaveBeenCalled();
});

it('ẩn khu vực hẹn khi điều phối thường và chỉ hiển thị hướng dẫn trong hộp thoại gửi khung', async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: [{ id: 'old-batch', status: 'APPLIED', expiresAt: appointment.expiresAt, appointments: [] }] });
  const props = { branchId: 'branch', jobId: 'job', candidateNumber: 2, onJob: async () => undefined };
  const { rerender } = render(<DispatcherDeliveryPlanning {...props} canPropose={false} />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Hẹn giao với khách')).not.toBeInTheDocument();
  expect(screen.queryByText('Xem phản hồi')).not.toBeInTheDocument();
  expect(screen.queryByText('Gửi khung giờ cho khách')).not.toBeInTheDocument();

  rerender(<DispatcherDeliveryPlanning {...props} canPropose />);
  expect(screen.queryByText(/Phương án #2 dùng để đề xuất/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Gửi khung giờ cho khách' }));
  expect(await screen.findByText(/Phương án #2 dùng để đề xuất/)).toBeInTheDocument();
  expect(apiClient.post).not.toHaveBeenCalled();
});
