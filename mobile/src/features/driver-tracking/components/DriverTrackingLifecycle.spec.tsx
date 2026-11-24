import { Alert, AppState } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { DriverTrackingLifecycle } from './DriverTrackingLifecycle';

let appStateListener: ((state: string) => void) | null = null;

jest.mock('@/features/auth/hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('@/features/driver-trips/services/driver-trips.service', () => ({
  driverTripsService: { getTrips: jest.fn() },
}));
jest.mock('@/features/driver-tracking/services/driver-tracking.service', () => ({
  driverTrackingService: {
    restoreForUser: jest.fn(),
    beginAfterStart: jest.fn(),
    flushForUser: jest.fn(),
    subscribe: jest.fn(() => jest.fn()),
    getSnapshot: jest.fn(() => ({ mode: 'IDLE', errorCode: null })),
  },
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
}));

const activeTrip = {
  id: 'trip-1',
  tripNumber: 'QA-DRIVER-001',
  status: 'IN_PROGRESS' as const,
  version: 3,
  plannedStartTime: '2026-11-17T05:00:00.000Z',
  plannedEndTime: '2026-11-17T09:00:00.000Z',
  actualStartTime: '2026-11-17T05:10:00.000Z',
  actualEndTime: null,
  totalDistanceKm: 10,
  totalDurationMinutes: 120,
  vehicle: {
    id: 'vehicle-1',
    plateNumber: 'QA-00.001',
    model: 'Demo',
    vehicleType: 'Truck',
  },
  assignment: {
    id: 'assignment-1',
    role: 'PRIMARY',
    status: 'ASSIGNED',
    startTime: '2026-11-17T05:00:00.000Z',
    endTime: '2026-11-17T09:00:00.000Z',
  },
  stopCount: 4,
};

describe('M3.6C DriverTrackingLifecycle resume after login', () => {
  const logout = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    appStateListener = null;
    jest.mocked(useAuth).mockReturnValue({
      status: 'authenticated',
      user: {
        id: 'user-1',
        username: 'driver.demo',
        fullName: 'Driver Demo',
        phone: null,
        email: null,
        role: 'DRIVER',
        active: true,
        branchId: 'branch-1',
        locationId: null,
        customer: null,
      },
      sessionError: null,
      isAuthenticating: false,
      login: jest.fn(),
      logout,
      refreshProfile: jest.fn(),
      retrySession: jest.fn(),
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    jest.mocked(driverTrackingService.restoreForUser).mockResolvedValue('NO_SESSION');
    jest.mocked(driverTrackingService.beginAfterStart).mockResolvedValue();
    jest.mocked(driverTrackingService.flushForUser).mockResolvedValue();
    jest.mocked(driverTripsService.getTrips).mockResolvedValue({
      items: [activeTrip],
      page: 1,
      limit: 2,
      total: 1,
      totalPages: 1,
    });
  });

  it('hỏi và tạo session mới khi tài xế đồng ý resume Trip duy nhất', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    render(<DriverTrackingLifecycle />);

    await waitFor(() =>
      expect(driverTrackingService.beginAfterStart).toHaveBeenCalledWith(
        'user-1',
        'trip-1',
        true,
      ),
    );
    expect(driverTripsService.getTrips).toHaveBeenCalledWith(1, 2, 'IN_PROGRESS');
  });

  it('không tạo session khi tài xế chọn để sau và không hỏi lại cùng phiên', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });

    render(<DriverTrackingLifecycle />);
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(1));

    await act(async () => {
      appStateListener?.('active');
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();
  });

  it('không gọi API Trip khi đã restore được local session', async () => {
    jest.mocked(driverTrackingService.restoreForUser).mockResolvedValue('RESTORED');

    render(<DriverTrackingLifecycle />);

    await waitFor(() => expect(driverTrackingService.restoreForUser).toHaveBeenCalled());
    expect(driverTripsService.getTrips).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('không tự chọn khi có nhiều Trip đang thực hiện', async () => {
    jest.mocked(driverTripsService.getTrips).mockResolvedValue({
      items: [activeTrip, { ...activeTrip, id: 'trip-2', tripNumber: 'QA-DRIVER-002' }],
      page: 1,
      limit: 2,
      total: 2,
      totalPages: 1,
    });

    render(<DriverTrackingLifecycle />);

    await waitFor(() => expect(driverTripsService.getTrips).toHaveBeenCalled());
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();
  });

  it.each([
    ['RELIEF', 'ASSIGNED'],
    ['PRIMARY', 'CANCELLED'],
  ])('không mời tiếp tục GPS với phân công %s/%s', async (role, status) => {
    jest.mocked(driverTripsService.getTrips).mockResolvedValue({
      items: [{ ...activeTrip, assignment: { ...activeTrip.assignment, role, status } }],
      page: 1,
      limit: 2,
      total: 1,
      totalPages: 1,
    });

    await render(<DriverTrackingLifecycle />);
    expect(driverTripsService.getTrips).toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();
  });
});
