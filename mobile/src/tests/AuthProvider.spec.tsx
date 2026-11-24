import { AppState, Pressable, Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { offlineDriverIdentity } from '@/features/auth/services/offline-driver-identity';
import type { AuthProfile } from '@/features/auth/types/auth.types';
import { authService } from '@/features/auth/services/auth.service';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import { AuthProvider } from '@/features/auth/providers/AuthProvider';
import { SessionErrorScreen } from '@/features/auth/screens/SessionErrorScreen';

const mockTrackingCleanup = jest.fn(async () => undefined);

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn(), addEventListener: jest.fn(() => jest.fn()) },
}));
jest.mock('@/features/driver-offline/services/offline-driver-execution.coordinator', () => ({
  offlineDriverExecutionCoordinator: { deactivate: jest.fn() },
}));
jest.mock('@/features/auth/components/OfflineDriverWorkspace', () => ({
  OfflineDriverWorkspace: () => null,
}));
jest.mock('@/features/auth/services/offline-driver-identity', () => ({
  ...jest.requireActual('@/features/auth/services/offline-driver-identity'),
  offlineDriverIdentity: { clear: jest.fn(), remember: jest.fn(), read: jest.fn() },
}));

const driver: AuthProfile = { id: 'driver-owner', username: 'qa', fullName: 'QA', role: 'DRIVER',
  customer: null, branchId: null, locationId: null, phone: null, email: null, active: true };
const identity = { version: 1 as const, ownerId: driver.id, scope: 'server',
  tokenDigest: 'fingerprint', verifiedAt: Date.now(), expiresAt: Date.now() + 60_000 };

function network(isConnected: boolean) {
  return { isConnected } as NetInfoState;
}

jest.mock('@/features/driver-tracking/services/driver-tracking.service', () => ({
  driverTrackingService: {
    cleanupOnLogout: () => mockTrackingCleanup(),
  },
}));

jest.mock('@/features/auth/services/auth.service', () => ({
  authService: {
    login: jest.fn(),
    registerCustomer: jest.fn(),
    getProfile: jest.fn(),
  },
}));

jest.mock('@/shared/storage/token-storage', () => ({
  tokenStorage: {
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
  },
}));

function StatusProbe() {
  const { status, logout } = useAuth();
  return <><Text>{status}</Text><Pressable onPress={() => void logout()}><Text>Logout</Text></Pressable></>;
}

function OfflineLogoutProbe() {
  const { status } = useAuth();
  return status === 'offline-read-only' ? <SessionErrorScreen /> : <Text>{status}</Text>;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrackingCleanup.mockResolvedValue(undefined);
    jest.mocked(tokenStorage.clear).mockResolvedValue();
    jest.mocked(NetInfo.fetch).mockResolvedValue(network(true));
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(null);
  });

  it('chuyển sang anonymous khi SecureStore không có token', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue(null);

    const view = await render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByText('anonymous')).toBeTruthy());
    expect(authService.getProfile).not.toHaveBeenCalled();
  });

  it('xóa token và đăng xuất khi profile trả 401', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('expired-token');
    jest
      .mocked(authService.getProfile)
      .mockRejectedValue(new ApiError('Token hết hạn', 401, 'HTTP_401'));

    const view = await render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByText('anonymous')).toBeTruthy());
    expect(tokenStorage.clear).toHaveBeenCalledTimes(1);
    expect(mockTrackingCleanup).toHaveBeenCalledTimes(1);
  });

  it('giữ phiên để thử lại khi profile gặp lỗi mạng', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest
      .mocked(authService.getProfile)
      .mockRejectedValue(new ApiError('Mất mạng', 0, 'NETWORK_ERROR'));

    const view = await render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(view.getByText('session-error')).toBeTruthy());
    expect(tokenStorage.clear).not.toHaveBeenCalled();
  });

  it.each([true, false])('cold start offline với cache eligibility %s', async (eligible) => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest.mocked(NetInfo.fetch).mockResolvedValue(network(false));
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(eligible ? identity : null);
    const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
    expect(await view.findByText(eligible ? 'offline-read-only' : 'session-error')).toBeTruthy();
    expect(authService.getProfile).not.toHaveBeenCalled();
  });

  it('reconnect xác minh đúng owner trước khi chuyển sang online', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest.mocked(NetInfo.fetch).mockResolvedValueOnce(network(false)).mockResolvedValue(network(true));
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(identity);
    jest.mocked(authService.getProfile).mockResolvedValue(driver);
    const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
    await view.findByText('offline-read-only');
    await act(async () => jest.mocked(NetInfo.addEventListener).mock.lastCall?.[0](network(true)));
    expect(await view.findByText('authenticated')).toBeTruthy();
    expect(authService.getProfile).toHaveBeenCalledWith('stored-token');
  });

  it('đăng xuất từ workspace chỉ đọc và xóa quyền khôi phục phiên', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest.mocked(NetInfo.fetch).mockResolvedValue(network(false));
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(identity);
    const view = await render(<AuthProvider><OfflineLogoutProbe /></AuthProvider>);

    const logout = await view.findByRole('button', { name: 'Đăng xuất' });
    await fireEvent.press(logout);

    expect(await view.findByText('anonymous')).toBeTruthy();
    expect(offlineDriverIdentity.clear).toHaveBeenCalledTimes(1);
    expect(tokenStorage.clear).toHaveBeenCalledTimes(1);
    expect(authService.getProfile).not.toHaveBeenCalled();
  });

  it('hủy quyền đọc khi profile reconnect thuộc owner khác', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest.mocked(NetInfo.fetch).mockResolvedValueOnce(network(false)).mockResolvedValue(network(true));
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(identity);
    jest.mocked(authService.getProfile).mockResolvedValue({ ...driver, id: 'other' });
    const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
    await view.findByText('offline-read-only');
    await act(async () => jest.mocked(NetInfo.addEventListener).mock.lastCall?.[0](network(true)));
    expect(await view.findByText('anonymous')).toBeTruthy();
    expect(offlineDriverIdentity.clear).toHaveBeenCalled();
    expect(offlineDriverIdentity.remember).not.toHaveBeenCalled();
  });

  it('kiểm lại quyền đọc khi app trở về foreground', async () => {
    const events = jest.spyOn(AppState, 'addEventListener');
    try {
      jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
      jest.mocked(NetInfo.fetch).mockResolvedValue(network(false));
      jest.mocked(offlineDriverIdentity.read).mockResolvedValueOnce(identity).mockResolvedValue(null);
      const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
      await view.findByText('offline-read-only');
      const handler = events.mock.calls.find(([name]) => name === 'change')?.[1];
      expect(handler).toBeDefined();
      await act(async () => { handler?.('active'); });
      expect(await view.findByText('session-error')).toBeTruthy();
    } finally {
      events.mockRestore();
    }
  });

  it('response restore đến sau logout không thể mở lại phiên', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    let resolve!: (profile: AuthProfile) => void;
    jest.mocked(authService.getProfile).mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
    await waitFor(() => expect(authService.getProfile).toHaveBeenCalled());
    await fireEvent.press(view.getByText('Logout'));
    await act(async () => resolve(driver));
    expect(view.getByText('anonymous')).toBeTruthy();
    expect(offlineDriverIdentity.remember).not.toHaveBeenCalled();
  });

  it.each([403, 500, 0])('online profile error %s không dùng offline identity', async (status) => {
    jest.mocked(tokenStorage.get).mockResolvedValue('stored-token');
    jest.mocked(offlineDriverIdentity.read).mockResolvedValue(identity);
    jest.mocked(authService.getProfile).mockRejectedValue(new ApiError('Lỗi', status, status ? `HTTP_${status}` : 'REQUEST_TIMEOUT'));
    const view = await render(<AuthProvider><StatusProbe /></AuthProvider>);
    expect(await view.findByText(status === 403 ? 'anonymous' : 'session-error')).toBeTruthy();
    expect(offlineDriverIdentity.read).not.toHaveBeenCalled();
  });
});
