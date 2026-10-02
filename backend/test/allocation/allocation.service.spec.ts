import { Test } from '@nestjs/testing';
import { AllocationService } from '../../src/allocation/allocation.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { AuditLogService } from '../../src/common/services/audit-log.service';
import { OutboxService } from '../../src/common/services/outbox.service';
import { InventoryService } from '../../src/inventory/inventory.service';

describe('AllocationService', () => {
  it('tính khoảng cách Haversine hợp lệ', async () => {
    const module = await Test.createTestingModule({ providers: [AllocationService, ...[PrismaService, IdempotencyService, AuditLogService, OutboxService, InventoryService].map((provide) => ({ provide, useValue: {} }))] }).compile();
    const service = module.get(AllocationService);
    expect(service.calculateHaversineDistance(21.0285, 105.8542, 21.0345, 105.9082)).toBeGreaterThan(5);
  });
});
