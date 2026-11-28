import { PrismaClient, Role, VehicleStatus, DriverStatus, OrderStatus, StopType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { seedCentralBranchData, seedDemoDepot } from './seed-central';

const prisma = new PrismaClient();

// The 15,000 VND/ton-hour and 20% full-payload fuel surcharge values below
// are demo data only. Production values must be calibrated from fuel logs and policy.
async function main() {
  console.log('🚀 Đang khởi tạo Master Data thực tế vào Supabase PostgreSQL...');

  // 1. Tạo Chi nhánh vận hành (Branches)
  const branchHN = await prisma.branch.upsert({
    where: { code: 'BRANCH-HAN' },
    update: {
      fuelPricePerLiter: 23800,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
    create: {
      code: 'BRANCH-HAN',
      name: 'Kho Vận Miền Bắc - Chi nhánh Hà Nội',
      address: 'Số 1 Huỳnh Tấn Phát, KCN Sài Đồng B, Long Biên, Hà Nội',
      latitude: 21.0345,
      longitude: 105.9082,
      phone: '024.3875.1234',
      timezone: 'Asia/Ho_Chi_Minh',
      fuelPricePerLiter: 23800,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
  });

  const branchDAD = await prisma.branch.upsert({
    where: { code: 'BRANCH-DAD' },
    update: {
      fuelPricePerLiter: 23500,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
    create: {
      code: 'BRANCH-DAD',
      name: 'Kho Vận Miền Trung - Chi nhánh Đà Nẵng',
      address: 'Đường số 3, KCN Hòa Cầm, Cẩm Lệ, Đà Nẵng',
      latitude: 16.0125,
      longitude: 108.1874,
      phone: '0236.3688.567',
      timezone: 'Asia/Ho_Chi_Minh',
      fuelPricePerLiter: 23500,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
  });

  const branchSGN = await prisma.branch.upsert({
    where: { code: 'BRANCH-SGN' },
    update: {
      fuelPricePerLiter: 24000,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
    create: {
      code: 'BRANCH-SGN',
      name: 'Kho Vận Miền Nam - Tổng kho Sóng Thần',
      address: 'Đại lộ Độc Lập, KCN Sóng Thần 1, TP. Dĩ An, Bình Dương / Thủ Đức',
      latitude: 10.8924,
      longitude: 106.7582,
      phone: '028.3729.8899',
      timezone: 'Asia/Ho_Chi_Minh',
      fuelPricePerLiter: 24000,
      monthlyWorkingMinutes: 10560,
      cargoHoldingCostVndPerTonHour: 15000,
    },
  });

  console.log('✅ Đã tạo 3 chi nhánh Hub vận tải.');
  const depotsByBranch = new Map(await Promise.all([branchHN, branchDAD, branchSGN].map(async (branch) => {
    const depot = await seedDemoDepot(prisma, branch);
    return [branch.id, depot.id] as const;
  })));

  // 2. Tạo Tài khoản Người dùng (Users)
  const salt = await bcrypt.genSalt(10);
  const adminPassword = await bcrypt.hash('admin123', salt);
  const dispatcherPassword = await bcrypt.hash('dispatcher123', salt);

  await prisma.user.upsert({
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

  await prisma.user.upsert({
    where: { username: 'dispatcher_hn' },
    update: {},
    create: {
      username: 'dispatcher_hn',
      password: dispatcherPassword,
      fullName: 'Nguyễn Văn Hùng (Điều phối HN)',
      email: 'hung.nv@tms-logistics.vn',
      phone: '0912345678',
      role: Role.STAFF,
      branchId: branchHN.id,
    },
  });

  await prisma.user.upsert({
    where: { username: 'dispatcher_sgn' },
    update: {},
    create: {
      username: 'dispatcher_sgn',
      password: dispatcherPassword,
      fullName: 'Lê Hoàng Nam (Điều phối HCM)',
      email: 'nam.lh@tms-logistics.vn',
      phone: '0987654321',
      role: Role.STAFF,
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
      fuelConsumptionLitersPer100Km: 18.5,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 120000,
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
      fuelConsumptionLitersPer100Km: 12.5,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 80000,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 21.0345,
      currentLongitude: 105.9082,
    },
    {
      plateNumber: '29D-528.36',
      model: 'Isuzu Forward NQR75L',
      vehicleType: 'Xe tải 5.5 tấn (Thùng kín đường dài)',
      homeBranchId: branchHN.id,
      payloadCapacityKg: 5500,
      volumeCapacityM3: 28.0,
      lengthCm: 630,
      widthCm: 220,
      heightCm: 210,
      fuelConsumptionLitersPer100Km: 17.5,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 120000,
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
      fuelConsumptionLitersPer100Km: 24,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 160000,
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
      fuelConsumptionLitersPer100Km: 11.5,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 75000,
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
      fuelConsumptionLitersPer100Km: 31,
      loadFuelSurchargePercentAtFullPayload: 20,
      fixedOperatingCostPerTrip: 220000,
      status: VehicleStatus.AVAILABLE,
      currentLatitude: 10.8924,
      currentLongitude: 106.7582,
    },
  ];

  for (const v of vehiclesData) {
    const {
      vehicleType: typeName,
      payloadCapacityKg,
      volumeCapacityM3,
      lengthCm,
      widthCm,
      heightCm,
      fuelConsumptionLitersPer100Km,
      loadFuelSurchargePercentAtFullPayload,
      fixedOperatingCostPerTrip,
      ...vehicleData
    } = v;
    const typeData = {
      name: typeName,
      payloadCapacityKg,
      volumeCapacityM3,
      lengthCm,
      widthCm,
      heightCm,
      fuelConsumptionLitersPer100Km,
      loadFuelSurchargePercentAtFullPayload,
      fixedOperatingCostPerTrip,
    };
    const vehicleType = await prisma.vehicleType.upsert({
      where: { code: `SEED-${v.plateNumber.replace(/[^A-Z0-9]/gi, '-')}` },
      update: typeData,
      create: {
        code: `SEED-${v.plateNumber.replace(/[^A-Z0-9]/gi, '-')}`,
        ...typeData,
      },
    });
    const homeDepotLocationId = depotsByBranch.get(v.homeBranchId);
    await prisma.vehicle.upsert({
      where: { plateNumber: v.plateNumber },
      update: { vehicleTypeId: vehicleType.id },
      create: { ...vehicleData, vehicleTypeId: vehicleType.id, homeDepotLocationId },
    });
    if (homeDepotLocationId) {
      await prisma.vehicle.updateMany({
        where: { plateNumber: v.plateNumber, homeBranchId: v.homeBranchId, homeDepotLocationId: null },
        data: { homeDepotLocationId },
      });
    }
  }
  console.log(`✅ Đã tạo ${vehiclesData.length} xe tải thực tế.`);

  // 4. Tạo Hồ sơ Tài xế (Drivers)
  const driversData = [
    {
      fullName: 'Lê Hoàng Long',
      citizenId: '001095045678',
      phone: '0986667788',
      licenseNumber: 'B2-01045678',
      licenseClass: 'B2',
      licenseExpiry: new Date('2030-01-15'),
      homeBranchId: branchHN.id,
      status: DriverStatus.AVAILABLE,
      fixedSalaryMonthly: 9500000,
      tripBasePay: 110000,
      perKmPay: 900,
    },
    {
      fullName: 'Nguyễn Văn Tuấn',
      citizenId: '001089012345',
      phone: '0981112233',
      licenseNumber: 'C-01012345',
      licenseClass: 'C',
      licenseExpiry: new Date('2028-10-15'),
      homeBranchId: branchHN.id,
      status: DriverStatus.AVAILABLE,
      fixedSalaryMonthly: 12000000,
      tripBasePay: 180000,
      perKmPay: 1300,
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
      fixedSalaryMonthly: 13500000,
      tripBasePay: 160000,
      perKmPay: 1100,
    },
    {
      fullName: 'Hoàng Văn Nam',
      citizenId: '001093034567',
      phone: '0985556677',
      licenseNumber: 'C-01034567',
      licenseClass: 'C',
      licenseExpiry: new Date('2029-11-25'),
      homeBranchId: branchHN.id,
      status: DriverStatus.AVAILABLE,
      fixedSalaryMonthly: 13000000,
      tripBasePay: 170000,
      perKmPay: 1200,
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
      fixedSalaryMonthly: 15000000,
      tripBasePay: 220000,
      perKmPay: 1500,
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
      fixedSalaryMonthly: 11500000,
      tripBasePay: 150000,
      perKmPay: 1000,
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
      fixedSalaryMonthly: 16000000,
      tripBasePay: 250000,
      perKmPay: 1600,
    },
  ];

  for (const d of driversData) {
    await prisma.driver.upsert({
      where: { citizenId: d.citizenId },
      update: {
        fixedSalaryMonthly: d.fixedSalaryMonthly,
        tripBasePay: d.tripBasePay,
        perKmPay: d.perKmPay,
      },
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
  await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-001' },
    update: { branchId: branchHN.id },
    create: {
      orderNumber: 'ORD-20260909-001',
      customerId: custVinamilk.id,
      branchId: branchHN.id,
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
          },
        ],
      },
    },
  });

  // Đơn hàng 2: Sunhouse gia dụng từ Ngọc Hồi về Siêu thị MediaMart Phạm Văn Đồng
  await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-002' },
    update: { branchId: branchHN.id },
    create: {
      orderNumber: 'ORD-20260909-002',
      customerId: custSunhouse.id,
      branchId: branchHN.id,
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
          },
        ],
      },
    },
  });

  // Đơn hàng 3: Panasonic giao từ KCN Thăng Long về Trung tâm Trần Thái Tông
  await prisma.order.upsert({
    where: { orderNumber: 'ORD-20260909-003' },
    update: { branchId: branchHN.id },
    create: {
      orderNumber: 'ORD-20260909-003',
      customerId: custPanasonic.id,
      branchId: branchHN.id,
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
          },
        ],
      },
    },
  });

  // Bộ dữ liệu demo điều phối: mỗi đơn có nhiều loại hàng, mỗi loại có nhiều kiện
  // vật lý và mỗi đơn có cặp điểm nhận/gửi riêng. Các mức chi phí chỉ dùng demo.
  const demoOrders = [
    {
      orderNumber: 'DEMO-HN-001', customerId: custPanasonic.id,
      pickup: ['Kho linh kiện Đông Anh, Hà Nội', 21.1392, 105.8491],
      delivery: ['Cửa hàng Tràng Tiền, Hoàn Kiếm, Hà Nội', 21.0245, 105.8556],
      items: [
        { sku: 'PAL-MOTOR-HN1', description: 'Pallet cụm mô-tơ công nghiệp (đế nặng)', packageType: 'PALLET', quantity: 3, weightKg: 1740, lengthCm: 200, widthCm: 102, heightCm: 90 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-002', customerId: custVinamilk.id,
      pickup: ['Kho lạnh Gia Lâm, Hà Nội', 21.0498, 105.9412],
      delivery: ['Siêu thị Nguyễn Trãi, Thanh Xuân, Hà Nội', 20.9964, 105.8071],
      items: [
        { sku: 'PAL-MILK-BASE', description: 'Pallet sữa nước đóng lốc (đế nặng)', packageType: 'PALLET', quantity: 3, weightKg: 1740, lengthCm: 200, widthCm: 102, heightCm: 90 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-003', customerId: custSunhouse.id,
      pickup: ['Kho Ngọc Hồi, Thanh Trì, Hà Nội', 20.9349, 105.8428],
      delivery: ['Siêu thị Mỹ Đình, Nam Từ Liêm, Hà Nội', 21.0118, 105.7706],
      items: [
        { sku: 'STOVE-LONG', description: 'Kiện bếp từ đôi dài (đế rộng)', packageType: 'CRATE', quantity: 2, weightKg: 840, lengthCm: 198, widthCm: 92, heightCm: 92 },
        { sku: 'COOKER', description: 'Thùng nồi cơm điện (tầng 2)', packageType: 'CARTON', quantity: 2, weightKg: 180, lengthCm: 188, widthCm: 88, heightCm: 82 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-004', customerId: custPanasonic.id,
      pickup: ['Kho linh kiện Đông Anh, Hà Nội', 21.1392, 105.8491],
      delivery: ['Kho Sài Đồng, Long Biên, Hà Nội', 21.0364, 105.9254],
      items: [
        { sku: 'INV-PALLET', description: 'Kiện biến tần công nghiệp (tầng 2)', packageType: 'CRATE', quantity: 2, weightKg: 340, lengthCm: 192, widthCm: 96, heightCm: 65 },
        { sku: 'LAMP', description: 'Thùng đèn LED nhẹ (nhiều kiện tầng 3)', packageType: 'CARTON', quantity: 4, weightKg: 72, lengthCm: 90, widthCm: 90, heightCm: 44 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-005', customerId: custVinamilk.id,
      pickup: ['Kho Ngọc Hồi, Thanh Trì, Hà Nội', 20.9349, 105.8428],
      delivery: ['Điểm bán Xuân La, Tây Hồ, Hà Nội', 21.0692, 105.8029],
      items: [
        { sku: 'DISPLAY-LONG', description: 'Kiện kệ trưng bày siêu thị (đế dài)', packageType: 'CRATE', quantity: 2, weightKg: 840, lengthCm: 198, widthCm: 92, heightCm: 92 },
        { sku: 'JUICE', description: 'Thùng nước trái cây hộp (tầng 2)', packageType: 'CARTON', quantity: 4, weightKg: 200, lengthCm: 92, widthCm: 88, heightCm: 82 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-006', customerId: custSunhouse.id,
      pickup: ['Kho lạnh Gia Lâm, Hà Nội', 21.0498, 105.9412],
      delivery: ['Trung tâm điện máy Cầu Giấy, Hà Nội', 21.0368, 105.7908],
      items: [
        { sku: 'HOOD-CRATE', description: 'Kiện máy hút mùi (tầng 2)', packageType: 'CRATE', quantity: 2, weightKg: 340, lengthCm: 192, widthCm: 96, heightCm: 65 },
        { sku: 'BLENDER', description: 'Thùng máy xay sinh tố nhẹ (nhiều kiện tầng 3)', packageType: 'CARTON', quantity: 4, weightKg: 72, lengthCm: 90, widthCm: 90, heightCm: 44 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-007', customerId: custPanasonic.id,
      pickup: ['Kho linh kiện Đông Anh, Hà Nội', 21.1392, 105.8491],
      delivery: ['Kho Linh Đàm, Hoàng Mai, Hà Nội', 20.9649, 105.8268],
      items: [
        { sku: 'AC-PALLET', description: 'Pallet cục nóng điều hòa (đế nặng)', packageType: 'PALLET', quantity: 3, weightKg: 1650, lengthCm: 195, widthCm: 100, heightCm: 88 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-008', customerId: custSunhouse.id,
      pickup: ['Kho lạnh Gia Lâm, Hà Nội', 21.0498, 105.9412],
      delivery: ['Điểm nhận Phạm Văn Đồng, Bắc Từ Liêm, Hà Nội', 21.0701, 105.7868],
      items: [
        { sku: 'RACK', description: 'Kiện giá kệ thép lắp ghép (đế nặng)', packageType: 'CRATE', quantity: 3, weightKg: 1650, lengthCm: 195, widthCm: 100, heightCm: 88 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-009', customerId: custPanasonic.id,
      pickup: ['KCN Phố Nối A, Yên Mỹ, Hưng Yên', 20.9542, 106.0581],
      delivery: ['Trung tâm Phân phối Hải Phòng, Hồng Bàng, Hải Phòng', 20.862328, 106.679927],
      items: [
        { sku: 'ELEC-PANEL', description: 'Tủ điện công nghiệp trung thế', packageType: 'CRATE', quantity: 2, weightKg: 960, lengthCm: 160, widthCm: 95, heightCm: 95 },
        { sku: 'BREAKER-BOX', description: 'Thùng aptomat & thiết bị đóng cắt', packageType: 'CARTON', quantity: 4, weightKg: 160, lengthCm: 75, widthCm: 85, heightCm: 55 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-010', customerId: custSunhouse.id,
      pickup: ['KCN Khai Quang, TP. Vĩnh Yên, Vĩnh Phúc', 21.3092, 105.6124],
      delivery: ['Tổng kho Phủ Lý, Hà Nam', 20.5385, 105.9182],
      items: [
        { sku: 'HEATER-BATCH', description: 'Lô bình nước nóng công nghiệp', packageType: 'CRATE', quantity: 3, weightKg: 780, lengthCm: 135, widthCm: 88, heightCm: 85 },
        { sku: 'SOLAR-KIT', description: 'Bộ khung năng lượng mặt trời', packageType: 'CRATE', quantity: 2, weightKg: 180, lengthCm: 125, widthCm: 80, heightCm: 55 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-011', customerId: custVinamilk.id,
      pickup: ['KCN Quang Châu, Việt Yên, Bắc Giang', 21.2285, 106.0954],
      delivery: ['Trung tâm Phân phối Thường Tín, Hà Nội', 20.8712, 105.8624],
      items: [
        { sku: 'MILK-POWDER', description: 'Pallet sữa bột lon xuất khẩu', packageType: 'PALLET', quantity: 2, weightKg: 840, lengthCm: 150, widthCm: 95, heightCm: 88 },
        { sku: 'CONDENSED-BOX', description: 'Thùng sữa đặc có đường', packageType: 'CARTON', quantity: 4, weightKg: 160, lengthCm: 70, widthCm: 85, heightCm: 55 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-012', customerId: custVinamilk.id,
      pickup: ['Kho lạnh Gia Lâm, Hà Nội', 21.0498, 105.9412],
      delivery: ['Trung tâm Phân phối Vinamilk, 458 Minh Khai, Hai Bà Trưng, Hà Nội', 20.9992, 105.8669],
      items: [
        { sku: 'PAL-UHT-HN12', description: 'Pallet sữa tươi tiệt trùng (tầng 2)', packageType: 'PALLET', quantity: 2, weightKg: 340, lengthCm: 190, widthCm: 95, heightCm: 64 },
        { sku: 'CHEESE-BOX', description: 'Thùng phô mai hộp nhẹ (nhiều kiện tầng 3)', packageType: 'CARTON', quantity: 4, weightKg: 72, lengthCm: 90, widthCm: 90, heightCm: 43 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-013', customerId: custPanasonic.id,
      pickup: ['Kho linh kiện Đông Anh, Hà Nội', 21.1392, 105.8491],
      delivery: ['Trung tâm Dịch vụ Panasonic, 88 Trần Thái Tông, Dịch Vọng Hậu, Cầu Giấy, Hà Nội', 21.0319, 105.7885],
      items: [
        { sku: 'WASHER-BASE', description: 'Kiện máy giặt cửa ngang (tầng 2)', packageType: 'CRATE', quantity: 2, weightKg: 340, lengthCm: 190, widthCm: 95, heightCm: 64 },
        { sku: 'IRON-TOP', description: 'Thùng bàn là hơi nước nhẹ (nhiều kiện tầng 3)', packageType: 'CARTON', quantity: 4, weightKg: 72, lengthCm: 90, widthCm: 90, heightCm: 43 },
      ],
    },
    {
      orderNumber: 'DEMO-HN-014', customerId: custSunhouse.id,
      pickup: ['Kho lạnh Gia Lâm, Hà Nội', 21.0498, 105.9412],
      delivery: ['Siêu thị MediaMart, 335 Phạm Văn Đồng, Bắc Từ Liêm, Hà Nội', 21.0645, 105.7848],
      items: [
        { sku: 'PURIFIER-BASE', description: 'Kiện máy lọc nước tủ đứng', packageType: 'CRATE', quantity: 2, weightKg: 720, lengthCm: 145, widthCm: 95, heightCm: 85 },
        { sku: 'AIRFRYER-BOX', description: 'Thùng nồi chiên không dầu (tầng 2)', packageType: 'CARTON', quantity: 2, weightKg: 180, lengthCm: 135, widthCm: 88, heightCm: 64 },
      ],
    },
  ] as const;

  for (const [index, demo] of demoOrders.entries()) {
    const totalWeightKg = demo.items.reduce((sum, item) => sum + item.weightKg, 0);
    const totalVolumeM3 = demo.items.reduce(
      (sum, item) => sum + (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
      0,
    );
    const totalPackages = demo.items.reduce((sum, item) => sum + item.quantity, 0);
    const demoOrder = await prisma.order.upsert({
      where: { orderNumber: demo.orderNumber },
      update: {
        branchId: branchHN.id,
        customerId: demo.customerId,
        totalWeightKg,
        totalVolumeM3: Math.round(totalVolumeM3 * 1000) / 1000,
        totalPackages,
      },
      create: {
        orderNumber: demo.orderNumber,
        customerId: demo.customerId,
        branchId: branchHN.id,
        status: OrderStatus.CONFIRMED,
        totalWeightKg,
        totalVolumeM3: Math.round(totalVolumeM3 * 1000) / 1000,
        totalPackages,
        notes: 'Dữ liệu giả lập phục vụ demo optimizer đa kiện; không phải đơn vận hành thật.',
        items: {
          create: demo.items.map((item) => ({
            ...item,
            volumeM3:
              (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
          })),
        },
        stops: {
          create: [
            {
              type: StopType.PICKUP,
              sequence: 1,
              address: demo.pickup[0],
              latitude: demo.pickup[1],
              longitude: demo.pickup[2],
              contactName: `Kho xuất demo ${index + 1}`,
              contactPhone: `09010000${index + 1}`,
              serviceDurationMinutes: 20,
            },
            {
              type: StopType.DELIVERY,
              sequence: 2,
              address: demo.delivery[0],
              latitude: demo.delivery[1],
              longitude: demo.delivery[2],
              contactName: `Điểm nhận demo ${index + 1}`,
              contactPhone: `09110000${index + 1}`,
              serviceDurationMinutes: 20,
            },
          ],
        },
      },
    });

    // Đồng bộ lại items nếu đơn đang ở trạng thái CONFIRMED và chưa có allocation giữ hàng.
    const existingAllocCount = await prisma.allocation.count({
      where: { orderItem: { orderId: demoOrder.id } },
    });
    if (existingAllocCount === 0 && demoOrder.status === OrderStatus.CONFIRMED) {
      await prisma.package.deleteMany({ where: { orderItem: { orderId: demoOrder.id } } });
      await prisma.orderItem.deleteMany({ where: { orderId: demoOrder.id } });
      for (const item of demo.items) {
        const createdItem = await prisma.orderItem.create({
          data: {
            orderId: demoOrder.id,
            ...item,
            volumeM3:
              (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
          },
        });
        const unitWeightG = Math.max(
          1000,
          Math.round((item.weightKg / item.quantity) * 1000),
        );
        const maxTopLoadG = Math.round(unitWeightG * 0.5);
        await prisma.package.createMany({
          data: Array.from({ length: item.quantity }, (_, qIdx) => ({
            orderItemId: createdItem.id,
            packageCode: `${demo.orderNumber}-${item.sku}-${qIdx + 1}`,
            lengthMm: Math.round(item.lengthCm * 10),
            widthMm: Math.round(item.widthCm * 10),
            heightMm: Math.round(item.heightCm * 10),
            weightG: BigInt(unitWeightG),
            cargoKind: 'STANDARD',
            allowUpperTier: true,
            noTopLoadRequested: false,
            maxTopLoadG,
            measurementSource: 'SEED_DEMO',
            status: 'READY',
          })),
        });
      }
    }

    const orderNumIndex = Number(demo.orderNumber.split('-').pop() || '0');
    const todayIctMidnight = new Date('2026-11-25T17:00:00.000Z');
    let pStartH = 6;
    let pEndH = 11.5;
    let dStartH = 11.5;
    let dEndH = 20;
    if (orderNumIndex === 7 || orderNumIndex === 8 || orderNumIndex === 12 || orderNumIndex === 13) {
      pStartH = 6; pEndH = 12.5; dStartH = 12.5; dEndH = 21;
    } else if (orderNumIndex === 3 || orderNumIndex === 5) {
      pStartH = 6; pEndH = 11; dStartH = 11; dEndH = 19;
    } else if (orderNumIndex === 9 || orderNumIndex === 10 || orderNumIndex === 11 || orderNumIndex === 14) {
      pStartH = 24 + 6; pEndH = 24 + 14; dStartH = 24 + 10; dEndH = 24 + 21;
    }
    const pickupStart = new Date(todayIctMidnight.getTime() + pStartH * 3600 * 1000);
    const pickupEnd = new Date(todayIctMidnight.getTime() + pEndH * 3600 * 1000);
    const deliveryStart = new Date(todayIctMidnight.getTime() + dStartH * 3600 * 1000);
    const deliveryEnd = new Date(todayIctMidnight.getTime() + dEndH * 3600 * 1000);

    // Giữ nguyên ID stop hiện có nhưng đồng bộ lại dữ liệu demo khi địa chỉ/tọa độ/khung giờ được sửa.
    await Promise.all([
      prisma.orderStop.updateMany({
        where: { orderId: demoOrder.id, type: StopType.PICKUP },
        data: {
          address: demo.pickup[0],
          latitude: demo.pickup[1],
          longitude: demo.pickup[2],
          windowStart: pickupStart,
          windowEnd: pickupEnd,
          serviceDurationMinutes: 10,
        },
      }),
      prisma.orderStop.updateMany({
        where: { orderId: demoOrder.id, type: StopType.DELIVERY },
        data: {
          address: demo.delivery[0],
          latitude: demo.delivery[1],
          longitude: demo.delivery[2],
          windowStart: deliveryStart,
          windowEnd: deliveryEnd,
          serviceDurationMinutes: 10,
        },
      }),
    ]);
  }

  // Bộ dữ liệu miền Nam tái hiện bài toán trong hình người dùng cung cấp:
  // 3 đơn x 15 kiện 90x40 cm. Xe 1.9 tấn không chở được một đơn (2.100 kg),
  // nên optimizer phải dùng sàn xe 960x240 cm. Khung giờ buộc lấy đủ 45 kiện
  // trước khi giao lần lượt, tạo nhu cầu chừa lối ngang/dọc ra cửa sau.
  const southernAisleOrders = [
    {
      orderNumber: 'DEMO-SGN-AISLE-001',
      customerId: custPanasonic.id,
      sku: 'SGN-AISLE-RED',
      description: 'Kiện demo đỏ - đơn giao thứ nhất',
      delivery: ['Điểm giao demo Thủ Đức, TP. Hồ Chí Minh', 10.8496, 106.7719],
      deliveryWindow: ['2026-09-11T03:00:00Z', '2026-09-11T04:00:00Z'],
    },
    {
      orderNumber: 'DEMO-SGN-AISLE-002',
      customerId: custVinamilk.id,
      sku: 'SGN-AISLE-ORANGE',
      description: 'Kiện demo cam - đơn giao thứ hai',
      delivery: ['Điểm giao demo Bình Thạnh, TP. Hồ Chí Minh', 10.8036, 106.7204],
      deliveryWindow: ['2026-09-11T04:00:00Z', '2026-09-11T05:00:00Z'],
    },
    {
      orderNumber: 'DEMO-SGN-AISLE-003',
      customerId: custSunhouse.id,
      sku: 'SGN-AISLE-YELLOW',
      description: 'Kiện demo vàng - đơn giao thứ ba',
      delivery: ['Điểm giao demo Quận 7, TP. Hồ Chí Minh', 10.7305, 106.7217],
      deliveryWindow: ['2026-09-11T05:00:00Z', '2026-09-11T06:30:00Z'],
    },
  ] as const;

  for (const [index, demo] of southernAisleOrders.entries()) {
    const quantity = 15;
    const totalWeightKg = 2100;
    const totalVolumeM3 = (90 * 40 * 45 * quantity) / 1_000_000;
    await prisma.order.upsert({
      where: { orderNumber: demo.orderNumber },
      update: { branchId: branchSGN.id },
      create: {
        orderNumber: demo.orderNumber,
        customerId: demo.customerId,
        branchId: branchSGN.id,
        status: OrderStatus.CONFIRMED,
        totalWeightKg,
        totalVolumeM3,
        totalPackages: quantity,
        notes:
          '[DEMO 2D] Ba đơn x 15 kiện; lấy hết trước khi giao để kiểm tra lối di chuyển ngang/dọc ra cửa sau. Không phải đơn vận hành thật.',
        items: {
          create: [
            {
              sku: demo.sku,
              description: demo.description,
              packageType: 'CARTON',
              quantity,
              weightKg: totalWeightKg,
              lengthCm: 90,
              widthCm: 40,
              heightCm: 45,
              volumeM3: totalVolumeM3,
            },
          ],
        },
        stops: {
          create: [
            {
              type: StopType.PICKUP,
              sequence: 1,
              address: `Khu xuất hàng demo ${index + 1}, Tổng kho Sóng Thần, Dĩ An`,
              latitude: 10.8924,
              longitude: 106.7582,
              contactName: `Kho demo miền Nam ${index + 1}`,
              contactPhone: `090200000${index + 1}`,
              serviceDurationMinutes: 20,
            },
            {
              type: StopType.DELIVERY,
              sequence: 2,
              address: demo.delivery[0],
              latitude: demo.delivery[1],
              longitude: demo.delivery[2],
              contactName: `Điểm nhận demo miền Nam ${index + 1}`,
              contactPhone: `091200000${index + 1}`,
              serviceDurationMinutes: 20,
            },
          ],
        },
      },
    });
  }

  console.log(
    `✅ Đã tạo dữ liệu vận tải, ${demoOrders.length} đơn đa loại và ${southernAisleOrders.length} đơn demo lối đi 2D miền Nam.`,
  );

  const hanoiPolygon = [
    [
      [105.78781, 21.08405],
      [105.78817, 21.08046],
      [105.78578, 21.07566],
      [105.78493, 21.06712],
      [105.78175, 21.0537],
      [105.78055, 21.03823],
      [105.77847, 21.02486],
      [105.77975, 21.02047],
      [105.80342, 20.99172],
      [105.81552, 20.97525],
      [105.81793, 20.9733],
      [105.82621, 20.97049],
      [105.8345, 20.9663],
      [105.85034, 20.96552],
      [105.86568, 20.96363],
      [105.87259, 20.9643],
      [105.87618, 20.96598],
      [105.88147, 20.97245],
      [105.88806, 20.97759],
      [105.89307, 20.98353],
      [105.89476, 20.9834],
      [105.89483, 20.98664],
      [105.89205, 20.99245],
      [105.89222, 20.99637],
      [105.8837, 21.00096],
      [105.88198, 21.00125],
      [105.87939, 21.00065],
      [105.87712, 21.00189],
      [105.8718, 21.00322],
      [105.86529, 21.00943],
      [105.86361, 21.01247],
      [105.86049, 21.02467],
      [105.85479, 21.0352],
      [105.83822, 21.05265],
      [105.83292, 21.06093],
      [105.83172, 21.06406],
      [105.82914, 21.065],
      [105.82653, 21.06831],
      [105.82573, 21.07296],
      [105.82072, 21.07756],
      [105.81456, 21.08828],
      [105.81277, 21.08965],
      [105.81074, 21.09007],
      [105.79737, 21.08929],
      [105.78733, 21.09088],
      [105.78781, 21.08405],
    ],
  ];

  const existingHanZone = await prisma.loadRestrictionZone.findFirst({
    where: {
      branchId: branchHN.id,
      name: 'Nội thành Hà Nội (Vành đai 3)',
    },
  });
  if (!existingHanZone) {
    await prisma.loadRestrictionZone.create({
      data: {
        branchId: branchHN.id,
        name: 'Nội thành Hà Nội (Vành đai 3)',
        description:
          'Cấm xe tải > 2.5 tấn giờ cao điểm trong Vành đai 3 – Đê Hữu Hồng bờ Tây sông Hồng',
        active: true,
        maxPayloadKg: 2500,
        polygon: hanoiPolygon,
        curfewWindows: [
          { startTime: '06:00', endTime: '09:00' },
          { startTime: '16:00', endTime: '20:00' },
        ],
      },
    });
  }

  // 7. Khởi tạo chính sách giờ lái chuẩn VN (Luật TTATGTĐB 2024: 4h liên tục / 10h ngày / 48h tuần)
  await prisma.workPolicy.upsert({
    where: {
      code_revision: {
        code: 'VN_TTATGTDB_2024',
        revision: 1,
      },
    },
    update: {},
    create: {
      code: 'VN_TTATGTDB_2024',
      revision: 1,
      effectiveFrom: new Date('2025-01-01T00:00:00Z'),
      jurisdiction: 'VN',
      approvalReference: 'Luật TTATGTĐB 2024 (36/2024/QH15)',
      limits: {
        enabled: true,
        maxContinuousDrivingSec: 4 * 3600,
        shortRestDurationSec: 15 * 60,
        maxDailyDrivingSec: 10 * 3600,
        dailyRestDurationSec: 8 * 3600,
        maxWeeklyDrivingSec: 48 * 3600,
        minInterTripRestSec: 0,
        overnightAllowanceVnd: 0,
        restAllowanceDuringService: true,
      },
    },
  });

  // 8. Khởi tạo 30 đơn hàng, đội xe, tài xế cho Chi nhánh Miền Trung (Đà Nẵng - BRANCH-DAD)
  await seedCentralBranchData();

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
