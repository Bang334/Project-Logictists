import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { deviceCodeStorage } from './device-code.storage';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

describe('M3.6C deviceCode storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(SecureStore.setItemAsync).mockResolvedValue();
    jest.mocked(Crypto.randomUUID).mockReturnValue(
      '123e4567-e89b-42d3-a456-426614174000',
    );
  });

  it('tạo UUID một lần và persist bằng SecureStore', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await expect(deviceCodeStorage.getOrCreate()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'smart_tms_gps_installation_uuid',
      '123e4567-e89b-42d3-a456-426614174000',
      expect.any(Object),
    );
  });

  it('app restart tái sử dụng installation UUID đã lưu', async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue(
      '123e4567-e89b-42d3-a456-426614174111',
    );
    await expect(deviceCodeStorage.getOrCreate()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174111',
    );
    expect(Crypto.randomUUID).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
