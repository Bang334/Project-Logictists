import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { OfflineDriverCommand, OfflineDriverCommandState } from '@/features/driver-offline/types/offline-driver-command.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverTripSupportScreen } from '../components/DriverTripSupportScreen';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';
import { DriverStatusBadge, driverStopTypeLabel } from '../components/DriverTripStatusBadge';
import type { DriverTripStop } from '../types/driver-trip.types';

const { colors, spacing } = driverTheme;
const stateLabels: Record<OfflineDriverCommandState, string> = {
  PENDING: 'Chờ đồng bộ', SYNCING: 'Đang đồng bộ', RETRY_WAIT: 'Chờ thử lại',
  AUTH_PAUSED: 'Tạm dừng do phiên đăng nhập', CONFLICT: 'Xung đột dữ liệu',
  FAILED: 'Đồng bộ thất bại', BLOCKED: 'Bị chặn bởi thao tác trước', SYNCED: 'Đã đồng bộ',
};
const attention = new Set<OfflineDriverCommandState>(['CONFLICT', 'FAILED', 'BLOCKED', 'AUTH_PAUSED']);
const formatDate = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const errorDetails = new Map([
  ['TRIP_VERSION_CONFLICT', 'Phiên bản chuyến đã thay đổi. Tải lại chuyến để kiểm tra và liên hệ điều phối.'],
  ['INVALID_STOP_STATE', 'Trạng thái điểm dừng đã thay đổi. Tải lại chuyến và liên hệ điều phối.'],
  ['INVALID_TRIP_STATE', 'Trạng thái chuyến đã thay đổi. Tải lại chuyến và liên hệ điều phối.'],
  ['STOP_OUT_OF_SEQUENCE', 'Điểm dừng không còn đúng thứ tự thực hiện. Kiểm tra kế hoạch với điều phối.'],
  ['OFFLINE_COMMAND_EXPIRED', 'Thao tác ngoại tuyến đã quá 24 giờ. Cần kiểm tra với điều phối.'],
  ['DATA_INTEGRITY_CONFLICT', 'Dữ liệu hàng hoặc điểm dừng không nhất quán. Cần điều phối kiểm tra.'],
  ['NETWORK_ERROR', 'Kết nối mạng bị gián đoạn. Kiểm tra mạng để đồng bộ lại.'],
  ['REQUEST_TIMEOUT', 'Máy chủ chưa phản hồi kịp. Kiểm tra mạng và thử đồng bộ khi có thể.'],
]);

function commandDetail(command: OfflineDriverCommand) {
  if (command.state === 'SYNCED') return null;
  if (command.state === 'AUTH_PAUSED') return 'Đăng nhập lại bằng đúng tài khoản để tiếp tục đồng bộ.';
  if (command.state === 'BLOCKED') return 'Cần xử lý thao tác đứng trước trong chuyến này. Liên hệ điều phối nếu lệnh trước bị lỗi.';
  const reason = errorDetails.get(command.lastErrorCode ?? '');
  if (reason) return reason;
  if (command.state === 'CONFLICT' || command.state === 'FAILED') return 'Tải lại chuyến để kiểm tra thông tin và liên hệ điều phối.';
  if (command.state === 'RETRY_WAIT') return 'Đang chờ đến lượt thử lại theo lịch đồng bộ.';
  if (command.state === 'PENDING' && command.transmissionState === 'NEVER_SENT') return 'Đã lưu trên thiết bị, chưa gửi.';
  return null;
}

export function DriverTripSyncScreen() {
  const { offlineQueue, isOnline, reload } = useDriverTripWorkspace();
  const [syncError, setSyncError] = useState<string | null>(null);
  const sync = async () => {
    setSyncError(null);
    try {
      await offlineQueue.sync();
      await reload();
    } catch {
      setSyncError('Chưa thể đồng bộ. Các thao tác vẫn được giữ trong hàng đợi.');
    }
  };

  return (
    <DriverTripSupportScreen compact title="Đồng bộ thao tác">
      {(trip) => {
        const commands = offlineQueue.commands.filter((command) => command.tripId === trip.id);
        const unsynced = commands.filter((command) => command.state !== 'SYNCED');
        const needsAttention = unsynced.filter((command) => attention.has(command.state));
        const pending = unsynced.filter((command) => !attention.has(command.state));
        const synced = commands.filter((command) => command.state === 'SYNCED');
        const first = unsynced.reduce<OfflineDriverCommand | undefined>(
          (head, command) => !head || command.sequence < head.sequence ? command : head, undefined,
        );
        const canRetry = trip.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED' &&
          trip.status === 'IN_PROGRESS' && first && !attention.has(first.state);
        const stops = new Map(trip.stops.map((stop) => [stop.id, stop]));
        const renderRow = (command: OfflineDriverCommand) => <CommandRow key={command.id} command={command}
          tripId={trip.id} stop={stops.get(command.stopId)} />;
        return (
          <>
            <View style={[styles.card, styles.summary]}>
              <Text style={styles.title}>{trip.tripNumber}</Text>
              <DriverStatusBadge small label={isOnline ? 'Có kết nối mạng' : 'Ngoại tuyến'}
                tone={isOnline ? 'success' : 'warning'} />
              <Text style={styles.meta}>{commands.length} thao tác của chuyến · {needsAttention.length} cần chú ý</Text>
              <Text style={styles.meta}>Chờ đồng bộ: {pending.length}</Text>
              <Text style={styles.meta}>Ứng dụng gửi theo thứ tự ghi nhận trong từng chuyến. Màn hình ưu tiên hiển thị thao tác cần chú ý.</Text>
            </View>
            {!isOnline && unsynced.length > 0 ? <Text style={styles.meta}>Kết nối mạng để đồng bộ thao tác đã lưu.</Text> : null}
            {syncError ? <ScreenMessage message={syncError} /> : null}
            {needsAttention.length ? <><Text accessibilityRole="header" style={styles.title}>Cần chú ý</Text>{needsAttention.map(renderRow)}</> : null}
            {pending.length ? <><Text accessibilityRole="header" style={styles.title}>Đang chờ gửi</Text>{pending.map(renderRow)}</> : null}
            {synced.length ? <><Text accessibilityRole="header" style={styles.title}>Lệnh đã gửi</Text>{synced.map(renderRow)}</> : null}
            {!first ? <ScreenMessage message="Không có thao tác chờ đồng bộ." tone="success" /> : null}
            {canRetry ? (
              <View style={styles.card}>
                <PrimaryButton appearance="driver" label="Thử đồng bộ" disabled={!isOnline}
                  loading={offlineQueue.isSyncing || first.state === 'SYNCING'}
                  onPress={() => { if (isOnline && !offlineQueue.isSyncing) void sync(); }} />
                <Text style={styles.meta}>Đồng bộ các thao tác đủ điều kiện của tài khoản hiện tại.</Text>
              </View>
            ) : null}
            {needsAttention.length ? <PrimaryButton appearance="driver" label="Tải lại chuyến" variant="secondary"
              disabled={!isOnline} onPress={() => void reload()} /> : null}
          </>
        );
      }}
    </DriverTripSupportScreen>
  );
}

function CommandRow({ command, tripId, stop }: {
  command: OfflineDriverCommand; tripId: string; stop?: DriverTripStop;
}) {
  const urgent = attention.has(command.state);
  const reason = commandDetail(command);
  const date = new Date(command.occurredAt);
  return (
    <View style={[styles.card, urgent && styles.attention]} testID={`driver-sync-command-${command.id}`}>
      <View style={styles.row}>
        <Text style={styles.title}>#{command.sequence} · {command.commandType === 'ARRIVE_STOP' ? 'Xác nhận đến' : 'Hoàn thành điểm dừng'}</Text>
        <DriverStatusBadge small label={stateLabels[command.state]}
          tone={urgent ? 'error' : command.state === 'SYNCED' ? 'success' : 'info'} />
      </View>
      <Text style={styles.meta}>{stop ? `Điểm ${stop.sequence} · ${driverStopTypeLabel(stop.stopType)}` : 'Không xác định được điểm dừng trong kế hoạch hiện tại.'}</Text>
      {Number.isFinite(date.getTime()) ? <Text style={styles.meta}>Ghi nhận: {formatDate.format(date)}</Text> : null}
      {command.transmissionState === 'SENT_UNCERTAIN' && command.state !== 'SYNCED' ? (
        <Text style={styles.meta}>{urgent
          ? 'Ứng dụng chưa xác nhận được kết quả lần gửi trước.'
          : 'Chưa xác định kết quả gửi trước. Lần thử lại dùng yêu cầu đã lưu.'}</Text>
      ) : null}
      {reason ? <Text style={styles.meta}>{reason}</Text> : null}
      {stop && urgent ? <PrimaryButton appearance="driver" variant="secondary" label="Xem điểm dừng"
        onPress={() => router.push({ pathname: '/trips/[id]/stops/[stopId]', params: { id: tripId, stopId: stop.id } })} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: driverTheme.radius.card, padding: spacing.md, gap: spacing.xs,
    borderWidth: 1, borderColor: colors.border },
  summary: { backgroundColor: colors.infoSurface },
  attention: { borderColor: colors.danger, backgroundColor: colors.dangerSurface },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  title: { ...driverTheme.type.strong, color: colors.text },
  meta: { ...driverTheme.type.meta, color: colors.textMuted },
});
