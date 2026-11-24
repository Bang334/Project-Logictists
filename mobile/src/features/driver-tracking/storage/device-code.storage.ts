import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DEVICE_CODE_KEY = 'smart_tms_gps_installation_uuid';

export const deviceCodeStorage = {
  async getOrCreate(): Promise<string> {
    const existing = await SecureStore.getItemAsync(DEVICE_CODE_KEY);
    if (existing) return existing;
    const deviceCode = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_CODE_KEY, deviceCode, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return deviceCode;
  },
};
