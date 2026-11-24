import { useLocalSearchParams } from 'expo-router';
import { DriverTripListScreen } from '@/features/driver-trips/screens/DriverTripListScreen';

export default function DriverTripsRoute() {
  const { status } = useLocalSearchParams<{ status?: string }>();
  const initialStatus = status === 'COMPLETED' || status === 'IN_PROGRESS' || status === 'DISPATCHED'
    ? status : 'ALL';
  return <DriverTripListScreen key={initialStatus} initialStatus={initialStatus} />;
}
