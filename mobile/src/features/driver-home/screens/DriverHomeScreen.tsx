import { useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { selectDriverNavigationStop } from '@/features/driver-navigation/selectors/driver-navigation-stop.selector';
import { useOfflineDriverQueue } from '@/features/driver-offline/hooks/useOfflineDriverQueue';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import type { DriverTrackingMode } from '@/features/driver-tracking/types/driver-tracking.types';
import { DriverTripStatusBadge, driverStopTypeLabel } from '@/features/driver-trips/components/DriverTripStatusBadge';
import { DriverTripHeader } from '@/features/driver-trips/components/DriverTripHeader';
import type { DriverTripDetail, DriverTripSummary } from '@/features/driver-trips/types/driver-trip.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';
import { driverTheme } from '@/shared/theme/driver-theme';
import { useDriverHomeData } from '../hooks/useDriverHomeData';

const tripTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });

function formatTripTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa có giờ dự kiến' : tripTime.format(date);
}

function compactTripNumber(value: string) {
  return value.length > 24 ? `${value.slice(0, 8)}…${value.slice(-10)}` : value;
}

function needsQueueReview(command: OfflineDriverCommand) {
  return command.state === 'CONFLICT' || command.state === 'FAILED' || command.state === 'BLOCKED';
}

export function DriverHomeScreen() {
  const { user } = useAuth();
  return user?.role === 'DRIVER'
    ? <DriverHome key={user.id} name={user.fullName} />
    : null;
}

function DriverHome({ name }: { name: string }) {
  const router = useRouter();
  const { isConnected, isInternetReachable } = useNetInfo();
  const isOnline = isConnected === true && isInternetReachable !== false;
  const { active, upcoming, activeError, upcomingError, isRefreshing, refresh } = useDriverHomeData(isOnline);
  const { commands, summary } = useOfflineDriverQueue();
  const tracking = useSyncExternalStore(
    driverTrackingService.subscribe,
    driverTrackingService.getSnapshot,
    driverTrackingService.getSnapshot,
  );

  const multipleActive = (active?.page.total ?? 0) > 1 || (active?.page.items.length ?? 0) > 1;
  const activeTrip = !multipleActive && active?.page.total === 1 ? active.page.items[0] : undefined;
  const detail = active?.detail ?? null;
  const tripCommands = activeTrip ? commands.filter((command) => command.tripId === activeTrip.id) : [];
  const target = detail ? selectDriverNavigationStop(detail, tripCommands) : null;
  const trackingTrip = active?.page.items.find((trip) => trip.id === tracking.tripId && trip.assignment.role === 'PRIMARY');
  const activePending = tripCommands.filter((command) => command.state !== 'SYNCED').length;
  const activeHasIssue = tripCommands.some(needsQueueReview);
  const otherIssues = commands.filter((command) => needsQueueReview(command) && command.tripId !== activeTrip?.id);
  const otherIssueIds = new Set(otherIssues.map((command) => command.tripId));
  const singleOtherTrip = otherIssueIds.size === 1
    ? [...(active?.page.items ?? []), ...(upcoming?.items ?? [])].find((trip) => otherIssueIds.has(trip.id))
    : undefined;
  const isStale = (!isOnline && (active || upcoming)) || (activeError && active) || (upcomingError && upcoming);

  function openTrip(trip: DriverTripSummary) {
    router.push({ pathname: '/trips/[id]', params: { id: trip.id } });
  }

  function openTrips(status?: 'IN_PROGRESS' | 'DISPATCHED') {
    if (status) router.push({ pathname: '/trips', params: { status } });
    else router.push('/trips');
  }

  function openSync(tripId: string) {
    router.push({ pathname: '/trips/[id]/sync', params: { id: tripId } });
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={isRefreshing}
          onRefresh={() => void refresh()} colors={[colors.primary]} />}>
        <DriverTripHeader compact title="Công việc" subtitle={name} />
        {isConnected === null ? <Text style={styles.meta}>Đang kiểm tra kết nối.</Text> : !isOnline ? (
          <ScreenMessage message={isStale
            ? 'Ngoại tuyến. Dữ liệu đã tải có thể đã cũ.'
            : 'Ngoại tuyến. Chưa có dữ liệu chuyến trên màn này.'} />
        ) : isStale ? <ScreenMessage message="Dữ liệu đã tải có thể đã cũ." /> : null}
        {isOnline && (activeError || upcomingError || active?.detailUnavailable) ? (
          <InlineAction label="Thử tải lại" onPress={() => void refresh()} />
        ) : null}

        <View style={styles.hero}>
          <Text accessibilityRole="header" style={styles.heading}>Chuyến đang thực hiện</Text>
          {activeError ? <ScreenMessage message={activeError} /> : null}
          {multipleActive ? (
            <>
              <Text style={styles.body}>Có nhiều chuyến đang thực hiện. Chọn chuyến bạn muốn mở.</Text>
              <PrimaryButton label="Chọn chuyến" onPress={() => openTrips('IN_PROGRESS')} />
            </>
          ) : activeTrip ? (
            <>
              <View style={styles.row}>
                <Text accessibilityLabel={activeTrip.tripNumber} numberOfLines={1} ellipsizeMode="middle"
                  style={[styles.tripCode, styles.flex]}>{activeTrip.tripNumber}</Text>
                <DriverTripStatusBadge status={activeTrip.status} compact />
              </View>
              <Text style={styles.body}>{activeTrip.vehicle.plateNumber} · {activeTrip.vehicle.model}</Text>
              {detail ? <ServerProgress trip={detail} /> : (
                <Text style={styles.meta}>
                  {activeTrip.stopCount} điểm dừng · Chưa có tiến độ xác nhận
                </Text>
              )}
              {target ? (
                <View style={styles.target}>
                  <Text style={styles.meta}>{target.contextLabel}</Text>
                  <Text style={styles.strong}>{target.stop.sequence}. {driverStopTypeLabel(target.stop.stopType)}</Text>
                  <Text style={styles.body} numberOfLines={2}>{target.stop.address}</Text>
                </View>
              ) : null}
              {active?.detailUnavailable ? <Text style={styles.meta}>Chưa tải được chi tiết chuyến.</Text> : null}
              <PrimaryButton label={(detail ?? activeTrip).assignment.role === 'PRIMARY' ? 'Tiếp tục chuyến' : 'Xem chuyến'}
                onPress={() => openTrip(activeTrip)} />
            </>
          ) : active && !activeError ? <Text style={styles.body}>Chưa có chuyến đang thực hiện.</Text> :
            isOnline && !activeError ? <ActivityIndicator accessibilityLabel="Đang tải chuyến đang thực hiện"
              color={colors.primary} /> : null}
        </View>

        <View style={styles.card}>
          <View style={styles.wrapRow}>
            <Text accessibilityRole="header" style={styles.heading}>Chuyến đã điều phối</Text>
            <InlineAction label="Xem tất cả" onPress={() => openTrips('DISPATCHED')} />
          </View>
          {upcomingError ? <ScreenMessage message={upcomingError} /> : null}
          {upcoming?.items.map((trip) => (
            <Pressable key={trip.id} accessibilityRole="button" accessibilityLabel={`Mở chuyến ${trip.tripNumber}`}
              accessibilityHint={`${formatTripTime(trip.plannedStartTime)} · ${trip.vehicle.plateNumber}`}
              style={styles.tripRow} onPress={() => openTrip(trip)}>
              <View style={styles.wrapRow}>
                <Text style={styles.strong}>{formatTripTime(trip.plannedStartTime)}</Text>
                <DriverTripStatusBadge status={trip.status} compact />
              </View>
              <Text style={styles.body}>{trip.vehicle.plateNumber} · {trip.vehicle.model}</Text>
              <Text style={styles.meta} numberOfLines={1} ellipsizeMode="middle">{compactTripNumber(trip.tripNumber)}</Text>
            </Pressable>
          ))}
          {upcoming && upcoming.items.length === 0 && !upcomingError
            ? <Text style={styles.meta}>Chưa có chuyến đã điều phối.</Text> : null}
          {isOnline && !upcoming && !upcomingError
            ? <ActivityIndicator accessibilityLabel="Đang tải chuyến đã điều phối" color={colors.primary} /> : null}
        </View>

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>Truy cập nhanh</Text>
          <View style={styles.links}>
            <InlineAction label="Danh sách chuyến" onPress={() => openTrips()} />
          </View>
        </View>

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.heading}>GPS và đồng bộ</Text>
          {trackingTrip ? (
            <Text style={styles.body}>{trackingTrip.id === activeTrip?.id ? 'GPS chuyến hiện tại' : `GPS · ${trackingTrip.tripNumber}`} · {gpsStatus[tracking.mode]}
              {tracking.pendingCount > 0 ? ` · ${tracking.pendingCount} vị trí đang chờ` : ''}
            </Text>
          ) : <Text style={styles.meta}>Chưa có trạng thái GPS của chuyến đang thực hiện.</Text>}
          {trackingTrip && tracking.warning ? <ScreenMessage message={tracking.warning} /> : null}
          {activeTrip ? (
            <View style={styles.queueGroup}>
              <Text style={styles.strong}>Thao tác chuyến hiện tại</Text>
              <Text style={styles.body}>{activePending
                ? `${activePending} thao tác chưa đồng bộ của chuyến này`
                : 'Chuyến này không có thao tác chưa đồng bộ.'}</Text>
              {activeHasIssue ? <ScreenMessage message="Chuyến này có thao tác cần xử lý." /> : null}
              {activePending > 0 ? (
                <InlineAction label="Xem đồng bộ chuyến hiện tại" onPress={() => openSync(activeTrip.id)} />
              ) : null}
            </View>
          ) : null}
          <View style={styles.queueGroup}>
            <Text style={styles.strong}>Tổng hàng đợi tài khoản</Text>
            <Text style={styles.body}>{summary.totalUnsynced > 0
              ? `${summary.totalUnsynced} thao tác chờ đồng bộ trên tài khoản`
              : 'Không có thao tác chờ đồng bộ.'}</Text>
            {otherIssues.length > 0 ? (
              <>
                <ScreenMessage message={activeTrip
                  ? `${otherIssues.length} thao tác cần xử lý ngoài chuyến hiện tại.`
                  : `${otherIssues.length} thao tác cần xử lý trên tài khoản.`} />
                {singleOtherTrip ? (
                  <>
                    <Text style={styles.meta} numberOfLines={1} ellipsizeMode="middle">{singleOtherTrip.tripNumber}</Text>
                    <InlineAction label="Xem đồng bộ chuyến cần xử lý" onPress={() => openSync(singleOtherTrip.id)} />
                  </>
                ) : (
                  <>
                    <Text style={styles.meta}>Home chưa xác định được một chuyến cụ thể để mở đồng bộ.</Text>
                    <InlineAction label="Xem danh sách chuyến" onPress={() => openTrips()} />
                  </>
                )}
              </>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ServerProgress({ trip }: { trip: DriverTripDetail }) {
  const total = trip.stops.length;
  const skipped = trip.stops.filter((stop) => stop.status === 'SKIPPED').length;
  const resolved = skipped + trip.stops.filter((stop) => stop.status === 'COMPLETED').length;
  return (
    <View style={styles.progress}>
      <Text style={styles.body}>{resolved}/{total} điểm đã xác nhận{skipped ? ` · ${skipped} điểm bỏ qua` : ''}</Text>
      {total > 0 ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Tiến độ máy chủ xác nhận"
          accessibilityValue={{ min: 0, max: total, now: resolved }} style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${100 * resolved / total}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

function InlineAction({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" style={styles.link} onPress={onPress}>
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}

const gpsStatus: Record<DriverTrackingMode, string> = {
  IDLE: 'Chưa bắt đầu', RESTORING: 'Đang khôi phục', BACKGROUND: 'Đang theo dõi',
  FOREGROUND_ONLY: 'Chỉ khi mở ứng dụng', PERMISSION_DENIED: 'Thiếu quyền vị trí',
  LOCATION_DISABLED: 'Vị trí đã tắt', SYNC_ERROR: 'Lỗi gửi vị trí', BLOCKED: 'Bị chặn', STOPPED: 'Đã dừng',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg, gap: spacing.sm },
  hero: { backgroundColor: driverTheme.colors.infoSurface, borderRadius: driverTheme.radius.card, padding: spacing.md, gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: driverTheme.radius.card, padding: spacing.md, gap: spacing.xs },
  heading: { ...driverTheme.type.heading, color: colors.text, flexShrink: 1 },
  tripCode: { ...driverTheme.type.strong, color: colors.text },
  strong: { ...driverTheme.type.strong, color: colors.text, flexShrink: 1 },
  body: { ...driverTheme.type.body, color: colors.text },
  meta: { ...driverTheme.type.meta, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    columnGap: spacing.sm, rowGap: spacing.xs },
  flex: { flex: 1 },
  tripRow: { paddingVertical: spacing.sm, gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  target: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  queueGroup: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.xs, gap: spacing.xs },
  progress: { gap: spacing.xs },
  progressTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  link: { minHeight: driverTheme.touchTarget, minWidth: driverTheme.touchTarget, justifyContent: 'center' },
  linkLabel: { color: colors.primary, fontWeight: '700' },
});
