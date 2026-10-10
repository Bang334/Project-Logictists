import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Api, apiUrl } from "./api";
import { DriverStore } from "./store";
const key = "tms.driver.access-token";
export function createStore() {
  return new DriverStore(
    new Api(apiUrl(process.env.EXPO_PUBLIC_API_URL)),
    {
      read: () => SecureStore.getItemAsync(key),
      write: (token) =>
        SecureStore.setItemAsync(key, token, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      clear: () => SecureStore.deleteItemAsync(key),
    },
    () => Crypto.randomUUID(),
  );
}
