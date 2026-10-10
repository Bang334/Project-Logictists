import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DriverApp } from '../DriverApp';
import { PickupScanner } from '../PickupScanner';
import { CameraView } from 'expo-camera';
import { detail, date, harness, list, reply } from './fixtures';
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
let mockPermission = { granted: true, canAskAgain: true };
const mockRequest = jest.fn();
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [mockPermission, mockRequest],
}));
const first = detail.trip.stops[0].tasks[0];
const arrived = { ...detail, status: 'ACCEPTED', version: 2, trip: { ...detail.trip, status: 'IN_PROGRESS', version: 4, actualStartTime: date,
  executionSnapshot: { id: 'snapshot', sourceTripVersion: 2 }, stops: [{ ...detail.trip.stops[0], status: 'ARRIVED', actualArrivalTime: date,
    tasks: [first, { ...first, id: 'task2', package: { ...first.package, id: 'parcel2', packageCode: 'PK-B' } }] }] } };
const loaded = { ...arrived, trip: { ...arrived.trip, version: 5, stops: arrived.trip.stops.map(s => ({ ...s, tasks: s.tasks.map((t,i) => i ? t : { ...t, actualQuantity: 1, pickup: { outcome: 'LOADED', reason: null, occurredAt: date } }) })) } };
const preview = { taskId: 'task', packageId: 'parcel', packageCode: 'PK-A', tripVersion: 4, loadPlanRevision: 1,
  placement: { packageId: 'parcel', xMm: 0, yMm: 0, zMm: 0, effectiveLengthMm: 200, effectiveWidthMm: 200, effectiveHeightMm: 200 } };
const response = { assignmentId: 'a', tripId: 'trip-a', stopId: 's1', tripVersion: 5, eventId: 'event', packageId: 'parcel', outcome: 'LOADED', occurredAt: date };
async function setup(value = arrived) {
  const h = harness('token-a'); await h.store.restore(); h.fetcher.mockResolvedValueOnce(reply(value)); await h.store.open('a'); return h;
}
beforeEach(() => { mockPermission = { granted: true, canAskAgain: true }; mockRequest.mockReset(); });

test('camera scans only once, validates with backend then requires physical-load confirmation', async () => {
  const h = await setup(); render(<DriverApp store={h.store} manageSession={false} />);
  fireEvent.press(screen.getByRole('button', { name: 'Quét QR kiện cần lấy' }));
  const camera = screen.UNSAFE_getByType(CameraView);
  expect(camera.props.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] });
  h.fetcher.mockResolvedValueOnce(reply(preview));
  await act(async () => { camera.props.onBarcodeScanned({ type: 'qr', data: 'TMS:PACKAGE:1:parcel' }); camera.props.onBarcodeScanned({ type: 'qr', data: 'TMS:PACKAGE:1:parcel' }); });
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/scan-pickup'))).toHaveLength(1);
  expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/pickup'))).toHaveLength(0);
  expect(screen.getByText(/Quét mã chưa xác nhận lấy hàng/)).toBeTruthy();
  h.fetcher.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(loaded));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Xác nhận đã xếp kiện lên xe' })));
  expect(h.store.snapshot().detail?.trip.stops[0].tasks[0].pickup?.outcome).toBe('LOADED');
  const request = h.fetcher.mock.calls.find(([url]) => String(url).endsWith('/pickup'));
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ expectedVersion: 2, expectedTripVersion: 4, qrCode: 'TMS:PACKAGE:1:parcel', loadedOnVehicle: true });
});
test('partial completion requires each missing reason and explicit outcome confirmation', async () => {
  const h = await setup(loaded); render(<DriverApp store={h.store} manageSession={false} />);
  fireEvent.press(screen.getByRole('button', { name: 'Kết thúc lấy hàng tại điểm' }));
  expect(screen.getByRole('button', { name: 'Xác nhận hiện trạng: Lấy thiếu' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Lý do chưa lấy PK-B'), 'Chưa đóng gói');
  const finished = { ...loaded, trip: { ...loaded.trip, version: 6, stops: loaded.trip.stops.map(s => ({ ...s, status: 'COMPLETED', actualDepartureTime: date })) } };
  h.fetcher.mockResolvedValueOnce(reply({ ...response, outcome: 'PARTIAL', packageId: null })).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(finished));
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Xác nhận hiện trạng: Lấy thiếu' })));
  const request = h.fetcher.mock.calls.find(([url]) => String(url).endsWith('/complete-pickup'));
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ declaredOutcome: 'PARTIAL', missing: [{ taskId: 'task2', reason: 'Chưa đóng gói' }] });
  expect(h.store.snapshot().detail?.trip.stops[0].status).toBe('COMPLETED');
});
test('permission denial provides a retry, scanner never falls back to manual entry', () => {
  mockPermission = { granted: false, canAskAgain: true }; const onScan = jest.fn();
  render(<PickupScanner onScan={onScan} onClose={jest.fn()} />);
  expect(screen.getByText(/Không thể thay bằng nhập mã thủ công/)).toBeTruthy();
  mockRequest.mockResolvedValue({ granted: false });
  fireEvent.press(screen.getByRole('button', { name: 'Cho phép camera' }));
  expect(mockRequest).toHaveBeenCalled(); expect(onScan).not.toHaveBeenCalled();
});
test('wrong QR/network errors do not mark a parcel loaded or enable confirmation', async () => {
  const h = await setup();
  h.fetcher.mockResolvedValueOnce(reply({ message: 'QR không thuộc điểm này' }, 404));
  expect(await h.store.scanPickup('s1', 'wrong')).toBeUndefined(); expect(h.store.snapshot().error).toBe('QR không thuộc điểm này');
  h.fetcher.mockRejectedValueOnce(new Error('offline'));
  expect(await h.store.scanPickup('s1', 'code')).toBeUndefined(); expect(h.store.snapshot().notice).toBeNull();
  expect(h.store.snapshot().detail?.trip.stops[0].tasks[0].pickup).toBeNull();
});
test('uncertain pickup preserves exact intent and double press cannot create another request', async () => {
  const h = await setup(); h.fetcher.mockRejectedValueOnce(new Error('offline'));
  const input = { qrCode: 'code', loadedOnVehicle: true as const };
  await Promise.all([h.store.respond('pickup','', 's1', input),h.store.respond('pickup','', 's1', input)]);
  expect(h.store.snapshot().intent?.action).toBe('pickup'); expect(h.store.snapshot().notice).toBeNull();
  h.fetcher.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(loaded));
  await h.store.respond('pickup');
  const requests = h.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/pickup'));
  expect(requests).toHaveLength(2); expect(requests[0][1]).toEqual(requests[1][1]);
});
test.each([401,403,409])('pickup handles HTTP %i without claiming success', async status => {
  const h = await setup(); h.fetcher.mockResolvedValueOnce(reply({ code: 'VERSION_CONFLICT', message: 'Denied' },status));
  if(status===409) h.fetcher.mockResolvedValueOnce(reply(list)).mockResolvedValueOnce(reply(loaded));
  await h.store.respond('pickup','', 's1',{qrCode:'code',loadedOnVehicle:true});
  expect(h.store.snapshot().authenticated).toBe(status!==401); expect(h.store.snapshot().intent).toBeNull();
  if(status===409) expect(h.store.snapshot().detail?.trip.version).toBe(5);
});
test('old scan response after logout cannot populate the next account', async () => {
  const h = await setup(); let finish: (value: Response) => void = () => { throw new Error('scan not requested'); };
  h.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const scan = h.store.scanPickup('s1','code');
  await h.store.logout(false); await h.store.login('b','password');
  finish(reply(preview)); expect(await scan).toBeUndefined(); expect(h.store.snapshot().detail).toBeNull();
});
