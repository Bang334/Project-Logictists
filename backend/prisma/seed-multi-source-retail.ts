import {
  FulfillmentGroupStatus,
  LocationType,
  OrderStatus,
  OrderType,
  PackageEventType,
  PackageStatus,
  PaymentStatus,
  PrismaClient,
  StopType,
  TransportRequestStatus,
} from '@prisma/client';

export async function seedMultiSourceRetail(prisma: PrismaClient) {
  console.log('📦 Đang khởi tạo Master Data Vùng phục vụ (ServiceZone) & Đơn hàng mẫu gom đa nguồn...');

  const branchHN = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-HAN' } });
  const branchSGN = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-SGN' } });

  // 1. Tạo ServiceZone Hà Nội & TP.HCM
  const zoneHN = await prisma.serviceZone.upsert({
    where: { code: 'ZONE-HAN' },
    update: {
      name: 'Vùng phục vụ Nội thành Hà Nội',
      maxSourcesAllowed: 2,
      maxDistanceBetweenSourcesKm: 40.0,
      active: true,
    },
    create: {
      code: 'ZONE-HAN',
      name: 'Vùng phục vụ Nội thành Hà Nội',
      description: 'Phạm vi giao hàng vật liệu xây dựng và hoàn thiện nội thành Hà Nội',
      maxSourcesAllowed: 2,
      maxDistanceBetweenSourcesKm: 40.0,
      active: true,
      version: 1,
    },
  });

  const zoneSGN = await prisma.serviceZone.upsert({
    where: { code: 'ZONE-SGN' },
    update: {
      name: 'Vùng phục vụ TP. Hồ Chí Minh & Đông Nam Bộ',
      maxSourcesAllowed: 2,
      maxDistanceBetweenSourcesKm: 40.0,
      active: true,
    },
    create: {
      code: 'ZONE-SGN',
      name: 'Vùng phục vụ TP. Hồ Chí Minh & Đông Nam Bộ',
      description: 'Phạm vi gom hàng đa nguồn và giao công trình TP.HCM, Dĩ An, Thủ Đức',
      maxSourcesAllowed: 2,
      maxDistanceBetweenSourcesKm: 40.0,
      active: true,
      version: 1,
    },
  });

  // 2. Gán Tỉnh thành phục vụ
  await prisma.serviceZoneProvince.upsert({
    where: { zoneId_provinceCode: { zoneId: zoneHN.id, provinceCode: '01' } },
    update: {},
    create: { zoneId: zoneHN.id, provinceCode: '01', provinceName: 'Thành phố Hà Nội' },
  });

  await prisma.serviceZoneProvince.upsert({
    where: { zoneId_provinceCode: { zoneId: zoneSGN.id, provinceCode: '79' } },
    update: {},
    create: { zoneId: zoneSGN.id, provinceCode: '79', provinceName: 'Thành phố Hồ Chí Minh' },
  });

  await prisma.serviceZoneProvince.upsert({
    where: { zoneId_provinceCode: { zoneId: zoneSGN.id, provinceCode: '74' } },
    update: {},
    create: { zoneId: zoneSGN.id, provinceCode: '74', provinceName: 'Tỉnh Bình Dương' },
  });

  // 3. Gán các Cửa hàng / Kho nguồn vào ServiceZone
  const storeHN = await prisma.location.findFirst({ where: { code: 'STORE-HN-01' } });
  if (storeHN) {
    await prisma.storeServiceZone.upsert({
      where: { locationId_zoneId: { locationId: storeHN.id, zoneId: zoneHN.id } },
      update: { maxDeliveryDistanceKm: 35 },
      create: { locationId: storeHN.id, zoneId: zoneHN.id, maxDeliveryDistanceKm: 35 },
    });
  }

  const storeSGN = await prisma.location.findFirst({ where: { code: 'STORE-SGN-01' } });
  if (storeSGN) {
    await prisma.storeServiceZone.upsert({
      where: { locationId_zoneId: { locationId: storeSGN.id, zoneId: zoneSGN.id } },
      update: { maxDeliveryDistanceKm: 35 },
      create: { locationId: storeSGN.id, zoneId: zoneSGN.id, maxDeliveryDistanceKm: 35 },
    });
  }

  const whSGN = await prisma.location.findFirst({ where: { code: 'WH-SGN-01' } });
  if (whSGN) {
    await prisma.storeServiceZone.upsert({
      where: { locationId_zoneId: { locationId: whSGN.id, zoneId: zoneSGN.id } },
      update: { maxDeliveryDistanceKm: 45 },
      create: { locationId: whSGN.id, zoneId: zoneSGN.id, maxDeliveryDistanceKm: 45 },
    });
  }

  console.log('✅ Đã tạo Vùng phục vụ & liên kết Tỉnh/Cửa hàng.');

  // 4. Tạo 1 Đơn hàng mẫu gom hàng đa nguồn (2 nguồn: WH-SGN-01 và STORE-SGN-01)
  if (whSGN && storeSGN) {
    const customer = await prisma.customer.findFirst({ where: { phone: '0900000001' } });
    const skuTiles = await prisma.sku.findFirst({ where: { skuCode: 'GACH-VIG-6060' } });
    const skuDulux = await prisma.sku.findFirst({ where: { skuCode: 'SON-DULUX-5L' } });

    if (customer && skuTiles && skuDulux) {
      const now = new Date();
      const deliveryWindowStart = new Date(now.getTime() + 2 * 3600 * 1000);
      const deliveryWindowEnd = new Date(now.getTime() + 5 * 3600 * 1000);

      // Điểm giao hàng công trình tại Quận 2
      const customerDeliveryAddress = 'Công trình Biệt thự An Phú, TP. Thủ Đức, TP. Hồ Chí Minh';
      const customerLat = 10.8012;
      const customerLng = 106.7415;

      const orderNumber = 'SO-MULTI-DEMO-001';
      let order = await prisma.order.findUnique({
        where: { orderNumber },
        include: { stops: true, items: true, fulfillmentGroups: true },
      });

      if (!order) {
        order = await prisma.order.create({
          data: {
            orderNumber,
            orderType: OrderType.RETAIL_DELIVERY,
            customerId: customer.id,
            branchId: branchSGN.id,
            status: OrderStatus.CONFIRMED,
            paymentStatus: PaymentStatus.COMPLETED,
            paymentMethod: 'BANK_TRANSFER',
            subtotal: 12500000,
            totalAmount: 12500000,
            totalWeightKg: 850,
            totalVolumeM3: 1.2,
            totalPackages: 2,
            maxSourcesAllowed: 2,
            maxDistanceBetweenSourcesKm: 40.0,
            serviceZoneSnapshotId: zoneSGN.id,
            notes: 'Đơn hàng gom đa nguồn mẫu: Gạch từ Kho Sóng Thần + Sơn từ Cửa hàng Thủ Đức.',
            items: {
              create: [
                {
                  skuId: skuTiles.id,
                  sku: skuTiles.skuCode,
                  description: skuTiles.name,
                  quantity: 20,
                  unitPrice: skuTiles.salePrice,
                  lineTotal: skuTiles.salePrice.mul(20),
                  weightKg: 500,
                  lengthCm: 60,
                  widthCm: 60,
                  heightCm: 50,
                  volumeM3: 0.7,
                },
                {
                  skuId: skuDulux.id,
                  sku: skuDulux.skuCode,
                  description: skuDulux.name,
                  quantity: 10,
                  unitPrice: skuDulux.salePrice,
                  lineTotal: skuDulux.salePrice.mul(10),
                  weightKg: 350,
                  lengthCm: 32,
                  widthCm: 32,
                  heightCm: 38,
                  volumeM3: 0.5,
                },
              ],
            },
            stops: {
              create: [
                {
                  type: StopType.PICKUP,
                  sequence: 1,
                  address: whSGN.address,
                  latitude: whSGN.latitude,
                  longitude: whSGN.longitude,
                  contactName: whSGN.name,
                  contactPhone: '028.3729.8899',
                  serviceDurationMinutes: 20,
                },
                {
                  type: StopType.PICKUP,
                  sequence: 2,
                  address: storeSGN.address,
                  latitude: storeSGN.latitude,
                  longitude: storeSGN.longitude,
                  contactName: storeSGN.name,
                  contactPhone: '028.3888.1122',
                  serviceDurationMinutes: 15,
                },
                {
                  type: StopType.DELIVERY,
                  sequence: 3,
                  address: customerDeliveryAddress,
                  latitude: customerLat,
                  longitude: customerLng,
                  contactName: customer.name,
                  contactPhone: customer.phone,
                  windowBasis: 'SERVICE_START',
                  windowStart: deliveryWindowStart,
                  windowEnd: deliveryWindowEnd,
                  serviceDurationMinutes: 30,
                },
              ],
            },
          },
          include: { stops: true, items: true, fulfillmentGroups: true },
        });

        const stopPickupA = order.stops.find((s) => s.latitude === whSGN.latitude)!;
        const stopPickupB = order.stops.find((s) => s.latitude === storeSGN.latitude)!;
        const stopDelivery = order.stops.find((s) => s.type === StopType.DELIVERY)!;

        // Tạo 2 FulfillmentGroup gắn pickupStopId
        const fgA = await prisma.fulfillmentGroup.create({
          data: {
            groupNumber: `${order.orderNumber}-G1`,
            orderId: order.id,
            sourceLocationId: whSGN.id,
            pickupStopId: stopPickupA.id,
            status: FulfillmentGroupStatus.PACKED,
            lines: {
              create: [
                {
                  orderItemId: order.items[0].id,
                  skuId: skuTiles.id,
                  requestedQuantity: 20,
                  reservedQuantity: 20,
                  packedQuantity: 20,
                },
              ],
            },
          },
        });

        const fgB = await prisma.fulfillmentGroup.create({
          data: {
            groupNumber: `${order.orderNumber}-G2`,
            orderId: order.id,
            sourceLocationId: storeSGN.id,
            pickupStopId: stopPickupB.id,
            status: FulfillmentGroupStatus.PACKED,
            lines: {
              create: [
                {
                  orderItemId: order.items[1].id,
                  skuId: skuDulux.id,
                  requestedQuantity: 10,
                  reservedQuantity: 10,
                  packedQuantity: 10,
                },
              ],
            },
          },
        });

        // Tạo 2 Kiện vật lý đã đo đạc (READY)
        const pkgA = await prisma.package.create({
          data: {
            orderId: order.id,
            packageCode: 'PKG-MULTI-01-TILES',
            lengthMm: 1200,
            widthMm: 800,
            heightMm: 750,
            weightG: BigInt(500000), // 500 kg
            allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
            measurementSource: 'MANUAL_MEASURED',
            status: PackageStatus.READY,
            items: {
              create: [{ orderItemId: order.items[0].id, quantity: 20 }],
            },
            events: {
              create: [{ eventType: PackageEventType.PACKED, locationId: whSGN.id }],
            },
          },
        });

        const pkgB = await prisma.package.create({
          data: {
            orderId: order.id,
            packageCode: 'PKG-MULTI-02-PAINT',
            lengthMm: 1100,
            widthMm: 900,
            heightMm: 800,
            weightG: BigInt(350000), // 350 kg
            allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
            measurementSource: 'MANUAL_MEASURED',
            status: PackageStatus.READY,
            items: {
              create: [{ orderItemId: order.items[1].id, quantity: 10 }],
            },
            events: {
              create: [{ eventType: PackageEventType.PACKED, locationId: storeSGN.id }],
            },
          },
        });

        // Tạo 2 TransportRequest ở trạng thái READY_FOR_ROUTING
        await prisma.transportRequest.create({
          data: {
            requestNumber: `TR-${order.orderNumber}-01`,
            orderId: order.id,
            fulfillmentGroupId: fgA.id,
            sourceLocationId: whSGN.id,
            pickupStopId: stopPickupA.id,
            deliveryStopId: stopDelivery.id,
            status: TransportRequestStatus.READY_FOR_ROUTING,
            packages: {
              create: [{ packageId: pkgA.id }],
            },
          },
        });

        await prisma.transportRequest.create({
          data: {
            requestNumber: `TR-${order.orderNumber}-02`,
            orderId: order.id,
            fulfillmentGroupId: fgB.id,
            sourceLocationId: storeSGN.id,
            pickupStopId: stopPickupB.id,
            deliveryStopId: stopDelivery.id,
            status: TransportRequestStatus.READY_FOR_ROUTING,
            packages: {
              create: [{ packageId: pkgB.id }],
            },
          },
        });

        console.log(`✅ Đã tạo đơn gom đa nguồn mẫu ${order.orderNumber} kèm 2 TransportRequest sẵn sàng điều phối.`);
      }
    }
  }
}
