import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type {
  CustomerOrderTracking,
  CustomerTrackedTrip,
} from '@/features/orders/types/order-tracking.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { colors, spacing } from '@/shared/theme/theme';

const TRIP_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Bản nháp',
  PLANNED: 'Đã lập kế hoạch',
  DISPATCHED: 'Đã điều phối',
  IN_PROGRESS: 'Đang vận chuyển',
  COMPLETED: 'Đã hoàn thành',
  CANCELLED: 'Đã hủy',
};

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Không xác định'
    : new Intl.DateTimeFormat('vi-VN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

function TripTrackingCard({ trip }: { trip: CustomerTrackedTrip }) {
  const location = trip.vehicleLocation;
  const completed = trip.status === 'COMPLETED';
  return (
    <View style={styles.tripCard} testID={`customer-tracking-trip-${trip.id}`}>
      <View style={styles.heading}>
        <Text style={styles.tripNumber}>{trip.tripNumber}</Text>
        <Text style={styles.tripStatus}>
          {TRIP_STATUS_LABEL[trip.status] ?? 'Trạng thái chưa xác định'}
        </Text>
      </View>

      <Text style={styles.label}>Dự kiến theo kế hoạch</Text>
      <Text style={styles.value}>
        {trip.plannedDeliveryAt
          ? formatDate(trip.plannedDeliveryAt)
          : 'Chưa có thời gian giao dự kiến'}
      </Text>

      {!location ? (
        <Text style={styles.muted}>Chưa có dữ liệu vị trí.</Text>
      ) : completed ? (
        <View style={styles.locationBlock}>
          <Text style={styles.locationTitle}>Vị trí cuối của chuyến</Text>
          <Text style={styles.muted}>Cập nhật lúc {formatDate(location.measuredAt)}</Text>
          {location.isStale ? (
            <Text style={styles.warning}>Vị trí có thể đã cũ.</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.locationBlock}>
          <Text style={location.isStale ? styles.warning : styles.fresh}>
            {location.isStale
              ? 'Vị trí có thể đã cũ.'
              : 'Vị trí vừa được cập nhật.'}
          </Text>
          <Text style={styles.muted}>Cập nhật lúc {formatDate(location.measuredAt)}</Text>
        </View>
      )}
    </View>
  );
}

export function CustomerOrderTrackingPanel({
  tracking,
  isLoading,
  isRefreshing,
  error,
  onRetry,
}: {
  tracking: CustomerOrderTracking | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  return (
    <View style={styles.container} testID="customer-order-tracking-panel">
      <View style={styles.heading}>
        <Text style={styles.title}>Theo dõi vận chuyển</Text>
        {isRefreshing && tracking ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : null}
      </View>

      {isLoading && !tracking ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>Đang tải thông tin theo dõi...</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {tracking
              ? `Không thể cập nhật dữ liệu mới: ${error}`
              : error}
          </Text>
          <PrimaryButton
            label="Thử tải lại tracking"
            variant="secondary"
            loading={isRefreshing}
            onPress={() => void onRetry()}
          />
        </View>
      ) : null}

      {tracking?.trackingStatus === 'NOT_ASSIGNED' ? (
        <Text style={styles.muted}>
          Đơn hàng chưa được phân công chuyến vận chuyển.
        </Text>
      ) : null}

      {tracking?.trackingStatus === 'AVAILABLE'
        ? tracking.trips.map((trip) => (
            <TripTrackingCard key={trip.id} trip={trip} />
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '800' },
  loading: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  tripCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.md,
    gap: spacing.sm,
  },
  tripNumber: { flex: 1, color: colors.text, fontWeight: '800' },
  tripStatus: { color: colors.primary, fontWeight: '700' },
  label: { color: colors.textMuted, fontSize: 12 },
  value: { color: colors.text, fontWeight: '700' },
  muted: { color: colors.textMuted, lineHeight: 20 },
  locationBlock: { gap: 4 },
  locationTitle: { color: colors.text, fontWeight: '700' },
  fresh: { color: colors.success, fontWeight: '700' },
  warning: { color: colors.danger, fontWeight: '700', lineHeight: 20 },
  errorBox: {
    backgroundColor: colors.dangerSurface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.sm,
  },
  errorText: { color: colors.danger, lineHeight: 20 },
});
