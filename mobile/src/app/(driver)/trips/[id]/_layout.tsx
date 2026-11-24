import { Stack, useLocalSearchParams } from 'expo-router';
import { DriverTripWorkspace } from '@/features/driver-trips/providers/DriverTripWorkspace';
import { useAuth } from '@/features/auth/hooks/useAuth';

export const unstable_settings = { anchor: 'index' };

export default function TripLayout() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { user } = useAuth();
  const tripId = typeof id === 'string' ? id : '';
  return (
    <DriverTripWorkspace key={`${user?.id ?? ''}:${tripId}`} tripId={tripId}>
      <Stack screenOptions={{ headerShown: false }} />
    </DriverTripWorkspace>
  );
}
