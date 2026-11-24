import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { driverTripsService } from '../services/driver-trips.service';
import { localDateRange, shiftDay } from './driver-schedule-dates';
import { useDriverScheduleRead } from './useDriverScheduleRead';

const { colors, spacing, radius, type } = driverTheme;

export function DriverActivityMetrics({ today, days, timeZone }: {
  today: string; days: number; timeZone: string;
}) {
  const load = useCallback(async () => {
    const range = localDateRange(shiftDay(today, 1 - days), shiftDay(today, 1), timeZone);
    return { data: [await driverTripsService.getActivitySummary(range)] };
  }, [today, days, timeZone]);
  const read = useDriverScheduleRead(load);
  const summary = (read.offline ? read.cachedItems : read.items)?.[0];
  const deliveries = summary?.deliveries;

  return (
    <View style={styles.panel}>
      {read.loading ? <ActivityIndicator accessibilityLabel="Đang tải tổng hợp hoạt động" color={colors.primary} /> : null}
      {read.offline ? <ScreenMessage message={summary
        ? 'Ngoại tuyến. Đang hiển thị số liệu lần tải gần nhất của kỳ này.'
        : 'Ngoại tuyến. Chưa có số liệu đã tải cho kỳ này.'} /> : null}
      {!read.offline && read.error ? (
        <>
          <ScreenMessage message={read.error} />
          <PrimaryButton appearance="driver" variant="secondary" label="Thử lại tổng hợp" onPress={read.refresh} />
        </>
      ) : null}
      {summary ? (
        <>
          <Text style={styles.meta}>
            Tổng hợp lúc {new Intl.DateTimeFormat('vi-VN', {
              timeZone: summary.timeZone, dateStyle: 'short', timeStyle: 'short',
            }).format(new Date(summary.asOf))}
          </Text>
          {summary.coverage.status === 'NO_DATA' ? (
            <Text style={styles.body}>Chưa có dữ liệu thực thi của bạn trong kỳ này.</Text>
          ) : (
            <>
              {summary.coverage.status === 'PARTIAL' ? (
                <ScreenMessage message="Dữ liệu chưa đầy đủ. Các số bên dưới là phần đã xác minh." />
              ) : null}
              <View style={styles.grid}>
                <Metric label="Chuyến đã kết thúc" value={summary.completedTripCount} />
                <Metric label="Điểm đã xử lý" value={summary.processedStopCount}
                  detail={`Điểm kho tính riêng · ${summary.depotStopCount ?? '—'}`} />
                <Metric label="Giao thành công" value={deliveries?.success} detail="Lần giao" />
                <View style={styles.card}>
                  <Text style={styles.label}>Một phần / thất bại</Text>
                  <Text style={styles.value}>{deliveries?.partial ?? '—'} / {deliveries?.failed ?? '—'}</Text>
                  <Text style={styles.meta}>Lần giao</Text>
                  {deliveries?.unclassified ? (
                    <Text style={styles.meta}>{deliveries.unclassified} lần chưa phân loại</Text>
                  ) : null}
                </View>
              </View>
            </>
          )}
        </>
      ) : null}
    </View>
  );
}

function Metric({ label, value, detail }: { label: string; value?: number | null; detail?: string }) {
  return <View style={styles.card}>
    <Text style={styles.label}>{label}</Text>
    <Text style={styles.value}>{value ?? '—'}</Text>
    {detail ? <Text style={styles.meta}>{detail}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  card: { flexBasis: '45%', flexGrow: 1, gap: spacing.xs, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, backgroundColor: colors.surface },
  label: { ...type.strong, color: colors.text },
  value: { ...type.title, color: colors.primary },
  body: { ...type.body, color: colors.text },
  meta: { ...type.meta, color: colors.textMuted },
});
