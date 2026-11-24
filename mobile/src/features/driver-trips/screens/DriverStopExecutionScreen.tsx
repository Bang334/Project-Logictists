import { useCallback, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverTripHeader } from '../components/DriverTripHeader';
import { DriverStopContact } from '../components/DriverStopContact';
import { DriverStatusBadge, driverStopStatusLabel, driverStopTypeLabel } from '../components/DriverTripStatusBadge';
import { DriverStopExecutionPanel, DriverStopTaskSummary } from '../components/execution/DriverStopExecutionPanel';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';
import { isDepot, offlineStopLabel, selectStopAction } from '../selectors/driver-trip-workflow';
import { canViewDriverStopPhone } from '../selectors/driver-stop-contact';
import type { DriverStopExecutionForm } from '../validation/driver-trip-execution.validation';

const { colors, spacing } = driverTheme;

export function DriverStopExecutionScreen() {
  const { stopId, id } = useLocalSearchParams<{ stopId?: string; id?: string }>();
  const workspace = useDriverTripWorkspace();
  const matchingTrip = typeof id === 'string' && id === workspace.tripId;
  const stop = matchingTrip && typeof stopId === 'string'
    ? workspace.trip?.stops.find((item) => item.id === stopId)
    : undefined;
  return <StopContent key={`${workspace.tripId}:${stopId ?? ''}`} stopId={stop?.id}
    validParams={matchingTrip && typeof stopId === 'string' && stopId.length > 0} />;
}

function StopContent({ stopId, validParams }: { stopId?: string; validParams: boolean }) {
  const { trip, reload, error, isLoading, execution, offlineQueue, isOnline } =
    useDriverTripWorkspace();
  const [draft, setDraft] = useState<DriverStopExecutionForm | null>(null);
  const [showTiming, setShowTiming] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrollContent = useRef<ComponentRef<typeof View>>(null);
  useFocusEffect(useCallback(() => {
    if (validParams) void reload();
  }, [reload, validParams]));
  usePreventRemove(draft !== null || execution.isSubmitting, ({ repeat }) => {
    if (execution.isSubmitting) {
      Alert.alert('Đang ghi nhận thao tác', 'Vui lòng chờ thao tác kết thúc trước khi rời điểm dừng.');
      return;
    }
    Alert.alert('Bỏ nội dung đang nhập?', 'Số lượng, người nhận và ghi chú chưa gửi sẽ bị mất.', [
      { text: 'Tiếp tục nhập', style: 'cancel' },
      { text: 'Bỏ nội dung', style: 'destructive', onPress: () => { setDraft(null); repeat(); } },
    ]);
  });

  const stop = trip?.stops.find((item) => item.id === stopId);
  const state = trip && stop ? selectStopAction(trip, stop, offlineQueue.commands, offlineQueue.summary) : null;
  const openPod = () => {
    if (trip && stop?.deliveryAttempt) router.push({
      pathname: '/trips/[id]/stops/[stopId]/pod',
      params: { id: trip.id, stopId: stop.id, attemptId: stop.deliveryAttempt.id },
    });
  };
  const openSync = () => {
    if (trip) router.push({ pathname: '/trips/[id]/sync', params: { id: trip.id } });
  };
  const mutationBase = trip && stop
    ? { tripId: trip.id, stopId: stop.id, expectedTripVersion: trip.version }
    : null;

  const header = <View style={styles.header}><DriverTripHeader compact
    title={stop ? driverStopTypeLabel(stop.stopType) : 'Điểm dừng'} showBack /></View>;

  if (!trip || !stop || !state || !mutationBase) return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      {header}
      {validParams && isLoading && !trip ? (
        <View style={styles.center}><ActivityIndicator accessibilityLabel="Đang tải điểm dừng" color={colors.primary} /></View>
      ) : (
        <View style={styles.center}>
          <ScreenMessage message={validParams && error ? error : 'Không tìm thấy điểm dừng thuộc chuyến này.'} />
          {validParams && error ? <PrimaryButton appearance="driver" label="Thử lại" onPress={() => void reload()} /> : null}
        </View>
      )}
    </SafeAreaView>
  );

  const revealError = (element: ComponentRef<typeof View>) => {
    if (scrollContent.current) element.measureLayout(scrollContent.current, (_left, top) => {
      scroll.current?.scrollTo({ y: Math.max(0, top - spacing.md), animated: true });
    });
  };
  const readOnly = trip.assignment.role !== 'PRIMARY' || trip.assignment.status !== 'ASSIGNED';
  const offlineLabel = offlineStopLabel[state.presentation];
  const renderLayout = (fields: ReactNode, action: ReactNode) => (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scroll} testID="driver-stop-scroll" style={styles.flex}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View ref={scrollContent} collapsable={false} style={styles.content}>
          {error ? <ScreenMessage message={error} /> : null}
          {execution.error ? <ScreenMessage message={execution.error} /> : null}
          {execution.notice ? <ScreenMessage message={execution.notice} tone="success" /> : null}
          {!isOnline ? <ScreenMessage message="Ngoại tuyến · Thao tác hợp lệ được lưu chờ đồng bộ." /> : null}
          <View style={styles.card}>
            <View style={styles.stopTags}>
              <Text style={styles.sequence}>Điểm {stop.sequence}/{trip.stops.length}</Text>
              <DriverStatusBadge small label={driverStopStatusLabel(stop.status)}
                tone={stop.status === 'COMPLETED' ? 'success' : stop.status === 'ARRIVED' ? 'info' : 'neutral'} />
            </View>
            <Text style={styles.title}>{stop.address}</Text>
            {!isDepot(stop) ? (
              <DriverStopContact name={stop.contactName} phone={stop.contactPhone}
                allowPhone={canViewDriverStopPhone(trip)} />
            ) : stop.contactName ? <Text style={styles.body}>{stop.contactName}</Text> : null}
            {offlineLabel ? (
              <DriverStatusBadge small label={offlineLabel}
                tone={state.presentation === 'CONFLICT' || state.presentation === 'FAILED' ? 'error' : 'warning'} />
            ) : null}
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTiming }}
              onPress={() => setShowTiming((current) => !current)} style={styles.disclosure}>
              <Text style={styles.link}>Thời gian và tọa độ</Text>
            </Pressable>
            {showTiming ? (
              <View>
                <Text style={styles.meta}>{trip.tripNumber}</Text>
                <Text style={styles.meta}>Dự kiến đến/rời: {formatTime(stop.plannedArrivalTime)} / {formatTime(stop.plannedDepartureTime)}</Text>
                <Text style={styles.meta}>Thực tế đến/rời: {formatTime(stop.actualArrivalTime)} / {formatTime(stop.actualDepartureTime)}</Text>
                <Text style={styles.meta}>{stop.latitude}, {stop.longitude}</Text>
              </View>
            ) : null}
            {trip.status === 'IN_PROGRESS' && trip.assignment.status === 'ASSIGNED' ? (
              <Pressable accessibilityRole="button" style={styles.disclosure}
                onPress={() => router.push({ pathname: '/trips/[id]/incidents', params: { id: trip.id } })}>
                <Text style={styles.link}>Xem sự cố của chuyến</Text>
              </Pressable>
            ) : null}
          </View>
          {fields}
          {readOnly ? <Text style={styles.meta}>Phân công này chỉ có quyền xem.</Text>
            : !state.action && !stop.deliveryAttempt ? (
            <Text style={styles.meta}>Điểm này hiện chỉ xem được thông tin.</Text>
          ) : null}
          {stop.stopType === 'DELIVERY' && !stop.deliveryAttempt && state.presentation === 'COMPLETED_PENDING_SYNC' ? (
            <Text style={styles.meta}>Bằng chứng mở sau khi máy chủ xác nhận lần giao.</Text>
          ) : null}
          {stop.deliveryAttempt ? (
            <View style={styles.card}>
              <Text style={styles.heading}>Kết quả giao hàng</Text>
              <Text style={styles.body}>{deliveryLabels[stop.deliveryAttempt.result]}</Text>
              {stop.deliveryAttempt.recipientName ? <Text style={styles.meta}>Người nhận: {stop.deliveryAttempt.recipientName}</Text> : null}
              {!readOnly ? (
                <PrimaryButton appearance="driver" label="Bằng chứng giao hàng" variant="secondary" onPress={openPod} />
              ) : null}
            </View>
          ) : null}
          {offlineQueue.summary.conflict + offlineQueue.summary.failed + offlineQueue.summary.blocked > 0 ? (
            <PrimaryButton appearance="driver" label="Kiểm tra đồng bộ" variant="secondary" onPress={openSync} />
          ) : null}
        </View>
      </ScrollView>
      {action ? <View style={styles.actionBar} testID="driver-stop-action-bar">{action}</View> : null}
    </KeyboardAvoidingView>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      {header}
      {state.action === 'COMPLETE' ? (
        <DriverStopExecutionPanel stop={stop} isSubmitting={execution.isSubmitting} draft={draft}
          onDraftChange={setDraft} renderLayout={renderLayout} onRevealError={revealError}
          onSubmit={async (completion) => {
            const accepted = await execution.execute({ ...mutationBase, command: 'COMPLETE_STOP', completion });
            if (accepted) setDraft(null);
            return accepted;
          }} />
      ) : renderLayout(<DriverStopTaskSummary tasks={stop.tasks} />, state.action === 'ARRIVE' ? (
        <PrimaryButton appearance="driver" label={isDepot(stop) ? 'Đã đến kho' : 'Đã đến điểm'}
          loading={execution.isSubmitting}
          onPress={() => void execution.execute({ ...mutationBase, command: 'ARRIVE_STOP' })} />
      ) : null)}
    </SafeAreaView>
  );
}

const deliveryLabels = { SUCCESS: 'Giao thành công', PARTIAL: 'Giao một phần', FAILED: 'Giao thất bại' };

function formatTime(value: string | null) {
  const time = value ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime())
    ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(time)
    : 'Chưa cập nhật';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.md },
  flex: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.sm },
  card: { padding: spacing.md, borderRadius: driverTheme.radius.card, gap: spacing.xs, backgroundColor: colors.surface },
  stopTags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  sequence: { ...driverTheme.type.label, paddingHorizontal: 8, paddingVertical: 4, color: colors.surface,
    backgroundColor: colors.primary, borderRadius: driverTheme.radius.pill, fontWeight: '700' },
  title: { ...driverTheme.type.heading, color: colors.text },
  heading: { ...driverTheme.type.strong, color: colors.text },
  body: { ...driverTheme.type.body, color: colors.text },
  meta: { ...driverTheme.type.meta, color: colors.textMuted },
  disclosure: { minHeight: 48, justifyContent: 'center' },
  link: { color: colors.primary, fontWeight: '700' },
  actionBar: { padding: spacing.md, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: colors.surface },
});
