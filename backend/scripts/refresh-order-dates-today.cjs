const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '../.env'),
  quiet: true,
});

const { PrismaClient } = require('@prisma/client');

const CONFIRM_FLAG = '--confirm';
const REMOTE_OVERRIDE_ENV = 'ALLOW_TEST_DATA_MUTATION';

function printUsage() {
  console.log(`
Cập nhật orderedAt của toàn bộ đơn hàng thành thời điểm hiện tại.

Chỉ dùng cho dữ liệu phát triển/kiểm thử:
  node scripts/refresh-order-dates-today.cjs ${CONFIRM_FLAG}

Script luôn từ chối NODE_ENV=production. Database local được phép mặc định;
database từ xa chỉ được phép khi ${REMOTE_OVERRIDE_ENV}=true. Nếu database từ
xa không có tên test/dev/local/demo, script sẽ in cảnh báo trước khi cập nhật.
`);
}

function fail(message) {
  console.error(`Không cập nhật đơn hàng: ${message}`);
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

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  if (!process.argv.includes(CONFIRM_FLAG)) {
    printUsage();
    fail(`thiếu cờ xác nhận ${CONFIRM_FLAG}`);
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

  const hasTestDatabaseName = /(test|dev|local|demo)/i.test(
    database.databaseName,
  );
  if (!database.isLocal && process.env[REMOTE_OVERRIDE_ENV] !== 'true') {
    fail(`database từ xa yêu cầu ${REMOTE_OVERRIDE_ENV}=true`);
    return;
  }
  if (!database.isLocal && !hasTestDatabaseName) {
    console.warn(
      `Cảnh báo: database từ xa "${database.databaseName}" không có tên dành cho test; đang tiếp tục vì ${REMOTE_OVERRIDE_ENV}=true.`,
    );
  }

  const prisma = new PrismaClient();
  const orderedAt = new Date();

  try {
    const totalOrders = await prisma.order.count();
    if (totalOrders === 0) {
      console.log('Database không có đơn hàng; không có dữ liệu cần cập nhật.');
      return;
    }

    const result = await prisma.order.updateMany({
      data: {
        orderedAt,
        version: { increment: 1 },
      },
    });

    const localTime = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(orderedAt);

    console.log(`Đã cập nhật ${result.count}/${totalOrders} đơn hàng.`);
    console.log(`orderedAt mới: ${orderedAt.toISOString()} (${localTime})`);
    console.log(`Database: ${database.host}/${database.databaseName}`);
    console.log('Hãy tạo lại job tối ưu; snapshot của các job cũ không bị sửa.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Cập nhật ngày đặt hàng thất bại:', error);
  process.exitCode = 1;
});
