import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { authService } from '@/features/auth/services/auth.service';
import type {
  AuthProfile,
  LoginRequest,
} from '@/features/auth/types/auth.types';
import { ApiError, toUserMessage } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import {
  authReducer,
  initialAuthState,
  type AuthState,
} from '@/features/auth/providers/auth-reducer';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { jwtExpiry, offlineDriverIdentity } from '../services/offline-driver-identity';
import { offlineDriverExecutionCoordinator } from '@/features/driver-offline/services/offline-driver-execution.coordinator';

type AuthContextValue = AuthState & {
  isAuthenticating: boolean;
  login: (request: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<AuthProfile>;
  retrySession: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const generation = useRef(0);
  const recoveredOwner = useRef<string | null>(null);
  const storageWrites = useRef<Promise<void>>(Promise.resolve());
  const gpsCleanup = useRef<Promise<void>>(Promise.resolve());
  const writeSession = useCallback((write: () => Promise<void>) => {
    const next = storageWrites.current.then(write);
    storageWrites.current = next.catch(() => undefined);
    return next;
  }, []);

  const clearSession = useCallback(async () => {
    generation.current += 1;
    offlineDriverExecutionCoordinator.deactivate();
    recoveredOwner.current = null;
    // Fence GPS work before Login becomes visible. Native unregistration may finish later.
    const tracking = driverTrackingService.cleanupOnLogout();
    gpsCleanup.current = tracking.catch(() => undefined);
    dispatch({ type: 'SIGNED_OUT' });
    const clear = writeSession(async () => {
      try {
        await offlineDriverIdentity.clear();
      } finally {
        await tokenStorage.clear();
      }
    });
    try {
      await tracking;
    } finally {
      await clear;
    }
  }, [writeSession]);

  const resolveProfile = useCallback(async (token: string, operation: number) => {
    try {
      const profile = await authService.getProfile(token);
      if (generation.current !== operation) return profile;
      if (!profile.active || (recoveredOwner.current &&
          (profile.id !== recoveredOwner.current || profile.role !== 'DRIVER'))) {
        throw new ApiError('Phiên đã thay đổi. Vui lòng đăng nhập lại.', 403, 'HTTP_403');
      }
      await writeSession(async () => {
        if (generation.current !== operation) return;
        try {
          await offlineDriverIdentity.remember(token, profile);
        } catch {
          // An unavailable local credential must not block successful online auth.
          await offlineDriverIdentity.clear().catch(() => undefined);
        }
      });
      if (generation.current === operation) {
        recoveredOwner.current = null;
        dispatch({ type: 'AUTHENTICATED', user: profile });
      }
      return profile;
    } catch (error) {
      if (generation.current !== operation) throw error;
      if (error instanceof ApiError && (error.isUnauthorized || error.status === 403)) {
        await clearSession();
      } else {
        dispatch({ type: 'SESSION_FAILED', message: toUserMessage(error) });
      }
      throw error;
    }
  }, [clearSession, writeSession]);

  const retrySession = useCallback(async () => {
    const operation = ++generation.current;
    offlineDriverExecutionCoordinator.deactivate();
    dispatch({ type: 'RESTORE_STARTED' });
    try {
      await storageWrites.current;
      const token = await tokenStorage.get();
      if (generation.current !== operation) return;
      if (!token) {
        recoveredOwner.current = null;
        dispatch({ type: 'SIGNED_OUT' });
        return;
      }
      const expiry = jwtExpiry(token);
      if (expiry !== null && expiry <= Date.now()) {
        await clearSession();
        return;
      }
      const network = await NetInfo.fetch().catch(() => null);
      if (generation.current !== operation) return;
      if (network?.isConnected === false) {
        const identity = await offlineDriverIdentity.read(token);
        if (generation.current !== operation) return;
        if (!identity || (recoveredOwner.current && recoveredOwner.current !== identity.ownerId)) {
          throw new Error('Cần kết nối máy chủ để xác thực phiên trước khi xem dữ liệu chuyến.');
        }
        recoveredOwner.current = identity.ownerId;
        dispatch({ type: 'OFFLINE_READ_ONLY', identity });
        return;
      }
      await resolveProfile(token, operation);
    } catch (error) {
      if (generation.current === operation) dispatch({ type: 'SESSION_FAILED', message: toUserMessage(error) });
      throw error;
    }
  }, [clearSession, resolveProfile]);

  useEffect(() => {
    void retrySession().catch(() => {
      // resolveProfile already stores a safe state and message for the UI.
    });
  }, [retrySession]);

  useEffect(() => {
    if (state.status !== 'offline-read-only') return;
    const operation = generation.current;
    const resume = () => {
      if (generation.current === operation) void retrySession().catch(() => undefined);
    };
    const unsubscribe = NetInfo.addEventListener((network) => {
      if (network.isConnected === true) resume();
    });
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') resume();
    });
    const expiry = setTimeout(resume, Math.max(0, state.identity.expiresAt - Date.now()));
    return () => { unsubscribe(); appState.remove(); clearTimeout(expiry); };
  }, [retrySession, state]);

  const login = useCallback(
    async (request: LoginRequest) => {
      const operation = ++generation.current;
      offlineDriverExecutionCoordinator.deactivate();
      recoveredOwner.current = null;
      setIsAuthenticating(true);
      try {
        await gpsCleanup.current;
        await writeSession(async () => {
          if (generation.current !== operation) return;
          try {
            await offlineDriverIdentity.clear();
          } finally {
            await tokenStorage.clear();
          }
        });
        if (generation.current !== operation) return;
        const result = await authService.login(request);
        await writeSession(async () => {
          if (generation.current === operation) await tokenStorage.set(result.accessToken);
        });
        if (generation.current === operation) await resolveProfile(result.accessToken, operation);
      } finally {
        setIsAuthenticating(false);
      }
    },
    [resolveProfile, writeSession],
  );

  const refreshProfile = useCallback(async () => {
    const operation = generation.current;
    await storageWrites.current;
    const token = await tokenStorage.get();
    if (generation.current !== operation) throw new ApiError('Phiên đã thay đổi.', 401, 'HTTP_401');
    if (!token) {
      dispatch({ type: 'SIGNED_OUT' });
      throw new ApiError('Phiên đăng nhập không còn tồn tại.', 401, 'HTTP_401');
    }
    return resolveProfile(token, operation);
  }, [resolveProfile]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      isAuthenticating,
      login,
      logout: clearSession,
      refreshProfile,
      retrySession,
    }),
    [
      state,
      isAuthenticating,
      login,
      clearSession,
      refreshProfile,
      retrySession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
