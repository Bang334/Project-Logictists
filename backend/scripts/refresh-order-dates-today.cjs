const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  quiet: true,
});

const CONFIRM_FLAG = '--confirm';
const DRY_RUN_FLAG = '--dry-run';
const REMOTE_OVERRIDE_ENV = 'ALLOW_TEST_DATA_MUTATION';
const DEMO_MEASUREMENT_SOURCE = 'SEED_DEMO';
const DEMO_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function printUsage() {
  console.log(`
Dời lịch các đơn seed demo chưa phân công tới thời điểm hiện tại.

Script cập nhật đồng bộ orderedAt và windowStart/windowEnd bằng cùng một độ lệch
cho từng đơn, vì vậy giữ nguyên khoảng cách và thời lượng của lịch demo.

Xem trước, không ghi database:
  node scripts/refresh-order-dates-today.cjs ${DRY_RUN_FLAG}

Thực hiện cập nhật:
  node scripts/refresh-order-dates-today.cjs ${CONFIRM_FLAG}

Chỉ dùng cho dữ liệu phát triển/kiểm thử. Script luôn từ chối NODE_ENV=production.
Database local được phép mặc định; database từ xa cần ${REMOTE_OVERRIDE_ENV}=true.
Chỉ đơn CONFIRMED có toàn bộ Package READY, measurementSource=${DEMO_MEASUREMENT_SOURCE},
không có Allocation và có cửa sổ thời gian đầy đủ mới được cập nhật.
`);
}

function fail(message) {
  console.error(`Không dời lịch demo: ${message}`);
  process.exitCode = 1;
}

function inspectDatabase(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL không hợp lệ');
  }

  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL không phải PostgreSQL');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName) {
    throw new Error('DATABASE_URL thiếu tên database');
  }

  return {
    host: parsed.hostname,
    databaseName,
    isLocal: ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  };
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function getDemoOrderSkipReason(order) {
  if (order.status !== 'CONFIRMED') return 'không ở trạng thái CONFIRMED';
  if (!isValidDate(order.orderedAt)) return 'orderedAt không hợp lệ';
  if (!Array.isArray(order.items) || order.items.length === 0) return 'không có dòng hàng';

  const packages = order.items.flatMap((item) => item.packages ?? []);
  if (packages.length === 0) return 'không có Package vật lý';
  if (order.items.some((item) => (item.allocations ?? []).length > 0)) {
    return 'đã có phân công/Allocation';
  }
  if (packages.some((pkg) => pkg.status !== 'READY')) {
    return 'có Package chưa READY';
  }
  if (packages.some((pkg) => pkg.measurementSource !== DEMO_MEASUREMENT_SOURCE)) {
    return 'không phải toàn bộ Package seed demo';
  }

  const stops = Array.isArray(order.stops) ? order.stops : [];
  const stopsWithWindows = stops.filter(
    (stop) => stop.windowStart !== null || stop.windowEnd !== null,
  );
  if (stopsWithWindows.length === 0) return 'không có khung giờ để dời';
  if (
    stopsWithWindows.some(
      (stop) =>
        !isValidDate(stop.windowStart) ||
        !isValidDate(stop.windowEnd) ||
        stop.windowEnd < stop.windowStart,
    )
  ) {
    return 'khung giờ không đầy đủ hoặc không hợp lệ';
  }

  return null;
}

function shiftDate(value, milliseconds) {
  const shifted = new Date(value.getTime() + milliseconds);
  if (!isValidDate(shifted)) throw new Error('Kết quả dời lịch vượt phạm vi Date');
  return shifted;
}

function localCalendarDayNumber(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return (
    Date.UTC(
      Number(values.get('year')),
      Number(values.get('month')) - 1,
      Number(values.get('day')),
    ) / MILLISECONDS_PER_DAY
  );
}

function computeCalendarDayShiftMilliseconds(source, target, timeZone = DEMO_TIME_ZONE) {
  if (!isValidDate(source) || !isValidDate(target)) {
    throw new Error('Không thể tính độ lệch ngày từ thời điểm không hợp lệ');
  }
  return (
    localCalendarDayNumber(target, timeZone) -
    localCalendarDayNumber(source, timeZone)
  ) * MILLISECONDS_PER_DAY;
}

function buildScheduleShift(order, targetOrderedAt) {
  const skipReason = getDemoOrderSkipReason(order);
  if (skipReason) {
    throw new Error(`Đơn ${order.orderNumber ?? order.id} không thể dời: ${skipReason}`);
  }
  if (!isValidDate(targetOrderedAt)) throw new Error('Thời điểm đích không hợp lệ');

  const shiftMilliseconds = targetOrderedAt.getTime() - order.orderedAt.getTime();
  const stops = order.stops
    .filter((stop) => stop.windowStart !== null && stop.windowEnd !== null)
    .map((stop) => ({
      id: stop.id,
      originalWindowStart: new Date(stop.windowStart),
      originalWindowEnd: new Date(stop.windowEnd),
      windowStart: shiftDate(stop.windowStart, shiftMilliseconds),
      windowEnd: shiftDate(stop.windowEnd, shiftMilliseconds),
    }));

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    expectedVersion: order.version,
    originalOrderedAt: new Date(order.orderedAt),
    orderedAt: new Date(targetOrderedAt),
    shiftMilliseconds,
    stops,
  };
}

function summarizePlans(plans, skipped, referenceNow, shiftMilliseconds, dryRun) {
  const shiftedWindows = plans.flatMap((plan) => plan.stops);
  const timestamps = shiftedWindows.flatMap((stop) => [
    stop.windowStart.getTime(),
    stop.windowEnd.getTime(),
  ]);
  return {
    dryRun,
    referenceNow: referenceNow.toISOString(),
    shiftDays: shiftMilliseconds / MILLISECONDS_PER_DAY,
    eligibleOrderCount: plans.length,
    shiftedStopCount: shiftedWindows.length,
    skippedOrderCount: skipped.length,
    earliestShiftedWindow:
      timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null,
    latestShiftedWindow:
      timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null,
    skipped,
  };
}

async function refreshDemoSchedules(prisma, referenceNow, { dryRun = false } = {}) {
  const orders = await prisma.order.findMany({
    where: { status: 'CONFIRMED' },
    include: {
      stops: { orderBy: { sequence: 'asc' } },
      items: {
        include: {
          allocations: { select: { id: true } },
          packages: {
            select: {
              status: true,
              measurementSource: true,
            },
          },
        },
      },
    },
    orderBy: { orderNumber: 'asc' },
  });

  const eligibleOrders = [];
  const skipped = [];
  for (const order of orders) {
    const reason = getDemoOrderSkipReason(order);
    if (reason) {
      skipped.push({ orderNumber: order.orderNumber, reason });
      continue;
    }
    eligibleOrders.push(order);
  }

  const anchorOrderedAt = eligibleOrders.reduce(
    (latest, order) =>
      !latest || order.orderedAt > latest ? order.orderedAt : latest,
    null,
  );
  const shiftMilliseconds = anchorOrderedAt
    ? computeCalendarDayShiftMilliseconds(anchorOrderedAt, referenceNow)
    : 0;
  const plans = eligibleOrders.map((order) =>
    buildScheduleShift(order, shiftDate(order.orderedAt, shiftMilliseconds)),
  );

  if (!dryRun && plans.length > 0) {
    await prisma.$transaction(
      async (tx) => {
        for (const plan of plans) {
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: plan.orderId,
              status: 'CONFIRMED',
              version: plan.expectedVersion,
            },
            data: {
              orderedAt: plan.orderedAt,
              version: { increment: 1 },
            },
          });
          if (orderUpdate.count !== 1) {
            throw new Error(
              `Đơn ${plan.orderNumber} đã thay đổi trong lúc chạy; toàn bộ cập nhật được rollback`,
            );
          }

          for (const stop of plan.stops) {
            const stopUpdate = await tx.orderStop.updateMany({
              where: {
                id: stop.id,
                orderId: plan.orderId,
                windowStart: stop.originalWindowStart,
                windowEnd: stop.originalWindowEnd,
              },
              data: {
                windowStart: stop.windowStart,
                windowEnd: stop.windowEnd,
              },
            });
            if (stopUpdate.count !== 1) {
              throw new Error(
                `Khung giờ của đơn ${plan.orderNumber} đã thay đổi trong lúc chạy; toàn bộ cập nhật được rollback`,
              );
            }
          }
        }
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  return summarizePlans(
    plans,
    skipped,
    referenceNow,
    shiftMilliseconds,
    dryRun,
  );
}

function printSummary(summary, database) {
  const mode = summary.dryRun ? 'XEM TRƯỚC' : 'ĐÃ CẬP NHẬT';
  console.log(`[${mode}] ${summary.eligibleOrderCount} đơn, ${summary.shiftedStopCount} điểm dừng.`);
  console.log(
    `Dời đồng bộ ${summary.shiftDays >= 0 ? '+' : ''}${summary.shiftDays} ngày theo múi giờ ${DEMO_TIME_ZONE}.`,
  );
  console.log(`Ngày tham chiếu: ${summary.referenceNow}`);
  if (summary.earliestShiftedWindow && summary.latestShiftedWindow) {
    console.log(
      `Khoảng cửa sổ mới: ${summary.earliestShiftedWindow} -> ${summary.latestShiftedWindow}`,
    );
  }
  console.log(`Bỏ qua: ${summary.skippedOrderCount} đơn không đủ điều kiện.`);
  for (const skipped of summary.skipped.slice(0, 10)) {
    console.log(`  - ${skipped.orderNumber}: ${skipped.reason}`);
  }
  if (summary.skipped.length > 10) {
    console.log(`  ... và ${summary.skipped.length - 10} đơn khác.`);
  }
  console.log(`Database: ${database.host}/${database.databaseName}`);
  if (!summary.dryRun && summary.eligibleOrderCount > 0) {
    console.log('Hãy tạo job tối ưu mới; snapshot của các job cũ không bị sửa.');
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  const dryRun = process.argv.includes(DRY_RUN_FLAG);
  const confirmed = process.argv.includes(CONFIRM_FLAG);
  if (!dryRun && !confirmed) {
    printUsage();
    fail(`thiếu ${DRY_RUN_FLAG} hoặc ${CONFIRM_FLAG}`);
    return;
  }
  if (dryRun && confirmed) {
    fail(`chỉ chọn một trong hai cờ ${DRY_RUN_FLAG} hoặc ${CONFIRM_FLAG}`);
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    fail('script test-data bị khóa trong NODE_ENV=production');
    return;
  }
  if (!process.env.DATABASE_URL) {
    fail('chưa cấu hình DATABASE_URL');
    return;
  }

  let database;
  try {
    database = inspectDatabase(process.env.DATABASE_URL);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const hasTestDatabaseName = /(test|dev|local|demo)/i.test(database.databaseName);
  if (!dryRun && !database.isLocal && process.env[REMOTE_OVERRIDE_ENV] !== 'true') {
    fail(`database từ xa yêu cầu ${REMOTE_OVERRIDE_ENV}=true`);
    return;
  }
  if (!dryRun && !database.isLocal && !hasTestDatabaseName) {
    console.warn(
      `Cảnh báo: database từ xa "${database.databaseName}" không có tên test/dev/local/demo; đang tiếp tục vì ${REMOTE_OVERRIDE_ENV}=true.`,
    );
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const summary = await refreshDemoSchedules(prisma, new Date(), { dryRun });
    printSummary(summary, database);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  buildScheduleShift,
  computeCalendarDayShiftMilliseconds,
  getDemoOrderSkipReason,
  inspectDatabase,
  refreshDemoSchedules,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Dời lịch demo thất bại:', error);
    process.exitCode = 1;
  });
}
