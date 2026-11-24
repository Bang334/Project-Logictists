import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { toUserMessage } from '@/shared/api/api-error';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

export function DriverPlaceholderScreen() {
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
        <Text style={styles.eyebrow}>DRIVER</Text>
        <Text style={styles.title}>Xin chào, {user?.fullName}</Text>
        <Text style={styles.description}>
          Đăng nhập Driver đã được nhận diện. Nghiệp vụ chuyến đi chưa được triển khai trong milestone Mobile Authentication.
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
  eyebrow: { color: colors.primary, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 26, fontWeight: '800' },
  description: { color: colors.textMuted, lineHeight: 22 },
});
