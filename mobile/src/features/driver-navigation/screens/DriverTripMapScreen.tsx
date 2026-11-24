import { useCallback, useEffect, useMemo, useReducer, useState, type ComponentProps } from 'react';
import { ActivityIndicator, NativeModules, Platform, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DriverMapErrorBoundary } from '../components/DriverMapErrorBoundary';
import { DriverMapStopPanel } from '../components/DriverMapStopPanel';
import type { ConfiguredDriverTripMap } from '../components/DriverTripMap';
import type { DriverMapLocation } from '../types/driver-map.types';
import { selectDriverMapLocation, selectDriverMapMarkers } from '../selectors/driver-map.selector';
import { selectDriverNavigationStop } from '../selectors/driver-navigation-stop.selector';
import { useOfflineDriverQueue } from '@/features/driver-offline/hooks/useOfflineDriverQueue';
import { useDriverTracking } from '@/features/driver-tracking/hooks/useDriverTracking';
import { DriverTripHeader } from '@/features/driver-trips/components/DriverTripHeader';
import { DriverStatusBadge } from '@/features/driver-trips/components/DriverTripStatusBadge';
import { useDriverTripDetail } from '@/features/driver-trips/hooks/useDriverTripDetail';
import { offlineStopLabel, selectStopAction } from '@/features/driver-trips/selectors/driver-trip-workflow';
import type { DriverTrackingSnapshot } from '@/features/driver-tracking/types/driver-tracking.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors, spacing, type } = driverTheme;

function DriverMapNative(props: ComponentProps<typeof ConfiguredDriverTripMap>) {
  // Keep the module in the Metro bundle, but evaluate it only inside the map error boundary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nativeMap: typeof import('../components/DriverTripMap') = require('../components/DriverTripMap');
  return <nativeMap.ConfiguredDriverTripMap {...props} />;
}

export function DriverTripMapScreen() {
  const mapboxToken = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN?.trim() ?? '';
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = Array.isArray(id) ? (id[0] ?? '') : (id ?? '');
  const { trip, isLoading, error, reload } = useDriverTripDetail(tripId);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const { snapshot } = useDriverTracking(tripId);
  const offline = useOfflineDriverQueue(tripId);
  const mapData = useMemo(
    () => trip ? selectDriverMapMarkers(trip, offline.commands) : { markers: [], invalidCoordinateCount: 0 },
    [offline.commands, trip],
  );
  const navigationTarget = useMemo(
    () => trip ? selectDriverNavigationStop(trip, offline.commands) : null,
    [offline.commands, trip],
  );
  const canOperate = trip?.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED';
  const canShowTripGps = trip?.status === 'IN_PROGRESS' && canOperate && snapshot.tripId === tripId;
  const sample = canShowTripGps && snapshot.mode !== 'PERMISSION_DENIED' && snapshot.mode !== 'LOCATION_DISABLED'
    ? snapshot.latestLocalLocation ?? null
    : null;
  const [sampleAgeRevision, updateSampleAge] = useReducer((revision: number) => revision + 1, 0);
  const driverLocation = useMemo(
    () => ({ location: selectDriverMapLocation(sample), revision: sampleAgeRevision }),
    [sample, sampleAgeRevision],
  ).location;
  useEffect(() => {
    if (!driverLocation || driverLocation.isStale) return;
    const remaining = Date.parse(driverLocation.measuredAt) + 120_001 - Date.now();
    const timeout = setTimeout(updateSampleAge, Math.max(1, remaining));
    return () => clearTimeout(timeout);
  }, [driverLocation]);

  const [selection, setSelection] = useState<{ tripId: string; stopIds: string[]; stopId?: string } | null>(null);
  function selectMarker(stopIds: string[]) {
    setSelection({ tripId, stopIds });
  }
  function deselectMarker(anchorStopId: string) {
    setSelection((value) => value && value.tripId === tripId && value.stopIds[0] === anchorStopId ? null : value);
  }
  const currentSelection = selection?.tripId === tripId ? selection : null;
  const selectedGroup = currentSelection
    ? currentSelection.stopIds.flatMap((stopId) => {
      const stop = trip?.stops.find((item) => item.id === stopId);
      return stop ? [stop] : [];
    })
    : [];
  const selectedStop = selectedGroup.find((stop) => stop.id === currentSelection?.stopId)
    ?? selectedGroup.find((stop) => stop.id === navigationTarget?.stop.id)
    ?? selectedGroup[0]
    ?? navigationTarget?.stop
    ?? null;
  const stopAction = trip && selectedStop ? selectStopAction(trip, selectedStop, offline.commands, offline.summary) : null;
  const hasCoordinates = mapData.markers.length > 0 || driverLocation !== null;
  const hasMapboxNative = Platform.OS === 'web' || Boolean(NativeModules.RNMBXModule);
  const hasMapboxToken = mapboxToken.startsWith('pk.');
  const canShowMap = hasCoordinates && hasMapboxNative && hasMapboxToken;

  function goBack() {
    if (router.canGoBack()) router.back();
    else if (tripId) router.replace({ pathname: '/trips/[id]', params: { id: tripId } });
    else router.replace('/trips');
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
      <DriverTripHeader compact title="Bản đồ chuyến" showBack onBack={goBack} />
      {isLoading && !trip ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingLabel}>Đang tải thông tin chuyến…</Text>
        </View>
      ) : error && !trip ? (
        <View style={styles.center}><ScreenMessage message={error} />
          <PrimaryButton appearance="driver" label="Thử lại" onPress={() => void reload()} />
        </View>
      ) : trip ? (
        <View style={styles.content}>
          <View style={styles.summary}>
            <Text style={styles.tripNumber} accessibilityLabel={trip.tripNumber}
              numberOfLines={1} ellipsizeMode="middle">{trip.tripNumber}</Text>
            <DriverMapGpsStatus
              location={driverLocation}
              tracking={canShowTripGps ? snapshot : null}
              isInProgress={trip.status === 'IN_PROGRESS'}
            />
          </View>
          <View style={styles.workspace}>
            <View style={[styles.mapArea, !canShowMap && styles.emptyMap]} testID="driver-map-area">
              {!hasCoordinates ? (
                <ScreenMessage message="Chưa có điểm dừng có tọa độ hợp lệ để hiển thị." />
              ) : !hasMapboxNative ? (
                <ScreenMessage message="Ứng dụng đang mở thiếu Mapbox native. Hãy mở Smart TMS bằng bản development APK có Mapbox." />
              ) : !hasMapboxToken ? (
                <ScreenMessage message="Cần cấu hình public token EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN cho bản development build." />
              ) : (
                <DriverMapErrorBoundary key={trip.id}>
                  <DriverMapNative
                    accessToken={mapboxToken}
                    markers={mapData.markers}
                    driverLocation={driverLocation}
                    targetStopId={navigationTarget?.stop.id}
                    selectedStopId={selectedGroup.length ? selectedStop?.id : undefined}
                    onSelectStops={selectMarker}
                    onDeselectStops={deselectMarker}
                  />
                </DriverMapErrorBoundary>
              )}
            </View>
            {error ? <ScreenMessage message={error} /> : null}
            <DriverMapStopPanel
              key={trip.id}
              stop={selectedStop}
              target={navigationTarget}
              selectedGroup={selectedGroup}
              readOnly={!stopAction?.action}
              offlineLabel={stopAction ? offlineStopLabel[stopAction.presentation] : null}
              invalidCoordinateCount={mapData.invalidCoordinateCount}
              tripEnded={trip.status === 'COMPLETED' || trip.status === 'CANCELLED'}
              onOpenStop={(stopId) => router.push({ pathname: '/trips/[id]/stops/[stopId]', params: { id: tripId, stopId } })}
              onSelectStop={(stopId) => setSelection((value) => value ? { ...value, stopId } : null)}
              onReturnToTarget={() => setSelection(null)}
            />
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function DriverMapGpsStatus({ location, tracking, isInProgress }: {
  location: DriverMapLocation | null;
  tracking: DriverTrackingSnapshot | null;
  isInProgress: boolean;
}) {
  if (!isInProgress) return null;
  if (tracking?.mode === 'PERMISSION_DENIED' || tracking?.warning === 'LOCATION_PERMISSION_NOT_REQUESTED') {
    return <DriverStatusBadge small tone="warning" label="GPS · Chưa cấp quyền vị trí" />;
  }
  if (tracking?.mode === 'LOCATION_DISABLED') {
    return <DriverStatusBadge small tone="warning" label="GPS · Dịch vụ vị trí đang tắt" />;
  }
  if (tracking?.errorCode === 'TRACKING_START_FAILED' || tracking?.errorCode === 'LOCATION_TASK_ERROR') {
    return <DriverStatusBadge small tone="error" label={location?.isStale ? 'GPS · Lỗi vị trí, mẫu đã cũ' : 'GPS · Lỗi nhận vị trí'} />;
  }
  if (!location) return <DriverStatusBadge small tone="neutral" label="GPS · Chưa có vị trí" />;
  return location.isStale
    ? <DriverStatusBadge small tone="warning" label="GPS · Vị trí đã cũ (> 2 phút)" />
    : <DriverStatusBadge small tone="success" label="GPS · Đã có vị trí" />;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  loadingLabel: { color: colors.textMuted, textAlign: 'center' },
  content: { flex: 1, paddingHorizontal: spacing.sm, paddingBottom: spacing.xs, gap: spacing.xs },
  summary: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.xs },
  tripNumber: { ...type.meta, color: colors.textMuted, flexGrow: 1, flexBasis: 145, flexShrink: 1 },
  workspace: { flex: 1, minHeight: 0, gap: spacing.xs },
  mapArea: { flex: 1, minHeight: 0 },
  emptyMap: { justifyContent: 'center', padding: spacing.md, borderRadius: driverTheme.radius.card, backgroundColor: colors.neutralSurface },
});
