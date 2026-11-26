const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  quiet: true,
});

const CONFIRM_FLAG = '--confirm';
const DRY_RUN_FLAG = '--dry-run';
const REMOTE_OVERRIDE_ENV = 'ALLOW_TEST_DATA_MUTATION';
const MAX_ORDERS_PER_PICKUP = 2;

function parseArgs(argv) {
  const options = { confirm: false, dryRun: false, maxPerPoint: MAX_ORDERS_PER_PICKUP };
  for (const arg of argv) {
    if (arg === CONFIRM_FLAG) options.confirm = true;
    else if (arg === DRY_RUN_FLAG) options.dryRun = true;
    else if (arg.startsWith('--max-per-point=')) {
      const val = Number(arg.slice('--max-per-point='.length));
      if (!Number.isInteger(val) || val < 1 || val > 10) {
        throw new Error('--max-per-point phải là số nguyên từ 1 đến 10');
      }
      options.maxPerPoint = val;
    } else {
      throw new Error(`Tham số không hỗ trợ: ${arg}`);
    }
  }
  return options;
}

function inspectDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('Thiếu DATABASE_URL');
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname,
    databaseName: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    isLocal: ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
  };
}

function coordKey(lat, lng) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function loadDanangCandidateLocations() {
  const fixturePaths = [
    path.resolve(__dirname, '../../optimizer/benchmarks/cases/stress_3d_danang_dense_120_orders.json'),
    path.resolve(__dirname, '../../optimizer/benchmarks/cases/stress_3d_danang_120_orders.json'),
  ];
  const byKey = new Map();
  for (const filePath of fixturePaths) {
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const order of data.orders || []) {
      for (const loc of [order.pickup_location, order.delivery_location]) {
        if (!loc || loc.latitude == null || loc.longitude == null) continue;
        // Lọc các điểm hợp lệ khu vực Đà Nẵng và lân cận miền Trung
        if (loc.latitude < 15.2 || loc.latitude > 16.7 || loc.longitude < 107.2 || loc.longitude > 109.0) {
          continue;
        }
        const key = coordKey(loc.latitude, loc.longitude);
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            address: loc.name,
            latitude: Number(loc.latitude),
            longitude: Number(loc.longitude),
          });
        }
      }
    }
  }
  return [...byKey.values()];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.confirm && options.dryRun) {
    throw new Error(`Không dùng đồng thời ${CONFIRM_FLAG} và ${DRY_RUN_FLAG}`);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Từ chối chạy trong môi trường NODE_ENV=production');
  }
  const dbInfo = inspectDatabase(process.env.DATABASE_URL);
  if (options.confirm && !dbInfo.isLocal && process.env[REMOTE_OVERRIDE_ENV] !== 'true') {
    throw new Error(`Database từ xa (${dbInfo.host}) yêu cầu ${REMOTE_OVERRIDE_ENV}=true`);
  }

  const candidates = loadDanangCandidateLocations();
  if (candidates.length === 0) {
    throw new Error('Không tìm thấy danh sách tọa độ Đà Nẵng từ fixture.');
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-DAD' } });
    const orders = await prisma.order.findMany({
      where: {
        branchId: branch.id,
        status: 'CONFIRMED',
        items: { none: { allocations: { some: {} } } },
      },
      select: {
        id: true,
        orderNumber: true,
        stops: {
          select: { id: true, type: true, address: true, latitude: true, longitude: true },
        },
      },
      orderBy: { orderNumber: 'asc' },
    });

    const usageByKey = new Map();
    const pendingReassign = [];

    for (const order of orders) {
      const pickup = order.stops.find((s) => s.type === 'PICKUP');
      const delivery = order.stops.find((s) => s.type === 'DELIVERY');
      if (!pickup) continue;
      const key = coordKey(pickup.latitude, pickup.longitude);
      const count = usageByKey.get(key) || 0;
      if (count < options.maxPerPoint) {
        usageByKey.set(key, count + 1);
      } else {
        pendingReassign.push({ order, pickup, delivery });
      }
    }

    const updates = [];
    let cursor = 0;

    for (const item of pendingReassign) {
      const deliveryKey = item.delivery
        ? coordKey(item.delivery.latitude, item.delivery.longitude)
        : null;
      let chosen = null;
      for (let step = 0; step < candidates.length; step++) {
        const cand = candidates[(cursor + step) % candidates.length];
        if (cand.key === deliveryKey) continue;
        const used = usageByKey.get(cand.key) || 0;
        if (used < options.maxPerPoint) {
          chosen = cand;
          cursor = (cursor + step + 1) % candidates.length;
          usageByKey.set(cand.key, used + 1);
          break;
        }
      }
      if (!chosen) {
        throw new Error(
          `Không đủ điểm ứng viên (${candidates.length}) để giữ tối đa ${options.maxPerPoint} đơn/điểm cho ${orders.length} đơn.`,
        );
      }
      updates.push({
        stopId: item.pickup.id,
        orderNumber: item.order.orderNumber,
        address: chosen.address,
        latitude: chosen.latitude,
        longitude: chosen.longitude,
      });
    }

    const modeLabel = options.confirm ? '[ĐÃ CẬP NHẬT]' : '[XEM TRƯỚC]';
    const maxCount = Math.max(...usageByKey.values(), 0);
    console.log(
      `${modeLabel} Tổng đơn: ${orders.length}, tách lại: ${updates.length} điểm nhận, số điểm nhận sau tách: ${usageByKey.size}, tối đa ${maxCount} đơn/điểm.`,
    );
    console.log(`Database: ${dbInfo.host}/${dbInfo.databaseName}`);

    if (options.confirm && updates.length > 0) {
      await prisma.$transaction(
        async (tx) => {
          for (const u of updates) {
            await tx.orderStop.update({
              where: { id: u.stopId },
              data: {
                address: u.address,
                latitude: u.latitude,
                longitude: u.longitude,
              },
            });
          }
        },
        { timeout: 60000 },
      );
    } else if (!options.confirm && updates.length > 0) {
      console.log(`Chạy lại với ${CONFIRM_FLAG} để ghi vào database.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`Lỗi: ${err.message}`);
  process.exitCode = 1;
});
