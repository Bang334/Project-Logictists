import * as SecureStore from 'expo-secure-store';

const ACCESS_TOKEN_KEY = 'smart_tms_access_token';

export const tokenStorage = {
  get(): Promise<string | null> {
    return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  },

  set(token: string): Promise<void> {
    return SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  clear(): Promise<void> {
    return SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  },
};
