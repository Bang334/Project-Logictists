import { useCallback, useSyncExternalStore } from "react";
import { useAuth } from "@/features/auth/hooks/useAuth";
import {
  offlineDriverExecutionCoordinator,
  summarizeOfflineCommands,
} from "@/features/driver-offline/services/offline-driver-execution.coordinator";

export function useOfflineDriverQueue(tripId?: string) {
  const { user } = useAuth();
  const ownerUserId = user?.id;
  const snapshot = useSyncExternalStore(
    offlineDriverExecutionCoordinator.subscribe,
    offlineDriverExecutionCoordinator.getSnapshot,
  );
  const commands =
    snapshot.ownerUserId === ownerUserId
      ? snapshot.commands.filter(
          (command) => tripId === undefined || command.tripId === tripId,
        )
      : [];
  const sync = useCallback(async () => {
    if (ownerUserId) {
      await offlineDriverExecutionCoordinator.sync(ownerUserId, true);
    }
  }, [ownerUserId]);
  return {
    commands,
    summary: summarizeOfflineCommands(commands),
    isSyncing: snapshot.isSyncing,
    lastSyncAt: snapshot.lastSyncAt,
    sync,
  };
}
