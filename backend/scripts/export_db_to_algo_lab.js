const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function exportDatabaseSnapshots() {
  try {
    const targetDir = path.resolve(__dirname, '../../algo_lab/datasets');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 1. Export Latest Hanoi Job (16 orders, 21 vehicles, 53x53 matrix)
    const hanoiJob = await prisma.optimizationJob.findFirst({
      where: {
        status: 'SUCCEEDED',
        branch: { code: 'BRANCH-HAN' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        branch: { select: { code: true, name: true } },
        createdAt: true,
        requestSnapshot: true,
      }
    });

    if (hanoiJob && hanoiJob.requestSnapshot?.optimizerPayload) {
      const payloadHN = hanoiJob.requestSnapshot.optimizerPayload;
      
      // Save as the primary sample database file requested by user
      const mainSamplePath = path.join(targetDir, 'database_sample.json');
      fs.writeFileSync(mainSamplePath, JSON.stringify(payloadHN, null, 2), 'utf8');
      console.log(`✅ [1] Đã lưu file dữ liệu mẫu chính: ${mainSamplePath}`);
      console.log(`    - Nguồn: Job ${hanoiJob.id} (${hanoiJob.branch.name})`);
      console.log(`    - Số đơn hàng: ${payloadHN.orders.length} đơn`);
      console.log(`    - Số lượng xe: ${payloadHN.vehicles.length} xe`);
      console.log(`    - Ma trận đường bộ: ${payloadHN.distance_matrix_meters.length}x${payloadHN.distance_matrix_meters[0].length}`);

      // Also save as specific name
      const hanoiPath = path.join(targetDir, 'db_hanoi_16_orders.json');
      fs.writeFileSync(hanoiPath, JSON.stringify(payloadHN, null, 2), 'utf8');
      console.log(`✅ [2] Đã lưu file: ${hanoiPath}`);
    }

    // 2. Export Da Nang Job (30 orders, 42 vehicles, 102x102 matrix) - Benchmark quy mô lớn
    const danangJob = await prisma.optimizationJob.findFirst({
      where: {
        status: 'SUCCEEDED',
        branch: { code: 'BRANCH-DAD' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        branch: { select: { code: true, name: true } },
        createdAt: true,
        requestSnapshot: true,
      }
    });

    if (danangJob && danangJob.requestSnapshot?.optimizerPayload) {
      const payloadDAD = danangJob.requestSnapshot.optimizerPayload;
      const danangPath = path.join(targetDir, 'db_danang_30_orders.json');
      fs.writeFileSync(danangPath, JSON.stringify(payloadDAD, null, 2), 'utf8');
      console.log(`✅ [3] Đã lưu file: ${danangPath}`);
      console.log(`    - Nguồn: Job ${danangJob.id} (${danangJob.branch.name})`);
      console.log(`    - Số đơn hàng: ${payloadDAD.orders.length} đơn`);
      console.log(`    - Số lượng xe: ${payloadDAD.vehicles.length} xe`);
      console.log(`    - Ma trận đường bộ: ${payloadDAD.distance_matrix_meters.length}x${payloadDAD.distance_matrix_meters[0].length}`);
    }

    // 3. Export Song Than Job (BRANCH-SGN)
    const songthanJob = await prisma.optimizationJob.findFirst({
      where: {
        status: 'SUCCEEDED',
        branch: { code: 'BRANCH-SGN' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        branch: { select: { code: true, name: true } },
        createdAt: true,
        requestSnapshot: true,
      }
    });

    if (songthanJob && songthanJob.requestSnapshot?.optimizerPayload) {
      const payloadSGN = songthanJob.requestSnapshot.optimizerPayload;
      const sgnPath = path.join(targetDir, 'db_songthan_4_orders.json');
      fs.writeFileSync(sgnPath, JSON.stringify(payloadSGN, null, 2), 'utf8');
      console.log(`✅ [4] Đã lưu file: ${sgnPath}`);
      console.log(`    - Nguồn: Job ${songthanJob.id} (${songthanJob.branch.name})`);
      console.log(`    - Số đơn hàng: ${payloadSGN.orders.length} đơn`);
      console.log(`    - Số lượng xe: ${payloadSGN.vehicles.length} xe`);
      console.log(`    - Ma trận đường bộ: ${payloadSGN.distance_matrix_meters.length}x${payloadSGN.distance_matrix_meters[0].length}`);
    }

    // 4. Export Nha Trang Job (BRANCH-NTR)
    const nhatrangJob = await prisma.optimizationJob.findFirst({
      where: {
        status: 'SUCCEEDED',
        branch: { code: 'BRANCH-NTR' },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        branch: { select: { code: true, name: true } },
        createdAt: true,
        requestSnapshot: true,
      }
    });

    if (nhatrangJob && nhatrangJob.requestSnapshot?.optimizerPayload) {
      const payloadNTR = nhatrangJob.requestSnapshot.optimizerPayload;
      const ntrPath = path.join(targetDir, 'db_nhatrang_2_orders.json');
      fs.writeFileSync(ntrPath, JSON.stringify(payloadNTR, null, 2), 'utf8');
      console.log(`✅ [5] Đã lưu file: ${ntrPath}`);
      console.log(`    - Nguồn: Job ${nhatrangJob.id} (${nhatrangJob.branch.name})`);
      console.log(`    - Số đơn hàng: ${payloadNTR.orders.length} đơn`);
      console.log(`    - Số lượng xe: ${payloadNTR.vehicles.length} xe`);
      console.log(`    - Ma trận đường bộ: ${payloadNTR.distance_matrix_meters.length}x${payloadNTR.distance_matrix_meters[0].length}`);
    }

    console.log('\n🎉 Hoàn thành xuất toàn bộ dữ liệu 4 chi nhánh từ Database Supabase sang algo_lab/datasets/!');
  } catch (err) {
    console.error('❌ Lỗi xuất dữ liệu:', err);
  } finally {
    await prisma.$disconnect();
  }
}

exportDatabaseSnapshots();
