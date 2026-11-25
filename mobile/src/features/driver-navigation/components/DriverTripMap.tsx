import { memo, useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Mapbox from '@rnmapbox/maps';
import type { PlannedRoute } from '@/features/driver-trips/selectors/planned-route.selector';
import type { DriverMapLocation, DriverMapMarker, DriverMapStopState } from '../types/driver-map.types';
import { driverTheme } from '@/shared/theme/driver-theme';

import { ScreenMessage } from '@/shared/components/ScreenMessage';

const { colors, spacing } = driverTheme;
const stateColors: Record<DriverMapStopState, string> = {
  COMPLETED: colors.success, CURRENT: colors.primary, UPCOMING: colors.textMuted,
  PENDING_SYNC: colors.warning, CONFLICT: colors.danger, SKIPPED: colors.textMuted,
};

const stopSymbols = { DEPOT_START: 'KĐ', PICKUP: 'L', DELIVERY: 'G', DEPOT_END: 'KK' } as const;

function groupStopsAtSameCoordinate(markers: DriverMapMarker[]) {
  const groups = new Map<string, { anchor: DriverMapMarker; stops: DriverMapMarker[] }>();
  for (const marker of markers) {
    const key = `${marker.latitude},${marker.longitude}`;
    const group = groups.get(key);
    if (group) {
      group.stops.push(marker);
    } else {
      groups.set(key, { anchor: marker, stops: [marker] });
    }
  }
  return [...groups.values()];
}

export const DriverTripMap = memo(function DriverTripMap({
  markers, route, driverLocation, targetStopId, selectedStopId, onSelectStops, onDeselectStops,
}: {
  markers: DriverMapMarker[];
  route?: PlannedRoute | null;
  driverLocation: DriverMapLocation | null;
  targetStopId?: string;
  selectedStopId?: string;
  onSelectStops?: (stopIds: string[]) => void;
  onDeselectStops?: (anchorStopId: string) => void;
}) {
  const camera = useRef<ComponentRef<typeof Mapbox.Camera>>(null);
  const { width, fontScale } = useWindowDimensions();
  const stopGroups = useMemo(() => groupStopsAtSameCoordinate(markers), [markers]);
  const [mapLoadIssue, setMapLoadIssue] = useState<'partial' | 'full' | null>(null);
  const [initialCamera] = useState<ComponentProps<typeof Mapbox.Camera>['defaultSettings']>(() => {
    const points = [
      ...markers,
      ...(route?.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })) ?? []),
    ];
    if (points.length === 0 && driverLocation) points.push(driverLocation);
    const first = points[0];
    if (!first) return undefined;
    const ne: [number, number] = [first.longitude, first.latitude];
    const sw: [number, number] = [first.longitude, first.latitude];
    for (const point of points) {
      ne[0] = Math.max(ne[0], point.longitude);
      ne[1] = Math.max(ne[1], point.latitude);
      sw[0] = Math.min(sw[0], point.longitude);
      sw[1] = Math.min(sw[1], point.latitude);
    }
    if (ne[0] === sw[0] && ne[1] === sw[1]) {
      return { centerCoordinate: [first.longitude, first.latitude], zoomLevel: 14 };
    }
    const largestGroup = Math.max(1, ...stopGroups.map(({ stops }) => stops.length));
    const horizontalPadding = Math.min(width / 3, 12 + Math.min(200, largestGroup * 48 * fontScale) / 2);
    return { bounds: { ne, sw }, padding: {
      paddingTop: 60, paddingRight: horizontalPadding, paddingBottom: 72, paddingLeft: horizontalPadding,
    } };
  });

  return (
    <View style={styles.mapFrame}>
      {mapLoadIssue ? (
        <ScreenMessage message={mapLoadIssue === 'partial'
          ? 'Một phần nền bản đồ chưa tải được. Các điểm dừng vẫn hiển thị.'
          : 'Không tải được nền bản đồ. Hãy kiểm tra mạng hoặc dùng nút Điều hướng bên dưới nếu có.'}
        />
      ) : null}
      <View style={styles.container}>
      <Mapbox.MapView
        style={styles.map}
        styleURL={Mapbox.StyleURL.Street}
        scaleBarEnabled={false}
        onMapLoadingError={(event) => {
          const issue = event?.type && event.type !== 'style' ? 'partial' : 'full';
          setMapLoadIssue((current) => current === 'full' ? current : issue);
        }}
        onDidFinishLoadingMap={() => setMapLoadIssue(null)}
      >
        <Mapbox.Camera ref={camera} defaultSettings={initialCamera} />
        {route ? (
          <Mapbox.ShapeSource id="planned-trip-route" shape={route}>
            <Mapbox.LineLayer id="planned-trip-route-outline" belowLayerID="road-label" style={{
              lineColor: '#FFFFFF', lineWidth: 7, lineJoin: 'round', lineCap: 'round',
            }} />
            <Mapbox.LineLayer id="planned-trip-route-line" belowLayerID="road-label" style={{
              lineColor: colors.primary, lineWidth: 4, lineJoin: 'round', lineCap: 'round',
            }} />
          </Mapbox.ShapeSource>
        ) : null}
        {stopGroups.map(({ anchor, stops }) => (
          <Mapbox.PointAnnotation key={anchor.id} id={`stop-${anchor.id}`} coordinate={[anchor.longitude, anchor.latitude]}
            selected={stops.some((stop) => stop.id === selectedStopId)}
            onSelected={() => onSelectStops?.(stops.map((stop) => stop.id))}
            onDeselected={() => onDeselectStops?.(anchor.id)}>
            <View
              collapsable={false}
              accessible
              accessibilityLabel={stops.map((stop) => stop.accessibilityLabel).join('; ')}
              style={styles.stopGroup}
            >
              {stops.map((stop) => (
                <View key={stop.id} style={[styles.marker,
                  (stop.id === targetStopId || stop.state === 'CURRENT') && styles.targetMarker,
                  { backgroundColor: stateColors[stop.state] }]}>
                  <Text style={styles.markerText}>{stopSymbols[stop.stopType]}{stop.sequence}</Text>
                </View>
              ))}
            </View>
          </Mapbox.PointAnnotation>
        ))}
        {driverLocation ? (
          <Mapbox.PointAnnotation id="driver-location" coordinate={[driverLocation.longitude, driverLocation.latitude]}>
            <View accessibilityLabel={driverLocation.isStale ? 'Vị trí cuối đã cũ của tài xế' : 'Vị trí của tài xế'}
              style={[styles.driverMarker, driverLocation.isStale && styles.staleDriverMarker]}><Text style={styles.driverText}>XE</Text></View>
          </Mapbox.PointAnnotation>
        ) : null}
      </Mapbox.MapView>
      {driverLocation ? (
        <Pressable accessibilityRole="button" onPress={() => camera.current?.setCamera({ centerCoordinate: [driverLocation.longitude, driverLocation.latitude], zoomLevel: 15, animationDuration: 500 })} style={styles.locationButton}>
          <Text style={styles.locationButtonText}>{driverLocation.isStale ? 'Vị trí cuối' : 'Vị trí của tôi'}</Text>
        </Pressable>
      ) : null}
      </View>
    </View>
  );
});

export function ConfiguredDriverTripMap({
  accessToken,
  ...mapProps
}: ComponentProps<typeof DriverTripMap> & { accessToken: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => Mapbox.setAccessToken(accessToken))
      .then(
        () => { if (active) setState('ready'); },
        () => { if (active) setState('failed'); },
      );
    return () => { active = false; };
  }, [accessToken]);

  if (state === 'failed') {
    return <ScreenMessage message="Không khởi tạo được Mapbox. Bạn vẫn có thể dùng nút Điều hướng nếu chuyến cho phép." />;
  }
  if (state === 'loading') {
    return (
      <View style={styles.mapLoading}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.loadingLabel}>Đang khởi tạo bản đồ…</Text>
      </View>
    );
  }
  return <DriverTripMap {...mapProps} />;
}

const styles = StyleSheet.create({
  mapLoading: { flex: 1, justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  loadingLabel: { color: colors.textMuted, textAlign: 'center' },
  mapFrame: { flex: 1, minHeight: 0, gap: spacing.xs },
  container: { flex: 1, borderRadius: driverTheme.radius.card, overflow: 'hidden', backgroundColor: colors.border },
  map: { flex: 1 },
  stopGroup: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 200 },
  marker: { minWidth: 42, minHeight: 42, paddingHorizontal: 5, paddingVertical: 5, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.surface },
  targetMarker: { minWidth: 48, minHeight: 48, borderRadius: 26, borderWidth: 3 },
  markerText: { color: '#FFF', fontSize: 12, fontWeight: '900' },
  driverMarker: { minWidth: 38, minHeight: 38, padding: 4, borderRadius: 22, backgroundColor: colors.text, borderWidth: 3, borderColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  staleDriverMarker: { backgroundColor: colors.warning },
  driverText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  locationButton: { position: 'absolute', right: spacing.sm, bottom: spacing.xl + spacing.sm, backgroundColor: colors.surface, borderRadius: driverTheme.radius.control, minHeight: driverTheme.touchTarget, justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderWidth: 1, borderColor: colors.border },
  locationButtonText: { color: colors.primary, fontWeight: '800' },
});
