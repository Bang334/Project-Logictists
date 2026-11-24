import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { toUserMessage } from '@/shared/api/api-error';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

export function UnsupportedRoleScreen() {
  const { user, logout } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    try {
      await logout();
    } catch (caughtError) {
      setError(toUserMessage(caughtError));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.card}>
        <Text style={styles.title}>Vai trò chưa hỗ trợ trên Mobile</Text>
        <Text style={styles.description}>
          Tài khoản có vai trò {user?.role ?? 'không xác định'}. Phiên bản này chỉ điều hướng CUSTOMER và màn hình chờ DRIVER.
        </Text>
        {error ? <ScreenMessage message={error} /> : null}
        <PrimaryButton label="Đăng xuất" onPress={() => void signOut()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  card: { padding: spacing.lg, borderRadius: 18, backgroundColor: colors.surface, gap: spacing.md },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  description: { color: colors.textMuted, lineHeight: 22 },
});
