import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/features/auth/hooks/useAuth';
import type { AuthProfile } from '@/features/auth/types/auth.types';
import { useOfflineDriverQueue } from '@/features/driver-offline/hooks/useOfflineDriverQueue';
import { DriverTripHeader } from '@/features/driver-trips/components/DriverTripHeader';
import { useDriverLogout } from '@/features/driver-trips/hooks/useDriverLogout';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { useDriverAccountData } from '../hooks/useDriverAccountData';

const { colors, spacing, type, radius } = driverTheme;
const driverStatuses = {
  AVAILABLE: 'Sẵn sàng',
  ON_DUTY: 'Đang làm nhiệm vụ',
  ON_LEAVE: 'Đang nghỉ phép',
  RESTING: 'Đang nghỉ',
};

export function DriverAccountScreen() {
  const { user, status } = useAuth();
  if (status !== 'authenticated' || user?.role !== 'DRIVER') return null;
  return <DriverAccount key={user.id} user={user} />;
}

function DriverAccount({ user }: { user: AuthProfile }) {
  const router = useRouter();
  const { signOut, logoutError, isLoggingOut } = useDriverLogout();
  const { summary } = useOfflineDriverQueue();
  const account = useDriverAccountData();
  const [showTrips, setShowTrips] = useState(false);
  const profile = account.profile?.data;
  const detail = account.selectedVehicle?.data;
  const vehicle = detail?.vehicle;
  const { lengthCm, widthCm, heightCm } = vehicle ?? {};

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}>
        <DriverTripHeader title="Tài khoản" compact />
        <View style={[styles.card, styles.identity]}>
          <Text style={styles.identityLabel}>Tài xế</Text>
          <Text style={styles.name}>{profile?.fullName ?? user.fullName}</Text>
          <Text style={styles.identityLabel}>{user.username}</Text>
          {profile ? <Text style={styles.identityLabel}>{driverStatuses[profile.status]}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>Hồ sơ vận hành</Text>
          {!account.profile ? <Loading label="Đang tải hồ sơ tài xế" /> : null}
          {account.profile?.error ? <ScreenMessage message={account.profile.error} /> : null}
          {profile ? (
            <>
              <Field label="Chi nhánh cơ sở" value={profile.homeBranch.name + ' · ' + profile.homeBranch.code} />
              <Field label="Số điện thoại công việc" value={profile.operationalPhone
                ? '••••' + (profile.operationalPhone.length > 4 ? ' ' + profile.operationalPhone.slice(-4) : '')
                : 'Chưa có số điện thoại'} />
              <View style={styles.divider} />
              <Text accessibilityRole="header" style={styles.heading}>Giấy phép lái xe</Text>
              {profile.license ? (
                <>
                  <Field label="Hạng bằng" value={profile.license.category} />
                  <Field label="Có giá trị đến" value={profile.license.validUntil.split('-').reverse().join('/')} />
                  <Field label="Xác minh"
                    value={profile.license.verificationStatus === 'PENDING' ? 'Chờ xác minh' : profile.license.verificationStatus} />
                </>
              ) : <Text style={styles.meta}>Chưa có hồ sơ giấy phép để hiển thị.</Text>}
            </>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>Xe theo chuyến</Text>
          <Text style={styles.meta}>Chuyến đã điều phối hoặc đang thực hiện.</Text>
          {account.listsLoading ? <Loading label="Đang tải chuyến được phân công" /> : null}
          {account.listError ? <ScreenMessage message={account.listError} /> : null}
          {!account.listsLoading && !account.listError && !account.trips.length ? (
            <Text style={styles.meta}>Chưa có chuyến để xem xe.</Text>
          ) : null}
          {account.trips.length > 0 && (!account.trip || account.trips.length > 1 || account.hasMore) ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTrips }}
              onPress={() => setShowTrips((expanded) => !expanded)} style={styles.trip}>
              <Text style={styles.strong}>{account.trip?.tripNumber ?? 'Chọn một chuyến để xem thông số xe.'}</Text>
              <Text style={styles.meta}>{showTrips ? 'Thu gọn danh sách' : 'Mở danh sách chuyến'}</Text>
            </Pressable>
          ) : account.trip ? <Text style={styles.strong}>{account.trip.tripNumber}</Text> : null}
          {showTrips ? account.trips.map((trip) => (
            <Pressable key={trip.id} accessibilityRole="button"
              accessibilityState={{ selected: account.trip?.id === trip.id }}
              onPress={() => { account.selectTrip(trip.id); setShowTrips(false); }}
              style={[styles.trip, account.trip?.id === trip.id && styles.selected]}>
              <Text style={styles.strong}>{trip.tripNumber}</Text>
              <Text style={styles.meta}>{trip.vehicle.plateNumber} · {trip.status === 'IN_PROGRESS' ? 'Đang thực hiện' : 'Đã điều phối'}</Text>
            </Pressable>
          )) : null}
          {showTrips && account.hasMore ? (
            <PrimaryButton label="Tải thêm chuyến" variant="secondary" loading={account.loadingMore} onPress={account.loadMore} />
          ) : null}
          {account.trip && !account.selectedVehicle ? <Loading label="Đang tải thông số xe" /> : null}
          {account.selectedVehicle?.error ? <ScreenMessage message={account.selectedVehicle.error} /> : null}
          {vehicle && detail ? (
            <View style={styles.specifications}>
              <Field label="Xe được phân công" value={vehicle.plateNumber + ' · ' + vehicle.model} />
              <Field label="Vai trò chuyến" value={detail.assignment.role === 'RELIEF' ? 'Hỗ trợ (RELIEF)' : detail.assignment.role} />
              <Field label="Tải trọng thiết kế" value={vehicle.payloadCapacityKg ? vehicle.payloadCapacityKg + ' kg' : 'Chưa có dữ liệu'} />
              <Field label="Thể tích thiết kế" value={vehicle.volumeCapacityM3 ? vehicle.volumeCapacityM3 + ' m³' : 'Chưa có dữ liệu'} />
              <Field label="Lọt lòng thùng (dài × rộng × cao)"
                value={lengthCm && widthCm && heightCm ? [lengthCm, widthCm, heightCm].join(' × ') + ' cm' : 'Chưa có dữ liệu'} />
              <PrimaryButton label="Xem chuyến" variant="secondary"
                onPress={() => router.push({ pathname: '/trips/[id]', params: { id: detail.id } })} />
            </View>
          ) : null}
        </View>

        {account.profile?.error || account.listError || account.selectedVehicle?.error ? (
          <PrimaryButton label="Tải lại thông tin" variant="secondary" onPress={account.reload} />
        ) : null}
        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>Đồng bộ thao tác</Text>
          <Text style={styles.meta}>
            {summary.totalUnsynced ? `${summary.totalUnsynced} thao tác chưa đồng bộ trên tài khoản này.` : 'Không có thao tác chờ đồng bộ.'}
          </Text>
        </View>
        {logoutError ? <ScreenMessage message={logoutError} /> : null}
        <PrimaryButton label="Đăng xuất" variant="secondary" loading={isLoggingOut} onPress={() => void signOut()} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.strong}>{value}</Text>
    </View>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={styles.loading}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  card: { backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.card, gap: spacing.sm },
  identity: { backgroundColor: colors.primary },
  name: { ...type.title, color: colors.surface },
  identityLabel: { ...type.meta, color: colors.surface },
  heading: { ...type.heading, color: colors.text },
  strong: { ...type.strong, color: colors.text },
  meta: { ...type.meta, color: colors.textMuted, flexShrink: 1 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  field: { gap: spacing.xs },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  trip: { minHeight: driverTheme.touchTarget, justifyContent: 'center', gap: spacing.xs,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.control, padding: spacing.sm },
  selected: { backgroundColor: colors.infoSurface, borderColor: colors.primary },
  specifications: { padding: spacing.sm, borderRadius: radius.control, backgroundColor: colors.neutralSurface, gap: spacing.sm },
});
