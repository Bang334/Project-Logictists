import { createContext, useCallback, useContext, useState, type PropsWithChildren } from 'react';
import { useNetInfo } from '@react-native-community/netinfo';
import { useOfflineDriverQueue } from '@/features/driver-offline/hooks/useOfflineDriverQueue';
import { useDriverTracking } from '@/features/driver-tracking/hooks/useDriverTracking';
import { useDriverTripDetail } from '../hooks/useDriverTripDetail';
import { useDriverTripExecution } from '../hooks/useDriverTripExecution';
import { createDriverPodUploadStore } from '../hooks/useDriverPod';

export type TripOverviewPanel = 'gps' | 'details';

function useTripWorkspaceState(tripId: string) {
  const detail = useDriverTripDetail(tripId);
  const tracking = useDriverTracking(tripId);
  const offlineQueue = useOfflineDriverQueue(tripId);
  const execution = useDriverTripExecution(detail.reload, tracking.lifecycle);
  const network = useNetInfo();
  const isOnline = network.isConnected === true && network.isInternetReachable !== false;
  const [panel, setPanel] = useState<TripOverviewPanel | null>(null);
  const [podRevision, setPodRevision] = useState(0);
  const [podUploadsInProgress, setPodUploadsInProgress] = useState(0);
  const [podUploadStore] = useState(createDriverPodUploadStore);
  const invalidatePodReadiness = useCallback(() => setPodRevision((revision) => revision + 1), []);
  const recordPodUploadActivity = useCallback((uploading: boolean) => {
    setPodUploadsInProgress((count) => count + (uploading ? 1 : -1));
    if (!uploading) invalidatePodReadiness();
  }, [invalidatePodReadiness]);
  return { ...detail, tripId, tracking, offlineQueue, execution, isOnline, panel, setPanel,
    podRevision, invalidatePodReadiness, podUploadStore, podUploadsInProgress, recordPodUploadActivity };
}

const WorkspaceContext = createContext<ReturnType<typeof useTripWorkspaceState> | null>(null);

export function DriverTripWorkspace({ tripId, children }: PropsWithChildren<{ tripId: string }>) {
  return (
    <WorkspaceContext.Provider value={useTripWorkspaceState(tripId)}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useDriverTripWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('DriverTripWorkspace is required for trip screens');
  return value;
}
