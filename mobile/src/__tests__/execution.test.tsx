import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DriverApp } from '../DriverApp';
import { detail, date, harness, list, reply } from './fixtures';
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const accepted = { ...detail, status: 'ACCEPTED', version: 2 };
const started = { ...accepted, trip: { ...accepted.trip, status: 'IN_PROGRESS', version: 3, actualStartTime: date,
  executionSnapshot: { id: 'snapshot', sourceTripVersion: 2 } } };
const arrived = { ...started, trip: { ...started.trip, version: 4,
  stops: started.trip.stops.map(stop => ({ ...stop, status: 'ARRIVED', actualArrivalTime: date })) } };
const result = (arrival = false) => ({ assignmentId: 'a', tripId: 'trip-a', tripVersion: arrival ? 4 : 3,
  stopId: arrival ? 's1' : null, eventId: 'event', snapshotId: 'snapshot', sourceTripVersion: 2,
  occurredAt: date, status: arrival ? 'ARRIVED' : 'IN_PROGRESS' });
async function loaded() {
  const h = harness('token-a'); await h.store.restore();
  h.fetcher.mockResolvedValueOnce(reply(accepted)); await h.store.open('a'); return h;
}
test('start and manual arrival require confirmation, reload actual state and stop at ARRIVED', async () => {
  const h = await loaded(); render(<DriverApp store={h.store} manageSession={false} />);
  fireEvent.press(screen.getByRole('button', { name: 'Bắt đầu chuyến' }));
  expect(h.fetcher.mock.calls.filter(([p]) => String(p).endsWith('/start'))).toHaveLength(0);
  h.fetcher.mockResolvedValueOnce(reply(result())).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(started));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Xác nhận thực hiện' })));
  await screen.findByText('Điểm cần đến: 1. Điểm lấy');
  fireEvent.press(screen.getByRole('button', { name: 'Tôi đã đến điểm' }));
  expect(screen.getByText(/chưa xác minh bằng GPS/)).toBeTruthy();
  h.fetcher.mockResolvedValueOnce(reply(result(true))).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(arrived));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Xác nhận thực hiện' })));
  await screen.findByText(/Chờ hoàn tất nghiệp vụ tại điểm/);
  expect(screen.queryByRole('button', { name: 'Tôi đã đến điểm' })).toBeNull();
  expect(h.store.snapshot().detail?.trip.stops[0].actualArrivalTime).toBe(date);
});
test('network uncertainty retains exact start intent and double press cannot duplicate it', async () => {
  const h = await loaded(); h.fetcher.mockRejectedValueOnce(new Error('offline'));
  await Promise.all([h.store.respond('start'), h.store.respond('start')]);
  expect(h.store.snapshot().notice).toBeNull(); expect(h.store.snapshot().intent?.action).toBe('start');
  h.fetcher.mockResolvedValueOnce(reply(result())).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(started));
  await h.store.respond('start');
  const calls = h.fetcher.mock.calls.filter(([p]) => String(p).endsWith('/start'));
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
  expect(h.store.snapshot().detail?.trip.status).toBe('IN_PROGRESS');
});
test.each([401,403,409])('execution handles HTTP %i without false success', async status => {
  const h = await loaded();
  h.fetcher.mockResolvedValueOnce(reply({ code: status === 409 ? 'VERSION_CONFLICT' : 'DENIED', message: 'Denied' }, status));
  if (status === 409) h.fetcher.mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(started));
  await h.store.respond('start');
  expect(h.store.snapshot().intent).toBeNull();
  expect(h.store.snapshot().authenticated).toBe(status !== 401);
  if (status === 409) expect(h.store.snapshot().detail?.trip.version).toBe(3);
  else expect(h.store.snapshot().error).toBe('Denied');
});
test('resource conflict keeps the reason instead of claiming a plan change', async () => {
  const h = await loaded();
  h.fetcher.mockResolvedValueOnce(reply({ code: 'RESOURCE_BUSY', message: 'Xe đang chạy chuyến khác' }, 409))
    .mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(accepted));
  await h.store.respond('start'); expect(h.store.snapshot().notice).toBe('Xe đang chạy chuyến khác');
});
