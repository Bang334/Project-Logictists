import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';

const statuses = ['AVAILABLE', 'ON_DUTY', 'ON_LEAVE', 'RESTING'] as const;

export interface DriverSelfProfile {
  id: string;
  fullName: string;
  operationalPhone: string | null;
  status: (typeof statuses)[number];
  homeBranch: { id: string; code: string; name: string; timezone: string | null };
  license: { category: string; validUntil: string; verificationStatus: string } | null;
}

function invalidProfile(): never {
  throw new ApiError('Máy chủ trả về hồ sơ tài xế không đúng định dạng.', 0, 'INVALID_RESPONSE');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return invalidProfile();
  return value as Record<string, unknown>;
}

function readString(value: unknown): string {
  if (typeof value !== 'string') return invalidProfile();
  return value;
}

export const driverProfileService = {
  async getProfile(): Promise<DriverSelfProfile> {
    const token = await tokenStorage.get();
    if (!token) throw new ApiError('Phiên đăng nhập không còn tồn tại.', 401, 'HTTP_401');
    const profile = record(await apiClient.request('/driver/me', { token }));
    const branch = record(profile.homeBranch);
    const license = profile.license === null ? null : record(profile.license);
    const status = statuses.find((candidate) => candidate === profile.status);
    if (!status) return invalidProfile();

    return {
      id: readString(profile.id),
      fullName: readString(profile.fullName),
      operationalPhone: profile.operationalPhone === null ? null : readString(profile.operationalPhone),
      status,
      homeBranch: {
        id: readString(branch.id),
        code: readString(branch.code),
        name: readString(branch.name),
        timezone: typeof branch.timezone === 'string' ? branch.timezone : null,
      },
      license: license && {
        category: readString(license.category),
        validUntil: readString(license.validUntil),
        verificationStatus: readString(license.verificationStatus),
      },
    };
  },
};
