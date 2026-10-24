const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildScheduleShift,
  computeCalendarDayShiftMilliseconds,
  getDemoOrderSkipReason,
  refreshDemoSchedules,
} = require('./refresh-order-dates-today.cjs');

function demoOrder(overrides = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORD-DEMO-001',
    status: 'CONFIRMED',
    version: 4,
    orderedAt: new Date('2026-10-09T07:12:56.014Z'),
    stops: [
      {
        id: 'pickup-1',
        windowStart: new Date('2026-10-11T00:00:00.000Z'),
        windowEnd: new Date('2026-10-14T11:00:00.000Z'),
      },
      {
        id: 'delivery-1',
        windowStart: new Date('2026-10-11T02:00:00.000Z'),
        windowEnd: new Date('2026-10-14T16:00:00.000Z'),
      },
    ],
    items: [
      {
        allocations: [],
        packages: [
          {
            status: 'READY',
            measurementSource: 'SEED_DEMO',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('refresh-order-dates-today', () => {
  it('dịch orderedAt và mọi cửa sổ theo cùng độ lệch mà không đổi thời lượng', () => {
    const order = demoOrder();
    const target = new Date('2026-10-12T07:12:56.014Z');

    const plan = buildScheduleShift(order, target);

    assert.equal(plan.shiftMilliseconds, 3 * 24 * 60 * 60 * 1000);
    assert.equal(plan.orderedAt.toISOString(), target.toISOString());
    assert.deepEqual(
      plan.stops.map((stop) => ({
        id: stop.id,
        start: stop.windowStart.toISOString(),
        end: stop.windowEnd.toISOString(),
      })),
      [
        {
          id: 'pickup-1',
          start: '2026-10-14T00:00:00.000Z',
          end: '2026-10-17T11:00:00.000Z',
        },
        {
          id: 'delivery-1',
          start: '2026-10-14T02:00:00.000Z',
          end: '2026-10-17T16:00:00.000Z',
        },
      ],
    );
    assert.equal(order.stops[0].windowStart.toISOString(), '2026-10-11T00:00:00.000Z');
  });

  it('tính độ lệch theo ngày lịch để không làm trôi giờ demo', () => {
    const source = new Date('2026-10-09T07:12:56.014Z');
    const now = new Date('2026-10-12T08:01:30.565Z');

    assert.equal(
      computeCalendarDayShiftMilliseconds(source, now, 'Asia/Ho_Chi_Minh'),
      3 * 24 * 60 * 60 * 1000,
    );
  });

  it('chỉ nhận đơn seed demo chưa phân công và có cửa sổ đầy đủ', () => {
    assert.equal(getDemoOrderSkipReason(demoOrder()), null);
    assert.match(
      getDemoOrderSkipReason(
        demoOrder({
          items: [{ allocations: [{}], packages: [{ status: 'READY', measurementSource: 'SEED_DEMO' }] }],
        }),
      ),
      /phân công/i,
    );
    assert.match(
      getDemoOrderSkipReason(
        demoOrder({
          items: [{ allocations: [], packages: [{ status: 'READY', measurementSource: 'MANUAL' }] }],
        }),
      ),
      /seed demo/i,
    );
    assert.match(
      getDemoOrderSkipReason(
        demoOrder({
          stops: [{ id: 'delivery-1', windowStart: new Date(), windowEnd: null }],
        }),
      ),
      /khung giờ/i,
    );
  });

  it('ghi Order và OrderStop trong một transaction với khóa version', async () => {
    const order = demoOrder();
    const orderUpdates = [];
    const stopUpdates = [];
    const tx = {
      order: {
        updateMany: async (args) => {
          orderUpdates.push(args);
          return { count: 1 };
        },
      },
      orderStop: {
        updateMany: async (args) => {
          stopUpdates.push(args);
          return { count: 1 };
        },
      },
    };
    const prisma = {
      order: { findMany: async () => [order] },
      $transaction: async (callback) => callback(tx),
    };

    const summary = await refreshDemoSchedules(
      prisma,
      new Date('2026-10-12T08:01:30.565Z'),
    );

    assert.equal(summary.shiftDays, 3);
    assert.equal(orderUpdates.length, 1);
    assert.deepEqual(orderUpdates[0].where, {
      id: 'order-1',
      status: 'CONFIRMED',
      version: 4,
    });
    assert.equal(
      orderUpdates[0].data.orderedAt.toISOString(),
      '2026-10-12T07:12:56.014Z',
    );
    assert.deepEqual(orderUpdates[0].data.version, { increment: 1 });
    assert.equal(stopUpdates.length, 2);
    assert.equal(
      stopUpdates[1].data.windowEnd.toISOString(),
      '2026-10-17T16:00:00.000Z',
    );
  });

  it('dừng và báo rollback khi version của đơn đã thay đổi', async () => {
    const prisma = {
      order: { findMany: async () => [demoOrder()] },
      $transaction: async (callback) => callback({
        order: { updateMany: async () => ({ count: 0 }) },
        orderStop: { updateMany: async () => ({ count: 1 }) },
      }),
    };

    await assert.rejects(
      refreshDemoSchedules(
        prisma,
        new Date('2026-10-12T08:01:30.565Z'),
      ),
      /rollback/i,
    );
  });
});
