import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DriverIncident } from '@/features/driver-incidents/types/driver-incident.types';
import {
  DRIVER_INCIDENT_SEVERITY_LABELS,
  DRIVER_INCIDENT_TYPE_LABELS,
  driverIncidentStatusLabel,
} from '@/features/driver-incidents/types/driver-incident.types';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverStatusBadge } from '@/features/driver-trips/components/DriverTripStatusBadge';

const { colors, spacing } = driverTheme;

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

export function DriverIncidentCard({ incident }: { incident: DriverIncident }) {
  const [expanded, setExpanded] = useState(false);
  const orders = incident.affectedOrders
    .map((order) => order.orderNumber)
    .join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Xem sự cố ${DRIVER_INCIDENT_TYPE_LABELS[incident.type]}`}
      accessibilityState={{ expanded }}
      accessibilityHint={`${driverIncidentStatusLabel(incident.status)} · ${DRIVER_INCIDENT_SEVERITY_LABELS[incident.severity]}`}
      onPress={() => setExpanded((current) => !current)}
      style={styles.card}
      testID={`driver-incident-${incident.id}`}
    >
      <View style={styles.heading}>
        <Text style={styles.title}>
          {DRIVER_INCIDENT_TYPE_LABELS[incident.type]}
        </Text>
        <DriverStatusBadge small label={driverIncidentStatusLabel(incident.status)}
          tone={incident.status === 'RESOLVED' ? 'success' : incident.status === 'OPEN' ? 'warning' : 'info'} />
        <DriverStatusBadge small label={`Mức độ: ${DRIVER_INCIDENT_SEVERITY_LABELS[incident.severity]}`}
          tone={incident.severity === 'CRITICAL' ? 'error' : incident.severity === 'HIGH' ? 'warning' : 'neutral'} />
      </View>
      <Text style={styles.meta}>
        Xảy ra lúc: {formatDate(incident.occurredAt)}
      </Text>
      <Text style={styles.description} numberOfLines={expanded ? undefined : 2}>
        {incident.description}
      </Text>
      {expanded ? (
        <View style={styles.detail}>
          <Text style={styles.meta}>{orders ? `Đơn bị ảnh hưởng: ${orders}` : 'Không chọn đơn bị ảnh hưởng'}</Text>
          <Text style={styles.meta}>
            Thời gian báo: {formatDate(incident.createdAt)}
          </Text>
          <Text style={styles.detailTitle}>Kết quả xử lý</Text>
          <Text style={styles.description}>
            {incident.resolution?.trim() || 'Chưa có kết quả xử lý.'}
          </Text>
        </View>
      ) : null}
      <Text style={styles.action}>{expanded ? 'Thu gọn' : 'Xem chi tiết'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: driverTheme.radius.control,
    padding: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.surface,
  },
  heading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  title: { ...driverTheme.type.strong, width: '100%', color: colors.text },
  meta: { color: colors.textMuted, lineHeight: 19 },
  description: { color: colors.text, lineHeight: 21 },
  detail: {
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  detailTitle: { color: colors.text, fontWeight: '700' },
  action: { color: colors.primary, fontWeight: '700', marginTop: spacing.xs },
});
