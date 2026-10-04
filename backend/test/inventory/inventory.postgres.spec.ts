import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { AuditLogService } from '../../src/common/services/audit-log.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('Inventory reservation concurrency (PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: InventoryService;
  const suffix = randomUUID();
  let locationId: string;
  let productId: string;
  let skuId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.RETAIL_RESERVATION_TTL_MINUTES = process.env.RETAIL_RESERVATION_TTL_MINUTES || '30';
    prisma = new PrismaService();
    await prisma.$connect();
    service = new InventoryService(
      prisma,
      undefined as unknown as IdempotencyService,
      undefined as unknown as AuditLogService,
    );

    const location = await prisma.location.create({
      data: {
        code: `IT-LOC-${suffix}`,
        name: 'Integration test location',
        address: 'Integration test only',
        latitude: 0,
        longitude: 0,
      },
    });
    locationId = location.id;
    const product = await prisma.product.create({
      data: { code: `IT-PROD-${suffix}`, name: 'Integration test product' },
    });
    productId = product.id;
    const sku = await prisma.sku.create({
      data: {
        productId,
        skuCode: `IT-SKU-${suffix}`,
        name: 'Integration test SKU',
      },
    });
    skuId = sku.id;
    await prisma.stockBalance.create({
      data: { locationId, skuId, onHand: 5, reserved: 0, safetyBuffer: 0 },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.inventoryReservation.deleteMany({ where: { skuId } });
    await prisma.stockBalance.deleteMany({ where: { skuId, locationId } });
    await prisma.sku.deleteMany({ where: { id: skuId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.$disconnect();
  });

  it('RT01: chỉ một trong hai transaction được giữ lượng tồn cuối cùng', async () => {
    const reserve = (key: string) =>
      prisma.$transaction((tx) =>
        service.reserveStockInTransaction(tx, {
          locationId,
          idempotencyKey: key,
          lines: [{ skuId, quantity: 4 }],
        }),
      );

    const outcomes = await Promise.allSettled([
      reserve(`rt01-a-${suffix}`),
      reserve(`rt01-b-${suffix}`),
    ]);

    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);

    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { skuId_locationId: { skuId, locationId } },
    });
    expect(balance.reserved).toBe(4);
    expect(balance.onHand - balance.reserved - balance.safetyBuffer).toBe(1);
    expect(
      await prisma.inventoryReservation.count({
        where: { skuId, locationId, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });
});
