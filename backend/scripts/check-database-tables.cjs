const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const PRISMA_METADATA_TABLES = new Set(['_prisma_migrations']);

async function main() {
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC;
    `;

    const dbTables = rows
      .map((row) => row.table_name)
      .filter((tableName) => !PRISMA_METADATA_TABLES.has(tableName));

    // Anchor declarations at the beginning of a line so a field named
    // "model" cannot be confused with a Prisma model declaration.
    const schemaContent = fs.readFileSync('prisma/schema.prisma', 'utf8');
    const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    const expectedTables = Array.from(
      schemaContent.matchAll(modelPattern),
      ([, modelName, modelBody]) => {
        const mappedName = modelBody.match(/@@map\("([^"]+)"\)/)?.[1];
        return mappedName ?? modelName;
      },
    ).sort();

    if (expectedTables.length === 0) {
      throw new Error('Không tìm thấy model nào trong prisma/schema.prisma.');
    }

    const missingInDb = expectedTables.filter(
      (tableName) => !dbTables.includes(tableName),
    );
    const extraInDb = dbTables.filter(
      (tableName) => !expectedTables.includes(tableName),
    );

    console.log('========================================================================');
    console.log(
      `THỰC TẾ TRONG DATABASE HIỆN CÓ:      ${dbTables.length} BẢNG NGHIỆP VỤ`,
    );
    console.log(
      `MỤC TIÊU THEO SCHEMA.PRISMA CẦN CÓ: ${expectedTables.length} BẢNG NGHIỆP VỤ`,
    );
    console.log('========================================================================');
    console.log('\n--- Danh sách bảng nghiệp vụ thực tế trong database ---');
    console.log(dbTables);
    console.log('\n--- KẾT QUẢ SO SÁNH ---');
    console.log(`Số bảng bị THIẾU trong DB (${missingInDb.length}):`, missingInDb);
    console.log(`Số bảng DƯ THỪA / CŨ trong DB (${extraInDb.length}):`, extraInDb);

    if (missingInDb.length === 0 && extraInDb.length === 0) {
      console.log('\n✅ Database hiện tại khớp với danh sách bảng trong schema.prisma.');
      return;
    }

    console.error('\n❌ Database hiện tại chưa khớp với cấu trúc mới.');
    process.exitCode = 1;
  } catch (error) {
    console.error('Lỗi khi truy vấn database:', error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
