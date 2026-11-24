import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverTripHeader } from '../components/DriverTripHeader';
import { DriverTripStatusBadge } from '../components/DriverTripStatusBadge';
import { driverTripsService } from '../services/driver-trips.service';
import type { DriverHistoryStatus, DriverTripSummary } from '../types/driver-trip.types';
import {
  agendaForDay, formatTripInstant, localDateRange, localDayKey, localMidnight, mondayOf, shiftDay,
} from './driver-schedule-dates';
import { useDriverScheduleRead, useDriverScheduleTimezone } from './useDriverScheduleRead';
import { DriverActivityMetrics } from './DriverActivityMetrics';

const { colors, spacing, radius, type } = driverTheme;
const weekdays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export function DriverCalendarScreen() {
  return <DriverSchedule title="Lịch chuyến" render={(zone) => <Calendar timeZone={zone} />} />;
}

export function DriverHistoryScreen() {
  return <DriverSchedule title="Lịch sử chuyến" render={(zone) => <History timeZone={zone} />} />;
}

function DriverSchedule({ title, render }: { title: string; render: (timeZone: string) => ReactNode }) {
  const auth = useAuth();
  if (auth.status !== 'authenticated' || auth.user.role !== 'DRIVER') return null;
  return <ScheduleFrame key={auth.user.id} title={title} render={render} />;
}

function ScheduleFrame({ title, render }: { title: string; render: (timeZone: string) => ReactNode }) {
  const timezone = useDriverScheduleTimezone();
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.screen}>
      <View style={styles.header}>
        <DriverTripHeader compact title={title} />
        {timezone.zone ? (
          <Text style={styles.meta}>
            {timezone.zone.isFallback ? 'Múi giờ mặc định' : 'Múi giờ chi nhánh'} · {timezone.zone.timeZone}
          </Text>
        ) : null}
      </View>
      {timezone.zone ? render(timezone.zone.timeZone) : (
        <View style={styles.content}>
          <ReadFeedback loading={timezone.loading} error={timezone.error} offline={timezone.offline}
            refresh={timezone.refresh} empty="Chưa có dữ liệu múi giờ." />
        </View>
      )}
    </SafeAreaView>
  );
}

function useScheduleToday(timeZone: string) {
  const [instant, setInstant] = useState(Date.now);
  useFocusEffect(useCallback(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      const now = Date.now();
      setInstant(now);
      const tomorrow = shiftDay(localDayKey(now, timeZone), 1);
      timer = setTimeout(update, localMidnight(tomorrow, timeZone) - now + 100);
    }
    update();
    return () => clearTimeout(timer);
  }, [timeZone]));
  return localDayKey(instant, timeZone);
}

async function loadWeek(monday: string, timeZone: string) {
  const range = localDateRange(monday, shiftDay(monday, 7), timeZone);
  const first = await driverTripsService.getTrips(1, 100, undefined, range);
  const trips = new Map(first.items.map((trip) => [trip.id, trip]));
  for (let page = 2; page <= first.totalPages; page += 1) {
    const result = await driverTripsService.getTrips(page, 100, undefined, range);
    for (const trip of result.items) trips.set(trip.id, trip);
  }
  return { data: [...trips.values()] };
}

function useCalendarRead(monday: string, timeZone: string) {
  const load = useCallback(() => loadWeek(monday, timeZone), [monday, timeZone]);
  return useDriverScheduleRead<DriverTripSummary, never>(load);
}

function Calendar({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  const today = useScheduleToday(timeZone);
  const [selected, setSelected] = useState<string>();
  const day = selected ?? today;
  const monday = mondayOf(day);
  const lastDay = shiftDay(monday, 6);
  const read = useCalendarRead(monday, timeZone);
  const agenda = agendaForDay(read.items ?? [], day, timeZone);
  const instant = (value: string) => formatTripInstant(value, timeZone);
  const dayScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const dayPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const x = dayPositions.current.get(day);
    if (x !== undefined) dayScroll.current?.scrollTo({ x, animated: false });
  }, [day]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.controls}>
        <Text accessibilityRole="header" style={styles.heading}>
          {monday.slice(8)}/{monday.slice(5, 7)} – {lastDay.split('-').reverse().join('/')}
        </Text>
        <View style={styles.row}>
          <Choice label="Tuần trước" onPress={() => setSelected(shiftDay(day, -7))} />
          <Choice label="Hôm nay" selected={day === today} onPress={() => setSelected(undefined)} />
          <Choice label="Tuần sau" onPress={() => setSelected(shiftDay(day, 7))} />
        </View>
        <ScrollView ref={dayScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.daysStrip}>
          {weekdays.map((weekday, index) => {
            const value = shiftDay(monday, index);
            return <Choice key={value} label={`${weekday}\n${value.slice(8)}/${value.slice(5, 7)}`}
              accessibilityLabel={value} selected={day === value} onPress={() => setSelected(value)}
              onLayout={({ nativeEvent }) => {
                const { x } = nativeEvent.layout;
                dayPositions.current.set(value, x);
                if (value === day) dayScroll.current?.scrollTo({ x, animated: false });
              }} />;
          })}
        </ScrollView>
      </View>
      <Text accessibilityRole="header" style={styles.heading}>Chuyến được phân công · {day.slice(8)}/{day.slice(5, 7)}</Text>
      <ReadFeedback loading={read.loading} error={read.error} offline={read.offline} refresh={read.refresh}
        empty={agenda.length === 0 ? 'Ngày này chưa có chuyến được phân công.' : undefined} />
      {agenda.map(({ trip, assignments }) => {
        const overnight = assignments.some(({ startTime, endTime }) =>
          localDayKey(Date.parse(startTime), timeZone) !== localDayKey(Date.parse(endTime) - 1, timeZone));
        return (
          <View key={trip.id} style={[styles.card, trip.status === 'IN_PROGRESS' && styles.activeCard]}>
            <TripTitle number={trip.tripNumber} status={trip.status} />
            {overnight ? <Text style={styles.emphasis}>Chuyến qua đêm</Text> : null}
            <Text style={styles.meta}>{trip.vehicle.plateNumber} · {trip.vehicle.model} · {trip.stopCount} điểm dừng</Text>
            <View style={styles.details}>
              <Text style={styles.body}>Kế hoạch · {instant(trip.plannedStartTime)} – {instant(trip.plannedEndTime)}</Text>
              <Text style={styles.body}>Thực tế · {trip.actualStartTime ? instant(trip.actualStartTime) : 'Chưa ghi nhận bắt đầu'}
                {trip.actualEndTime ? ` – ${instant(trip.actualEndTime)}` : ''}</Text>
            </View>
            {assignments.map((assignment) => <Text key={assignment.id} style={styles.meta}>
              {assignment.role} · Phân công {instant(assignment.startTime)} – {instant(assignment.endTime)}
            </Text>)}
            <PrimaryButton appearance="driver" label="Xem chuyến" onPress={() =>
              router.push({ pathname: '/trips/[id]', params: { id: trip.id } })} />
          </View>
        );
      })}
    </ScrollView>
  );
}

function History({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  const today = useScheduleToday(timeZone);
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<DriverHistoryStatus>();
  const load = useCallback(async (cursor?: string) => {
    const range = localDateRange(shiftDay(today, 1 - days), shiftDay(today, 1), timeZone);
    const page = await driverTripsService.getHistory(range, status, cursor);
    return { data: page.items, next: page.nextCursor ?? undefined };
  }, [days, status, timeZone, today]);
  const read = useDriverScheduleRead(load);
  const items = [...new Map((read.items ?? []).map((item) => [item.tripId, item])).values()];

  return (
    <FlatList data={items} keyExtractor={(item) => item.tripId}
      contentContainerStyle={styles.content}
      refreshing={read.loading && items.length > 0} onRefresh={read.refresh}
      ListHeaderComponent={
        <View style={styles.controls}>
          <Text accessibilityRole="header" style={styles.heading}>Tổng hợp hoạt động</Text>
          <View style={styles.row}>{[7, 30, 90].map((value) => <Choice key={value}
            label={`${value} ngày`} selected={days === value} onPress={() => setDays(value)} />)}</View>
          <DriverActivityMetrics today={today} days={days} timeZone={timeZone} />
          <Text accessibilityRole="header" style={styles.heading}>Nhật ký chuyến xe</Text>
          <View style={styles.row}>
            <Choice label="Tất cả" selected={!status} onPress={() => setStatus(undefined)} />
            <Choice label="Hoàn thành" selected={status === 'COMPLETED'} onPress={() => setStatus('COMPLETED')} />
            <Choice label="Đã hủy" selected={status === 'CANCELLED'} onPress={() => setStatus('CANCELLED')} />
          </View>
          <ReadFeedback loading={read.loading && !items.length} error={read.error} offline={read.offline}
            refresh={items.length && read.loadMore ? read.loadMore : read.refresh}
            empty={items.length === 0 ? 'Chưa có chuyến trong khoảng đã chọn.' : undefined} />
        </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityLabel={`Mở chuyến ${item.tripNumber}`} style={styles.card}
        onPress={() => router.push({ pathname: '/trips/[id]', params: { id: item.tripId } })}>
        <TripTitle number={item.tripNumber} status={item.status} />
        <Text style={styles.body}>{item.dateBasis === 'ACTUAL_END' ? 'Kết thúc thực tế' : 'Mốc bắt đầu kế hoạch'}
          {' · '}{formatTripInstant(item.historyAt, timeZone)}</Text>
        <Text style={styles.meta}>{item.vehicle.plateNumber} · {item.vehicle.model}</Text>
        <View style={styles.details}>
          <Text style={styles.body}>{item.processedStops}/{item.stopCount} điểm đã xử lý · {item.distinctPackageCount} kiện có mã</Text>
          <Text style={styles.meta}>Lấy · {item.loadTaskCount} tác vụ · {item.loadedQuantity ?? 'Chưa có số thực tế'}</Text>
          <Text style={styles.meta}>Giao · {item.unloadTaskCount} tác vụ · {item.unloadedQuantity ?? 'Chưa có số thực tế'}</Text>
        </View>
      </Pressable>}
      ListFooterComponent={read.loadMore && !read.error ? (
        <PrimaryButton label="Tải thêm" appearance="driver" variant="secondary" loading={read.loadingMore} onPress={read.loadMore} />
      ) : undefined} />
  );
}

function TripTitle({ number, status }: { number: string; status: DriverTripSummary['status'] }) {
  return <View style={styles.row}>
    <Text style={styles.heading}>{number}</Text>
    <DriverTripStatusBadge status={status} compact />
  </View>;
}

function Choice({ label, accessibilityLabel, selected, onPress, onLayout }: {
  label: string; accessibilityLabel?: string; selected?: boolean; onPress: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ selected }} onPress={onPress} onLayout={onLayout} style={[styles.choice, selected && styles.selected]}>
    <Text style={[styles.choiceLabel, selected && styles.selectedLabel]}>{label}</Text>
  </Pressable>;
}

function ReadFeedback({ loading, error, empty, offline, refresh }: {
  loading: boolean; error?: string; empty?: string; offline: boolean; refresh: () => void;
}) {
  if (loading) return <ActivityIndicator accessibilityLabel="Đang tải" color={colors.primary} />;
  if (error) return <View style={styles.controls}>
    <ScreenMessage message={error} />
    {!offline ? <PrimaryButton appearance="driver" variant="secondary" label="Thử lại" onPress={refresh} /> : null}
  </View>;
  return empty ? <View style={styles.card}><Text style={styles.body}>{empty}</Text></View> : null;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.md, gap: spacing.xs },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  controls: { gap: spacing.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  daysStrip: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  card: { padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface,
    borderColor: colors.border, borderWidth: 1, borderRadius: radius.card },
  activeCard: { borderLeftWidth: 4, borderLeftColor: colors.success },
  details: { padding: spacing.sm, gap: spacing.xs, backgroundColor: colors.neutralSurface, borderRadius: radius.control },
  heading: { ...type.heading, color: colors.text, flexShrink: 1 },
  body: { ...type.body, color: colors.text },
  meta: { ...type.meta, color: colors.textMuted },
  emphasis: { ...type.strong, color: colors.info },
  choice: { minHeight: driverTheme.touchTarget, minWidth: driverTheme.touchTarget, justifyContent: 'center',
    borderRadius: radius.control, backgroundColor: colors.neutralSurface, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  choiceLabel: { ...type.meta, color: colors.primary, textAlign: 'center' },
  selected: { backgroundColor: colors.primary },
  selectedLabel: { color: colors.surface },
});
