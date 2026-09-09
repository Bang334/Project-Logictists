import { PrismaClient, Role, VehicleStatus, DriverStatus, OrderStatus, StopType, TaskAction } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Đang khởi tạo Master Data thực tế vào Supabase PostgreSQL...');

  // 1. Tạo Chi nhánh vận hành (Branches)
  const branchHN = await prisma.branch.upsert({
    where: { code: 'BRANCH-HAN' },
    update: {},
    create: {
      code: 'BRANCH-HAN',
      name: 'Kho Vận Miền Bắc - Chi nhánh Hà Nội',
      address: 'Số 1 Huỳnh Tấn Phát, KCN Sài Đồng B, Long Biên, Hà Nội',
      latitude: 21.0345,
      longitude: 105.9082,
      phone: '024.3875.1234',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  });

  const branchDAD = await prisma.branch.upsert({
    where: { code: 'BRANCH-DAD' },
    update: {},
    create: {
      code: 'BRANCH-DAD',
      name: 'Kho Vận Miền Trung - Chi nhánh Đà Nẵng',
      address: 'Đường số 3, KCN Hòa Cầm, Cẩm Lệ, Đà Nẵng',
      latitude: 16.0125,
      longitude: 108.1874,
      phone: '0236.3688.567',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  });

  const branchSGN = await prisma.branch.upsert({
    where: { code: 'BRANCH-SGN' },
    update: {},
    create: {
      code: 'BRANCH-SGN',
      name: 'Kho Vận Miền Nam - Tổng kho Sóng Thần',
      address: 'Đại lộ Độc Lập, KCN Sóng Thần 1, TP. Dĩ An, Bình Dương / Thủ Đức',
      latitude: 10.8924,
      longitude: 106.7582,
      phone: '028.3729.8899',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  });

  console.log('✅ Đã tạo 3 chi nhánh Hub vận tải.');

  // 2. Tạo Tài khoản Người dùng (Users)
  const salt = await bcrypt.genSalt(10);
  const adminPassword = await bcrypt.hash('admin123', salt);
  const dispatcherPassword = await bcrypt.hash('dispatcher123', salt);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: adminPassword,
      fullName: 'Quản Trị Viên Hệ Thống',
      email: 'admin@tms-logistics.vn',
      phone: '0901234567',
      role: Role.ADMIN,
      branchId: branchHN.id,
    },
  });

  const dispatcherHN = await prisma.user.upsert({
    where: { username: 'dispatcher_hn' },
    update: {},
    create: {
      username: 'dispatcher_hn',
      password: dispatcherPassword,
      fullName: 'Nguyễn Văn Hùng (Điều phối HN)',
      email: 'hung.nv@tms-logistics.vn',
      phone: '0912345678',
      role: Role.DISPATCHER,
      branchId: branchHN.id,
    },
  });

  const dispatcherSGN = await prisma.user.upsert({
    where: { username: 'dispatcher_sgn' },
    update: {},
    create: {
      username: 'dispatcher_sgn',
      password: dispatcherPassword,
      fullName: 'Lê Hoàng Nam (Điều phối HCM)',
      email: 'nam.lh@tms-logistics.vn',
      phone: '0987654321',
      role: Role.DISPATCHER,
      branchId: branchSGN.id,
    },
  });

  console.log('✅ Đã tạo các tài khoản quản trị và điều phối viên.');

  // 3. Tạo Đội xe thực tế (Vehicles)
  const vehiclesData = [
    {
      plateNumber: '29H-842.15',
      model: 'Hino 500 Series FC9J',
      vehicleType: 'Xe tải 5 tấn (Thùng kín)',
      homeBranchId: branchHN.id,
      payloadCapacityKg: 5200,
      volumeCapacityM3: 26.5,
      lengthCm: 620,
      widthCm: 215,
      heightCm: 205,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 21.0345,
      currentLongitude: 105.9082,
    },
    {
      plateNumber: '29C-678.92',
      model: 'Hyundai Mighty 110S',
      vehicleType: 'Xe tải 2.5 tấn (Thùng mui bạt)',
      homeBranchId: branchHN.id,
      payloadCapacityKg: 2450,
      volumeCapacityM3: 14.2,
      lengthCm: 430,
      widthCm: 190,
      heightCm: 180,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 21.0345,
      currentLongitude: 105.9082,
    },
    {
      plateNumber: '43C-312.45',
      model: 'Isuzu FVR34SE4',
      vehicleType: 'Xe tải 8 tấn (Thùng kín)',
      homeBranchId: branchDAD.id,
      payloadCapacityKg: 8000,
      volumeCapacityM3: 45.0,
      lengthCm: 820,
      widthCm: 235,
      heightCm: 235,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 16.0125,
      currentLongitude: 108.1874,
    },
    {
      plateNumber: '51D-921.34',
      model: 'Hino 300 Series XZU720L',
      vehicleType: 'Xe tải 1.9 tấn (Thùng kín vào phố)',
      homeBranchId: branchSGN.id,
      payloadCapacityKg: 1900,
      volumeCapacityM3: 12.5,
      lengthCm: 450,
      widthCm: 185,
      heightCm: 180,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 10.8924,
      currentLongitude: 106.7582,
    },
    {
      plateNumber: '50H-156.78',
      model: 'Chenglong 3 chân 6x2',
      vehicleType: 'Xe tải nặng 15 tấn (Thùng mui bạt)',
      homeBranchId: branchSGN.id,
      payloadCapacityKg: 14800,
      volumeCapacityM3: 55.0,
      lengthCm: 960,
      widthCm: 240,
      heightCm: 240,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 10.8924,
      currentLongitude: 106.7582,
    },
  ];

  for (const v of vehiclesData) {
    await prisma.vehicle.upsert({
      where: { plateNumber: v.plateNumber },
      update: {},
      create: v,
    });
  }
  console.log(`✅ Đã tạo ${vehiclesData.length} xe tải thực tế.`);

  // 4. Tạo Hồ sơ Tài xế (Drivers)
  const driversData = [
    {
      fullName: 'Nguyễn Văn Tuấn',
      citizenId: '001089012345',
      phone: '0981112233',
      licenseNumber: 'B2-79012345',
      licenseClass: 'C',
      licenseExpiry: new Date('2028-10-15'),
      homeBranchId: branchHN.id,
      status: DriverStatus.AVAILABLE,
    },
    {
      fullName: 'Trần Đình Trọng',
      citizenId: '001091023456',
      phone: '0982223344',
      licenseNumber: 'C-01023456',
      licenseClass: 'C',
      licenseExpiry: new Date('2029-05-20'),
      homeBranchId: branchHN.id,
      status: DriverStatus.AVAILABLE,
    },
    {
      fullName: 'Lê Quang Dũng',
      citizenId: '048085034567',
      phone: '0983334455',
      licenseNumber: 'FC-48034567',
      licenseClass: 'FC',
      licenseExpiry: new Date('2027-12-30'),
      homeBranchId: branchDAD.id,
      status: DriverStatus.AVAILABLE,
    },
    {
      fullName: 'Phạm Minh Hoàng',
      citizenId: '079088045678',
      phone: '0984445566',
      licenseNumber: 'C-79045678',
      licenseClass: 'C',
      licenseExpiry: new Date('2029-08-18'),
      homeBranchId: branchSGN.id,
      status: DriverStatus.AVAILABLE,
    },
    {
      fullName: 'Vũ Thành Nam',
      citizenId: '079090056789',
      phone: '0985556677',
      licenseNumber: 'FC-79056789',
      licenseClass: 'FC',
      licenseExpiry: new Date('2028-03-25'),
      homeBranchId: branchSGN.id,
      status: DriverStatus.AVAILABLE,
    },
  ];

  for (const d of driversData) {
    await prisma.driver.upsert({
      where: { citizenId: d.citizenId },
      update: {},
      create: d,
    });
  }
  console.log(`✅ Đã tạo ${driversData.length} tài xế với chứng chỉ hợp lệ.`);

  // 5. Tạo Khách hàng thực tế (Customers)
  const custVinamilk = await prisma.customer.upsert({
    where: { code: 'CUST-VINAMILK' },
    update: {},
    create: {
      code: 'CUST-VINAMILK',
      name: 'Công ty Cổ phần Sữa Việt Nam (Vinamilk)',
      taxCode: '0300588569',
      address: 'Số 10 Tân Trào, P. Tân Phú, Quận 7, TP. Hồ Chí Minh',
      contactPerson: 'Chị Mai Lan',
      phone: '028.5415.5555',
      email: 'logistics@vinamilk.com.vn',
    },
  });

  const custSunhouse = await prisma.customer.upsert({
    where: { code: 'CUST-SUNHOUSE' },
    update: {},
    create: {
      code: 'CUST-SUNHOUSE',
      name: 'Tập đoàn Sunhouse Việt Nam',
      taxCode: '0101659783',
      address: 'Tầng 12, Tòa nhà Richy Tower, 35 Mạc Thái Tổ, Yên Hòa, Cầu Giấy, Hà Nội',
      contactPerson: 'Anh Trần Hùng',
      phone: '024.3736.6676',
      email: 'vanchuyen@sunhouse.com.vn',
    },
  });

  const custPanasonic = await prisma.customer.upsert({
    where: { code: 'CUST-PANASONIC' },
    update: {},
    create: {
      code: 'CUST-PANASONIC',
      name: 'Công ty TNHH Panasonic Việt Nam',
      taxCode: '0101375327',
      address: 'Lô J1-J2, KCN Thăng Long, Huyện Đông Anh, Hà Nội',
      contactPerson: 'Anh Quang Minh',
      phone: '024.3955.0111',
      email: 'supplychain@vn.panasonic.com',
    },
  });

  console.log('✅ Đã tạo các khách hàng doanh nghiệp đối tác.');

  // 6. Tạo Các Đơn hàng Vận tải Thực tế (Orders with accurate Mapbox coordinates)
  // Đơn hàng 1: Sữa Vinamilk từ KCN Tiên Sơn về Kho Minh Khai (Hai Bà Trưng, HN)
  const order1 = await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-001' },
    update: {},
    create: {
      orderNumber: 'ORD-20260909-001',
      customerId: custVinamilk.id,
      status: OrderStatus.CONFIRMED,
      totalWeightKg: 1250,
      totalVolumeM3: 4.8,
      totalPackages: 100,
      notes: 'Hàng sữa chua tiệt trùng, xếp cẩn thận, không để ẩm ướt.',
      items: {
        create: [
          {
            sku: 'VNM-MILK-180ML',
            description: 'Sữa chua uống Probi 180ml (Thùng 48 hộp)',
            packageType: 'CARTON',
            quantity: 100,
            weightKg: 1250,
            lengthCm: 35,
            widthCm: 25,
            heightCm: 18,
            volumeM3: 4.8,
          },
        ],
      },
      stops: {
        create: [
          {
            type: StopType.PICKUP,
            sequence: 1,
            address: 'Nhà máy Sữa Tiên Sơn, Đường TS7, KCN Tiên Sơn, Bắc Ninh',
            latitude: 21.1189,
            longitude: 105.9967,
            contactName: 'Kho Tiên Sơn - Anh Bình',
            contactPhone: '0912111333',
            serviceDurationMinutes: 30,
            windowStart: new Date('2026-09-10T08:00:00Z'),
            windowEnd: new Date('2026-09-10T10:30:00Z'),
          },
          {
            type: StopType.DELIVERY,
            sequence: 2,
            address: 'Trung tâm Phân phối Vinamilk, 458 Minh Khai, Hai Bà Trưng, Hà Nội',
            latitude: 20.9992,
            longitude: 105.8674,
            contactName: 'Thủ kho Minh Khai - Chị Nga',
            contactPhone: '0913222444',
            serviceDurationMinutes: 30,
            windowStart: new Date('2026-09-10T11:00:00Z'),
            windowEnd: new Date('2026-09-10T15:00:00Z'),
          },
        ],
      },
    },
  });

  // Đơn hàng 2: Sunhouse gia dụng từ Ngọc Hồi về Siêu thị MediaMart Phạm Văn Đồng
  const order2 = await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-002' },
    update: {},
    create: {
      orderNumber: 'ORD-20260909-002',
      customerId: custSunhouse.id,
      status: OrderStatus.CONFIRMED,
      totalWeightKg: 850,
      totalVolumeM3: 6.2,
      totalPackages: 40,
      notes: 'Hàng gia dụng điện tử: Nồi cơm điện, chảo chống dính cao cấp.',
      items: {
        create: [
          {
            sku: 'SH-COOKER-18L',
            description: 'Nồi cơm điện tử Sunhouse Mama 1.8L',
            packageType: 'CARTON',
            quantity: 40,
            weightKg: 850,
            lengthCm: 45,
            widthCm: 35,
            heightCm: 32,
            volumeM3: 6.2,
          },
        ],
      },
      stops: {
        create: [
          {
            type: StopType.PICKUP,
            sequence: 1,
            address: 'Tổng kho Sunhouse Miền Bắc, Km 14, Quốc Lộ 1A, Ngọc Hồi, Thanh Trì, Hà Nội',
            latitude: 20.9324,
            longitude: 105.8567,
            contactName: 'Anh Hùng - Kho Ngọc Hồi',
            contactPhone: '0988776655',
            serviceDurationMinutes: 25,
            windowStart: new Date('2026-09-10T08:30:00Z'),
            windowEnd: new Date('2026-09-10T11:00:00Z'),
          },
          {
            type: StopType.DELIVERY,
            sequence: 2,
            address: 'Siêu thị MediaMart, 335 Phạm Văn Đồng, Bắc Từ Liêm, Hà Nội',
            latitude: 21.0664,
            longitude: 105.7836,
            contactName: 'Nhận hàng MediaMart - Anh Cường',
            contactPhone: '0977665544',
            serviceDurationMinutes: 25,
            windowStart: new Date('2026-09-10T13:00:00Z'),
            windowEnd: new Date('2026-09-10T16:30:00Z'),
          },
        ],
      },
    },
  });

  // Đơn hàng 3: Panasonic giao từ KCN Thăng Long về Trung tâm Trần Thái Tông
  const order3 = await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-003' },
    update: {},
    create: {
      orderNumber: 'ORD-20260909-003',
      customerId: custPanasonic.id,
      status: OrderStatus.CONFIRMED,
      totalWeightKg: 420,
      totalVolumeM3: 3.1,
      totalPackages: 15,
      notes: 'Linh kiện quạt và thiết bị chiếu sáng, hàng dễ vỡ.',
      items: {
        create: [
          {
            sku: 'PANA-FAN-F409',
            description: 'Quạt đứng Panasonic F-409MB',
            packageType: 'CARTON',
            quantity: 15,
            weightKg: 420,
            lengthCm: 50,
            widthCm: 45,
            heightCm: 40,
            volumeM3: 3.1,
          },
        ],
      },
      stops: {
        create: [
          {
            type: StopType.PICKUP,
            sequence: 1,
            address: 'Nhà máy Panasonic, Lô J1-J2, KCN Thăng Long, Kim Chung, Đông Anh, Hà Nội',
            latitude: 21.1342,
            longitude: 105.7725,
            contactName: 'Xuất hàng Pana - Anh Thắng',
            contactPhone: '0934567890',
            serviceDurationMinutes: 20,
            windowStart: new Date('2026-09-10T09:00:00Z'),
            windowEnd: new Date('2026-09-10T11:30:00Z'),
          },
          {
            type: StopType.DELIVERY,
            sequence: 2,
            address: 'Trung tâm Dịch vụ Panasonic, 88 Trần Thái Tông, Dịch Vọng Hậu, Cầu Giấy, Hà Nội',
            latitude: 21.0312,
            longitude: 105.7871,
            contactName: 'Nhận linh kiện - Chị Yến',
            contactPhone: '0945678901',
            serviceDurationMinutes: 20,
            windowStart: new Date('2026-09-10T14:00:00Z'),
            windowEnd: new Date('2026-09-10T17:00:00Z'),
          },
        ],
      },
    },
  });

  console.log('✅ Đã tạo các đơn hàng vận tải thực tế với tọa độ chuẩn.');
  console.log('🎉 KHỞI TẠO MASTER DATA THÀNH CÔNG VÀO POSTGRESQL SUPABASE!');
}

main()
  .catch((e) => {
    console.error('❌ Lỗi khi seed dữ liệu:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
