const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const branches = await prisma.branch.findMany({
    select: { id: true, code: true, name: true, address: true }
  });
  console.log('=== DANH SÁCH CHI NHÁNH TRONG DATABASE ===');
  for (const b of branches) {
    const jobs = await prisma.optimizationJob.findMany({
      where: { branchId: b.id },
      select: { id: true, status: true, createdAt: true, requestSnapshot: true },
      orderBy: { createdAt: 'desc' },
      take: 2
    });
    const orderCount = await prisma.order.count({ where: { branchId: b.id } });
    const vehicleCount = await prisma.vehicle.count({ where: { homeBranchId: b.id } });
    console.log(`Chi nhánh: [${b.code}] ${b.name} (${b.city})`);
    console.log(`   - Tổng đơn hàng trong DB: ${orderCount}`);
    console.log(`   - Tổng xe: ${vehicleCount}`);
    console.log(`   - Số jobs đã tạo: ${jobs.length}`);
    for (const j of jobs) {
      const hasPayload = !!j.requestSnapshot?.optimizerPayload;
      const orderN = hasPayload ? j.requestSnapshot.optimizerPayload.orders?.length : 0;
      const vehN = hasPayload ? j.requestSnapshot.optimizerPayload.vehicles?.length : 0;
      console.log(`      * Job ${j.id}: Status=${j.status}, Date=${j.createdAt}, HasPayload=${hasPayload}, Orders=${orderN}, Vehs=${vehN}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
