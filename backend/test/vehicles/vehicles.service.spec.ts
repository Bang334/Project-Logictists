import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Principal } from '../../src/auth/access';
import { VehiclesService } from '../../src/vehicles/vehicles.service';

describe('VehiclesService vehicle types', () => {
  const prisma = {
    vehicle: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    vehicleType: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    location: { findUnique: jest.fn() },
  };
  const admin: Principal = {
    id: 'user-1',
    username: 'admin',
    fullName: 'Admin',
    sessionId: 'session-1',
    grants: [
      {
        role: 'ADMIN',
        scopeType: 'COMPANY',
        branchId: null,
        permissions: ['vehicles.read', 'vehicles.manage'],
      },
    ],
  };
  let service: VehiclesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VehiclesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(VehiclesService);
  });

  it('returns the type as the source of the backward-compatible flat capability fields', async () => {
    prisma.vehicle.findMany.mockResolvedValue([
      {
        id: 'vehicle-1',
        plateNumber: '51A-000.01',
        vehicleTypeId: 'type-1',
        payloadCapacityKg: 999,
        vehicleTypeRecord: {
          id: 'type-1',
          name: 'Xe 2 tấn',
          payloadCapacityKg: 2000,
          volumeCapacityM3: 12,
          lengthCm: 420,
          widthCm: 200,
          heightCm: 210,
          fuelConsumptionLitersPer100Km: 12,
          loadFuelSurchargePercentAtFullPayload: 15,
          fixedOperatingCostPerTrip: 100000,
        },
      },
    ]);

    const [vehicle] = await service.findAll(admin);

    expect(vehicle).toMatchObject({
      vehicleTypeId: 'type-1',
      vehicleType: 'Xe 2 tấn',
      payloadCapacityKg: 2000,
      volumeCapacityM3: 12,
      lengthCm: 420,
    });
  });

  it('lists only active types in stable capacity/name order', async () => {
    prisma.vehicleType.findMany.mockResolvedValue([]);

    await service.findTypes();

    expect(prisma.vehicleType.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: [{ payloadCapacityKg: 'asc' }, { name: 'asc' }],
    });
  });

  it('rejects changing a vehicle to an inactive or missing type', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({
      id: 'vehicle-1',
      homeBranchId: 'branch-1',
      homeDepotLocationId: null,
    });
    prisma.vehicleType.findFirst.mockResolvedValue(null);

    await expect(
      service.update('vehicle-1', { vehicleTypeId: 'type-disabled' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });
});
