import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DriverNavigationPanel } from '@/features/driver-navigation/components/DriverNavigationPanel';
import { selectDriverNavigationStop } from '@/features/driver-navigation/selectors/driver-navigation-stop.selector';
import { stopOfflinePresentation } from '@/features/driver-offline/selectors/offline-driver-overlay';
import { DriverTrackingPanel } from '@/features/driver-tracking/components/DriverTrackingPanel';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverTripHeader } from '../components/DriverTripHeader';
import { DriverTripStatusBadge, driverStopStatusLabel, driverStopTypeLabel } from '../components/DriverTripStatusBadge';
import { useDriverTripPodReadiness } from '../hooks/useDriverTripPodReadiness';
import { useDriverTripWorkspace, type TripOverviewPanel } from '../providers/DriverTripWorkspace';
import { offlineStopLabel, selectTripWorkflow } from '../selectors/driver-trip-workflow';
import type { DriverTripStop } from '../types/driver-trip.types';

const { colors, spacing } = driverTheme;

function dateLabel(value: string | null) {
  if (!value) return 'Chưa cập nhật';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa cập nhật' :
    new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function DriverTripDetailScreen() {
  const { trip, isLoading, error, reload, offlineQueue, tracking, execution, isOnline, panel, setPanel,
    podRevision, invalidatePodReadiness, podUploadsInProgress } =
    useDriverTripWorkspace();

  const [tripCheckedOnFocus, setTripCheckedOnFocus] = useState(false);
  useFocusEffect(useCallback(() => {
    let focused = true;
    void reload().then(() => {
      if (focused) setTripCheckedOnFocus(true);
    }, () => setTripCheckedOnFocus(false));
    return () => {
      focused = false;
      setTripCheckedOnFocus(false);
    };
  }, [reload]));
  const hasCurrentTrip = tripCheckedOnFocus && !isLoading && !error;
  const readiness = useDriverTripPodReadiness(trip,
    isOnline && hasCurrentTrip && podUploadsInProgress === 0 && trip?.status === 'IN_PROGRESS' &&
    trip.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED', podRevision);

  const target = useMemo(() => trip ? selectDriverNavigationStop(trip, offlineQueue.commands) : null,
    [trip, offlineQueue.commands]);
  const workflow = trip ? selectTripWorkflow(
    trip, offlineQueue.commands, offlineQueue.summary, readiness, isOnline,
  ) : null;
  const visibleStop = target?.blockedReason ? target.stop : workflow?.actionable ?? target?.stop;
  const visibleStopState = visibleStop ? stopOfflinePresentation(visibleStop.id, offlineQueue.commands) : null;
  const canOpenReadOnlyStop = !workflow?.canOperate && !!visibleStop;
  const selectPanel = (next: TripOverviewPanel) => setPanel((current) => current === next ? null : next);
  const openStop = (stopId: string) => {
    if (trip) router.push({ pathname: '/trips/[id]/stops/[stopId]', params: { id: trip.id, stopId } });
  };
  const openPod = (stop: DriverTripStop) => {
    if (trip && stop.deliveryAttempt) router.push({
      pathname: '/trips/[id]/stops/[stopId]/pod',
      params: { id: trip.id, stopId: stop.id, attemptId: stop.deliveryAttempt.id },
    });
  };
  const openSync = () => {
    if (trip) router.push({ pathname: '/trips/[id]/sync', params: { id: trip.id } });
  };
  const runPrimary = () => {
    if (!trip || !workflow) return;
    switch (workflow.action) {
      case 'START':
      case 'COMPLETE':
        if (workflow.action === 'COMPLETE' && (!hasCurrentTrip || execution.isSubmitting)) return;
        void execution.execute({
          command: workflow.action === 'START' ? 'START_TRIP' : 'COMPLETE_TRIP',
          tripId: trip.id,
          expectedTripVersion: trip.version,
        });
        break;
      case 'OPEN_STOP':
        if (workflow.actionable) openStop(workflow.actionable.id);
        break;
      case 'POD':
        if (workflow.podStop) openPod(workflow.podStop);
        break;
      case 'SYNC':
        openSync();
        break;
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}><DriverTripHeader compact title="Tổng quan chuyến" showBack /></View>
      {isLoading && !trip ? (
        <View style={styles.center}><ActivityIndicator accessibilityLabel="Đang tải chuyến" color={colors.primary} /></View>
      ) : !trip || !workflow ? (
        <View style={styles.center}>
          <ScreenMessage message={error ?? 'Không có dữ liệu chuyến.'} />
          <PrimaryButton appearance="driver" label="Thử lại" onPress={() => void reload()} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {error ? <ScreenMessage message={error} /> : null}
          {execution.error ? <ScreenMessage message={execution.error} /> : null}
          {execution.notice ? <ScreenMessage message={execution.notice} tone="success" /> : null}
          {execution.hasUncertainCommand ? <ScreenMessage message="Chưa xác định kết quả. Thử lại cùng thao tác để giữ mã chống trùng." /> : null}

          <View style={styles.card}>
            <View style={styles.wrapRow}>
              <Text style={styles.title} accessibilityLabel={trip.tripNumber}
                numberOfLines={2} ellipsizeMode="middle">{trip.tripNumber}</Text>
              <DriverTripStatusBadge status={trip.status} compact />
            </View>
            <Text style={styles.body}>{trip.vehicle.plateNumber} · {trip.vehicle.model}</Text>
            <Text style={styles.stopTitle}>{workflow.resolvedCount}/{trip.stops.length} điểm đã xác nhận</Text>
            <View style={styles.progressTrack} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <View style={[styles.progressFill, { width: `${trip.stops.length ? 100 * workflow.resolvedCount / trip.stops.length : 0}%` }]} />
            </View>
            {workflow.skippedCount > 0 ? <Text style={styles.meta}>Đã bỏ qua: {workflow.skippedCount}</Text> : null}
            {workflow.localCompletedCount > 0 ? <Text style={styles.meta}>Hoàn thành trên máy, chờ đồng bộ: {workflow.localCompletedCount}</Text> : null}

            <View style={styles.section}>
              <Text style={styles.meta} accessibilityRole="header">
                {target?.basis === 'LOCAL_PENDING' && target.stop.id === visibleStop?.id ? target.contextLabel :
                  !workflow.canOperate && visibleStop ? 'Điểm dừng của chuyến' :
                  workflow.actionable ? 'Điểm cần xử lý' : target?.contextLabel ?? 'Thực hiện chuyến'}
              </Text>
              {visibleStop ? (
                <>
                  <Text style={styles.stopTitle}>
                    {visibleStop.sequence}. {driverStopTypeLabel(visibleStop.stopType)}
                  </Text>
                  <Text style={styles.body}>{visibleStop.address}</Text>
                </>
              ) : <Text style={styles.meta}>Không có điểm cần xử lý.</Text>}
              {visibleStop && visibleStopState ? (
                <Text style={styles.meta}>{offlineStopLabel[visibleStopState] ?? driverStopStatusLabel(visibleStop.status)}</Text>
              ) : null}
              {!workflow.canOperate ? <Text style={styles.meta}>Phân công này chỉ có quyền xem.</Text> : null}
              {workflow.message ? <ScreenMessage message={workflow.message} /> : null}
              {workflow.action && !(workflow.action === 'COMPLETE' && !hasCurrentTrip) ? (
                <PrimaryButton appearance="driver" label={actionLabels[workflow.action]} onPress={runPrimary}
                  loading={(workflow.action === 'START' || workflow.action === 'COMPLETE') && execution.isSubmitting} />
              ) : null}
              {workflow.action === 'POD' && workflow.hasUnknownPod && !isLoading ? (
                <QuickAction label="Kiểm tra lại e-POD"
                  onPress={() => error ? void reload() : invalidatePodReadiness()} />
              ) : null}
              {canOpenReadOnlyStop && visibleStop ? (
                <QuickAction label="Xem điểm dừng" onPress={() => openStop(visibleStop.id)} />
              ) : null}
              {target && target.stop.id === visibleStop?.id ? <DriverNavigationPanel target={target} compact /> : null}
            </View>

            <View style={[styles.section, styles.wrapRow]}>
              <QuickAction label="Bản đồ" onPress={() => router.push({ pathname: '/trips/[id]/map', params: { id: trip.id } })} />
              <QuickAction label="Sự cố" onPress={() => router.push({ pathname: '/trips/[id]/incidents', params: { id: trip.id } })} />
              <QuickAction label="Đồng bộ" onPress={openSync} />
            </View>
            <View style={styles.section}>
              {!isOnline ? <Text style={styles.meta}>Ngoại tuyến · Kiểm tra thao tác chờ đồng bộ</Text> : null}
              <Toggle label={`GPS · ${gpsLabels[tracking.snapshot.mode]} · Chờ ${tracking.snapshot.pendingCount}`}
                expanded={panel === 'gps'} onPress={() => selectPanel('gps')} />
              <Text style={workflow.blocked ? styles.warning : styles.meta}>
                Đồng bộ chuyến · {offlineQueue.summary.totalUnsynced} chưa đồng bộ
              </Text>
              {workflow.blocked ? <Text style={styles.warning}>Có thao tác của chuyến cần kiểm tra.</Text> : null}
            </View>

            <View style={styles.section}>
              <QuickAction label="Xem tất cả điểm dừng"
                onPress={() => router.push({ pathname: '/trips/[id]/stops', params: { id: trip.id } })} />
              <Toggle label="Lịch và phân công" expanded={panel === 'details'} onPress={() => selectPanel('details')} />
            </View>
          </View>

          {panel === 'gps' ? (
            <DriverTrackingPanel snapshot={tracking.snapshot} onRetryPermission={tracking.retryPermissions}
              onOpenSettings={tracking.openSettings} onFlush={tracking.flush}
              canStartTracking={trip.status === 'IN_PROGRESS' && workflow.canOperate}
              isStartingTracking={tracking.isStartingTracking} onStartTracking={tracking.startTracking} />
          ) : null}
          {panel === 'details' ? (
            <View style={styles.card}>
              <Text style={styles.body}>Kế hoạch: {dateLabel(trip.plannedStartTime)} – {dateLabel(trip.plannedEndTime)}</Text>
              <Text style={styles.body}>Thực tế: {dateLabel(trip.actualStartTime)} – {dateLabel(trip.actualEndTime)}</Text>
              <Text style={styles.body}>Phân công: {trip.assignment.role} · {trip.assignment.status}</Text>
              <Text style={styles.meta}>{dateLabel(trip.assignment.startTime)} – {dateLabel(trip.assignment.endTime)}</Text>
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function QuickAction({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.quickAction}>
      <Text style={styles.toggleText}>{label}</Text>
    </Pressable>
  );
}

function Toggle({ label, expanded, onPress }: { label: string; expanded: boolean; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={onPress} style={styles.toggle}>
      <Text style={styles.toggleText}>{label}</Text>
      <Text style={styles.toggleText} accessible={false}>{expanded ? '−' : '+'}</Text>
    </Pressable>
  );
}

const actionLabels = {
  START: 'Bắt đầu chuyến', OPEN_STOP: 'Mở điểm hiện tại', SYNC: 'Xem đồng bộ',
  POD: 'Bổ sung bằng chứng', COMPLETE: 'Hoàn thành chuyến',
};
const gpsLabels = {
  IDLE: 'Chưa bắt đầu', RESTORING: 'Đang khôi phục', BACKGROUND: 'Đang theo dõi',
  FOREGROUND_ONLY: 'Chỉ khi mở ứng dụng', PERMISSION_DENIED: 'Thiếu quyền vị trí',
  LOCATION_DISABLED: 'Vị trí đã tắt', SYNC_ERROR: 'Lỗi gửi GPS',
  BLOCKED: 'Bị chặn', STOPPED: 'Đã dừng',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.md },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: colors.surface, padding: spacing.md, borderRadius: driverTheme.radius.card, gap: spacing.xs },
  section: { paddingTop: spacing.sm, marginTop: spacing.xs, gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  quickAction: { minHeight: driverTheme.touchTarget, minWidth: driverTheme.touchTarget, justifyContent: 'center' },
  title: { ...driverTheme.type.heading, color: colors.text, flexShrink: 1 },
  stopTitle: { ...driverTheme.type.strong, color: colors.text },
  body: { ...driverTheme.type.body, color: colors.text },
  meta: { ...driverTheme.type.meta, color: colors.textMuted },
  warning: { color: colors.danger, fontWeight: '600' },
  progressTrack: { height: 5, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.primary },
  toggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between' },
  toggleText: { color: colors.primary, fontWeight: '700', flexShrink: 1 },
});
