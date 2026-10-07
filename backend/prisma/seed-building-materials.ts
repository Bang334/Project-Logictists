import {
  LocationType,
  OrderStatus,
  OrderType,
  PaymentStatus,
  PrismaClient,
  ProductStatus,
  SkuStatus,
  StorageCondition,
} from '@prisma/client';

export async function seedBuildingMaterials(prisma: PrismaClient) {
  console.log('🏗️ Đang nạp Master Data Vật Liệu Xây Dựng, Kho bãi, Showroom & Công trình giao tận nơi...');

  // 1. Lấy 3 chi nhánh nền tảng
  const branchHN = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-HAN' } });
  const branchDAD = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-DAD' } });
  const branchSGN = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-SGN' } });

  // 2. Tạo 5 Danh mục Vật Liệu Xây Dựng chính
  const categoriesData = [
    { code: 'STEEL', name: 'Sắt thép & Kim khí', description: 'Thép thanh vằn, thép hộp, xà gồ và tôn cuộn mạ màu' },
    { code: 'TILES', name: 'Gạch men & Gạch ốp lát', description: 'Gạch granite lát sàn, gạch ceramic ốp tường cao cấp' },
    { code: 'DOORS', name: 'Cửa & Kết cấu hoàn thiện', description: 'Cửa cuốn khe thoáng, cửa nhôm Xingfa và cửa composite' },
    { code: 'PAINT', name: 'Sơn nước & Hóa chất phủ', description: 'Sơn nội/ngoại thất cao cấp, sơn lót kháng kiềm, chống thấm' },
    { code: 'CEMENT_ADHESIVE', name: 'Xi măng & Keo dán gạch', description: 'Xi măng bao xây tô, keo dán gạch đá và bột bả' },
  ];

  const categoryMap = new Map<string, string>();
  for (const cat of categoriesData) {
    const record = await prisma.category.upsert({
      where: { code: cat.code },
      update: { name: cat.name, description: cat.description, active: true },
      create: { code: cat.code, name: cat.name, description: cat.description, active: true },
    });
    categoryMap.set(cat.code, record.id);
  }

  // 3. Danh sách 16 Sản phẩm & SKU VLXD chuẩn hóa thông số
  const vlxdProducts = [
    // SẮT THÉP
    {
      catCode: 'STEEL',
      productCode: 'PROD-THEP-D16',
      name: 'Thép thanh vằn Hòa Phát D16',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943201/tms/products/steel-rebar-d16.jpg',
      skuCode: 'THEP-HP-D16',
      barcode: '893500010016',
      uom: 'Bó',
      price: 23700000,
      weightGrams: 1580000, // 1.58 tấn
      lengthMm: 5850,
      widthMm: 250,
      heightMm: 250,
      volumeMm3: BigInt(365625000), // ~0.366 m3
    },
    {
      catCode: 'STEEL',
      productCode: 'PROD-THEP-D20',
      name: 'Thép thanh vằn Hòa Phát D20',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943202/tms/products/steel-rebar-d20.jpg',
      skuCode: 'THEP-HP-D20',
      barcode: '893500010020',
      uom: 'Bó',
      price: 18525000,
      weightGrams: 1235000, // 1.235 tấn
      lengthMm: 5850,
      widthMm: 200,
      heightMm: 200,
      volumeMm3: BigInt(234000000),
    },
    {
      catCode: 'STEEL',
      productCode: 'PROD-THEP-HOP-HS',
      name: 'Thép hộp mạ kẽm Hoa Sen 50×100×1.8mm',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943203/tms/products/steel-tube.jpg',
      skuCode: 'THEP-HOP-HS-50100',
      barcode: '893500010100',
      uom: 'Bó',
      price: 8640000,
      weightGrams: 480000, // 480 kg
      lengthMm: 6000,
      widthMm: 300,
      heightMm: 250,
      volumeMm3: BigInt(450000000),
    },
    {
      catCode: 'STEEL',
      productCode: 'PROD-TON-LOM-HS',
      name: 'Tôn lạnh mạ màu Hoa Sen dày 0.45mm (Tấm 6m)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943187/tms/products/corrugated-roof.jpg',
      skuCode: 'TON-LOM-HS-045',
      barcode: '893500010045',
      uom: 'Cuộn/Kiện',
      price: 5760000,
      weightGrams: 320000, // 320 kg
      lengthMm: 6000,
      widthMm: 1080,
      heightMm: 150,
      volumeMm3: BigInt(972000000),
    },

    // GẠCH MEN & GẠCH ỐP LÁT
    {
      catCode: 'TILES',
      productCode: 'PROD-GACH-DT-8080',
      name: 'Gạch lát nền Granite Đồng Tâm 800×800mm',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943204/tms/products/tiles-granite-8080.jpg',
      skuCode: 'GACH-DT-8080-GRANITE',
      barcode: '893500020080',
      uom: 'Hộp',
      price: 480000,
      weightGrams: 42000, // 42 kg
      lengthMm: 820,
      widthMm: 820,
      heightMm: 50,
      volumeMm3: BigInt(33620000),
    },
    {
      catCode: 'TILES',
      productCode: 'PROD-GACH-VGC-6060',
      name: 'Gạch men lát sàn Viglacera 600×600mm',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943206/tms/products/tiles-rustic-6060.jpg',
      skuCode: 'GACH-VGC-6060-CERAMIC',
      barcode: '893500020060',
      uom: 'Hộp',
      price: 245000,
      weightGrams: 32000, // 32 kg
      lengthMm: 620,
      widthMm: 620,
      heightMm: 60,
      volumeMm3: BigInt(23064000),
    },
    {
      catCode: 'TILES',
      productCode: 'PROD-GACH-PRIME-3060',
      name: 'Gạch ốp tường Prime Ceramic 300×600mm',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943205/tms/products/tiles-marble-3060.jpg',
      skuCode: 'GACH-PRIME-3060-OP',
      barcode: '893500020030',
      uom: 'Hộp',
      price: 215000,
      weightGrams: 26500, // 26.5 kg
      lengthMm: 620,
      widthMm: 320,
      heightMm: 100,
      volumeMm3: BigInt(19840000),
    },

    // CỬA & KẾT CẤU HOÀN THIỆN
    {
      catCode: 'DOORS',
      productCode: 'PROD-CUA-AUSTDOOR',
      name: 'Cửa cuốn khe thoáng Austdoor Super S50i (Bộ kiện)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943188/tms/products/door-roller-shutter.jpg',
      skuCode: 'CUA-AUSTDOOR-S50i',
      barcode: '893500030050',
      uom: 'Bộ',
      price: 18900000,
      weightGrams: 165000, // 165 kg
      lengthMm: 3800,
      widthMm: 550,
      heightMm: 550,
      volumeMm3: BigInt(1149500000),
    },
    {
      catCode: 'DOORS',
      productCode: 'PROD-CUA-XINGFA',
      name: 'Cửa đi 4 cánh nhôm Xingfa hệ 55 kính cường lực',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943190/tms/products/door-xingfa-aluminum.jpg',
      skuCode: 'CUA-XINGFA-4CANH',
      barcode: '893500030055',
      uom: 'Bộ',
      price: 14500000,
      weightGrams: 145000, // 145 kg
      lengthMm: 2850,
      widthMm: 1250,
      heightMm: 200,
      volumeMm3: BigInt(712500000),
    },
    {
      catCode: 'DOORS',
      productCode: 'PROD-CUA-GO-COMPOSITE',
      name: 'Cửa gỗ Composite Huge chống nước vân gỗ',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943189/tms/products/door-wood-composite.jpg',
      skuCode: 'CUA-GO-COMPOSITE-N01',
      barcode: '893500030001',
      uom: 'Bộ',
      price: 4200000,
      weightGrams: 48000, // 48 kg
      lengthMm: 2250,
      widthMm: 950,
      heightMm: 150,
      volumeMm3: BigInt(320625000),
    },

    // SƠN NƯỚC & HÓA CHẤT PHỦ
    {
      catCode: 'PAINT',
      productCode: 'PROD-SON-DULUX-18L',
      name: 'Sơn nội thất cao cấp Dulux Ambiance 5in1 (Thùng 18L)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943195/tms/products/paint-dulux-ambiance.jpg',
      skuCode: 'SON-DULUX-AMB-18L',
      barcode: '893500040018',
      uom: 'Thùng/Xô',
      price: 2450000,
      weightGrams: 24500, // 24.5 kg
      lengthMm: 320,
      widthMm: 320,
      heightMm: 380,
      volumeMm3: BigInt(38912000),
    },
    {
      catCode: 'PAINT',
      productCode: 'PROD-SON-JOTUN-15L',
      name: 'Sơn ngoại thất cao cấp Jotun Jotashield Bền Màu (15L)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943196/tms/products/paint-jotun-exterior.jpg',
      skuCode: 'SON-JOTUN-SHIELD-15L',
      barcode: '893500040015',
      uom: 'Thùng/Xô',
      price: 2850000,
      weightGrams: 21000, // 21 kg
      lengthMm: 300,
      widthMm: 300,
      heightMm: 360,
      volumeMm3: BigInt(32400000),
    },
    {
      catCode: 'PAINT',
      productCode: 'PROD-SON-KOVA-20KG',
      name: 'Sơn lót kháng kiềm ngoại thất Kova K-209 (Thùng 20kg)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943198/tms/products/paint-kova-primer.jpg',
      skuCode: 'SON-KOVA-K209-20KG',
      barcode: '893500040020',
      uom: 'Thùng/Xô',
      price: 1680000,
      weightGrams: 22000, // 22 kg
      lengthMm: 320,
      widthMm: 320,
      heightMm: 380,
      volumeMm3: BigInt(38912000),
    },
    {
      catCode: 'PAINT',
      productCode: 'PROD-CHONG-THAM-SIKA',
      name: 'Hợp chất chống thấm đàn hồi Sika Raintite (Thùng 20kg)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943211/tms/products/waterproof-sika.jpg',
      skuCode: 'CHONG-THAM-SIKA-20KG',
      barcode: '893500040022',
      uom: 'Thùng/Xô',
      price: 1850000,
      weightGrams: 22500, // 22.5 kg
      lengthMm: 320,
      widthMm: 320,
      heightMm: 380,
      volumeMm3: BigInt(38912000),
    },

    // XI MĂNG & KEO DÁN GẠCH
    {
      catCode: 'CEMENT_ADHESIVE',
      productCode: 'PROD-XI-MANG-HT',
      name: 'Xi măng Vicem Hoàng Thạch PCB40 (Bao 50kg)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943162/tms/products/cement-hatien-pcb40.jpg',
      skuCode: 'XI-MANG-HT-PCB40',
      barcode: '893500050050',
      uom: 'Bao',
      price: 92000,
      weightGrams: 50000, // 50 kg
      lengthMm: 650,
      widthMm: 420,
      heightMm: 140,
      volumeMm3: BigInt(38220000),
    },
    {
      catCode: 'CEMENT_ADHESIVE',
      productCode: 'PROD-KEO-WEBER',
      name: 'Keo dán gạch đá cao cấp Weber.tai fix (Bao 25kg)',
      imageUrl: 'https://res.cloudinary.com/dwrg5ars1/image/upload/v1790943194/tms/products/mortar-weber-adhesive.jpg',
      skuCode: 'KEO-DAN-GACH-WEBER-25',
      barcode: '893500050025',
      uom: 'Bao',
      price: 280000,
      weightGrams: 25000, // 25 kg
      lengthMm: 500,
      widthMm: 350,
      heightMm: 120,
      volumeMm3: BigInt(21000000),
    },
  ];

  const skuList: any[] = [];
  for (const item of vlxdProducts) {
    const categoryId = categoryMap.get(item.catCode)!;
    const product = await prisma.product.upsert({
      where: { code: item.productCode },
      update: { name: item.name, imageUrl: item.imageUrl, categoryId },
      create: {
        code: item.productCode,
        name: item.name,
        imageUrl: item.imageUrl,
        categoryId,
        status: ProductStatus.ACTIVE,
      },
    });

    const sku = await prisma.sku.upsert({
      where: { skuCode: item.skuCode },
      update: {
        name: item.name,
        barcode: item.barcode,
        salePrice: item.price,
        uom: item.uom,
        weightGrams: item.weightGrams,
        lengthMm: item.lengthMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        volumeMm3: item.volumeMm3,
        status: SkuStatus.ACTIVE,
        isSellable: true,
      },
      create: {
        productId: product.id,
        skuCode: item.skuCode,
        name: item.name,
        barcode: item.barcode,
        salePrice: item.price,
        uom: item.uom,
        weightGrams: item.weightGrams,
        lengthMm: item.lengthMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        volumeMm3: item.volumeMm3,
        storageCondition: StorageCondition.AMBIENT,
        status: SkuStatus.ACTIVE,
        isSellable: true,
      },
    });
    skuList.push(sku);
  }
  console.log(`✅ Đã nạp ${skuList.length} mặt hàng Vật Liệu Xây Dựng chi tiết.`);

  // 4. Mạng Lưới Tổng Kho & Showroom/Đại Lý VLXD (Locations)
  const locationsData = [
    // TỔNG KHO TRUNG TÂM (CENTRAL_WAREHOUSES)
    {
      code: 'WH-HN-01',
      name: 'Tổng Kho VLXD Miền Bắc - Long Biên',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchHN.id,
      address: 'Số 1 Huỳnh Tấn Phát, KCN Sài Đồng B, Long Biên, Hà Nội',
      latitude: 21.0345,
      longitude: 105.9082,
      capabilities: ['STORE', 'PACK', 'CROSS_DOCK'],
      totalHoldingSlots: 500,
      availableHoldingSlots: 450,
    },
    {
      code: 'WH-HY-01',
      name: 'Tổng Kho Thép & Tôn Phố Nối A',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchHN.id,
      address: 'Km 24, Quốc lộ 5, KCN Phố Nối A, Yên Mỹ, Hưng Yên',
      latitude: 20.9382,
      longitude: 106.0125,
      capabilities: ['STORE', 'PACK'],
      totalHoldingSlots: 600,
      availableHoldingSlots: 550,
    },
    {
      code: 'WH-DAD-01',
      name: 'Tổng Kho VLXD Miền Trung - Hòa Cầm',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchDAD.id,
      address: 'Đường số 3, KCN Hòa Cầm, Cẩm Lệ, Đà Nẵng',
      latitude: 16.0125,
      longitude: 108.1874,
      capabilities: ['STORE', 'PACK', 'CROSS_DOCK'],
      totalHoldingSlots: 400,
      availableHoldingSlots: 360,
    },
    {
      code: 'WH-SGN-01',
      name: 'Tổng Kho VLXD Miền Nam - Sóng Thần',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchSGN.id,
      address: 'Đại lộ Độc Lập, KCN Sóng Thần 1, Dĩ An, Bình Dương / Thủ Đức',
      latitude: 10.8924,
      longitude: 106.7582,
      capabilities: ['STORE', 'PACK', 'CROSS_DOCK'],
      totalHoldingSlots: 800,
      availableHoldingSlots: 720,
    },

    // SHOWROOM & ĐẠI LÝ PHÂN PHỐI (STORES)
    {
      code: 'STORE-HN-CG',
      name: 'Showroom VLXD & Thiết Bị Cầu Giấy',
      type: LocationType.STORE,
      managingBranchId: branchHN.id,
      address: '188 Phạm Văn Đồng, Mai Dịch, Cầu Giấy, Hà Nội',
      latitude: 21.0425,
      longitude: 105.7821,
      capabilities: ['SELL', 'PACK'],
      totalHoldingSlots: 50,
      availableHoldingSlots: 45,
    },
    {
      code: 'STORE-HN-HD',
      name: 'Đại Lý Sắt Thép & Gạch Ốp Lát Hà Đông',
      type: LocationType.STORE,
      managingBranchId: branchHN.id,
      address: '452 Quang Trung, La Khê, Hà Đông, Hà Nội',
      latitude: 20.9632,
      longitude: 105.7684,
      capabilities: ['SELL', 'PACK'],
      totalHoldingSlots: 60,
      availableHoldingSlots: 55,
    },
    {
      code: 'STORE-SGN-TD',
      name: 'Showroom Cửa & Gạch Men Thủ Đức',
      type: LocationType.STORE,
      managingBranchId: branchSGN.id,
      address: '120 Võ Văn Ngân, Bình Thọ, TP. Thủ Đức, TP.HCM',
      latitude: 10.8512,
      longitude: 106.7725,
      capabilities: ['SELL', 'PACK'],
      totalHoldingSlots: 60,
      availableHoldingSlots: 55,
    },
    {
      code: 'STORE-SGN-BT',
      name: 'Đại Lý VLXD Tây Sài Gòn - Bình Tân',
      type: LocationType.STORE,
      managingBranchId: branchSGN.id,
      address: '88 Kinh Dương Vương, An Lạc, Bình Tân, TP.HCM',
      latitude: 10.7456,
      longitude: 106.6124,
      capabilities: ['SELL', 'PACK'],
      totalHoldingSlots: 50,
      availableHoldingSlots: 45,
    },
    {
      code: 'STORE-DAD-HC',
      name: 'Showroom VLXD Hải Châu - Đà Nẵng',
      type: LocationType.STORE,
      managingBranchId: branchDAD.id,
      address: '250 Nguyễn Tri Phương, Thạc Gián, Hải Châu, Đà Nẵng',
      latitude: 16.0582,
      longitude: 108.2045,
      capabilities: ['SELL', 'PACK'],
      totalHoldingSlots: 40,
      availableHoldingSlots: 35,
    },

    // BÃI VẬT LIỆU TRUNG CHUYỂN (MATERIAL DEPOTS / PICKUP POINTS)
    {
      code: 'DEPOT-HM-01',
      name: 'Bãi Vật Liệu Trung Chuyển Hoàng Mai',
      type: LocationType.PICKUP_POINT,
      managingBranchId: branchHN.id,
      address: 'Đường Vành Đai 3, Yên Sở, Hoàng Mai, Hà Nội',
      latitude: 20.9782,
      longitude: 105.8523,
      capabilities: ['PICKUP'],
      totalHoldingSlots: 100,
      availableHoldingSlots: 90,
    },
    {
      code: 'DEPOT-NTL-01',
      name: 'Bãi Tập Kết Vật Liệu Nam Từ Liêm',
      type: LocationType.PICKUP_POINT,
      managingBranchId: branchHN.id,
      address: 'Đại lộ Thăng Long, Mễ Trì, Nam Từ Liêm, Hà Nội',
      latitude: 21.0084,
      longitude: 105.7765,
      capabilities: ['PICKUP'],
      totalHoldingSlots: 120,
      availableHoldingSlots: 110,
    },
  ];

  const locationMap = new Map<string, any>();
  for (const loc of locationsData) {
    const createdLoc = await prisma.location.upsert({
      where: { code: loc.code },
      update: {
        name: loc.name,
        type: loc.type,
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        managingBranchId: loc.managingBranchId,
      },
      create: loc,
    });
    locationMap.set(loc.code, createdLoc);
  }
  console.log(`✅ Đã nạp ${locationsData.length} Tổng kho, Showroom và Bãi vật liệu.`);

  // Cập nhật người dùng điều phối với location chính thức
  const defaultWarehouseHN = locationMap.get('WH-HN-01');
  if (defaultWarehouseHN) {
    await prisma.user.updateMany({
      where: { username: { in: ['admin', 'dispatcher_hn'] } },
      data: { locationId: defaultWarehouseHN.id },
    });
  }

  // 5. Nạp Tồn Kho (StockBalance) dồi dào cho các SKU tại các Kho & Cửa hàng
  for (const sku of skuList) {
    for (const loc of Array.from(locationMap.values())) {
      if (loc.type === LocationType.CENTRAL_WAREHOUSE || loc.type === LocationType.STORE) {
        await prisma.stockBalance.upsert({
          where: {
            skuId_locationId: { skuId: sku.id, locationId: loc.id },
          },
          update: { onHand: 150 },
          create: {
            skuId: sku.id,
            locationId: loc.id,
            onHand: 150,
            safetyBuffer: 10,
          },
        });
      }
    }
  }
  console.log('✅ Đã nạp cân đối tồn kho VLXD cho toàn hệ thống.');

  // 6. Khách Hàng Doanh Nghiệp, Nhà Thầu & Địa Chỉ Công Trình Giao Hàng Tận Nơi (CustomerAddresses)
  const customersData = [
    {
      code: 'CUS-COTECCONS',
      name: 'Công ty Cổ phần Xây dựng Coteccons',
      phone: '0903112233',
      email: 'supply@coteccons.vn',
      address: '236/6 Điện Biên Phủ, Phường 17, Bình Thạnh, TP.HCM',
      sites: [
        {
          label: 'Dự án Chung cư Masteri Waterfront',
          recipientName: 'Kỹ sư trưởng Lê Hữu Đạt',
          phone: '0912445566',
          address: 'Khu đô thị Vinhomes Ocean Park, Đa Tốn, Gia Lâm, Hà Nội',
          latitude: 20.9924,
          longitude: 105.9456,
        },
        {
          label: 'Dự án Đại đô thị The Global City',
          recipientName: 'Chỉ huy trưởng Nguyễn Tuấn Anh',
          phone: '0913778899',
          address: 'Đường Đỗ Xuân Hợp, Phường An Phú, TP. Thủ Đức, TP.HCM',
          latitude: 10.7982,
          longitude: 106.7645,
        },
      ],
    },
    {
      code: 'CUS-HOABINH',
      name: 'Tập đoàn Xây dựng Hòa Bình',
      phone: '0908223344',
      email: 'procurement@hbcg.vn',
      address: 'Tòa nhà Pax Sky, 123 Nguyễn Đình Chiểu, Quận 3, TP.HCM',
      sites: [
        {
          label: 'Công trình Tổ hợp Green Diamond 93 Láng Hạ',
          recipientName: 'Kỹ sư quản lý Hoàng Văn Lâm',
          phone: '0988112233',
          address: '93 Láng Hạ, Chợ Dừa, Đống Đa, Hà Nội',
          latitude: 21.0182,
          longitude: 105.8145,
        },
        {
          label: 'Dự án Khu phức hợp Novotel Beachfront',
          recipientName: 'Kỹ sư Trần Đức Trọng',
          phone: '0935123456',
          address: 'Võ Nguyên Giáp, Phước Mỹ, Sơn Trà, Đà Nẵng',
          latitude: 16.0654,
          longitude: 108.2456,
        },
      ],
    },
    {
      code: 'CUS-UNICONS',
      name: 'Công ty TNHH Đầu tư Xây dựng Unicons',
      phone: '0905334455',
      email: 'vattu@unicons.com.vn',
      address: 'Tầng 5, Tòa nhà Coteccons, Bình Thạnh, TP.HCM',
      sites: [
        {
          label: 'Dự án Nhà xưởng công nghiệp KCN Yên Phong',
          recipientName: 'Đội trưởng xây dựng Bùi Quốc Toàn',
          phone: '0977889900',
          address: 'Lô CN-08, KCN Yên Phong, Yên Trung, Yên Phong, Bắc Ninh',
          latitude: 21.2156,
          longitude: 105.9845,
        },
      ],
    },
    {
      code: 'CUS-RESIDENTIAL-HN',
      name: 'Chủ biệt thự Vinhomes Riverside - Ông Phạm Quốc Bảo',
      phone: '0912888999',
      email: 'baopq@residence.vn',
      address: 'Khu Hoa Lan 06-18, KĐT Vinhomes Riverside, Long Biên, Hà Nội',
      sites: [
        {
          label: 'Công trình hoàn thiện Biệt thự Hoa Lan 06',
          recipientName: 'Chủ nhà - Anh Phạm Quốc Bảo',
          phone: '0912888999',
          address: 'Số 18 Đường Hoa Lan 06, KĐT Vinhomes Riverside, Phúc Đồng, Long Biên, Hà Nội',
          latitude: 21.0489,
          longitude: 105.9123,
        },
      ],
    },
  ];

  const customerMap = new Map<string, any>();
  const siteMap = new Map<string, any>();

  for (const cData of customersData) {
    const customer = await prisma.customer.upsert({
      where: { code: cData.code },
      update: { name: cData.name, phone: cData.phone, email: cData.email, address: cData.address },
      create: { code: cData.code, name: cData.name, phone: cData.phone, email: cData.email, address: cData.address },
    });
    customerMap.set(cData.code, customer);

    for (const site of cData.sites) {
      const addr = await prisma.customerAddress.create({
        data: {
          customerId: customer.id,
          label: site.label,
          recipientName: site.recipientName,
          phone: site.phone,
          address: site.address,
          latitude: site.latitude,
          longitude: site.longitude,
          isDefault: true,
        },
      });
      siteMap.set(site.label, addr);
    }
  }
  console.log('✅ Đã tạo các nhà thầu và địa chỉ công trình xây dựng thực tế.');

  // 7. Tạo Các Đơn Hàng Vận Tải VLXD Giao Tận Chân Công Trình (RETAIL_DELIVERY / B2B_TRANSPORT)
  const skuD16 = skuList.find((s) => s.skuCode === 'THEP-HP-D16');
  const skuAustdoor = skuList.find((s) => s.skuCode === 'CUA-AUSTDOOR-S50i');
  const skuDulux = skuList.find((s) => s.skuCode === 'SON-DULUX-AMB-18L');
  const skuJotun = skuList.find((s) => s.skuCode === 'SON-JOTUN-SHIELD-15L');
  const skuCement = skuList.find((s) => s.skuCode === 'XI-MANG-HT-PCB40');
  const skuXingfa = skuList.find((s) => s.skuCode === 'CUA-XINGFA-4CANH');

  const whHN = locationMap.get('WH-HN-01');
  const storeCG = locationMap.get('STORE-HN-CG');
  const whSGN = locationMap.get('WH-SGN-01');

  // Đơn 1: Thép + Xi măng giao tận công trình Masteri Waterfront (Gia Lâm, HN)
  const siteMasteri = siteMap.get('Dự án Chung cư Masteri Waterfront');
  const custCotec = customerMap.get('CUS-COTECCONS');

  if (siteMasteri && custCotec && whHN && skuD16 && skuCement) {
    const items = [
      {
        skuId: skuD16.id,
        sku: skuD16.skuCode,
        description: skuD16.name,
        quantity: 2, // 2 bó thép = 3,160 kg
        unitPrice: skuD16.salePrice,
        lineTotal: skuD16.salePrice.mul(2),
        weightKg: 3160,
        lengthCm: 585,
        widthCm: 25,
        heightCm: 25,
        volumeM3: 0.732,
      },
      {
        skuId: skuCement.id,
        sku: skuCement.skuCode,
        description: skuCement.name,
        quantity: 20, // 20 bao xi măng = 1,000 kg
        unitPrice: skuCement.salePrice,
        lineTotal: skuCement.salePrice.mul(20),
        weightKg: 1000,
        lengthCm: 65,
        widthCm: 42,
        heightCm: 14,
        volumeM3: 0.764,
      },
    ];

    const totalWeight = items.reduce((s, it) => s + it.weightKg, 0); // 4,160 kg (vừa vặn xe 5T)
    const totalVolume = items.reduce((s, it) => s + it.volumeM3, 0); // 1.496 m3

    await prisma.order.upsert({
      where: { orderNumber: 'VLXD-2026-001' },
      update: {},
      create: {
        orderNumber: 'VLXD-2026-001',
        orderType: OrderType.RETAIL_DELIVERY,
        customerId: custCotec.id,
        branchId: branchHN.id,
        allocatedSourceId: whHN.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.COMPLETED,
        paymentMethod: 'BANK_TRANSFER',
        subtotal: 49240000,
        totalAmount: 49240000,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        totalPackages: 22,
        notes: 'Giao tận chân tháp căn hộ Masteri Waterfront. Yêu cầu xe thùng dài xếp thép đáy thùng.',
        items: { create: items },
        stops: {
          create: [
            {
              type: 'PICKUP',
              sequence: 1,
              address: whHN.address,
              latitude: whHN.latitude,
              longitude: whHN.longitude,
              contactName: whHN.name,
              contactPhone: '024.3875.1234',
              serviceDurationMinutes: 30,
            },
            {
              type: 'DELIVERY',
              sequence: 2,
              address: siteMasteri.address,
              latitude: siteMasteri.latitude!,
              longitude: siteMasteri.longitude!,
              contactName: siteMasteri.recipientName,
              contactPhone: siteMasteri.phone,
              serviceDurationMinutes: 45,
            },
          ],
        },
        packages: {
          create: [
            {
              packageCode: 'PKG-VLXD01-001',
              lengthMm: 5850,
              widthMm: 250,
              heightMm: 250,
              weightG: BigInt(1580000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
            {
              packageCode: 'PKG-VLXD01-002',
              lengthMm: 5850,
              widthMm: 250,
              heightMm: 250,
              weightG: BigInt(1580000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
            {
              packageCode: 'PKG-VLXD01-003',
              lengthMm: 1200,
              widthMm: 1000,
              heightMm: 800,
              weightG: BigInt(1000000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
          ],
        },
      },
    });
  }

  // Đơn 2: Cửa nhôm Xingfa + Sơn Jotun giao Biệt thự Hoa Lan 06 Vinhomes Riverside
  const siteVinhomes = siteMap.get('Công trình hoàn thiện Biệt thự Hoa Lan 06');
  const custResHN = customerMap.get('CUS-RESIDENTIAL-HN');

  if (siteVinhomes && custResHN && storeCG && skuXingfa && skuJotun && skuAustdoor) {
    const items = [
      {
        skuId: skuAustdoor.id,
        sku: skuAustdoor.skuCode,
        description: skuAustdoor.name,
        quantity: 1, // 165 kg
        unitPrice: skuAustdoor.salePrice,
        lineTotal: skuAustdoor.salePrice,
        weightKg: 165,
        lengthCm: 380,
        widthCm: 55,
        heightCm: 55,
        volumeM3: 1.15,
      },
      {
        skuId: skuXingfa.id,
        sku: skuXingfa.skuCode,
        description: skuXingfa.name,
        quantity: 2, // 290 kg
        unitPrice: skuXingfa.salePrice,
        lineTotal: skuXingfa.salePrice.mul(2),
        weightKg: 290,
        lengthCm: 285,
        widthCm: 125,
        heightCm: 20,
        volumeM3: 1.42,
      },
      {
        skuId: skuJotun.id,
        sku: skuJotun.skuCode,
        description: skuJotun.name,
        quantity: 10, // 210 kg
        unitPrice: skuJotun.salePrice,
        lineTotal: skuJotun.salePrice.mul(10),
        weightKg: 210,
        lengthCm: 30,
        widthCm: 30,
        heightCm: 36,
        volumeM3: 0.32,
      },
    ];

    await prisma.order.upsert({
      where: { orderNumber: 'VLXD-2026-002' },
      update: {},
      create: {
        orderNumber: 'VLXD-2026-002',
        orderType: OrderType.RETAIL_DELIVERY,
        customerId: custResHN.id,
        branchId: branchHN.id,
        allocatedSourceId: storeCG.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.COMPLETED,
        paymentMethod: 'ONLINE_QR',
        subtotal: 76400000,
        totalAmount: 76400000,
        totalWeightKg: 665,
        totalVolumeM3: 2.89,
        totalPackages: 13,
        notes: 'Giao trực tiếp cổng biệt thự Hoa Lan 06. Hàng cửa nhôm kính cần cẩn thận chèn đệm.',
        items: { create: items },
        stops: {
          create: [
            {
              type: 'PICKUP',
              sequence: 1,
              address: storeCG.address,
              latitude: storeCG.latitude,
              longitude: storeCG.longitude,
              contactName: storeCG.name,
              contactPhone: '024.3736.6676',
              serviceDurationMinutes: 25,
            },
            {
              type: 'DELIVERY',
              sequence: 2,
              address: siteVinhomes.address,
              latitude: siteVinhomes.latitude!,
              longitude: siteVinhomes.longitude!,
              contactName: siteVinhomes.recipientName,
              contactPhone: siteVinhomes.phone,
              serviceDurationMinutes: 30,
            },
          ],
        },
        packages: {
          create: [
            {
              packageCode: 'PKG-VLXD02-001',
              lengthMm: 3800,
              widthMm: 550,
              heightMm: 550,
              weightG: BigInt(165000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
            {
              packageCode: 'PKG-VLXD02-002',
              lengthMm: 2850,
              widthMm: 1250,
              heightMm: 200,
              weightG: BigInt(145000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
            {
              packageCode: 'PKG-VLXD02-003',
              lengthMm: 2850,
              widthMm: 1250,
              heightMm: 200,
              weightG: BigInt(145000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
          ],
        },
      },
    });
  }

  // Đơn 4: Sơn Dulux giao Đại đô thị The Global City (Thủ Đức, TP.HCM)
  const siteGlobalCity = siteMap.get('Dự án Đại đô thị The Global City');
  if (siteGlobalCity && custCotec && whSGN && skuDulux) {
    const items = [
      {
        skuId: skuDulux.id,
        sku: skuDulux.skuCode,
        description: skuDulux.name,
        quantity: 40, // 980 kg, ~1.56 m3
        unitPrice: skuDulux.salePrice,
        lineTotal: skuDulux.salePrice.mul(40),
        weightKg: 980,
        lengthCm: 32,
        widthCm: 32,
        heightCm: 38,
        volumeM3: 1.56,
      },
    ];

    await prisma.order.upsert({
      where: { orderNumber: 'VLXD-2026-004' },
      update: {},
      create: {
        orderNumber: 'VLXD-2026-004',
        orderType: OrderType.RETAIL_DELIVERY,
        customerId: custCotec.id,
        branchId: branchSGN.id,
        allocatedSourceId: whSGN.id,
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.COMPLETED,
        paymentMethod: 'BANK_TRANSFER',
        subtotal: 98000000,
        totalAmount: 98000000,
        totalWeightKg: 980,
        totalVolumeM3: 1.56,
        totalPackages: 40,
        notes: 'Giao trực tiếp kho tập kết vật tư phân khu Soho The Global City.',
        items: { create: items },
        stops: {
          create: [
            {
              type: 'PICKUP',
              sequence: 1,
              address: whSGN.address,
              latitude: whSGN.latitude,
              longitude: whSGN.longitude,
              contactName: whSGN.name,
              contactPhone: '028.3729.8899',
              serviceDurationMinutes: 25,
            },
            {
              type: 'DELIVERY',
              sequence: 2,
              address: siteGlobalCity.address,
              latitude: siteGlobalCity.latitude!,
              longitude: siteGlobalCity.longitude!,
              contactName: siteGlobalCity.recipientName,
              contactPhone: siteGlobalCity.phone,
              serviceDurationMinutes: 35,
            },
          ],
        },
        packages: {
          create: [
            {
              packageCode: 'PKG-VLXD04-PALLET-01',
              lengthMm: 1200,
              widthMm: 1000,
              heightMm: 950,
              weightG: BigInt(980000),
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              status: 'READY',
              measurementSource: 'AUTO_ORDER',
            },
          ],
        },
      },
    });
  }

  console.log('✅ Hoàn tất khởi tạo toàn bộ Master Data & Đơn Hàng Vật Liệu Xây Dựng giao tận nơi!');
}
