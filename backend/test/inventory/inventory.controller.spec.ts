import { Role } from '@prisma/client';
import { InventoryController } from '../../src/inventory/inventory.controller';
import { InventoryService } from '../../src/inventory/inventory.service';

describe('InventoryController', () => {
  it('allows an admin without a default location to query all balances', async () => {
    const queryStock = jest.fn().mockResolvedValue([{ id: 'balance-1' }]);
    const controller = new InventoryController({ queryStock } as unknown as InventoryService);

    const result = await controller.queryStock(
      {},
      {
        user: {
          id: 'admin-1',
          role: Role.ADMIN,
          branchId: 'branch-1',
          locationId: null,
        },
      },
    );

    expect(queryStock).toHaveBeenCalledWith({ locationId: undefined });
    expect(result).toEqual([{ id: 'balance-1' }]);
  });
});
