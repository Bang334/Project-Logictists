import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { driverTheme } from '@/shared/theme/driver-theme';
import type { StopListRow } from '../selectors/driver-stop-list';
import { offlineStopLabel } from '../selectors/driver-trip-workflow';
import { DriverStatusBadge, driverStopStatusLabel, driverStopTypeLabel } from './DriverTripStatusBadge';

const { colors, spacing } = driverTheme;
const plannedTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const statusTones = { PENDING: 'neutral', ARRIVED: 'info', COMPLETED: 'success', SKIPPED: 'warning' } as const;

export const DriverTripStopRow = memo(function DriverTripStopRow({
  row, currentLabel, canOperate, onOpen,
}: {
  row: StopListRow;
  currentLabel?: string;
  canOperate: boolean;
  onOpen(stopId: string): void;
}) {
  const { stop, overlay } = row;
  const type = driverStopTypeLabel(stop.stopType);
  const status = driverStopStatusLabel(stop.status);
  const overlayLabel = offlineStopLabel[overlay];
  const plan = stop.plannedArrivalTime ?? stop.plannedDepartureTime;
  const time = plan ? new Date(plan) : null;
  const timeLabel = time && Number.isFinite(time.getTime())
    ? `Dự kiến ${stop.plannedArrivalTime ? 'đến' : 'rời'} ${plannedTime.format(time)}`
    : null;
  const packageIds = new Set(stop.tasks.flatMap((task) => task.package ? [task.package.id] : []));
  const taskLabel = stop.tasks.length ? `${stop.tasks.length} công việc` : null;
  const packageLabel = packageIds.size ? `${packageIds.size} kiện liên kết` : null;
  const attention = overlay === 'CONFLICT' || overlay === 'FAILED';

  return (
    <Pressable accessibilityRole="button"
      accessibilityLabel={`${canOperate ? 'Mở' : 'Xem'} điểm ${stop.sequence}: ${type}`}
      accessibilityHint={[currentLabel, stop.address, status, overlayLabel, timeLabel, taskLabel, packageLabel]
        .filter(Boolean).join('. ')}
      testID={`driver-stop-row-${stop.id}`}
      onPress={() => onOpen(stop.id)}
      style={({ pressed }) => [
        styles.row, overlayLabel && (attention ? styles.attention : styles.pending),
        currentLabel && styles.current, pressed && styles.pressed,
      ]}>
      <View style={[styles.sequence, currentLabel && styles.currentSequence]}>
        <Text style={[styles.sequenceText, currentLabel && styles.currentSequenceText]}>{stop.sequence}</Text>
      </View>
      <View style={styles.details}>
        {currentLabel ? <Text style={styles.currentLabel}>{currentLabel}</Text> : null}
        <View style={styles.line}>
          <Text style={styles.title}>{type}</Text>
          <DriverStatusBadge small label={status} tone={statusTones[stop.status]} />
        </View>
        <Text style={styles.body}>{stop.address}</Text>
        {timeLabel ? <Text style={styles.meta}>{timeLabel}</Text> : null}
        {taskLabel ? <Text style={styles.meta}>{[taskLabel, packageLabel].filter(Boolean).join(' · ')}</Text> : null}
        {overlayLabel ? <DriverStatusBadge small label={overlayLabel} tone={attention ? 'error' : 'warning'} /> : null}
      </View>
      <Text accessible={false} style={styles.chevron}>›</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: driverTheme.touchTarget, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1,
    borderRadius: driverTheme.radius.control, padding: spacing.sm,
  },
  pending: { borderColor: colors.warning, backgroundColor: colors.warningSurface },
  attention: { borderColor: colors.danger, backgroundColor: colors.dangerSurface },
  current: { borderColor: colors.primary, borderWidth: 2 },
  pressed: { opacity: 0.8 },
  sequence: { minWidth: 36, padding: spacing.xs, alignItems: 'center', borderRadius: 8, backgroundColor: colors.neutralSurface },
  currentSequence: { backgroundColor: colors.primary },
  sequenceText: { ...driverTheme.type.meta, fontVariant: ['tabular-nums'], fontWeight: '700', color: colors.primary },
  currentSequenceText: { color: colors.surface },
  details: { flex: 1, minWidth: 0, gap: 3 },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  title: { ...driverTheme.type.meta, fontWeight: '700', color: colors.text, flexShrink: 1 },
  body: { ...driverTheme.type.meta, color: colors.textMuted },
  meta: { ...driverTheme.type.label, color: colors.textMuted },
  currentLabel: { ...driverTheme.type.label, color: colors.info, fontWeight: '700' },
  chevron: { ...driverTheme.type.heading, color: colors.info },
});
