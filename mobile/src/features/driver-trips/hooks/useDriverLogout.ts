import { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useOfflineDriverQueue } from '@/features/driver-offline/hooks/useOfflineDriverQueue';

function confirmLogoutWithPendingCommands(count: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Còn thao tác chưa đồng bộ',
      `Bạn còn ${count} thao tác chưa đồng bộ. Chúng được giữ lại trên thiết bị và chỉ tiếp tục đồng bộ khi bạn đăng nhập lại đúng tài khoản này.`,
      [
        { text: 'Ở lại', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Vẫn đăng xuất', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function useDriverLogout() {
  const { logout } = useAuth();
  const { summary } = useOfflineDriverQueue();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const confirming = useRef(false);

  const signOut = async () => {
    if (confirming.current) return;
    confirming.current = true;
    try {
      if (summary.totalUnsynced > 0 && !(await confirmLogoutWithPendingCommands(summary.totalUnsynced))) return;
      setLogoutError(null);
      setIsLoggingOut(true);
      await logout();
    } catch {
      setLogoutError('Không thể đăng xuất. Vui lòng thử lại.');
    } finally {
      confirming.current = false;
      setIsLoggingOut(false);
    }
  };

  return { signOut, logoutError, isLoggingOut };
}
