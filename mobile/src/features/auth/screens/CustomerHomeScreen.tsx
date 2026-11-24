import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { toUserMessage } from '@/shared/api/api-error';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

interface ProfileRowProps {
  label: string;
  value: string | null | undefined;
}

function ProfileRow({ label, value }: ProfileRowProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value || 'Chưa cập nhật'}</Text>
    </View>
  );
}

export function CustomerHomeScreen() {
  const { user, refreshProfile, logout } = useAuth();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const refresh = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      await refreshProfile();
    } catch (caughtError) {
      setError(toUserMessage(caughtError));
    } finally {
      setIsRefreshing(false);
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await logout();
    } catch (caughtError) {
      setError(toUserMessage(caughtError));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View>
          <Text style={styles.eyebrow}>CUSTOMER</Text>
          <Text style={styles.title}>Xin chào, {user.fullName}</Text>
          <Text style={styles.subtitle}>
            Tạo và theo dõi yêu cầu vận chuyển hàng hóa của bạn.
          </Text>
        </View>

        {error ? <ScreenMessage message={error} /> : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Thông tin tài khoản</Text>
          <ProfileRow label="Tên đăng nhập" value={user.username} />
          <ProfileRow label="Họ tên" value={user.fullName} />
          <ProfileRow label="Điện thoại" value={user.phone} />
          <ProfileRow label="Email" value={user.email} />
          <ProfileRow label="Mã khách hàng" value={user.customer?.code} />
        </View>

        <View style={styles.actions}>
          <PrimaryButton
            label="Đơn vận chuyển"
            onPress={() => router.push('/orders')}
          />
          <PrimaryButton
            label="Tạo đơn mới"
            variant="secondary"
            onPress={() => router.push('/orders/create')}
          />
          <PrimaryButton
            label="Làm mới profile"
            variant="secondary"
            loading={isRefreshing}
            onPress={() => void refresh()}
          />
          <PrimaryButton label="Đăng xuất" onPress={() => void signOut()} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg },
  eyebrow: { color: colors.primary, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 4 },
  subtitle: { color: colors.textMuted, lineHeight: 21, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  row: { gap: 3, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.sm },
  rowLabel: { color: colors.textMuted, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
  actions: { gap: spacing.md },
});
