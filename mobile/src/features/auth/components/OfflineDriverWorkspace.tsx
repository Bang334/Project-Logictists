import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { offlineDriverCommandStorage } from '@/features/driver-offline/storage/offline-driver-command.storage';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import { offlineTripSnapshots } from '@/features/driver-trips/storage/offline-trip-snapshots';
import {
  driverStopStatusLabel, driverStopTypeLabel, driverTaskActionLabel,
} from '@/features/driver-trips/components/DriverTripStatusBadge';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';
import type { OfflineDriverIdentity } from '../services/offline-driver-identity';

type Snapshots = Awaited<ReturnType<typeof offlineTripSnapshots.list>>;
const labels: Record<OfflineDriverCommand['state'], string> = {
  PENDING: 'Chờ đồng bộ',
  RETRY_WAIT: 'Chờ thử lại',
  SYNCING: 'Lần gửi chưa được đối chiếu',
  AUTH_PAUSED: 'Chờ xác thực',
  CONFLICT: 'Xung đột',
  FAILED: 'Thất bại',
  BLOCKED: 'Bị chặn',
  SYNCED: 'Đã đồng bộ',
};

export function OfflineDriverWorkspace({ identity }: { identity: OfflineDriverIdentity }) {
  const [data, setData] = useState<{ snapshots: Snapshots | null; commands: OfflineDriverCommand[] | null }>();
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      offlineTripSnapshots.list(identity), offlineDriverCommandStorage.listForOwner(identity.ownerId),
    ]).then(([trips, queue]) => {
      if (!active) return;
      setData({
        snapshots: trips.status === 'fulfilled' ? trips.value : null,
        commands: queue.status === 'fulfilled'
          ? queue.value.filter((command) => command.ownerUserId === identity.ownerId && command.state !== 'SYNCED')
          : null,
      });
    });
    return () => { active = false; };
  }, [identity]);

  if (!data) return <Text style={styles.meta}>Đang đọc dữ liệu đã lưu…</Text>;
  const { snapshots, commands } = data;
  const tripNumbers = new Map(snapshots?.map(({ trip }) => [trip.id, trip.tripNumber]));
  return (
    <>
      <Text style={styles.heading}>Chuyến đã lưu</Text>
      {!snapshots?.length ? (
        <ScreenMessage message="Chưa có dữ liệu chuyến dùng được trên thiết bị. Kết nối mạng rồi mở chuyến để tải lại." />
      ) : snapshots.map(({ trip, savedAt }) => (
        <View key={trip.id} style={styles.card}>
          <Pressable accessibilityRole="button" style={styles.touch}
            accessibilityState={{ expanded: openTrip === trip.id }}
            onPress={() => setOpenTrip(openTrip === trip.id ? null : trip.id)}>
            <Text style={styles.heading}>{trip.tripNumber}</Text>
            <Text style={styles.meta}>Đã lưu {new Date(savedAt).toLocaleString('vi-VN')} · {trip.stops.length} điểm dừng</Text>
          </Pressable>
          {openTrip === trip.id ? trip.stops.map((stop) => (
            <View key={stop.id} style={styles.stop}>
              <Text style={styles.heading}>{stop.sequence}. {driverStopTypeLabel(stop.stopType)}</Text>
              <Text style={styles.meta}>{stop.address} · {driverStopStatusLabel(stop.status)}</Text>
              {stop.tasks.map((task) => (
                <Text key={task.id} style={styles.meta}>
                  {driverTaskActionLabel(task.action)} · {task.package?.packageCode ?? task.order?.orderNumber ?? 'Kiện hàng'} · Kế hoạch {task.plannedQuantity}
                  {task.actualQuantity !== null ? ` · Đã xác nhận ${task.actualQuantity}` : ''}
                </Text>
              ))}
            </View>
          )) : null}
        </View>
      ))}
      <Text style={styles.heading}>Hàng đợi đồng bộ</Text>
      {!commands ? <Text style={styles.meta}>Không đọc được hàng đợi trên thiết bị.</Text> : !commands.length
        ? <Text style={styles.meta}>Không có thao tác chờ xử lý.</Text>
        : commands.map((command) => {
          const trip = snapshots?.find((entry) => entry.trip.id === command.tripId)?.trip;
          const stop = trip?.stops.find((entry) => entry.id === command.stopId);
          return (
            <Text key={command.id} style={styles.meta}>
              {tripNumbers.get(command.tripId) ?? `Chuyến ${command.tripId}`} · #{command.sequence} · {stop ? `Điểm ${stop.sequence} · ` : ''}
              {command.commandType === 'ARRIVE_STOP' ? 'Đến điểm' : 'Hoàn thành điểm'} · {labels[command.state]}
            </Text>
          );
        })}
    </>
  );
}

const { colors, spacing, type } = driverTheme;
const styles = StyleSheet.create({
  card: { padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: driverTheme.radius.control },
  heading: { ...type.strong, color: colors.text },
  meta: { ...type.meta, color: colors.textMuted },
  stop: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: spacing.sm },
  touch: { minHeight: driverTheme.touchTarget, justifyContent: 'center' },
});
