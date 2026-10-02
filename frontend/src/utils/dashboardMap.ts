import type { MapMarker } from '../components/MapboxMap';
import type { Branch, Location } from '../types';

const hasValidCoordinates = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

const markerTypeByLocation: Record<Location['type'], MapMarker['type']> = {
  CENTRAL_WAREHOUSE: 'WAREHOUSE',
  PICKUP_POINT: 'PICKUP_POINT',
  STORE: 'STORE',
};

export const buildNetworkMarkers = (
  branches: Branch[],
  locations: Location[],
): MapMarker[] => {
  const branchMarkers: MapMarker[] = branches
    .filter((branch) => hasValidCoordinates(branch.latitude, branch.longitude))
    .map((branch) => ({
      id: `branch:${branch.id}`,
      latitude: branch.latitude,
      longitude: branch.longitude,
      title: branch.name,
      subtitle: `Chi nhánh vận tải · ${branch.address}`,
      type: 'DEPOT',
    }));

  const locationMarkers: MapMarker[] = locations
    .filter((location) => hasValidCoordinates(location.latitude, location.longitude))
    .map((location) => ({
      id: `location:${location.id}`,
      latitude: location.latitude,
      longitude: location.longitude,
      title: location.name,
      subtitle: `${location.code} · ${location.address}`,
      type: markerTypeByLocation[location.type],
    }));

  return [...branchMarkers, ...locationMarkers];
};
