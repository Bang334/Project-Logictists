import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { DriverIncidentCard } from '@/features/driver-incidents/components/DriverIncidentCard';
import { DriverIncidentForm } from '@/features/driver-incidents/components/DriverIncidentForm';
import { useCreateDriverIncident } from '@/features/driver-incidents/hooks/useCreateDriverIncident';
import { useDriverIncidents } from '@/features/driver-incidents/hooks/useDriverIncidents';
import { getTripIncidentOrderOptions } from '@/features/driver-incidents/validation/driver-incident.validation';
import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import { PrimaryButton } from '@/shared/components/PrimaryButton';
import { ScreenMessage } from '@/shared/components/ScreenMessage';
import { driverTheme } from '@/shared/theme/driver-theme';

const { colors, spacing } = driverTheme;

interface Props {
  trip: DriverTripDetail;
  reloadTrip(): Promise<void>;
  isOnline?: boolean;
}

export function DriverIncidentPanel({ trip, reloadTrip, isOnline = true }: Props) {
  const [showForm, setShowForm] = useState(false);
  const incidents = useDriverIncidents(trip.id);
  const create = useCreateDriverIncident(trip.id, incidents.reload, reloadTrip);
  const orders = useMemo(() => getTripIncidentOrderOptions(trip), [trip]);
  const canCreate =
    (trip.status === 'DISPATCHED' || trip.status === 'IN_PROGRESS') &&
    trip.assignment.status === 'ASSIGNED' &&
    trip.assignment.role === 'PRIMARY';

  return (
    <View style={styles.panel} testID="driver-incident-panel">
      <View style={styles.heading}>
        <Text style={styles.title}>{trip.tripNumber}</Text>
        <Text style={styles.count}>{incidents.items.length} sự cố đã tải</Text>
      </View>
      {canCreate ? (
        <PrimaryButton appearance="driver" label="Báo sự cố" disabled={!isOnline} onPress={() => setShowForm(true)} />
      ) : <Text style={styles.empty}>Chỉ xem sự cố của chuyến.</Text>}
      {showForm && canCreate ? (
        <DriverIncidentForm
          orders={orders}
          isSubmitting={create.isSubmitting}
          submitError={create.error}
          hasUncertainSubmission={create.hasUncertainSubmission}
          canSubmit={isOnline}
          onSubmit={(input) => isOnline ? create.submit(input) : Promise.resolve(false)}
          onClose={() => {
            create.clearError();
            setShowForm(false);
          }}
        />
      ) : null}

      {incidents.isLoading && incidents.items.length === 0 ? (
        <ActivityIndicator color={colors.primary} />
      ) : null}
      {incidents.error ? (
        <View style={styles.group}>
          <ScreenMessage message={incidents.error} />
          <PrimaryButton
            label="Thử tải lại sự cố"
            variant="secondary"
            onPress={() => void incidents.reload()}
          />
        </View>
      ) : null}
      {!incidents.isLoading &&
      !incidents.error &&
      incidents.items.length === 0 ? (
        <Text style={styles.empty}>
          Chưa có sự cố nào được báo cho chuyến này.
        </Text>
      ) : null}
      {incidents.items.map((incident) => (
        <DriverIncidentCard key={incident.id} incident={incident} />
      ))}
      {incidents.hasMore ? (
        <PrimaryButton
          label="Xem thêm"
          variant="secondary"
          loading={incidents.isLoadingMore}
          onPress={() => void incidents.loadMore()}
        />
      ) : null}
      {!incidents.isLoading && incidents.items.length > 0 ? (
        <PrimaryButton
          label="Làm mới sự cố"
          variant="secondary"
          onPress={() => void incidents.reload()}
        />
      ) : null}
      {!isOnline ? <ScreenMessage message="Cần kết nối mạng để gửi báo cáo sự cố." /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.sm,
  },
  heading: {
    padding: spacing.md, gap: spacing.xs, borderRadius: driverTheme.radius.card, backgroundColor: colors.infoSurface,
  },
  title: { ...driverTheme.type.strong, color: colors.text },
  count: { ...driverTheme.type.meta, color: colors.info },
  empty: { color: colors.textMuted, lineHeight: 20 },
  group: { gap: spacing.sm },
});
