import React, { useEffect, useSyncExternalStore } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { DriverApp } from "../../DriverApp";
import { useDriverStore } from "../../DriverContext";
export default function AssignmentRoute() {
  const store = useDriverStore(),
    router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    if (state.profile && !state.restoring) void store.open(id);
  }, [id, store, state.profile, state.restoring]);
  return (
    <DriverApp
      store={store}
      manageSession={false}
      onBack={() => {
        store.back();
        router.replace("/assignments");
      }}
      onOpen={(next) =>
        router.replace({ pathname: "/assignments/[id]", params: { id: next } })
      }
    />
  );
}
