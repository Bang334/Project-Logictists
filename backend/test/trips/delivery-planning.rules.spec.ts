import { proposedDeliveryWindows } from '../../src/trips/delivery-planning.rules';

const proposal = (times: number[], status = 'SUCCESS') => ({
  planningEpochIso: '2031-01-02T17:00:00Z',
  result: { status, unassigned_orders: [], routes: [{ stops: times.map(arrival_time_sec => ({ stop_type: 'DELIVERY', order_id: 'order', arrival_time_sec })) }] },
});

describe('Đề xuất khung dựa trên tuyến khả thi', () => {
  const now = new Date('2031-01-01T00:00:00Z'), expires = new Date('2031-01-02T13:00:00Z');
  it('bao trùm mọi lần giao của cùng đơn, nằm trong ca, không nhận khung khách tự chọn', () => {
    const [window] = proposedDeliveryWindows(proposal([9 * 3600, 10 * 3600]), 120, expires, 28800, 61200, now);
    expect(window.windowStart.toISOString()).toBe('2031-01-03T02:00:00.000Z');
    expect(window.windowEnd.toISOString()).toBe('2031-01-03T04:00:00.000Z');
  });
  it('không gửi đề xuất từ nghiệm thiếu đơn hoặc khung không bao phủ các lần giao', () => {
    expect(() => proposedDeliveryWindows(proposal([32400], 'PARTIAL'), 120, expires, 28800, 61200, now)).toThrow(/giao đủ/);
    expect(() => proposedDeliveryWindows(proposal([32400, 50400]), 120, expires, 28800, 61200, now)).toThrow(/không nằm/);
  });
  it('không gửi khi hết hạn phản hồi hoặc hạn phản hồi nằm sau khung giao', () => {
    expect(() => proposedDeliveryWindows(proposal([32400]), 120, now, 28800, 61200, now)).toThrow(/không hợp lệ/);
    expect(() => proposedDeliveryWindows(proposal([32400]), 120, new Date('2031-01-03T04:00:00Z'), 28800, 61200, now)).toThrow(/trước/);
  });
  it('không gom các lần giao khác ngày vào một lời hẹn sai', () => {
    expect(() => proposedDeliveryWindows(proposal([32400, 86400 + 32400]), 1440, expires, 28800, 61200, now)).toThrow(/không nằm/);
  });
});
