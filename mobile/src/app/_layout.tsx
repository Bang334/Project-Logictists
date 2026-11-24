import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/features/auth/providers/AuthProvider";
import { useAuth } from "@/features/auth/hooks/useAuth";
import { FullScreenLoader } from "@/shared/components/FullScreenLoader";
import { DriverTrackingLifecycle } from "@/features/driver-tracking/components/DriverTrackingLifecycle";
import { OfflineDriverExecutionLifecycle } from "@/features/driver-offline/components/OfflineDriverExecutionLifecycle";
import "@/features/driver-tracking/tasks/driver-location.task";

export function RootNavigator() {
  const { status, user } = useAuth();

  if (status === "initializing") return <FullScreenLoader />;

  const isAuthenticated = status === "authenticated";
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === "anonymous"}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected
        guard={isAuthenticated && user?.role === "CUSTOMER"}
        redirectTo="/login"
      >
        <Stack.Screen name="(customer)" />
      </Stack.Protected>
      <Stack.Protected
        guard={isAuthenticated && user?.role === "DRIVER"}
        redirectTo="/login"
      >
        <Stack.Screen name="(driver)" />
      </Stack.Protected>
      <Stack.Protected
        guard={
          isAuthenticated &&
          user?.role !== "CUSTOMER" &&
          user?.role !== "DRIVER"
        }
        redirectTo="/login"
      >
        <Stack.Screen name="unsupported-role" />
      </Stack.Protected>
      <Stack.Protected
        guard={status === "session-error" || status === "offline-read-only"}
        redirectTo={status === "anonymous" ? "/login" : undefined}
      >
        <Stack.Screen name="session-error" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <DriverTrackingLifecycle />
      <OfflineDriverExecutionLifecycle />
      <StatusBar style="dark" />
      <RootNavigator />
    </AuthProvider>
  );
}
