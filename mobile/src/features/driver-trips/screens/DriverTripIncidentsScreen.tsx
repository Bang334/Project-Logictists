import { DriverIncidentPanel } from '@/features/driver-incidents/components/DriverIncidentPanel';
import { DriverTripSupportScreen } from '../components/DriverTripSupportScreen';
import { useDriverTripWorkspace } from '../providers/DriverTripWorkspace';

export function DriverTripIncidentsScreen() {
  const { reload, isOnline, error } = useDriverTripWorkspace();
  return (
    <DriverTripSupportScreen compact title="Sự cố chuyến">
      {(trip) => <DriverIncidentPanel key={trip.id} trip={trip} reloadTrip={reload} isOnline={isOnline && !error} />}
    </DriverTripSupportScreen>
  );
}
