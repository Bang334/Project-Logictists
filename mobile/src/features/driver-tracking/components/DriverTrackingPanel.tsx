import { StyleSheet, Text, View } from 'react-native';
import type { DriverTrackingSnapshot } from '@/features/driver-tracking/types/driver-tracking.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { colors, spacing } from '@/shared/theme/theme';

const STATUS_LABEL: Record<DriverTrackingSnapshot['mode'], string> = {
  IDLE: 'Chưa bắt đầu',
  RESTORING: 'Đang khôi phục tracking',
  BACKGROUND: 'Đang theo dõi cả khi chạy nền',
  FOREGROUND_ONLY: 'Chỉ theo dõi khi mở ứng dụng',
  PERMISSION_DENIED: 'Mất quyền vị trí',
  LOCATION_DISABLED: 'Dịch vụ vị trí đang tắt',
  SYNC_ERROR: 'Lỗi đồng bộ',
  BLOCKED: 'Tracking đã bị dừng',
  STOPPED: 'Đã dừng',
};

const WARNING_LABEL: Record<string, string> = {
  BACKGROUND_PERMISSION_DENIED:
    'Chưa được cấp quyền vị trí nền. Ứng dụng chỉ theo dõi khi đang mở.',
  LOCATION_PERMISSION_NOT_REQUESTED: 'Bạn chưa bật quyền vị trí cho chuyến này.',
  GPS_QUEUE_LIMIT_REACHED:
    'Bộ nhớ đệm GPS đã đạt giới hạn an toàn; một số điểm cũ có thể đã bị loại bỏ.',
  GPS_INVALID_BATCH_DROPPED:
    'Một nhóm điểm GPS không hợp lệ đã bị loại bỏ để tránh lỗi đồng bộ lặp lại.',
};

function getWarningMessage(code: string): string {
  return WARNING_LABEL[code] ?? 'Tracking vị trí đang có cảnh báo. Vui lòng thử đồng bộ lại.';
}

function formatSyncTime(value: string | null): string {
  if (!value) return 'Chưa đồng bộ';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa đồng bộ' : date.toLocaleString('vi-VN');
}

export function DriverTrackingPanel({
  snapshot,
  onRetryPermission,
  onOpenSettings,
  onFlush,
  canStartTracking,
  isStartingTracking,
  onStartTracking,
}: {
  snapshot: DriverTrackingSnapshot;
  onRetryPermission: () => Promise<void>;
  onOpenSettings: () => Promise<void>;
  onFlush: () => Promise<void>;
  canStartTracking: boolean;
  isStartingTracking: boolean;
  onStartTracking: () => Promise<void>;
}) {
  const needsPermission =
    snapshot.mode === 'PERMISSION_DENIED' ||
    snapshot.mode === 'LOCATION_DISABLED' ||
    snapshot.mode === 'FOREGROUND_ONLY';
  return (
    <View style={styles.container} testID="driver-tracking-panel">
      <Text style={styles.title}>Theo dõi vị trí</Text>
      <Text style={styles.status}>{STATUS_LABEL[snapshot.mode]}</Text>
      {snapshot.pendingCount > 0 ? (
        <Text style={styles.detail}>Đang chờ đồng bộ {snapshot.pendingCount} điểm</Text>
      ) : null}
      <Text style={styles.detail}>Đồng bộ gần nhất: {formatSyncTime(snapshot.lastSyncAt)}</Text>
      {snapshot.warning ? (
        <Text style={styles.warning}>{getWarningMessage(snapshot.warning)}</Text>
      ) : null}
      {snapshot.errorCode ? (
        <Text style={styles.warning}>Mã lỗi đồng bộ: {snapshot.errorCode}</Text>
      ) : null}
      {canStartTracking && snapshot.mode === 'IDLE' ? (
        <PrimaryButton
          label="Bắt đầu tracking"
          loading={isStartingTracking}
          onPress={() => void onStartTracking()}
        />
      ) : null}
      {needsPermission ? (
        <View style={styles.actions}>
          <PrimaryButton
            label="Kiểm tra lại quyền vị trí"
            onPress={() => void onRetryPermission()}
          />
          <PrimaryButton label="Mở Cài đặt" onPress={() => void onOpenSettings()} />
        </View>
      ) : null}
      {(snapshot.mode === 'SYNC_ERROR' || snapshot.pendingCount > 0) &&
      snapshot.mode !== 'BLOCKED' ? (
        <PrimaryButton label="Thử đồng bộ" onPress={() => void onFlush()} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  status: { color: colors.primary, fontWeight: '800' },
  detail: { color: colors.textMuted },
  warning: { color: colors.danger, lineHeight: 20 },
  actions: { gap: spacing.sm },
});
