import { LocationType, OrderStatus, OrderType, PackageEventType, PackageStatus, PaymentStatus, PrismaClient } from '@prisma/client';

export async function seedRetailPilotFlow(prisma: PrismaClient) {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-HAN' } });
  const southernBranch = await prisma.branch.findUniqueOrThrow({ where: { code: 'BRANCH-SGN' } });
  const store = await prisma.location.upsert({ where: { code: 'STORE-HN-01' }, update: {}, create: { code: 'STORE-HN-01', name: 'Cửa hàng Hà Nội', type: LocationType.STORE, managingBranchId: branch.id, address: 'Long Biên, Hà Nội', latitude: 21.0345, longitude: 105.9082, capabilities: ['SELL', 'PACK'], totalHoldingSlots: 20, availableHoldingSlots: 20 } });
  const southernStore = await prisma.location.upsert({ where: { code: 'STORE-SGN-01' }, update: { name: 'Cửa hàng Thành phố Hồ Chí Minh', address: 'Thủ Đức, Thành phố Hồ Chí Minh' }, create: { code: 'STORE-SGN-01', name: 'Cửa hàng Thành phố Hồ Chí Minh', type: LocationType.STORE, managingBranchId: southernBranch.id, address: 'Thủ Đức, Thành phố Hồ Chí Minh', latitude: 10.8494, longitude: 106.7537, capabilities: ['SELL', 'PACK'], totalHoldingSlots: 20, availableHoldingSlots: 20 } });
  await prisma.user.updateMany({ where: { username: { in: ['admin', 'dispatcher_hn'] } }, data: { locationId: store.id } });
  await prisma.user.updateMany({ where: { username: 'dispatcher_sgn' }, data: { locationId: southernStore.id } });
  const pickup = await prisma.location.upsert({ where: { code: 'PICKUP-HN-01' }, update: {}, create: { code: 'PICKUP-HN-01', name: 'Điểm nhận Hà Nội', type: LocationType.PICKUP_POINT, managingBranchId: branch.id, address: 'Hoàn Kiếm, Hà Nội', latitude: 21.0285, longitude: 105.8542, capabilities: ['PICKUP'], totalHoldingSlots: 50, availableHoldingSlots: 49 } });
  const customer = await prisma.customer.upsert({ where: { phone: '0900000001' }, update: {}, create: { code: 'CUS-DEMO-001', name: 'Khách hàng Demo VLXD', phone: '0900000001', address: 'Hà Nội' } });
  
  // Dùng SKU Thép Hòa Phát D16 thay cho gạo cũ
  const sku = await prisma.sku.findUniqueOrThrow({ where: { skuCode: 'THEP-HP-D16' } });
  await prisma.stockBalance.upsert({ where: { skuId_locationId: { skuId: sku.id, locationId: store.id } }, update: { onHand: 100 }, create: { skuId: sku.id, locationId: store.id, onHand: 100, safetyBuffer: 5 } });
  const order = await prisma.order.upsert({
    where: { orderNumber: 'SO-DEMO-001' },
    update: {},
    create: { orderNumber: 'SO-DEMO-001', orderType: OrderType.RETAIL_PICKUP, customerId: customer.id, branchId: branch.id, selectedPickupPointId: pickup.id, allocatedSourceId: store.id, status: OrderStatus.ASSIGNED, paymentStatus: PaymentStatus.COMPLETED, subtotal: 47400000, totalAmount: 47400000, totalWeightKg: 3160, totalVolumeM3: 0.732, totalPackages: 1, items: { create: { skuId: sku.id, sku: sku.skuCode, description: sku.name, quantity: 2, unitPrice: 23700000, lineTotal: 47400000, weightKg: 3160, lengthCm: 585, widthCm: 25, heightCm: 25, volumeM3: 0.732 } } },
    include: { items: true },
  });
  const pkg = await prisma.package.upsert({ where: { packageCode: 'PKG-DEMO-001' }, update: {}, create: { orderId: order.id, packageCode: 'PKG-DEMO-001', lengthMm: 5850, widthMm: 250, heightMm: 250, weightG: BigInt(3160000), allowedOrientations: ['DEFAULT', 'ROTATE_YAW'], measurementSource: 'SEED', status: PackageStatus.READY, items: { create: { orderItemId: order.items[0].id, quantity: 2 } }, events: { create: { eventType: PackageEventType.PACKED, locationId: store.id } } } });
  await prisma.transferShipment.upsert({ where: { packageId: pkg.id }, update: {}, create: { shipmentNumber: 'TRF-DEMO-001', packageId: pkg.id, sourceLocationId: store.id, destinationPickupPointId: pickup.id } });
}
