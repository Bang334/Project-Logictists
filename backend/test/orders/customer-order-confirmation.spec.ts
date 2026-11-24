import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { OrderStatus, OrderType, Role, StopType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CustomerOrderConfirmationService } from '../../src/orders/customer-order-confirmation.service';
import { validateCustomerOrderForConfirmation } from '../../src/orders/customer-order-confirmation.validation';
import { ConfirmCustomerOrderDto } from '../../src/orders/dto/confirm-customer-order.dto';
import { PrismaService } from '../../src/prisma/prisma.service';

const stop = {
  id: 'pickup', orderId: 'order', type: StopType.PICKUP, sequence: 1,
  address: 'Kho QA', latitude: 10, longitude: 106, contactName: 'QA',
  contactPhone: '0900123456', serviceDurationMinutes: 15, createdAt: new Date(),
};
const validOrder = () => ({
  id: 'order', orderNumber: 'QA-1', status: OrderStatus.DRAFT,
  orderType: OrderType.B2B_TRANSPORT, branchId: 'branch', version: 1,
  events: [{ id: 'origin' }], _count: { packages: 0 },
  stops: [stop, { ...stop, id: 'delivery', type: StopType.DELIVERY, sequence: 2 }],
  items: [{
    id: 'item', orderId: 'order', skuId: null, sku: null, description: 'Kiện QA',
    packageType: 'CARTON', quantity: 2, weightKg: 4, lengthCm: 50, widthCm: 20,
    heightCm: 10, volumeM3: 0.02, createdAt: new Date(),
  }],
  totalPackages: 2, totalWeightKg: 4, totalVolumeM3: 0.02,
});

describe('M2.3 validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const metadata: ArgumentMetadata = { type: 'body', metatype: ConfirmCustomerOrderDto };

  it('accepts a positive JSON integer and a UUID', async () => {
    const body = { expectedVersion: 1, idempotencyKey: randomUUID() };
    await expect(pipe.transform(body, metadata)).resolves.toEqual(body);
  });

  it.each(['1', 0, 1.5, -1, 2_147_483_648, null, undefined])(
    'rejects invalid version %p',
    async (expectedVersion) => {
      await expect(pipe.transform({ expectedVersion, idempotencyKey: randomUUID() }, metadata))
        .rejects.toMatchObject({ status: 400 });
    },
  );

  it('rejects invalid key and fields outside the DTO', async () => {
    await expect(pipe.transform({ expectedVersion: 1, idempotencyKey: 'wrong' }, metadata))
      .rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ expectedVersion: 1, idempotencyKey: randomUUID(), status: 'CONFIRMED' }, metadata))
      .rejects.toMatchObject({ status: 400 });
  });

  it('accepts Customer Order data using line weight and cubic meters', () => {
    expect(() => validateCustomerOrderForConfirmation(validOrder())).not.toThrow();
  });

  it.each<(draft: ReturnType<typeof validOrder>) => void>([
    (draft) => { draft.stops.reverse(); },
    (draft) => { draft.stops[1] = { ...draft.stops[1], latitude: Infinity }; },
    (draft) => { draft.stops[1] = { ...draft.stops[1], contactPhone: '123' }; },
    (draft) => { draft.items[0].quantity = 501; },
    (draft) => { draft.items[0].weightKg = 2000.01; },
    (draft) => { draft.items[0].lengthCm = 0.04; },
    (draft) => { draft.items[0].weightKg = 0.0001; },
    (draft) => { draft.items[0].volumeM3 = 0.01; },
    (draft) => { draft.totalPackages = 1; },
    (draft) => { draft.totalVolumeM3 = NaN; },
  ])('rejects an invalid persisted Customer Order (%#)', (change) => {
    const draft = validOrder();
    change(draft);
    expect(() => validateCustomerOrderForConfirmation(draft)).toThrow(
      expect.objectContaining({ status: 422, response: expect.objectContaining({ errorCode: 'ORDER_VALIDATION_FAILED' }) }),
    );
  });
});

describe('M2.3 confirmation service', () => {
  function setup() {
    const occurredAt = new Date('2026-11-22T08:30:00Z');
    const tx = {
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: 'order' }]).mockResolvedValueOnce([{ active: true }]),
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(validOrder()), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedCommand: { findUnique: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'command' }), update: jest.fn() },
      orderEvent: { create: jest.fn().mockResolvedValue({ occurredAt }) },
    };
    const prisma = { $transaction: jest.fn((run: (transaction: typeof tx) => unknown) => run(tx)) };
    const service = new CustomerOrderConfirmationService(prisma as unknown as PrismaService);
    const actor = { id: 'actor', role: Role.DISPATCHER, branchId: 'branch' };
    const dto = { expectedVersion: 1, idempotencyKey: randomUUID() };
    return { tx, prisma, service, actor, dto, occurredAt };
  }

  it('rejects unrelated roles and out-of-branch access before replay', async () => {
    const { tx, prisma, service, actor, dto } = setup();
    expect(() => service.confirm('order', dto, { ...actor, role: Role.CUSTOMER })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(service.confirm('order', dto, { ...actor, branchId: 'other' })).rejects.toMatchObject({ status: 403 });
    expect(tx.processedCommand.findUnique).not.toHaveBeenCalled();
  });

  it('uses DRAFT and version in CAS and records a stable receipt with audit timestamp', async () => {
    const { tx, service, actor, dto, occurredAt } = setup();
    const receipt = await service.confirm('order', dto, actor);
    expect(receipt).toEqual({
      orderId: 'order', orderNumber: 'QA-1', status: 'CONFIRMED', version: 2,
      confirmedAt: occurredAt.toISOString(),
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order', status: 'DRAFT', version: 1 },
      data: { status: 'CONFIRMED', version: { increment: 1 } },
    });
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ commandId: 'command', actorUserId: actor.id, fromStatus: 'DRAFT', toStatus: 'CONFIRMED' }),
    }));
    expect(tx.processedCommand.update).toHaveBeenCalledWith({ where: { id: 'command' }, data: { status: 'COMPLETED', result: receipt } });

    const { tx: retryTx, service: retryService } = setup();
    retryTx.order.findUniqueOrThrow.mockResolvedValue({ ...validOrder(), status: OrderStatus.ASSIGNED });
    retryTx.processedCommand.findUnique.mockResolvedValue({
      requestHash: tx.processedCommand.create.mock.calls[0][0].data.requestHash,
      status: 'COMPLETED', result: receipt,
    });
    await expect(retryService.confirm('order', dto, actor)).resolves.toEqual(receipt);
    await expect(retryService.confirm('order', { ...dto, expectedVersion: 2 }, actor))
      .rejects.toMatchObject({ status: 409, response: { errorCode: 'ORDER_CONFIRM_IDEMPOTENCY_CONFLICT' } });
    expect(retryTx.order.updateMany).not.toHaveBeenCalled();
    expect(retryTx.orderEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: OrderStatus.ASSIGNED }, 'ORDER_STATE_CONFLICT'],
    [{ version: 2 }, 'ORDER_VERSION_CONFLICT'],
    [{ events: [] }, 'ORDER_NOT_CONFIRMABLE'],
  ])('rejects invalid state/source/version (%#)', async (change, errorCode) => {
    const { tx, service, actor, dto } = setup();
    tx.order.findUniqueOrThrow.mockResolvedValue({ ...validOrder(), ...change });
    await expect(service.confirm('order', dto, actor))
      .rejects.toMatchObject({ status: 409, response: { errorCode } });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});
