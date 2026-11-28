import React from 'react';
import axios from 'axios';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import RecipientDeliveryPage from '../pages/RecipientDeliveryPage';

vi.mock('axios', async (importOriginal) => {
  const original = await importOriginal<typeof import('axios')>();
  return {
    ...original,
    default: {
      ...original.default,
      get: vi.fn(),
      post: vi.fn(),
      isAxiosError: original.default.isAxiosError,
    },
  };
});

beforeAll(() => {
  const getStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => getStyle(element),
  });
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
});

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const baseAppointment = {
  id: 'app-1',
  batchId: 'batch-1',
  orderId: 'order-1',
  version: 1,
  status: 'PENDING',
  windowStart: '2031-01-03T02:00:00Z',
  windowEnd: '2031-01-03T04:00:00Z',
  expiresAt: '2031-01-02T13:00:00Z',
  order: { orderNumber: 'DH-WEB-01' },
};

describe('RecipientDeliveryPage', () => {
  it('báo lỗi khi URL thiếu token trong hash fragment', async () => {
    render(<RecipientDeliveryPage />);
    expect(await screen.findByText(/thiếu mã xác thực/i)).toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('tải đề xuất bằng X-Delivery-Token và giữ nguyên idempotencyKey khi thử lại xác nhận', async () => {
    window.location.hash = '#signed-token-123';
    vi.mocked(axios.get).mockResolvedValueOnce({ data: baseAppointment });
    vi.mocked(axios.post)
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValueOnce({ data: { ...baseAppointment, status: 'CONFIRMED', version: 2 } });

    render(<RecipientDeliveryPage />);
    expect(await screen.findByText('Đơn hàng DH-WEB-01')).toBeInTheDocument();
    expect(vi.mocked(axios.get)).toHaveBeenCalledWith(
      expect.stringContaining('/delivery-planning/recipient'),
      expect.objectContaining({ headers: { 'X-Delivery-Token': 'signed-token-123' } }),
    );

    const confirmBtn = screen.getByRole('button', { name: 'Xác nhận nhận hàng khung này' });
    fireEvent.click(confirmBtn);
    await screen.findByText(/Không xử lý được yêu cầu/);

    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận nhận hàng khung này' }));
    await screen.findByText('Đã ghi nhận xác nhận khung giờ nhận hàng của bạn.');

    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(axios.post).mock.calls[0][1]).toEqual(
      vi.mocked(axios.post).mock.calls[1][1],
    );
    expect(vi.mocked(axios.post).mock.calls[0][1]).toMatchObject({
      version: 1,
      decision: 'CONFIRMED',
    });
  });

  it('hiển thị trạng thái hết hạn khi đề xuất đã quá expiresAt', async () => {
    window.location.hash = '#expired-token';
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: { ...baseAppointment, expiresAt: '2020-01-01T00:00:00Z' },
    });

    render(<RecipientDeliveryPage />);
    expect(await screen.findByText('Liên kết phản hồi đã quá hạn.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Xác nhận nhận hàng khung này' })).not.toBeInTheDocument();
  });

  it('mở biểu mẫu đổi giờ và gửi CHANGE_REQUESTED theo múi giờ +07:00', async () => {
    window.location.hash = '#change-token';
    vi.mocked(axios.get).mockResolvedValueOnce({ data: baseAppointment });
    vi.mocked(axios.post).mockResolvedValueOnce({
      data: {
        ...baseAppointment,
        status: 'CHANGE_REQUESTED',
        version: 2,
        requestedStart: '2031-01-03T02:00:00+07:00',
        requestedEnd: '2031-01-03T04:00:00+07:00',
      },
    });

    render(<RecipientDeliveryPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Đổi khung giờ khác' }));
    fireEvent.change(screen.getByPlaceholderText('Ví dụ: Gọi trước 15 phút'), {
      target: { value: 'Giao buổi sáng giúp tôi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi khung giờ mong muốn' }));

    await screen.findByText('Đã gửi đề xuất khung giờ nhận hàng mới cho bộ phận điều phối.');
    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      expect.stringContaining('/delivery-planning/recipient'),
      expect.objectContaining({
        version: 1,
        decision: 'CHANGE_REQUESTED',
        requestedStart: '2031-01-03T09:00:00+07:00',
        requestedEnd: '2031-01-03T11:00:00+07:00',
        note: 'Giao buổi sáng giúp tôi',
      }),
      expect.objectContaining({ headers: { 'X-Delivery-Token': 'change-token' } }),
    );
  });
});
