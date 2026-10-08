import React, { useCallback } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { DriverApp } from "../../DriverApp";
import { useDriverStore } from "../../DriverContext";
export default function AssignmentsRoute() {
  const store = useDriverStore(),
    router = useRouter();
  useFocusEffect(
    useCallback(() => {
      store.back();
    }, [store]),
  );
  return (
    <DriverApp
      store={store}
      manageSession={false}
      onOpen={(id) =>
        router.push({ pathname: "/assignments/[id]", params: { id } })
      }
    />
  );
}
