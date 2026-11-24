import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DriverTripSummary } from '@/features/driver-trips/types/driver-trip.types';
import { colors, spacing } from '@/shared/theme/theme';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverTripStatusBadge, driverTripStatusLabel } from './DriverTripStatusBadge';

const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const time = new Intl.DateTimeFormat('vi-VN', { timeStyle: 'short' });

function formatSchedule(start: string, end: string) {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Chưa có giờ dự kiến';
  const endLabel = from.toDateString() === to.toDateString() ? time.format(to) : dateTime.format(to);
  return `${dateTime.format(from)} → ${endLabel}`;
}

export function DriverTripCard({
  trip,
  onPress,
}: {
  trip: DriverTripSummary;
  onPress: () => void;
}) {
  const schedule = formatSchedule(trip.plannedStartTime, trip.plannedEndTime);
  const readOnly = trip.assignment.role !== 'PRIMARY' || trip.assignment.status !== 'ASSIGNED';
  const code = trip.tripNumber.length > 36
    ? `${trip.tripNumber.slice(0, 16)}…${trip.tripNumber.slice(-14)}` : trip.tripNumber;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Xem chuyến ${trip.tripNumber}`}
      accessibilityHint={`${driverTripStatusLabel(trip.status)}. ${schedule}. ${trip.vehicle.plateNumber}, ${trip.vehicle.vehicleType}. ${trip.stopCount} điểm dừng.${readOnly ? ' Chỉ xem.' : ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.heading}>
        <Text style={styles.tripNumber} numberOfLines={2}>{code}</Text>
        <DriverTripStatusBadge status={trip.status} compact />
      </View>
      <Text style={styles.time}>{schedule}</Text>
      <View style={styles.footer}>
        <Text style={styles.secondary}>{trip.vehicle.plateNumber} · {trip.vehicle.vehicleType}</Text>
        <Text style={styles.secondary}>{trip.stopCount} điểm dừng{readOnly ? ' · Chỉ xem' : ''}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: driverTheme.radius.card,
    padding: 12,
    gap: spacing.xs,
  },
  pressed: { opacity: 0.75 },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tripNumber: { ...driverTheme.type.strong, flexShrink: 1, color: colors.text },
  time: { ...driverTheme.type.meta, color: colors.text },
  secondary: { ...driverTheme.type.meta, color: colors.textMuted, flexShrink: 1 },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: spacing.sm },
});
