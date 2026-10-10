import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Text, View } from "react-native";
import { Stack, usePathname, useRouter } from "expo-router";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DriverContext } from "../DriverContext";
import { createStore } from "../runtime";
import { DriverStore } from "../store";

function SessionNavigator({ store }: { store: DriverStore }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const router = useRouter(),
    path = usePathname();
  useEffect(() => {
    void store.restore();
    const listener = AppState.addEventListener("change", (next) => {
      if (next === "active") void store.restore();
    });
    return () => listener.remove();
  }, [store]);
  useEffect(() => {
    if (state.restoring) return;
    if ((!state.authenticated || !state.profile) && path !== "/")
      router.replace("/");
    if (state.authenticated && state.profile && path === "/")
      router.replace("/assignments");
  }, [path, router, state.authenticated, state.profile, state.restoring]);
  return (
    <DriverContext.Provider value={store}>
      <Stack screenOptions={{ headerShown: false, animation: "none" }} />
    </DriverContext.Provider>
  );
}
export default function RootLayout() {
  const [runtime] = useState(() => {
    try {
      return { store: createStore(), error: null };
    } catch (e) {
      return {
        store: null,
        error: e instanceof Error ? e.message : "Lỗi cấu hình",
      };
    }
  });
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#f1f5f9" }}>
        {runtime.store ? (
          <SessionNavigator store={runtime.store} />
        ) : (
          <View style={{ padding: 24 }}>
            <Text accessibilityRole="alert">{runtime.error}</Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
