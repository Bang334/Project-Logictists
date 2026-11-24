import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CustomerOrderSummary } from '@/features/orders/types/order.types';
import { colors, spacing } from '@/shared/theme/theme';
import { OrderStatusBadge } from './OrderStatusBadge';

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
}

function formatNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits }).format(value);
}

export function OrderCard({
  order,
  onPress,
}: {
  order: CustomerOrderSummary;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Xem đơn ${order.orderNumber}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.heading}>
        <Text style={styles.orderNumber}>{order.orderNumber}</Text>
        <OrderStatusBadge status={order.status} />
      </View>
      <View style={styles.metrics}>
        <Text style={styles.metric}>{order.totalPackages} kiện</Text>
        <Text style={styles.dot}>•</Text>
        <Text style={styles.metric}>
          {formatNumber(order.totalWeightKg)} kg
        </Text>
      </View>
      <Text style={styles.date}>Tạo lúc {formatDate(order.createdAt)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.75 },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  orderNumber: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  metrics: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  metric: { color: colors.text, fontWeight: '600' },
  dot: { color: colors.textMuted },
  date: { color: colors.textMuted, fontSize: 13 },
});
