import { Alert, StyleSheet, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, testRouter, waitFor } from 'expo-router/testing-library';
import { router, useLocalSearchParams } from 'expo-router';
import RootLayout from '@/app/_layout';
import AuthLayout from '@/app/(auth)/_layout';
import CustomerLayout from '@/app/(customer)/_layout';
import * as DriverLayout from '@/app/(driver)/_layout';
import DriverTabsLayout from '@/app/(driver)/(tabs)/_layout';
import DriverEntry from '@/app/(driver)/(tabs)/index';
import DriverAccount from '@/app/(driver)/(tabs)/account';
import TripList from '@/app/(driver)/trips/index';
import Calendar from '@/app/(driver)/(tabs)/calendar';
import History from '@/app/(driver)/(tabs)/activity';
import { authService } from '@/features/auth/services/auth.service';
import { LoginScreen } from '@/features/auth/screens/LoginScreen';
import { SessionErrorScreen } from '@/features/auth/screens/SessionErrorScreen';
import NetInfo from '@react-native-community/netinfo';
import { jwtExpiry, offlineDriverIdentity } from '@/features/auth/services/offline-driver-identity';
import type { AuthProfile } from '@/features/auth/types/auth.types';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import { offlineDriverExecutionCoordinator } from '@/features/driver-offline/services/offline-driver-execution.coordinator';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { EMPTY_TRACKING_SNAPSHOT } from '@/features/driver-tracking/types/driver-tracking.types';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import { driverProfileService, type DriverSelfProfile } from '../services/driver-profile.service';
import type { DriverTripDetail, DriverTripPage, DriverTripStop, DriverTripSummary } from '@/features/driver-trips/types/driver-trip.types';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';

jest.mock('@/features/auth/services/auth.service', () => ({ authService: { getProfile: jest.fn(), login: jest.fn() } }));
jest.mock('../services/driver-profile.service', () => ({ driverProfileService: { getProfile: jest.fn() } }));
jest.mock('@/shared/storage/token-storage', () => ({ tokenStorage: { get: jest.fn(), clear: jest.fn(), set: jest.fn() } }));
jest.mock('react-native/Libraries/Components/RefreshControl/RefreshControl', () => {
  const React = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ onRefresh }: { onRefresh: () => void }) =>
    React.createElement(Pressable, { testID: 'driver-home-refresh', onPress: onRefresh }) };
});
jest.mock('@/features/driver-tracking/tasks/driver-location.task', () => ({}));
const mockTrackingMount = jest.fn();
jest.mock('@/features/driver-tracking/components/DriverTrackingLifecycle', () => ({
  DriverTrackingLifecycle: () => {
    jest.requireActual('react').useEffect(() => { mockTrackingMount(); }, []);
    return null;
  },
}));
jest.mock('@/features/driver-offline/services/offline-driver-execution.coordinator', () => ({
  offlineDriverExecutionCoordinator: {
    activate: jest.fn(async () => undefined), sync: jest.fn(async () => undefined), deactivate: jest.fn(),
  },
}));
jest.mock('@/features/auth/components/OfflineDriverWorkspace', () => ({
  OfflineDriverWorkspace: () => null,
}));
jest.mock('@/features/auth/services/offline-driver-identity', () => ({
  jwtExpiry: jest.fn(() => null),
  offlineDriverIdentity: { read: jest.fn(), remember: jest.fn(), clear: jest.fn() },
}));
jest.mock('@/features/driver-tracking/services/driver-tracking.service', () => ({
  driverTrackingService: {
    getSnapshot: jest.fn(), subscribe: jest.fn(() => () => undefined),
    cleanupOnLogout: jest.fn(async () => undefined), beginAfterStart: jest.fn(),
  },
}));
jest.mock('@/features/driver-trips/services/driver-trips.service', () => ({
  driverTripsService: { getTrips: jest.fn(), getTrip: jest.fn(), getHistory: jest.fn(), getActivitySummary: jest.fn(), startTrip: jest.fn(), arriveStop: jest.fn(),
    completeStop: jest.fn(), completeTrip: jest.fn() },
}));

let mockOnline = true;
const mockConnectivityListeners = new Set<() => void>();
const mockSubscribeConnectivity = (listener: () => void) => {
  mockConnectivityListeners.add(listener);
  return () => { mockConnectivityListeners.delete(listener); };
};
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => jest.fn()) },
  useNetInfo: () => {
    const online = jest.requireActual('react').useSyncExternalStore(mockSubscribeConnectivity, () => mockOnline);
    return { isConnected: online, isInternetReachable: online };
  },
}));
let mockCommands: OfflineDriverCommand[] = [];
jest.mock('@/features/driver-offline/hooks/useOfflineDriverQueue', () => ({
  useOfflineDriverQueue: () => ({
    commands: mockCommands,
    summary: {
      totalUnsynced: mockCommands.filter((command) => command.state !== 'SYNCED').length,
      conflict: mockCommands.filter((command) => command.state === 'CONFLICT').length,
      failed: mockCommands.filter((command) => command.state === 'FAILED').length,
      blocked: mockCommands.filter((command) => command.state === 'BLOCKED').length,
    },
  }),
}));

const profile: AuthProfile = {
  id: 'driver-user', username: 'driver-qa', fullName: 'Tài xế QA', role: 'DRIVER',
  phone: null, email: null, active: true, branchId: null, locationId: null, customer: null,
};
const selfProfile: DriverSelfProfile = {
  id: 'driver-record', fullName: 'Hồ sơ tài xế QA', operationalPhone: null, status: 'AVAILABLE',
  homeBranch: { id: 'branch-qa', code: 'QA', name: 'Kho QA', timezone: 'Asia/Ho_Chi_Minh' },
  license: null,
};
const active: DriverTripSummary = {
  id: 'trip-active', tripNumber: 'QA-ACTIVE-0001', status: 'IN_PROGRESS', version: 2,
  plannedStartTime: '2026-11-20T00:00:00.000Z', plannedEndTime: '2026-11-20T04:00:00.000Z',
  actualStartTime: '2026-11-20T00:00:00.000Z', actualEndTime: null,
  totalDistanceKm: 5, totalDurationMinutes: 25,
  vehicle: { id: 'vehicle-1', plateNumber: 'QA-123', model: 'Xe tải', vehicleType: 'TRUCK' },
  assignment: { id: 'assignment-1', role: 'PRIMARY', status: 'ASSIGNED', startTime: '2026-11-20T00:00:00.000Z', endTime: '2026-11-20T04:00:00.000Z' },
  stopCount: 3,
};
const planned: DriverTripSummary = { ...active, id: 'trip-planned', tripNumber: 'QA-PLANNED-0002', status: 'DISPATCHED' };
const stop: DriverTripStop = {
  id: 'stop-1', sequence: 1, status: 'COMPLETED', stopType: 'PICKUP', address: 'Kho đã lấy hàng',
  latitude: 21.03, longitude: 105.85, contactName: null, contactPhone: null,
  plannedArrivalTime: null, plannedDepartureTime: null, actualArrivalTime: null, actualDepartureTime: null,
  tasks: [],
};
const detail: DriverTripDetail = {
  ...active, stops: [stop,
    { ...stop, id: 'stop-2', sequence: 2, status: 'PENDING', stopType: 'DELIVERY', address: 'Kho giao tiếp theo' },
    { ...stop, id: 'stop-3', sequence: 3, status: 'PENDING', stopType: 'DEPOT_END', address: 'Kho cuối' },
  ],
};

function page(items: DriverTripSummary[] = []): DriverTripPage {
  return { items, page: 1, limit: 3, total: items.length, totalPages: Number(items.length > 0) };
}

function TripRouteProbe() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>Trip {id}</Text>;
}

function SyncRouteProbe() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>Sync {id}</Text>;
}

function openApp(initialUrl = '/') {
  return renderRouter({
    '_layout': RootLayout,
    '(auth)/_layout': AuthLayout,
    '(auth)/login': LoginScreen,
    '(auth)/register': () => <Text>Đăng ký</Text>,
    '(customer)/_layout': CustomerLayout,
    '(customer)/index': () => <Text>Customer Home</Text>,
    '(driver)/_layout': DriverLayout,
    '(driver)/(tabs)/_layout': DriverTabsLayout,
    '(driver)/(tabs)/index': DriverEntry,
    '(driver)/(tabs)/account': DriverAccount,
    '(driver)/trips/index': TripList,
    '(driver)/(tabs)/calendar': Calendar,
    '(driver)/(tabs)/activity': History,
    '(driver)/trips/[id]': TripRouteProbe,
    '(driver)/trips/[id]/sync': SyncRouteProbe,
    'session-error': SessionErrorScreen,
  }, { initialUrl });
}

function enableNetwork(online: boolean) {
  mockOnline = online;
  mockConnectivityListeners.forEach((listener) => listener());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOnline = true;
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true } as Awaited<ReturnType<typeof NetInfo.fetch>>);
  mockCommands = [];
  jest.mocked(tokenStorage.get).mockResolvedValue('stored-test-token');
  jest.mocked(jwtExpiry).mockReturnValue(null);
  jest.mocked(authService.getProfile).mockResolvedValue(profile);
  jest.mocked(driverProfileService.getProfile).mockReset().mockResolvedValue(selfProfile);
  jest.mocked(driverTrackingService.getSnapshot).mockReturnValue(EMPTY_TRACKING_SNAPSHOT);
  jest.mocked(driverTripsService.getTrips).mockReset().mockResolvedValue(page());
  jest.mocked(driverTripsService.getTrip).mockReset().mockResolvedValue(detail);
  jest.mocked(driverTripsService.getHistory).mockReset().mockResolvedValue({ items: [], nextCursor: null });
  jest.mocked(driverTripsService.getActivitySummary).mockReset().mockImplementation(async (range) => ({
    range, timeZone: 'Asia/Ho_Chi_Minh', asOf: '2026-11-21T00:00:00Z',
    completedTripCount: null, processedStopCount: null, depotStopCount: null, deliveries: null,
    coverage: { status: 'NO_DATA' },
  }));
});

it('deep link Driver ở cold start offline chỉ mở vùng khôi phục', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValueOnce({ isConnected: false } as Awaited<ReturnType<typeof NetInfo.fetch>>);
  jest.mocked(offlineDriverIdentity.read).mockResolvedValueOnce({
    version: 1, ownerId: profile.id, scope: 'qa', tokenDigest: 'digest', verifiedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  await openApp('/trips/trip-active');
  expect(await screen.findByText('Dữ liệu chuyến ngoại tuyến')).toBeTruthy();
  expect(screen.queryByText('Trip trip-active')).toBeNull();
  expect(authService.getProfile).not.toHaveBeenCalled();
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
  expect(screen.queryByTestId('driver-tab-home')).toBeNull();
  expect(offlineDriverExecutionCoordinator.activate).not.toHaveBeenCalled();
});

it('JWT hết hạn vào Login thay vì mount tab từ deep link', async () => {
  jest.mocked(jwtExpiry).mockReturnValue(Date.now() - 1);
  const app = await openApp('/activity');
  expect(await screen.findByLabelText('Tên đăng nhập')).toBeTruthy();
  expect(app.getPathname()).toBe('/login');
  expect(screen.queryByTestId('driver-tab-activity')).toBeNull();
  expect(offlineDriverExecutionCoordinator.activate).not.toHaveBeenCalled();
});

it('đăng xuất từ cold start offline về /login', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValueOnce({ isConnected: false } as Awaited<ReturnType<typeof NetInfo.fetch>>);
  jest.mocked(offlineDriverIdentity.read).mockResolvedValueOnce({
    version: 1, ownerId: profile.id, scope: 'qa', tokenDigest: 'digest', verifiedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  const app = await openApp('/');
  await fireEvent.press(await screen.findByRole('button', { name: 'Đăng xuất' }));
  expect(await screen.findByLabelText('Tên đăng nhập')).toBeTruthy();
  expect(app.getPathname()).toBe('/login');
});

it('deep link Tài khoản offline không đọc hồ sơ hoặc xe', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValueOnce({ isConnected: false } as Awaited<ReturnType<typeof NetInfo.fetch>>);
  jest.mocked(offlineDriverIdentity.read).mockResolvedValueOnce({
    version: 1, ownerId: profile.id, scope: 'qa', tokenDigest: 'digest', verifiedAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  await openApp('/account');
  expect(await screen.findByText('Dữ liệu chuyến ngoại tuyến')).toBeTruthy();
  expect(driverProfileService.getProfile).not.toHaveBeenCalled();
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
});

it('Account ghi rõ dữ liệu còn thiếu và chỉ lấy hồ sơ chính chủ', async () => {
  await openApp('/account');
  expect(await screen.findByText('Hồ sơ tài xế QA')).toBeTruthy();
  expect(screen.getByText('Kho QA · QA')).toBeTruthy();
  expect(screen.getByText('Chưa có hồ sơ giấy phép để hiển thị.')).toBeTruthy();
  expect(screen.getByText('Chưa có số điện thoại')).toBeTruthy();
  expect(await screen.findByText('Chưa có chuyến để xem xe.')).toBeTruthy();
  expect(driverProfileService.getProfile).toHaveBeenCalledWith();
});

it('Account tải xe đúng Trip được chọn và RELIEF chỉ xem', async () => {
  const relief: DriverTripSummary = {
    ...planned,
    assignment: { ...planned.assignment, role: 'RELIEF' },
    vehicle: { ...planned.vehicle, id: 'vehicle-2', plateNumber: 'QA-456' },
  };
  jest.mocked(driverProfileService.getProfile).mockResolvedValue({
    ...selfProfile, license: { category: 'CE', validUntil: '2030-02-01', verificationStatus: 'PENDING' },
  });
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    page(status === 'IN_PROGRESS' ? [active] : [relief]));
  jest.mocked(driverTripsService.getTrip).mockImplementation(async (id) =>
    id === active.id ? detail : { ...relief, stops: [], vehicle: {
      ...relief.vehicle, payloadCapacityKg: 7000, volumeCapacityM3: 35, lengthCm: 700, widthCm: 240, heightCm: 270,
    } });
  await openApp('/account');
  expect(await screen.findByText('01/02/2030')).toBeTruthy();
  expect(screen.getByText('Chờ xác minh')).toBeTruthy();
  expect(await screen.findByText('Chọn một chuyến để xem thông số xe.')).toBeTruthy();
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Chọn một chuyến để xem thông số xe.'));
  await fireEvent.press(screen.getByText(relief.tripNumber));
  expect(await screen.findByText('7000 kg')).toBeTruthy();
  expect(screen.getByText('700 × 240 × 270 cm')).toBeTruthy();
  expect(screen.getByText('Hỗ trợ (RELIEF)')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem chuyến' }));
  expect(await screen.findByText(`Trip ${relief.id}`)).toBeTruthy();
  expect(screen.queryByTestId('driver-tab-account')).toBeNull();
  await testRouter.back('/account');
  expect(screen.getByText('7000 kg')).toBeTruthy();
  await fireEvent.press(screen.getByText('Mở danh sách chuyến'));
  await fireEvent.press(screen.getByText(active.tripNumber));
  expect(await screen.findByText('QA-123 · Xe tải')).toBeTruthy();
  expect(screen.queryByText('7000 kg')).toBeNull();
  expect(jest.mocked(driverTripsService.getTrip).mock.calls).toEqual([[relief.id], [active.id]]);
  expect(driverTripsService.startTrip).not.toHaveBeenCalled();
  expect(driverTripsService.arriveStop).not.toHaveBeenCalled();
});

it('khôi phục phiên Driver vào Home và phân biệt danh sách rỗng', async () => {
  const app = await openApp();
  expect(await screen.findByText('Chưa có chuyến đang thực hiện.')).toBeTruthy();
  expect(screen.getByText('Chưa có chuyến đã điều phối.')).toBeTruthy();
  expect(screen.getByText('Tài xế QA')).toBeTruthy();
  expect(app.getSegments()).toEqual(['(driver)', '(tabs)']);
  expect(authService.getProfile).toHaveBeenCalledWith('stored-test-token');
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
});

it('tên dài xuống hàng riêng và giữ font scaling trên tiêu đề và tên', async () => {
  const name = 'Nguyễn Thị Hoàng Bảo Ngọc Trần Phạm Minh Anh';
  jest.mocked(authService.getProfile).mockResolvedValueOnce({ ...profile, fullName: name });
  await openApp();
  const title = await screen.findByRole('header', { name: 'Công việc' });
  const driverName = screen.getByText(name);
  expect(title.props.allowFontScaling).toBe(true);
  expect(driverName.props.allowFontScaling).toBe(true);
  expect(driverName.props.numberOfLines).toBeUndefined();
  expect(StyleSheet.flatten(title.props.style).lineHeight).toBeGreaterThan(24);
  expect(StyleSheet.flatten(driverName.props.style).lineHeight).toBeGreaterThan(15);
  await fireEvent.press(screen.getByTestId('driver-tab-account'));
  expect(await screen.findByText(profile.username)).toBeTruthy();
});

it('chặn deep link Driver với Customer và user chưa có phiên', async () => {
  jest.mocked(authService.getProfile).mockResolvedValueOnce({ ...profile, role: 'CUSTOMER' });
  const customer = await openApp('/trips/trip-active');
  expect(await screen.findByText('Customer Home')).toBeTruthy();
  expect(driverTripsService.getTrips).not.toHaveBeenCalled();
  await customer.unmount();
  jest.mocked(tokenStorage.get).mockResolvedValueOnce(null);
  await openApp('/trips/trip-active');
  expect(await screen.findByLabelText('Tên đăng nhập')).toBeTruthy();
  expect(driverTripsService.getTrips).not.toHaveBeenCalled();
});

it('đăng nhập từ Login vào đúng một Driver Home', async () => {
  jest.mocked(tokenStorage.get).mockResolvedValueOnce(null);
  jest.mocked(authService.login).mockResolvedValue({
    accessToken: 'login-test-token',
    user: { id: profile.id, username: profile.username, fullName: profile.fullName, role: 'DRIVER', locationId: null },
  });
  await openApp('/login');
  await fireEvent.changeText(await screen.findByLabelText('Tên đăng nhập'), 'driver-qa');
  await fireEvent.changeText(screen.getByLabelText('Mật khẩu'), 'DemoTestPassword');
  await fireEvent.press(screen.getByRole('button', { name: 'Đăng nhập' }));
  expect(await screen.findByText('Công việc')).toBeTruthy();
  expect(authService.getProfile).toHaveBeenCalledWith('login-test-token');
  expect(testRouter.canGoBack()).toBe(false);
});

it('deep link Trip cũ giữ đúng chuyến và Back về Home', async () => {
  const app = await openApp('/trips/trip-active');
  expect(await screen.findByText('Trip trip-active')).toBeTruthy();
  await testRouter.back();
  expect(app.getPathname()).toBe('/');
  expect(await screen.findByText('Công việc')).toBeTruthy();
});

it('chỉ tải một detail, hiện tiến độ server, chuyến đã điều phối và Back về đúng Home', async () => {
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    page(status === 'IN_PROGRESS' ? [active] : status === 'DISPATCHED' ? [planned] : []));
  await openApp();
  expect(await screen.findByText('1/3 điểm đã xác nhận')).toBeTruthy();
  expect(screen.getByText('Kho giao tiếp theo')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Mở chuyến QA-PLANNED-0002' })).toBeTruthy();
  expect(driverTripsService.getTrip).toHaveBeenCalledTimes(1);
  expect(driverTripsService.getTrip).toHaveBeenCalledWith(active.id);
  await fireEvent.press(screen.getByRole('button', { name: 'Tiếp tục chuyến' }));
  expect(await screen.findByText('Trip trip-active')).toBeTruthy();
  await testRouter.back('/');
  expect(screen.getByText('Công việc')).toBeTruthy();
  expect(testRouter.canGoBack()).toBe(false);
  expect(driverTripsService.getTrips).toHaveBeenCalledTimes(4);
  expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();
  expect(driverTripsService.startTrip).not.toHaveBeenCalled();
  expect(driverTripsService.arriveStop).not.toHaveBeenCalled();
  expect(driverTripsService.completeStop).not.toHaveBeenCalled();
  expect(driverTripsService.completeTrip).not.toHaveBeenCalled();
});

it('không tự chọn khi tổng server có nhiều chuyến và giữ lọc khi mở danh sách', async () => {
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    status === 'IN_PROGRESS' ? { ...page([active]), total: 3, totalPages: 2 } : page([planned]));
  const app = await openApp();
  await screen.findByText(/Có nhiều chuyến đang thực hiện/);
  expect(screen.queryByText('Tiếp tục chuyến')).toBeNull();
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Chọn chuyến' }));
  expect(app.getSearchParams()).toMatchObject({ status: 'IN_PROGRESS' });
  expect(await screen.findByRole('header', { name: 'Chuyến' })).toBeTruthy();
});

it('mở danh sách lọc DISPATCHED và chuyển tab mà không tạo lifecycle mới', async () => {
  const app = await openApp();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem tất cả' }));
  expect(app.getSearchParams()).toMatchObject({ status: 'DISPATCHED' });
  await testRouter.back('/');
  await fireEvent.press(screen.getByTestId('driver-tab-activity'));
  expect(app.getPathname()).toBe('/activity');
  expect(await screen.findByText('Chưa có chuyến trong khoảng đã chọn.')).toBeTruthy();
  await testRouter.back('/');
  await fireEvent.press(screen.getByTestId('driver-tab-calendar'));
  expect(app.getPathname()).toBe('/calendar');
  expect(await screen.findByText('Ngày này chưa có chuyến được phân công.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('driver-tab-account'));
  await fireEvent.press(screen.getByTestId('driver-tab-home'));
  await fireEvent.press(screen.getByTestId('driver-tab-home'));
  expect(app.getPathname()).toBe('/');
  expect(testRouter.canGoBack()).toBe(false);
  expect(mockTrackingMount).toHaveBeenCalledTimes(1);
  expect(offlineDriverExecutionCoordinator.activate).toHaveBeenCalledTimes(1);
  expect(offlineDriverExecutionCoordinator.activate).toHaveBeenCalledWith(profile.id, expect.any(Function));
  expect(offlineDriverExecutionCoordinator.sync).not.toHaveBeenCalled();
  expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();
  expect(driverTripsService.startTrip).not.toHaveBeenCalled();
});

it('Activity lọc trạng thái, tải cursor, mở đúng Trip rồi Back', async () => {
  const item = {
    tripId: active.id, tripNumber: active.tripNumber, status: 'COMPLETED', historyAt: '2026-11-20T08:00:00Z',
    dateBasis: 'ACTUAL_END', vehicle: active.vehicle, stopCount: 3, processedStops: 3,
    loadTaskCount: 1, unloadTaskCount: 1, loadedQuantity: 2, unloadedQuantity: 2, distinctPackageCount: 1,
    successAttempts: 1, failedAttempts: 0, partialAttempts: 0,
  } as const;
  jest.mocked(driverTripsService.getHistory).mockImplementation(async (_, status, cursor) =>
    cursor ? { items: [{ ...item, tripId: 'cancelled-trip', tripNumber: 'QA-CANCELLED', status: 'CANCELLED',
      dateBasis: 'PLANNED_START' }], nextCursor: null }
      : { items: [item], nextCursor: status ? null : 'next-page' });
  const app = await openApp('/activity');
  await fireEvent.press(await screen.findByRole('button', { name: 'Tải thêm' }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Mở chuyến QA-CANCELLED' }));
  expect(await screen.findByText('Trip cancelled-trip')).toBeTruthy();
  await testRouter.back('/activity');
  await fireEvent.press(screen.getByRole('button', { name: 'Hoàn thành' }));
  await waitFor(() => expect(driverTripsService.getHistory)
    .toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }), 'COMPLETED', undefined));
  expect(app.getPathname()).toBe('/activity');
});

it('Activity giữ số đã xác minh trong đúng kỳ khi offline và không làm mất History', async () => {
  jest.mocked(driverTripsService.getActivitySummary).mockImplementation(async (range) => ({
    range, timeZone: 'Asia/Ho_Chi_Minh', asOf: '2026-11-21T00:00:00Z',
    completedTripCount: 1, processedStopCount: 4, depotStopCount: 1,
    deliveries: { success: 2, partial: 1, failed: 0, unclassified: 1 }, coverage: { status: 'PARTIAL' },
  }));
  await openApp('/activity');
  expect(await screen.findByText('Giao thành công')).toBeTruthy();
  expect(screen.getByText('1 / 0')).toBeTruthy();
  expect(screen.getByText('1 lần chưa phân loại')).toBeTruthy();
  expect(await screen.findByText('Nhật ký chuyến xe')).toBeTruthy();
  await act(async () => enableNetwork(false));
  expect(await screen.findByText('Ngoại tuyến. Đang hiển thị số liệu lần tải gần nhất của kỳ này.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '7 ngày' }));
  expect(await screen.findByText('Ngoại tuyến. Chưa có số liệu đã tải cho kỳ này.')).toBeTruthy();
  expect(screen.queryByText('Giao thành công')).toBeNull();
  expect(driverTripsService.getActivitySummary).toHaveBeenCalledTimes(1);
});

it('Trip List nằm ngoài tab bar và Back về đúng tab nguồn', async () => {
  await openApp();
  await fireEvent.press(await screen.findByRole('button', { name: 'Danh sách chuyến' }));
  await screen.findByRole('header', { name: 'Chuyến' });
  expect(screen.queryByTestId('driver-tab-account')).toBeNull();
  expect(screen.getByRole('header', { name: 'Chuyến' })).toBeTruthy();
  await testRouter.back('/');
  expect(screen.getByRole('header', { name: 'Công việc' })).toBeTruthy();
});

it('rút mã upcoming trên giao diện nhưng giữ mã đầy đủ cho trợ năng và mở đúng ID', async () => {
  const trip = { ...planned, tripNumber: 'QA-M412B-PLANNED-2026-11-20-0000123456' };
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    status === 'DISPATCHED' ? page([trip]) : page());
  await openApp();
  const card = await screen.findByRole('button', { name: `Mở chuyến ${trip.tripNumber}` });
  expect(screen.getByText('QA-M412B…0000123456')).toBeTruthy();
  expect(screen.getByText('QA-123 · Xe tải')).toBeTruthy();
  await fireEvent.press(card);
  expect(await screen.findByText('Trip trip-planned')).toBeTruthy();
});

it('mở chuyến đã điều phối qua navigator của màn khi router toàn cục chưa sẵn sàng', async () => {
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    page(status === 'DISPATCHED' ? [planned] : []));
  await openApp();
  const card = await screen.findByRole('button', { name: `Mở chuyến ${planned.tripNumber}` });
  const globalPush = jest.spyOn(router, 'push').mockImplementation(() => {
    throw new Error('The imperative router is unavailable before the first render has finished.');
  });
  try {
    await fireEvent.press(card);
    expect(await screen.findByText('Trip trip-planned')).toBeTruthy();
    expect(globalPush).not.toHaveBeenCalled();
  } finally {
    globalPush.mockRestore();
  }
});

it('thiếu detail vẫn nhận diện chuyến và không suy ra tiến độ', async () => {
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  jest.mocked(driverTripsService.getTrip).mockRejectedValueOnce(new ApiError('Not found', 404, 'NOT_FOUND'));
  await openApp();
  expect(await screen.findByText('Chưa tải được chi tiết chuyến.')).toBeTruthy();
  expect(screen.getByText('3 điểm dừng · Chưa có tiến độ xác nhận')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('điểm hoàn tất local chỉ ảnh hưởng gợi ý, không tăng số đã xác nhận', async () => {
  mockCommands = [{
    tripId: active.id, stopId: 'stop-2', state: 'PENDING', commandType: 'COMPLETE_STOP', sequence: 1,
  } as OfflineDriverCommand];
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  jest.mocked(driverTrackingService.getSnapshot).mockReturnValue({
    ...EMPTY_TRACKING_SNAPSHOT, tripId: active.id, mode: 'SYNC_ERROR', pendingCount: 2,
  });
  await openApp();
  expect(await screen.findByText('1/3 điểm đã xác nhận')).toBeTruthy();
  expect(screen.getByText('Tiếp theo trên thiết bị · chưa đồng bộ')).toBeTruthy();
  expect(screen.getByText('Kho cuối')).toBeTruthy();
  expect(screen.getByText(/Lỗi gửi vị trí.*2 vị trí đang chờ/)).toBeTruthy();
  expect(screen.getByText('1 thao tác chờ đồng bộ trên tài khoản')).toBeTruthy();
});

function queueCommand(tripId: string, state: OfflineDriverCommand['state']): OfflineDriverCommand {
  return { tripId, stopId: 'stop-2', state, commandType: 'COMPLETE_STOP', sequence: 1 } as OfflineDriverCommand;
}

it('tách lỗi của chuyến hiện tại khỏi tổng tài khoản và mở Sync đúng chuyến', async () => {
  mockCommands = [queueCommand(active.id, 'CONFLICT'), queueCommand(active.id, 'SYNCED'), queueCommand('other', 'PENDING')];
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  await openApp();
  expect(await screen.findByText('Chuyến này có thao tác cần xử lý.')).toBeTruthy();
  expect(screen.getByText('1 thao tác chưa đồng bộ của chuyến này')).toBeTruthy();
  expect(screen.getByText('2 thao tác chờ đồng bộ trên tài khoản')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem đồng bộ chuyến hiện tại' }));
  expect(await screen.findByText('Sync trip-active')).toBeTruthy();
});

it('lỗi chuyến khác không đổ vào chuyến hiện tại và CTA dẫn tới đúng chuyến đã xác định', async () => {
  mockCommands = [queueCommand(active.id, 'PENDING'), queueCommand(planned.id, 'FAILED')];
  jest.mocked(driverTripsService.getTrips).mockImplementation(async (_, __, status) =>
    status === 'IN_PROGRESS' ? page([active]) : page([planned]));
  await openApp();
  expect(await screen.findByText('1 thao tác cần xử lý ngoài chuyến hiện tại.')).toBeTruthy();
  expect(screen.queryByText('Chuyến này có thao tác cần xử lý.')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem đồng bộ chuyến cần xử lý' }));
  expect(await screen.findByText('Sync trip-planned')).toBeTruthy();
});

it('khi không xác định chuyến bị lỗi thì chỉ mở danh sách và không gắn lỗi cho chuyến hiện tại', async () => {
  mockCommands = [queueCommand('unknown-trip', 'BLOCKED')];
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  const app = await openApp();
  expect(await screen.findByText('Home chưa xác định được một chuyến cụ thể để mở đồng bộ.')).toBeTruthy();
  expect(screen.getByText('Chuyến này không có thao tác chưa đồng bộ.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Xem đồng bộ chuyến/ })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Xem danh sách chuyến' }));
  expect(app.getPathname()).toBe('/trips');
});

it('không có active Trip thì lỗi vẫn thuộc hàng đợi tài khoản', async () => {
  mockCommands = [queueCommand('unknown-trip', 'FAILED')];
  await openApp();
  expect(await screen.findByText('Chưa có chuyến đang thực hiện.')).toBeTruthy();
  expect(screen.getByText('1 thao tác cần xử lý trên tài khoản.')).toBeTruthy();
  expect(screen.queryByText('Thao tác chuyến hiện tại')).toBeNull();
});

it('báo lỗi mạng và giữ snapshot phiên với nhãn cũ khi refresh thất bại', async () => {
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  await openApp();
  await screen.findByText('1/3 điểm đã xác nhận');
  jest.mocked(driverTripsService.getTrips).mockRejectedValue(new ApiError('Kết nối gián đoạn', 0, 'NETWORK_ERROR'));
  await fireEvent.press(screen.getByTestId('driver-home-refresh'));
  expect(await screen.findByText('Dữ liệu đã tải có thể đã cũ.')).toBeTruthy();
  expect(screen.getAllByText('Kết nối gián đoạn')).toHaveLength(2);
  expect(screen.getByText('1/3 điểm đã xác nhận')).toBeTruthy();
});

it('mở Home offline hiển thị thiếu dữ liệu, sau reconnect dùng snapshot phiên khi offline lại', async () => {
  mockOnline = false;
  jest.mocked(driverTripsService.getTrips).mockResolvedValueOnce(page([active]));
  await openApp();
  expect(await screen.findByText('Ngoại tuyến. Chưa có dữ liệu chuyến trên màn này.')).toBeTruthy();
  expect(driverTripsService.getTrips).not.toHaveBeenCalled();
  await act(async () => enableNetwork(true));
  await screen.findByText('1/3 điểm đã xác nhận');
  await act(async () => enableNetwork(false));
  expect(screen.getByText('Ngoại tuyến. Dữ liệu đã tải có thể đã cũ.')).toBeTruthy();
  expect(driverTripsService.getTrips).toHaveBeenCalledTimes(2);
});

it('gộp pull-to-refresh khi focus đang tải và tải lại khi quay về sau request trước', async () => {
  let resolveActive!: (result: DriverTripPage) => void;
  jest.mocked(driverTripsService.getTrips).mockImplementationOnce(() => new Promise((resolve) => { resolveActive = resolve; }));
  await openApp();
  await waitFor(() => expect(driverTripsService.getTrips).toHaveBeenCalledTimes(2));
  await fireEvent.press(screen.getByTestId('driver-home-refresh'));
  expect(driverTripsService.getTrips).toHaveBeenCalledTimes(2);
  await act(async () => resolveActive(page()));
  await screen.findByText('Chưa có chuyến đang thực hiện.');
  await fireEvent.press(screen.getByTestId('driver-tab-account'));
  const callsAfterOpeningAccount = jest.mocked(driverTripsService.getTrips).mock.calls.length;
  await testRouter.back('/');
  expect(driverTripsService.getTrips).toHaveBeenCalledTimes(callsAfterOpeningAccount + 2);
});

it('Tài khoản giữ logout guard và chỉ đăng xuất sau khi xác nhận', async () => {
  mockCommands = [{ state: 'PENDING' } as OfflineDriverCommand];
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  try {
    await openApp();
    await fireEvent.press(screen.getByTestId('driver-tab-account'));
    expect(await screen.findByText('driver-qa')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(alert).toHaveBeenCalledWith('Còn thao tác chưa đồng bộ', expect.any(String), expect.any(Array), expect.any(Object));
    await act(async () => alert.mock.lastCall?.[2]?.[0]?.onPress?.());
    expect(tokenStorage.clear).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
    await act(async () => alert.mock.lastCall?.[2]?.[1]?.onPress?.());
    expect(await screen.findByLabelText('Tên đăng nhập')).toBeTruthy();
    expect(tokenStorage.clear).toHaveBeenCalledTimes(1);
    expect(mockCommands).toHaveLength(1);
  } finally {
    alert.mockRestore();
  }
});

it('không gọi detail hoặc hiện dữ liệu từ response list của phiên đã đăng xuất', async () => {
  let resolveActive!: (result: DriverTripPage) => void;
  jest.mocked(driverTripsService.getTrips).mockImplementationOnce(() => new Promise((resolve) => { resolveActive = resolve; }));
  await openApp();
  await waitFor(() => expect(driverTripsService.getTrips).toHaveBeenCalledTimes(2));
  await fireEvent.press(screen.getByTestId('driver-tab-account'));
  await fireEvent.press(screen.getByRole('button', { name: 'Đăng xuất' }));
  await screen.findByLabelText('Tên đăng nhập');
  await act(async () => resolveActive(page([active])));
  expect(driverTripsService.getTrip).not.toHaveBeenCalled();
  expect(screen.queryByText(active.tripNumber)).toBeNull();
});
