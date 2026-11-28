import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthRequest } from '../../src/auth/access';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TransportSettingsController } from '../../src/settings/transport-settings.controller';
import { resolveVietnamDrivingRestPolicy } from '../../src/trips/interprovincial-policy';

const admin = { user: {
  role: Role.ADMIN,
  grants: [{ role: Role.ADMIN, scopeType: 'COMPANY', branchId: null, permissions: ['settings.manage'] }],
} } as AuthRequest;

const policyInput = {
  code: 'vn-test', revision: 1, effectiveFrom: '2026-11-27', effectiveTo: '2026-11-28',
  limits: {
    enabled: true,
    maxContinuousDrivingSec: 14_400,
    shortRestDurationSec: 900,
    maxDailyDrivingSec: 36_000,
    dailyRestDurationSec: 28_800,
    maxWeeklyDrivingSec: 172_800,
    minInterTripRestSec: 3_600,
    overnightAllowanceVnd: 200_000,
    restAllowanceDuringService: false,
  },
};

describe('TransportSettingsController', () => {
  const createPolicy = jest.fn(async ({ data }) => data);
  const createToll = jest.fn(async ({ data }) => data);
  const transport = new TransportSettingsController({
    workPolicy: { create: createPolicy },
    tollCorridor: { create: createToll },
  } as unknown as PrismaService);

  it('applies the work policy through the last calendar date in Vietnam', async () => {
    const policy = await transport.createWorkPolicy(admin, policyInput);
    expect(resolveVietnamDrivingRestPolicy([policy], new Date('2026-11-28T16:30:00Z')))
      .toMatchObject({ policy_code: 'VN-TEST', min_inter_trip_rest_sec: 3600 });
    expect(resolveVietnamDrivingRestPolicy([policy], new Date('2026-11-28T17:00:00Z')).policy_code)
      .not.toBe('VN-TEST');
  });

  it('rejects corrupted driving limits and inverted effective dates', () => {
    expect(() => transport.createWorkPolicy(admin, {
      ...policyInput, limits: { ...policyInput.limits, maxDailyDrivingSec: 1000 },
    })).toThrow(BadRequestException);
    expect(() => transport.createWorkPolicy(admin, { ...policyInput, effectiveTo: '2026-11-26' }))
      .toThrow(BadRequestException);
  });

  it('writes directional normalized tolls only for administrators', async () => {
    const corridor = { fromProvinceCode: '79', toProvinceCode: 'dn', active: true, baseTollVnd: 25000 };
    expect(() => transport.createTollCorridor({ user: { grants: [] } } as unknown as AuthRequest, corridor))
      .toThrow(ForbiddenException);
    await expect(transport.createTollCorridor(admin, corridor))
      .resolves.toMatchObject({ fromProvinceCode: '79', toProvinceCode: 'DN', baseTollVnd: 25000 });
    expect(() => transport.createTollCorridor(admin, { ...corridor, fromProvinceCode: 'DN' }))
      .toThrow(BadRequestException);
  });
});
