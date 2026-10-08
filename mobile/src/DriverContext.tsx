import { createContext, useContext } from "react";
import { DriverStore } from "./store";
export const DriverContext = createContext<DriverStore | null>(null);
export function useDriverStore() {
  const store = useContext(DriverContext);
  if (!store) throw new Error("Driver session provider is missing");
  return store;
}
