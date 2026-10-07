import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PricingService } from '../../src/catalog/pricing.service';

describe('PricingService', () => {
  it('đọc giá trực tiếp từ SKU trong schema demo', async () => {
    const module = await Test.createTestingModule({ providers: [PricingService, { provide: PrismaService, useValue: { sku: { findUnique: jest.fn().mockResolvedValue({ id: 'sku', salePrice: new Prisma.Decimal(12000) }) } } }] }).compile();
    await expect(module.get(PricingService).resolveSkuPrice('sku')).resolves.toEqual(expect.objectContaining({ effectivePrice: 12000, priceListId: 'DEFAULT' }));
  });
});
