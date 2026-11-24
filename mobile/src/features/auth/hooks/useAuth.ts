import { use } from 'react';
import { AuthContext } from '@/features/auth/providers/AuthProvider';

export function useAuth() {
  const context = use(AuthContext);
  if (!context) {
    throw new Error('useAuth phải được sử dụng bên trong AuthProvider.');
  }
  return context;
}
