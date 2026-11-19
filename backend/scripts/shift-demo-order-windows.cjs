const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  quiet: true,
});

const CONFIRM_FLAG = '--confirm';
const DRY_RUN_FLAG = '--dry-run';
const INCLUDE_USER_DECLARED_FLAG = '--include-user-declared';
const REMOTE_OVERRIDE_ENV = 'ALLOW_TEST_DATA_MUTATION';
const DEMO_MEASUREMENT_SOURCE = 'SEED_DEMO';
const DEMO_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_LEAD_DAYS = 7;

function printUsage() {
  console.log(`
Dời lịch các đơn chưa phân công bị trễ hoặc sắp hết hạn để chạy demo không dính phạt trễ.

Cách dùng:
  Xem trước (không ghi DB):
    node scripts/shift-demo-order-windows.cjs ${DRY_RUN_FLAG} [--branch=BRANCH-DAD] [--lead-days=7]

  Thực hiện cập nhật DB:
    node scripts/shift-demo-order-windows.cjs ${CONFIRM_FLAG} [--branch=BRANCH-DAD] [--lead-days=7]

Tùy chọn:
  --branch=CODE             Chỉ lọc theo mã chi nhánh (ví dụ: BRANCH-DAD). Mặc định: tất cả chi nhánh.
  --lead-days=N             Số ngày tối thiểu từ hôm nay đến hạn chót sớm nhất của đơn (mặc định: ${DEFAULT_LEAD_DAYS}).
  ${INCLUDE_USER_DECLARED_FLAG}   Cho phép dời cả đơn có package measurementSource=USER_DECLARED (chưa phân công).
  ${DRY_RUN_FLAG}                 Chỉ xem trước, không ghi database (mặc định nếu không có ${CONFIRM_FLAG}).
  ${CONFIRM_FLAG}                 Ghi cập nhật vào database.

Ghi chú an toàn:
  - Từ chối chạy khi NODE_ENV=production.
  - Database từ xa cần ALLOW_TEST_DATA_MUTATION=true trong .env hoặc biến môi trường.
  - Chỉ cập nhật đơn CONFIRMED, chưa có Allocation, chưa có DeliveryAppointment, và có windowStart/windowEnd hợp lệ.
  - Dời theo bội số nguyên ngày (Asia/Ho_Chi_Minh) cho orderedAt và tất cả windowStart/windowEnd, giữ nguyên giờ trong ngày.
`);
}

function parseArgs(argv) {
  const options = {
    confirm: false,
    dryRun: false,
    help: false,
    branchCode: null,
    leadDays: DEFAULT_LEAD_DAYS,
    includeUserDeclared: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === CONFIRM_FLAG) options.confirm = true;
    else if (arg === DRY_RUN_FLAG) options.dryRun = true;
    else if (arg === INCLUDE_USER_DECLARED_FLAG) options.includeUserDeclared = true;
    else if (arg.startsWith('--branch=')) options.branchCode = arg.slice('--branch='.length).trim() || null;
    else if (arg.startsWith('--lead-days=')) {
      const parsed = Number(arg.slice('--lead-days='.length));
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
        throw new Error('--lead-days phải là số nguyên từ 1 đến 365');
      }
      options.leadDays = parsed;
    } else {
      throw new Error(`Tham số không hỗ trợ: ${arg}`);
    }
  }
  return options;
}

function inspectDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('Thiếu DATABASE_URL');
  const parsed = new URL(databaseUrl);
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL không phải PostgreSQL');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  return {
    host: parsed.hostname,
    databaseName,
    isLocal: ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  };
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function localCalendarDayNumber(value, timeZone = DEMO_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const map = new Map(parts.map((p) => [p.type, p.value]));
  return (
    Date.UTC(Number(map.get('year')), Number(map.get('month')) - 1, Number(map.get('day'))) /
    MILLISECONDS_PER_DAY
  );
}

function getSkipReason(order, includeUserDeclared) {
  if (order.status !== 'CONFIRMED') return 'không ở trạng thái CONFIRMED';
  if (!isValidDate(order.orderedAt)) return 'orderedAt không hợp lệ';
  if (!Array.isArray(order.items) || order.items.length === 0) return 'không có dòng hàng';
  if (order.items.some((item) => (item.allocations ?? []).length > 0)) {
    return 'đã có Allocation';
  }
  if ((order.deliveryAppointments ?? []).length > 0) return 'đã có lịch hẹn giao';

  const packages = order.items.flatMap((item) => item.packages ?? []);
  if (packages.length === 0) return 'không có Package vật lý';
  if (packages.some((pkg) => pkg.status !== 'READY')) return 'có Package chưa READY';

  const allowedSources = includeUserDeclared
    ? new Set([DEMO_MEASUREMENT_SOURCE, 'USER_DECLARED'])
    : new Set([DEMO_MEASUREMENT_SOURCE]);
  if (packages.some((pkg) => !allowedSources.has(pkg.measurementSource))) {
    return 'không thuộc nguồn seed demo';
  }

  const stopsWithWindows = (order.stops ?? []).filter(
    (s) => s.windowStart !== null || s.windowEnd !== null,
  );
  if (stopsWithWindows.length === 0) return 'không có khung giờ để dời';
  if (
    stopsWithWindows.some(
      (s) => !isValidDate(s.windowStart) || !isValidDate(s.windowEnd) || s.windowEnd < s.windowStart,
    )
  ) {
    return 'khung giờ không hợp lệ';
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (options.confirm && options.dryRun) {
    throw new Error(`Không dùng đồng thời ${CONFIRM_FLAG} và ${DRY_RUN_FLAG}`);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Từ chối chạy trong môi trường NODE_ENV=production');
  }

  const dbInfo = inspectDatabase(process.env.DATABASE_URL);
  const allowRemote = process.env[REMOTE_OVERRIDE_ENV] === 'true';
  if (options.confirm && !dbInfo.isLocal && !allowRemote) {
    throw new Error(
      `Database từ xa (${dbInfo.host}) yêu cầu ${REMOTE_OVERRIDE_ENV}=true để chạy ${CONFIRM_FLAG}`,
    );
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const now = new Date();
  const todayDay = localCalendarDayNumber(now, DEMO_TIME_ZONE);
  const targetMinDay = todayDay + options.leadDays;

  try {
    const where = { status: 'CONFIRMED' };
    if (options.branchCode) {
      const branch = await prisma.branch.findUnique({
        where: { code: options.branchCode },
        select: { id: true, code: true, name: true },
      });
      if (!branch) {
        throw new Error(`Không tìm thấy chi nhánh với code=${options.branchCode}`);
      }
      where.branchId = branch.id;
    }

    const orders = await prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNumber: true,
        orderedAt: true,
        status: true,
        branch: { select: { code: true } },
        deliveryAppointments: { select: { id: true }, take: 1 },
        stops: {
          select: { id: true, type: true, windowStart: true, windowEnd: true },
        },
        items: {
          select: {
            allocations: { select: { id: true }, take: 1 },
            packages: { select: { status: true, measurementSource: true } },
          },
        },
      },
      orderBy: { orderNumber: 'asc' },
    });

    const updates = [];
    const skipped = [];

    for (const order of orders) {
      const reason = getSkipReason(order, options.includeUserDeclared);
      if (reason) {
        skipped.push({ orderNumber: order.orderNumber ?? order.id, reason });
        continue;
      }

      const windowStops = order.stops.filter((s) => s.windowStart && s.windowEnd);
      const earliestEnd = windowStops.reduce(
        (min, s) => (s.windowEnd < min ? s.windowEnd : min),
        windowStops[0].windowEnd,
      );
      const earliestEndDay = localCalendarDayNumber(earliestEnd, DEMO_TIME_ZONE);
      const shiftDays = targetMinDay - earliestEndDay;

      if (shiftDays <= 0) {
        skipped.push({
          orderNumber: order.orderNumber ?? order.id,
          reason: `hạn sớm nhất đã cách hiện tại >= ${options.leadDays} ngày`,
        });
        continue;
      }

      const shiftMs = shiftDays * MILLISECONDS_PER_DAY;
      updates.push({
        id: order.id,
        orderNumber: order.orderNumber ?? order.id,
        branchCode: order.branch?.code ?? 'UNKNOWN',
        shiftDays,
        orderedAt: new Date(order.orderedAt.getTime() + shiftMs),
        stops: windowStops.map((s) => ({
          id: s.id,
          windowStart: new Date(s.windowStart.getTime() + shiftMs),
          windowEnd: new Date(s.windowEnd.getTime() + shiftMs),
        })),
      });
    }

    const modeLabel = options.confirm ? '[ĐÃ CẬP NHẬT]' : '[XEM TRƯỚC]';
    const totalStops = updates.reduce((sum, u) => sum + u.stops.length, 0);
    console.log(`${modeLabel} ${updates.length} đơn, ${totalStops} điểm dừng (lead-days=${options.leadDays}).`);
    console.log(`Database: ${dbInfo.host}/${dbInfo.databaseName}`);

    if (updates.length > 0) {
      for (const u of updates.slice(0, 10)) {
        const lastStop = u.stops[u.stops.length - 1];
        console.log(
          `  - ${u.orderNumber} (${u.branchCode}): +${u.shiftDays} ngày -> windowEnd=${lastStop.windowEnd.toISOString()}`,
        );
      }
      if (updates.length > 10) {
        console.log(`  ... và ${updates.length - 10} đơn khác.`);
      }
    }

    if (options.confirm && updates.length > 0) {
      await prisma.$transaction(
        async (tx) => {
          for (const u of updates) {
            await tx.order.update({
              where: { id: u.id },
              data: {
                orderedAt: u.orderedAt,
                version: { increment: 1 },
              },
            });
            for (const s of u.stops) {
              await tx.orderStop.update({
                where: { id: s.id },
                data: {
                  windowStart: s.windowStart,
                  windowEnd: s.windowEnd,
                },
              });
            }
          }
        },
        { timeout: 60000 },
      );
    } else if (!options.confirm && updates.length > 0) {
      console.log(`Chạy lại với ${CONFIRM_FLAG} để ghi thay đổi vào database.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`Lỗi: ${err.message}`);
  process.exitCode = 1;
});
