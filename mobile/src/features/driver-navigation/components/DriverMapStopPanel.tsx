import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  DriverStatusBadge,
  driverStopStatusLabel,
  driverStopTypeLabel,
} from '@/features/driver-trips/components/DriverTripStatusBadge';
import type { DriverTripStop } from '@/features/driver-trips/types/driver-trip.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { driverTheme } from '@/shared/theme/driver-theme';
import { INVALID_NAVIGATION_COORDINATE_MESSAGE } from '../services/external-navigation.service';
import type { DriverNavigationSelection } from '../types/driver-navigation.types';
import { DriverNavigationPanel } from './DriverNavigationPanel';

const { colors, spacing, type } = driverTheme;

export function DriverMapStopPanel({
  stop, target, selectedGroup, readOnly, offlineLabel, invalidCoordinateCount, tripEnded,
  onOpenStop, onSelectStop, onReturnToTarget,
}: {
  stop: DriverTripStop | null;
  target: DriverNavigationSelection | null;
  selectedGroup: DriverTripStop[];
  readOnly: boolean;
  offlineLabel: string | null;
  invalidCoordinateCount: number;
  tripEnded: boolean;
  onOpenStop: (stopId: string) => void;
  onSelectStop: (stopId: string) => void;
  onReturnToTarget: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isTarget = Boolean(target && target.stop.id === stop?.id);
  const selectedTarget = isTarget ? target : null;
  const navigationIssue = selectedTarget?.blockedReason
    ?? (selectedTarget && !selectedTarget.coordinateValid ? INVALID_NAVIGATION_COORDINATE_MESSAGE : null);

  return (
    <View style={styles.panel} testID="driver-map-stop-panel">
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} testID="driver-map-details">
        {stop ? (
          <>
            <View style={styles.row}>
              <Text style={styles.eyebrow}>{selectedTarget?.contextLabel ?? 'Điểm đã chọn'}</Text>
              <DriverStatusBadge label={driverStopStatusLabel(stop.status)} tone="neutral" small />
            </View>
            <Text accessibilityRole="header" style={styles.title}>{stop.sequence}. {driverStopTypeLabel(stop.stopType)}</Text>
            <Text style={styles.address} numberOfLines={showDetails ? undefined : 2}
              accessibilityLabel={stop.address}>{stop.address}</Text>
            {offlineLabel ? (
              <DriverStatusBadge label={offlineLabel} tone={selectedTarget?.blockedReason ? 'error' : 'warning'} small />
            ) : null}
            {readOnly ? <Text style={styles.meta}>Chỉ xem điểm dừng</Text> : null}
            {navigationIssue ? <Text style={styles.warning}>{navigationIssue}</Text> : null}
          </>
        ) : (
          <Text style={styles.address}>{tripEnded
            ? 'Chuyến đã kết thúc. Chọn marker để xem lại điểm dừng.'
            : 'Chưa có điểm cần xử lý. Chọn marker để xem điểm dừng.'}</Text>
        )}
        <View style={styles.row}>
          {stop && !isTarget && target ? (
            <Pressable accessibilityRole="button" style={styles.action} onPress={onReturnToTarget}>
              <Text style={styles.link}>Về điểm hiện tại</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDetails }}
            style={styles.action} onPress={() => setShowDetails((value) => !value)}>
            <Text style={styles.link}>{showDetails ? 'Thu gọn' : stop ? 'Chi tiết và chú giải' : 'Chú giải'}</Text>
          </Pressable>
        </View>
        {selectedGroup.length > 1 ? (
          <View style={styles.group}>
            <Text style={styles.meta}>Các điểm cùng tọa độ</Text>
            <View style={styles.row}>
              {selectedGroup.map((member) => (
                <Pressable key={member.id} accessibilityRole="button"
                  accessibilityState={{ selected: member.id === stop?.id }} style={styles.action}
                  onPress={() => onSelectStop(member.id)}>
                  <Text style={styles.link}>{member.sequence}. {driverStopTypeLabel(member.stopType)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        {showDetails ? (
          <View style={styles.group}>
            {stop && (stop.contactName || stop.contactPhone) ? (
              <Text style={styles.address}>{[stop.contactName, stop.contactPhone].filter(Boolean).join(' · ')}</Text>
            ) : null}
            {stop && stop.tasks.length > 0 ? <Text style={styles.meta}>{stop.tasks.length} công việc</Text> : null}
            <Text style={styles.meta}>KĐ: kho xuất phát · KK: kho kết thúc · L: lấy hàng · G: giao hàng · XE: vị trí tài xế</Text>
            <Text style={styles.meta}>Viền dày: điểm cần xử lý · xanh lá: hoàn tất · cam: chờ đồng bộ · đỏ: cần chú ý</Text>
          </View>
        ) : null}
        {invalidCoordinateCount > 0 ? (
          <Text style={styles.meta}>{invalidCoordinateCount} điểm dừng thiếu tọa độ hợp lệ.</Text>
        ) : null}
      </ScrollView>
      {stop ? (
        <View style={styles.actions}>
          <View style={styles.primary}>
            <PrimaryButton appearance="driver" label={readOnly ? 'Xem điểm dừng' : 'Mở điểm dừng'}
              onPress={() => onOpenStop(stop.id)} />
          </View>
          {selectedTarget && !navigationIssue ? (
            <View style={styles.secondary}>
              <DriverNavigationPanel key={stop.id} compact target={selectedTarget} actionLabel="Chỉ đường ngoài" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    maxHeight: '43%', flexShrink: 1, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.border, borderRadius: driverTheme.radius.card, overflow: 'hidden',
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.md },
  eyebrow: { ...type.label, color: colors.info, fontWeight: '700' },
  title: { ...type.heading, color: colors.text },
  address: { ...type.meta, color: colors.text },
  meta: { ...type.label, color: colors.textMuted },
  warning: { ...type.meta, color: colors.warning },
  action: { minHeight: driverTheme.touchTarget, minWidth: driverTheme.touchTarget, justifyContent: 'center' },
  link: { ...type.meta, color: colors.primary, fontWeight: '700' },
  group: { gap: spacing.xs, paddingBottom: spacing.sm },
  actions: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.sm,
  },
  primary: { flexGrow: 1, flexBasis: 144 },
  secondary: { flexShrink: 1, maxWidth: '100%' },
});
