import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { selectDriverNavigationStop } from '@/features/driver-navigation/selectors/driver-navigation-stop.selector';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import { DriverStopListHeader, DriverStopMapBar, DriverStopOrderBanner, DriverStopSearch } from '../components/DriverStopListChrome';
import { DriverTripStopRow } from '../components/DriverTripStopRow';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';
import { buildStopListRows, filterStopListRows, stopListFilters, type StopListFilter, type StopListRow } from '../selectors/driver-stop-list';

const { colors, spacing } = driverTheme;
const filters = Object.keys(stopListFilters) as StopListFilter[];
const stopKey = ({ stop }: StopListRow) => stop.id;
const maxJumpAttempts = 8;

export function DriverTripStopsScreen() {
  const { tripId, trip, isLoading, isOnline, error, reload, offlineQueue } = useDriverTripWorkspace();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StopListFilter>('ALL');
  const [jump, setJump] = useState<{ id: string; attempt: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<StopListRow>>(null);
  const headerHeight = useRef(0);
  const failed = useRef(false);
  useFocusEffect(useCallback(() => {
    if (tripId) void reload();
  }, [reload, tripId]));
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const rows = useMemo(() => buildStopListRows(trip?.stops ?? [], offlineQueue.commands),
    [trip?.stops, offlineQueue.commands]);
  const matchingRows = useMemo(() => filterStopListRows(rows, 'ALL', query), [rows, query]);
  const rowsByFilter = useMemo(() => (
    Object.fromEntries(filters.map((key) => [key, key === 'ALL' ? matchingRows : filterStopListRows(matchingRows, key, '')]))
  ), [matchingRows]);
  const visibleRows = rowsByFilter[filter] ?? [];
  const remaining = useMemo(() => rows.reduce((count, { stop }) =>
    count + (stop.status === 'COMPLETED' || stop.status === 'SKIPPED' ? 0 : 1), 0), [rows]);
  const current = useMemo(() => trip ? selectDriverNavigationStop(trip, offlineQueue.commands) : null,
    [trip, offlineQueue.commands]);
  const currentId = current?.stop.id;
  const canOperate = trip?.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED';
  const openStop = useCallback((stopId: string) => {
    router.push({ pathname: '/trips/[id]/stops/[stopId]', params: { id: tripId, stopId } });
  }, [tripId]);

  const jumpIndex = jump ? visibleRows.findIndex(({ stop }) => stop.id === jump.id) : -1;
  useEffect(() => {
    if (!jump || jumpIndex < 0 || jump.id !== currentId) return;
    const timer = setTimeout(() => {
      failed.current = false;
      list.current?.scrollToIndex({ index: jumpIndex, animated: jump.attempt === 0, viewOffset: spacing.xs });
      if (!failed.current) setJump(null);
    }, jump.attempt === 0 ? 0 : 120);
    return () => clearTimeout(timer);
  }, [currentId, jump, jumpIndex]);

  const jumpToCurrent = () => {
    if (!currentId) return;
    Keyboard.dismiss();
    if (!visibleRows.some(({ stop }) => stop.id === currentId)) {
      setFilter('ALL');
      setQuery('');
      setNotice('Đã bỏ bộ lọc và từ khóa để hiện điểm hiện tại.');
    } else {
      setNotice(null);
    }
    setJump({ id: currentId, attempt: 0 });
  };

  const recoverJump: NonNullable<ComponentProps<typeof FlatList<StopListRow>>['onScrollToIndexFailed']> =
    ({ index, highestMeasuredFrameIndex, averageItemLength }) => {
      if (!jump || index !== jumpIndex) return;
      failed.current = true;
      if (jump.attempt >= maxJumpAttempts) {
        setJump(null);
        setNotice(`Chưa cuộn đến điểm ${current?.stop.sequence}. Hãy thử lại hoặc tìm theo số điểm.`);
        return;
      }
      // Scroll near an unmeasured row so the list can lay out more items before the next exact jump.
      const estimatedIndex = Math.min(index, Math.max(0, highestMeasuredFrameIndex + 8));
      const offsetIndex = jump.attempt === 0 ? index : estimatedIndex;
      list.current?.scrollToOffset({ offset: headerHeight.current + offsetIndex * averageItemLength, animated: false });
      setJump({ id: jump.id, attempt: jump.attempt + 1 });
    };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <DriverStopListHeader tripNumber={trip?.tripNumber} count={trip?.stops.length} onBack={() => router.back()} />
      {!trip ? (
        <View style={styles.center}>
          {isLoading ? <ActivityIndicator accessibilityLabel="Đang tải điểm dừng" color={colors.primary} /> : (
            <>
              <ScreenMessage message={error ?? 'Không có dữ liệu chuyến.'} />
              <PrimaryButton appearance="driver" label="Thử lại" onPress={() => void reload()} />
            </>
          )}
        </View>
      ) : (
        <>
          <FlatList ref={list} style={styles.list} testID="driver-trip-stops-list" data={visibleRows} keyExtractor={stopKey}
            contentContainerStyle={styles.content} initialNumToRender={8}
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            refreshing={isLoading} onRefresh={() => void reload()}
            onScrollToIndexFailed={recoverJump}
            onScrollBeginDrag={() => setJump(null)}
            ItemSeparatorComponent={StopSeparator}
            ListHeaderComponent={(
              <View style={styles.controls} onLayout={(event) => { headerHeight.current = event.nativeEvent.layout.height; }}>
                <DriverStopOrderBanner />
                {error ? <ScreenMessage message={error} /> : null}
                {!isOnline ? <Text style={styles.offline}>Ngoại tuyến · Dữ liệu chuyến trên thiết bị</Text> : null}
                {!canOperate ? <Text style={styles.meta}>Phân công này chỉ có quyền xem.</Text> : null}
                {trip.stops.length > 0 ? (
                  <>
                    <DriverStopSearch value={query}
                      onChangeText={(value) => { setQuery(value); setJump(null); setNotice(null); }} />
                    <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}
                      testID="driver-stop-filters" contentContainerStyle={styles.filters}>
                      {filters.map((key) => (
                        <Pressable key={key} accessibilityRole="button" accessibilityLabel={stopListFilters[key]}
                          accessibilityHint={`${rowsByFilter[key]?.length ?? 0} điểm`}
                          accessibilityState={{ selected: filter === key }}
                          style={[styles.filter, { maxWidth: width - spacing.md * 2 }]}
                          onPress={() => { setFilter(key); setJump(null); setNotice(null); }}>
                          <View style={[styles.filterChip, filter === key && styles.selectedFilter]}>
                            <Text style={[styles.filterText, filter === key && styles.selectedText]}>{stopListFilters[key]}</Text>
                            <Text accessible={false} style={[styles.filterCount, filter === key && styles.selectedCount]}>
                              {rowsByFilter[key]?.length ?? 0}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </ScrollView>
                    {currentId || filter !== 'ALL' || query.trim() ? (
                      <View style={styles.jumpRow}>
                        {currentId ? (
                          <Pressable accessibilityRole="button" onPress={jumpToCurrent} style={styles.jump}>
                            <Text style={styles.jumpLabel}>Đến điểm hiện tại</Text>
                          </Pressable>
                        ) : null}
                        {filter !== 'ALL' || query.trim() ? (
                          <Text style={styles.meta}>{visibleRows.length}/{rows.length} điểm hiển thị</Text>
                        ) : null}
                      </View>
                    ) : null}
                    {notice ? <Text style={styles.meta} accessibilityLiveRegion="polite">{notice}</Text> : null}
                  </>
                ) : null}
              </View>
            )}
            ListEmptyComponent={!isLoading ? (
              <Text style={styles.meta}>
                {rows.length ? 'Không có điểm dừng phù hợp.' : 'Chuyến chưa có điểm dừng.'}
              </Text>
            ) : undefined}
            renderItem={({ item }) => (
              <DriverTripStopRow row={item} currentLabel={item.stop.id === currentId ? current?.contextLabel : undefined}
                canOperate={canOperate && trip.status === 'IN_PROGRESS'} onOpen={openStop} />
            )}
          />
          {!keyboardVisible ? (
            <DriverStopMapBar remaining={remaining}
              onOpenMap={() => router.push({ pathname: '/trips/[id]/map', params: { id: trip.id } })} />
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

function StopSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  list: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  controls: { gap: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  meta: { ...driverTheme.type.meta, color: colors.textMuted },
  offline: { ...driverTheme.type.meta, color: colors.warning, backgroundColor: colors.warningSurface,
    borderRadius: driverTheme.radius.control, padding: spacing.sm },
  filters: { alignItems: 'center', gap: spacing.xs },
  filter: { minHeight: driverTheme.touchTarget, justifyContent: 'center', paddingVertical: 4 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: driverTheme.radius.pill, paddingHorizontal: 9, paddingVertical: 5 },
  selectedFilter: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { ...driverTheme.type.label, flexShrink: 1, color: colors.text, fontWeight: '700' },
  filterCount: { ...driverTheme.type.label, fontVariant: ['tabular-nums'], color: colors.textMuted,
    paddingHorizontal: 4, borderRadius: driverTheme.radius.pill, backgroundColor: colors.neutralSurface },
  selectedCount: { color: colors.primary, backgroundColor: colors.infoSurface },
  selectedText: { color: colors.surface },
  jumpRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm,
    justifyContent: 'space-between' },
  jump: { minHeight: driverTheme.touchTarget, maxWidth: '100%', justifyContent: 'center' },
  jumpLabel: { ...driverTheme.type.label, color: colors.surface, fontWeight: '700',
    backgroundColor: colors.info, paddingHorizontal: 12, paddingVertical: 7, borderRadius: driverTheme.radius.pill },
  separator: { height: 8 },
});
