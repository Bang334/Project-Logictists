import type {
  AuthProfile,
} from '@/features/auth/types/auth.types';
import type { OfflineDriverIdentity } from '../services/offline-driver-identity';

export type AuthState =
  | { status: 'initializing'; user: null; sessionError: null }
  | { status: 'anonymous'; user: null; sessionError: null }
  | { status: 'authenticated'; user: AuthProfile; sessionError: null }
  | { status: 'offline-read-only'; user: null; sessionError: null; identity: OfflineDriverIdentity }
  | { status: 'session-error'; user: null; sessionError: string };

export type AuthAction =
  | { type: 'RESTORE_STARTED' }
  | { type: 'SIGNED_OUT' }
  | { type: 'AUTHENTICATED'; user: AuthProfile }
  | { type: 'OFFLINE_READ_ONLY'; identity: OfflineDriverIdentity }
  | { type: 'SESSION_FAILED'; message: string };

export const initialAuthState: AuthState = {
  status: 'initializing',
  user: null,
  sessionError: null,
};

export function authReducer(_state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'RESTORE_STARTED':
      return initialAuthState;
    case 'SIGNED_OUT':
      return { status: 'anonymous', user: null, sessionError: null };
    case 'AUTHENTICATED':
      return {
        status: 'authenticated',
        user: action.user,
        sessionError: null,
      };
    case 'OFFLINE_READ_ONLY':
      return { status: 'offline-read-only', user: null, sessionError: null, identity: action.identity };
    case 'SESSION_FAILED':
      return {
        status: 'session-error',
        user: null,
        sessionError: action.message,
      };
  }
}
