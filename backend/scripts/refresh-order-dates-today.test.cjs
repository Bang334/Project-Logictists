const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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
        type: 'PICKUP',
        windowStart: new Date('2026-10-11T00:00:00.000Z'),
        windowEnd: new Date('2026-10-14T11:00:00.000Z'),
      },
      {
        id: 'delivery-1',
        type: 'DELIVERY',
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
    assert.match(getDemoOrderSkipReason(demoOrder({ deliveryAppointments: [{ id: 'appointment-1' }] })), /đã có lịch hẹn giao/);
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
      new Date('2026-10-15T08:01:30.565Z'),
    );

    assert.equal(summary.shiftDays, 6);
    assert.equal(orderUpdates.length, 1);
    const filter = orderUpdates[0].where;
    assert.equal(filter.id, 'order-1');
    assert.equal(filter.status, 'CONFIRMED');
    assert.equal(filter.version, 4);
    assert.deepEqual(filter.orderedAt, order.orderedAt);
    assert.deepEqual(filter.deliveryAppointments, { none: {} });
    assert.deepEqual(filter.items.none.OR[0], { allocations: { some: {} } });
    assert.equal(
      orderUpdates[0].data.orderedAt.toISOString(),
      '2026-10-15T07:12:56.014Z',
    );
    assert.deepEqual(orderUpdates[0].data.version, { increment: 1 });
    assert.equal(stopUpdates.length, 2);
    assert.equal(
      stopUpdates[1].data.windowEnd.toISOString(),
      '2026-10-20T16:00:00.000Z',
    );
  });

  it('hook dev bỏ qua production hoặc DB từ xa chưa được cấp quyền', () => {
    const script = path.join(__dirname, 'refresh-order-dates-today.cjs');
    const database = 'postgresql://test:test@unreachable.invalid:5432/demo';
    for (const [environment, reason] of [['production', /production/], ['development', /ALLOW_TEST_DATA_MUTATION/]]) {
      const result = spawnSync(process.execPath, [script, '--startup'], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, NODE_ENV: environment, DATABASE_URL: database, ALLOW_TEST_DATA_MUTATION: 'false' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BỎ QUA DỜI LỊCH DEMO/);
      assert.match(result.stdout, reason);
    }
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
        new Date('2026-10-15T08:01:30.565Z'),
      ),
      /rollback/i,
    );
  });

  it('khởi động lại cùng ngày không ghi database hoặc tăng version', async () => {
    const order = demoOrder();
    const prisma = {
      order: { findMany: async () => [order] },
      $transaction: async () => assert.fail('Không được ghi khi lịch chưa cũ'),
    };
    const summary = await refreshDemoSchedules(
      prisma,
      new Date('2026-10-09T12:00:00.000Z'),
    );
    assert.equal(summary.shiftDays, 0);
    assert.equal(order.version, 4);
  });

  it('startup không kéo lịch tương lai lùi về hôm nay', async () => {
    const prisma = {
      order: { findMany: async () => [demoOrder()] },
      $transaction: async () => assert.fail('Không được ghi lùi lịch'),
    };
    const summary = await refreshDemoSchedules(
      prisma,
      new Date('2026-10-08T08:00:00.000Z'),
    );
    assert.equal(summary.shiftDays, 0);
  });

  it('startup dời lịch cũ rồi chạy lại cùng ngày không ghi thêm', async () => {
    const order = demoOrder();
    let transactions = 0;
    const prisma = {
      order: { findMany: async () => [order] },
      $transaction: async (callback) => {
        transactions += 1;
        return callback({
          order: { updateMany: async ({ data }) => {
            order.orderedAt = data.orderedAt;
            order.version += 1;
            return { count: 1 };
          } },
          orderStop: { updateMany: async ({ where, data }) => {
            Object.assign(order.stops.find((stop) => stop.id === where.id), data);
            return { count: 1 };
          } },
        });
      },
    };
    const now = new Date('2026-10-15T08:00:00.000Z');
    const first = await refreshDemoSchedules(prisma, now);
    const second = await refreshDemoSchedules(prisma, now);
    assert.equal(first.shiftDays, 6);
    assert.equal(second.shiftDays, 0);
    assert.equal(transactions, 1);
    assert.equal(order.version, 5);
    assert.equal(order.stops[1].windowEnd.toISOString(), '2026-10-20T16:00:00.000Z');
  });

  it('đơn tạo từ lâu nhưng chưa hết hạn giao giữ nguyên, kể cả khi có đơn khác quá hạn', async () => {
    const expired = demoOrder();
    const valid = demoOrder({ id: 'order-2', orderNumber: 'VALID',
      stops: demoOrder().stops.map((stop) => ({ ...stop,
        windowStart: new Date('2026-10-15T09:00:00Z'),
        windowEnd: new Date('2026-10-16T09:00:00Z'),
      })),
    });
    const updates = [];
    const prisma = {
      order: { findMany: async () => [expired, valid] },
      $transaction: async (callback) => callback({
        order: { updateMany: async (args) => { updates.push(args.where.id); return { count: 1 }; } },
        orderStop: { updateMany: async () => ({ count: 1 }) },
      }),
    };
    const summary = await refreshDemoSchedules(prisma, new Date('2026-10-15T08:00:00Z'));
    assert.deepEqual(updates, ['order-1']);
    assert.equal(summary.eligibleOrderCount, 1);
    assert.equal(valid.version, 4);
    assert.equal(valid.orderedAt.toISOString(), '2026-10-09T07:12:56.014Z');
  });

  it('đúng hạn giao cuối chưa bị coi là quá hạn; sau 1ms mới dời', async () => {
    const prisma = {
      order: { findMany: async () => [demoOrder()] },
      $transaction: async () => assert.fail('dry-run không được ghi'),
    };
    const atDeadline = await refreshDemoSchedules(prisma, new Date('2026-10-14T16:00:00Z'), { dryRun: true });
    const expired = await refreshDemoSchedules(prisma, new Date('2026-10-14T16:00:00.001Z'), { dryRun: true });
    assert.equal(atDeadline.eligibleOrderCount, 0);
    assert.equal(expired.eligibleOrderCount, 1);
  });

  it('đơn hết hạn sớm trong cùng ngày vẫn được dời tới hạn tương lai', async () => {
    const order = demoOrder({ orderedAt: new Date('2026-10-14T06:00:00Z') });
    const prisma = { order: { findMany: async () => [order] } };
    const summary = await refreshDemoSchedules(prisma, new Date('2026-10-14T17:00:00Z'), { dryRun: true });
    assert.equal(summary.shiftDays, 1);
    assert.equal(summary.latestShiftedWindow, '2026-10-15T16:00:00.000Z');
  });

  it('nhiều điểm giao chỉ quá hạn khi hạn giao cuối cùng đã qua', async () => {
    const order = demoOrder();
    order.stops.push({ ...order.stops[1], id: 'delivery-2', windowEnd: new Date('2026-10-18T16:00:00Z') });
    const summary = await refreshDemoSchedules(
      { order: { findMany: async () => [order] } },
      new Date('2026-10-15T08:00:00Z'), { dryRun: true },
    );
    assert.equal(summary.eligibleOrderCount, 0);
  });

  it('mỗi đơn quá hạn được tính độ dời riêng, không phụ thuộc ngày tạo của đơn khác', async () => {
    const orders = [demoOrder(), demoOrder({ id: 'order-2', orderNumber: 'LATER',
      orderedAt: new Date('2026-10-13T07:12:56.014Z'),
    })];
    const summary = await refreshDemoSchedules(
      { order: { findMany: async () => orders } },
      new Date('2026-10-15T08:00:00Z'), { dryRun: true },
    );
    assert.equal(summary.shiftDays, null);
    assert.deepEqual(summary.shifts.map((shift) => shift.shiftDays), [6, 2]);
  });
});
