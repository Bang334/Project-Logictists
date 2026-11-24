import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useAuth } from "@/features/auth/hooks/useAuth";
import { offlineDriverExecutionCoordinator } from "@/features/driver-offline/services/offline-driver-execution.coordinator";

export function OfflineDriverExecutionLifecycle() {
  const { status, user, logout } = useAuth();
  const wasConnected = useRef<boolean | null>(null);

  useEffect(() => {
    if (status !== "authenticated" || user?.role !== "DRIVER") {
      offlineDriverExecutionCoordinator.deactivate();
      return;
    }
    const ownerUserId = user.id;
    void offlineDriverExecutionCoordinator.activate(ownerUserId, logout).catch(() => undefined);
    const appStateSubscription = AppState.addEventListener(
      "change",
      (state) => {
        if (state === "active") {
          void offlineDriverExecutionCoordinator.sync(ownerUserId);
        }
      },
    );
    const networkSubscription = NetInfo.addEventListener((network) => {
      const isConnected =
        network.isConnected === true && network.isInternetReachable !== false;
      if (isConnected && wasConnected.current === false) {
        void offlineDriverExecutionCoordinator.sync(ownerUserId);
      }
      wasConnected.current = isConnected;
    });
    return () => {
      appStateSubscription.remove();
      networkSubscription();
      offlineDriverExecutionCoordinator.deactivate();
    };
  }, [status, user?.id, user?.role, logout]);

  return null;
}
