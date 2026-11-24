import { StyleSheet, Text, View } from 'react-native';
import type {
  DriverPackageStatus,
  DriverStopStatus,
  DriverStopType,
  DriverTaskAction,
  DriverTripStatus,
} from '@/features/driver-trips/types/driver-trip.types';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors } = driverTheme;

const TRIP_LABELS: Record<DriverTripStatus, string> = {
  DISPATCHED: 'Đã điều phối',
  IN_PROGRESS: 'Đang thực hiện',
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã hủy',
};

const STOP_LABELS: Record<DriverStopStatus, string> = {
  PENDING: 'Chờ đến điểm',
  ARRIVED: 'Đã đến',
  COMPLETED: 'Đã hoàn tất',
  SKIPPED: 'Đã bỏ qua',
};

const STOP_TYPE_LABELS: Record<DriverStopType, string> = {
  PICKUP: 'Lấy hàng',
  DELIVERY: 'Giao hàng',
  DEPOT_START: 'Kho xuất phát',
  DEPOT_END: 'Kho kết thúc',
};

const TASK_LABELS: Record<DriverTaskAction, string> = {
  LOAD: 'Xếp hàng',
  UNLOAD: 'Dỡ hàng',
};

const PACKAGE_LABELS: Record<DriverPackageStatus, string> = {
  DRAFT: 'Nháp',
  READY: 'Sẵn sàng',
  ALLOCATED: 'Đã phân bổ',
  LOADED: 'Đã lên xe',
  DELIVERED: 'Đã giao',
  DAMAGED: 'Hư hỏng',
  CANCELLED: 'Đã hủy',
};

export function driverTripStatusLabel(status: DriverTripStatus): string {
  return TRIP_LABELS[status];
}

export function driverStopStatusLabel(status: DriverStopStatus): string {
  return STOP_LABELS[status];
}

export function driverStopTypeLabel(type: DriverStopType): string {
  return STOP_TYPE_LABELS[type];
}

export function driverTaskActionLabel(action: DriverTaskAction): string {
  return TASK_LABELS[action];
}

export function driverPackageStatusLabel(status: DriverPackageStatus): string {
  return PACKAGE_LABELS[status];
}

export function DriverTripStatusBadge({
  status,
  compact = false,
}: {
  status: DriverTripStatus;
  compact?: boolean;
}) {
  if (compact) {
    return <DriverStatusBadge label={driverTripStatusLabel(status)} tone={compactTones[status]} />;
  }
  return (
    <View
      style={[
        styles.badge,
        status === 'IN_PROGRESS' && styles.inProgress,
        status === 'COMPLETED' && styles.completed,
        status === 'CANCELLED' && styles.cancelled,
      ]}
    >
      <Text
        style={[
          styles.label,
          status === 'IN_PROGRESS' && styles.inProgressLabel,
          status === 'COMPLETED' && styles.completedLabel,
          status === 'CANCELLED' && styles.cancelledLabel,
        ]}
      >
        {driverTripStatusLabel(status)}
      </Text>
    </View>
  );
}

const badgeTones = {
  info: { background: colors.infoSurface, text: colors.info },
  active: { background: colors.primary, text: colors.surface },
  success: { background: colors.successSurface, text: colors.success },
  warning: { background: colors.warningSurface, text: colors.warning },
  error: { background: colors.dangerSurface, text: colors.danger },
  neutral: { background: colors.neutralSurface, text: colors.textMuted },
} as const;

const compactTones = {
  DISPATCHED: 'info',
  IN_PROGRESS: 'active',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
} as const;

export function DriverStatusBadge({ label, tone, small = false }: {
  label: string; tone: keyof typeof badgeTones; small?: boolean;
}) {
  const { background, text } = badgeTones[tone];
  return (
    <View style={[styles.compactBadge, { backgroundColor: background }]}>
      <Text style={[styles.compactLabel, small && driverTheme.type.label, { color: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compactBadge: { alignSelf: 'flex-start', maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: driverTheme.radius.pill },
  compactLabel: { ...driverTheme.type.meta, fontWeight: '700' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.infoSurface,
  },
  label: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  inProgress: { backgroundColor: colors.warningSurface },
  inProgressLabel: { color: colors.warning },
  completed: { backgroundColor: colors.successSurface },
  completedLabel: { color: colors.success },
  cancelled: { backgroundColor: colors.dangerSurface },
  cancelledLabel: { color: colors.danger },
});
