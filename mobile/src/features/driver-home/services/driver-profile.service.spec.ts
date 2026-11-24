import { apiClient } from '@/shared/api/api-client';
import { tokenStorage } from '@/shared/storage/token-storage';
import { driverProfileService } from './driver-profile.service';

jest.mock('@/shared/api/api-client', () => ({ apiClient: { request: jest.fn() } }));
jest.mock('@/shared/storage/token-storage', () => ({ tokenStorage: { get: jest.fn() } }));

const profile = {
  id: 'driver-1', fullName: 'Driver QA', operationalPhone: null, status: 'AVAILABLE',
  homeBranch: { id: 'branch-1', code: 'QA', name: 'Kho QA', timezone: 'Asia/Ho_Chi_Minh' },
  license: null,
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(tokenStorage.get).mockResolvedValue('test-token');
});

it('reads only the current profile and retains the public fields', async () => {
  jest.mocked(apiClient.request).mockResolvedValue({ ...profile, licenseNumber: 'internal' });
  await expect(driverProfileService.getProfile()).resolves.toEqual(profile);
  expect(apiClient.request).toHaveBeenCalledWith('/driver/me', { token: 'test-token' });
});

it('refuses an absent token before sending a request', async () => {
  jest.mocked(tokenStorage.get).mockResolvedValue(null);
  await expect(driverProfileService.getProfile()).rejects.toMatchObject({ status: 401 });
  expect(apiClient.request).not.toHaveBeenCalled();
});

it('leaves an unavailable branch timezone for the schedule fallback', async () => {
  jest.mocked(apiClient.request).mockResolvedValue({ ...profile, homeBranch: { ...profile.homeBranch, timezone: undefined } });
  await expect(driverProfileService.getProfile()).resolves.toMatchObject({ homeBranch: { timezone: null } });
});

it('rejects an incomplete profile instead of displaying verification data', async () => {
  jest.mocked(apiClient.request).mockResolvedValue({ ...profile, license: { category: 'C' } });
  await expect(driverProfileService.getProfile()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
