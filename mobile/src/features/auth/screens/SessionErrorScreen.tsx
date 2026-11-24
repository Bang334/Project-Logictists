import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { toUserMessage } from '@/shared/api/api-error';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';
import { OfflineDriverWorkspace } from '../components/OfflineDriverWorkspace';

export function SessionErrorScreen() {
  const auth = useAuth();
  const { sessionError, retrySession, logout } = auth;
  const [isRetrying, setIsRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const retry = async () => {
    setIsRetrying(true);
    setActionError(null);
    try {
      await retrySession();
    } catch (error) {
      setActionError(toUserMessage(error));
    } finally {
      setIsRetrying(false);
    }
  };

  const signOut = async () => {
    setActionError(null);
    try {
      await logout();
    } catch (error) {
      setActionError(toUserMessage(error));
    }
  };

  if (auth.status === 'offline-read-only') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.card}>
          <Text style={styles.title}>Dữ liệu chuyến ngoại tuyến</Text>
          <ScreenMessage message="Đang xem dữ liệu đã lưu. Kết nối mạng và xác thực lại để tiếp tục thao tác." />
          <OfflineDriverWorkspace key={auth.identity.tokenDigest} identity={auth.identity} />
          {actionError ? <ScreenMessage message={actionError} /> : null}
          <PrimaryButton label="Thử kiểm tra lại" loading={isRetrying} onPress={() => void retry()} />
          <PrimaryButton label="Đăng xuất" variant="secondary" onPress={() => void signOut()} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.card}>
        <Text style={styles.title}>Không thể kiểm tra phiên đăng nhập</Text>
        <Text style={styles.description}>
          Token vẫn được giữ an toàn trên thiết bị. Ứng dụng không tự refresh hoặc tự gửi lại yêu cầu đăng nhập.
        </Text>
        <ScreenMessage message={actionError ?? sessionError ?? 'Lỗi phiên đăng nhập.'} />
        <PrimaryButton label="Thử kiểm tra lại" loading={isRetrying} onPress={() => void retry()} />
        <PrimaryButton
          label="Xóa phiên và đăng xuất"
          variant="secondary"
          onPress={() => void signOut()}
        />
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
