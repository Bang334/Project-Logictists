import { StyleSheet, Text, View } from 'react-native';
import type { OrderStatus } from '@/features/orders/types/order.types';
import { colors } from '@/shared/theme/theme';

const LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Chờ duyệt',
  CONFIRMED: 'Đã xác nhận',
  ASSIGNED: 'Đã phân chuyến',
  IN_TRANSIT: 'Đang vận chuyển',
  COMPLETED: 'Hoàn thành',
  CANCELLED: 'Đã hủy',
};

export function orderStatusLabel(status: OrderStatus): string {
  return LABELS[status];
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <View
      style={[
        styles.badge,
        status === 'COMPLETED' && styles.completed,
        status === 'CANCELLED' && styles.cancelled,
      ]}
    >
      <Text
        style={[
          styles.label,
          status === 'COMPLETED' && styles.completedLabel,
          status === 'CANCELLED' && styles.cancelledLabel,
        ]}
      >
        {orderStatusLabel(status)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: '#E8F0FE',
  },
  label: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  completed: { backgroundColor: colors.successSurface },
  completedLabel: { color: colors.success },
  cancelled: { backgroundColor: colors.dangerSurface },
  cancelledLabel: { color: colors.danger },
});
