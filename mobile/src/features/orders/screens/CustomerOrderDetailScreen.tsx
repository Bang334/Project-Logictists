import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OrderScreenHeader } from '@/features/orders/components/OrderScreenHeader';
import { OrderStatusBadge } from '@/features/orders/components/OrderStatusBadge';
import { useCustomerOrderDetail } from '@/features/orders/hooks/useCustomerOrderDetail';
import { useCustomerOrderTracking } from '@/features/orders/hooks/useCustomerOrderTracking';
import { CustomerOrderTrackingPanel } from '@/features/orders/components/CustomerOrderTrackingPanel';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { colors, spacing } from '@/shared/theme/theme';

function formatNumber(value: number, digits = 3): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

export function CustomerOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orderId = Array.isArray(id) ? id[0] ?? '' : id ?? '';
  return <CustomerOrderDetail key={orderId} orderId={orderId} />;
}

function CustomerOrderDetail({ orderId }: { orderId: string }) {
  const { order, isLoading, error, reload } =
    useCustomerOrderDetail(orderId);
  const tracking = useCustomerOrderTracking(orderId);
  const latestTracking = tracking.tracking;
  const handledTracking = useRef<typeof latestTracking>(null);

  useEffect(() => {
    if (!order || !latestTracking || latestTracking.orderId !== orderId ||
        handledTracking.current === latestTracking) return;

    // At most one refresh per successful tracking poll, even if the detail request fails.
    handledTracking.current = latestTracking;
    if (latestTracking.orderStatus !== order.status) void reload();
  }, [latestTracking, order, orderId, reload]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <OrderScreenHeader title="Chi tiết đơn" showBack />
      {isLoading && !order ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error && !order ? (
        <View style={styles.errorContainer}>
          <ScreenMessage message={error} />
          <PrimaryButton label="Thử lại" onPress={() => void reload()} />
        </View>
      ) : order ? (
        <ScrollView contentContainerStyle={styles.content}>
          {error ? <ScreenMessage message={error} /> : null}
          <View style={styles.heroCard}>
            <View style={styles.heading}>
              <Text style={styles.orderNumber}>{order.orderNumber}</Text>
              <OrderStatusBadge status={order.status} />
            </View>
            <Text style={styles.date}>Tạo lúc {formatDate(order.createdAt)}</Text>
            <View style={styles.metrics}>
              <Metric label="Số kiện" value={String(order.totalPackages)} />
              <Metric label="Khối lượng" value={`${formatNumber(order.totalWeightKg)} kg`} />
              <Metric label="Thể tích" value={`${formatNumber(order.totalVolumeM3)} m³`} />
            </View>
          </View>

          <CustomerOrderTrackingPanel
            tracking={tracking.tracking}
            isLoading={tracking.isLoading}
            isRefreshing={tracking.isRefreshing}
            error={tracking.error}
            onRetry={tracking.retry}
          />

          <Section title="Hành trình">
            {order.stops.map((stop) => (
              <View key={stop.id} style={styles.stop}>
                <Text style={styles.stopType}>
                  {stop.type === 'PICKUP' ? '1. Điểm lấy hàng' : '2. Điểm giao hàng'}
                </Text>
                <Text style={styles.value}>{stop.address}</Text>
                <Text style={styles.secondary}>
                  {stop.contactName} · {stop.contactPhone}
                </Text>
                <Text style={styles.secondary}>
                  {formatNumber(stop.latitude, 6)}, {formatNumber(stop.longitude, 6)}
                </Text>
              </View>
            ))}
          </Section>

          <Section title={`Hàng hóa (${order.items.length} loại)`}>
            {order.items.map((item) => (
              <View key={item.id} style={styles.item}>
                <View style={styles.heading}>
                  <Text style={styles.itemTitle}>{item.description}</Text>
                  <Text style={styles.packageType}>{item.packageType}</Text>
                </View>
                <Text style={styles.value}>
                  {item.quantity} kiện × {item.unitWeightKg === null ? '—' : `${formatNumber(item.unitWeightKg)} kg`}
                </Text>
                <Text style={styles.secondary}>
                  Tổng dòng: {formatNumber(item.lineWeightKg)} kg · {formatNumber(item.lineVolumeM3)} m³
                </Text>
                <Text style={styles.secondary}>
                  {formatNumber(item.lengthCm)} × {formatNumber(item.widthCm)} × {formatNumber(item.heightCm)} cm
                </Text>
              </View>
            ))}
          </Section>

          {order.notes ? (
            <Section title="Ghi chú">
              <Text style={styles.value}>{order.notes}</Text>
            </Section>
          ) : null}

          <Text style={styles.notice}>
            Giá vận chuyển chưa được báo. Việc duyệt đơn do bộ phận điều phối xử lý.
          </Text>
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorContainer: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  content: { padding: spacing.lg, paddingTop: 0, gap: spacing.md, paddingBottom: spacing.xl },
  heroCard: { backgroundColor: colors.surface, borderRadius: 18, padding: spacing.lg, gap: spacing.md },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  orderNumber: { flex: 1, color: colors.text, fontSize: 21, fontWeight: '800' },
  date: { color: colors.textMuted },
  metrics: { flexDirection: 'row', gap: spacing.sm },
  metric: { flex: 1, padding: spacing.sm, borderRadius: 12, backgroundColor: '#F4F7FB' },
  metricLabel: { color: colors.textMuted, fontSize: 12 },
  metricValue: { color: colors.text, fontWeight: '800', marginTop: 3 },
  section: { backgroundColor: colors.surface, borderRadius: 18, padding: spacing.lg, gap: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  stop: { gap: 4, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  stopType: { color: colors.primary, fontWeight: '800' },
  value: { color: colors.text, lineHeight: 21 },
  secondary: { color: colors.textMuted, lineHeight: 19 },
  item: { gap: 5, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemTitle: { flex: 1, color: colors.text, fontWeight: '800' },
  packageType: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  notice: { color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
