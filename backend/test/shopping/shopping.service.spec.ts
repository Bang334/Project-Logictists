import { Test, TestingModule } from '@nestjs/testing';
import { ShoppingService } from '../../src/shopping/shopping.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MapboxService } from '../../src/mapbox/mapbox.service';
import { BadRequestException } from '@nestjs/common';

describe('ShoppingService', () => {
  let service: ShoppingService;
  let prisma: any;
  let mapbox: any;

  const mockStoreA = {
    id: 'store-a',
    code: 'HN-STORE-01',
    name: 'Cửa hàng Đống Đa',
    type: 'STORE',
    address: 'Đống Đa, Hà Nội',
    latitude: 21.01,
    longitude: 105.82,
    maxDeliveryDistanceKm: 100,
    active: true,
  };

  const mockStoreB = {
    id: 'store-b',
    code: 'HN-STORE-02',
    name: 'Cửa hàng Cầu Giấy',
    type: 'STORE',
    address: 'Cầu Giấy, Hà Nội',
    latitude: 21.03,
    longitude: 105.78,
    maxDeliveryDistanceKm: 100,
    active: true,
  };

  const mockStoreFar = {
    id: 'store-far',
    code: 'HN-STORE-FAR',
    name: 'Cửa hàng Sơn Tây',
    type: 'STORE',
    address: 'Sơn Tây, Hà Nội',
    latitude: 21.14,
    longitude: 105.20, // Cách Cầu Giấy/Đống Đa ~65km (> 40km)
    maxDeliveryDistanceKm: 100,
    active: true,
  };

  const mockZoneProvinces = [
    {
      id: 'zp-1',
      zoneId: 'zone-north',
      provinceCode: 'HN',
      provinceName: 'Hà Nội',
      zone: {
        id: 'zone-north',
        code: 'NORTH_ZONE',
        name: 'Vùng Miền Bắc',
        active: true,
        storeZones: [
          { location: mockStoreA, maxDeliveryDistanceKm: null },
          { location: mockStoreB, maxDeliveryDistanceKm: null },
          { location: mockStoreFar, maxDeliveryDistanceKm: null },
        ],
      },
    },
  ];

  beforeEach(async () => {
    prisma = {
      serviceZone: {
        findMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue({
          id: 'zone-north',
          version: 1,
          maxSourcesAllowed: 2,
          maxDistanceBetweenSourcesKm: 40,
        }),
      },
      retailQuote: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      serviceZoneProvince: {
        findMany: jest.fn().mockResolvedValue(mockZoneProvinces),
      },
      product: {
        findMany: jest.fn(),
      },
      sku: {
        findMany: jest.fn(),
      },
      stockBalance: {
        findMany: jest.fn(),
      },
      location: {
        findUnique: jest.fn((args) => {
          if (args.where.id === 'store-a') return Promise.resolve(mockStoreA);
          if (args.where.id === 'store-b') return Promise.resolve(mockStoreB);
          if (args.where.id === 'store-far') return Promise.resolve(mockStoreFar);
          return Promise.resolve(null);
        }),
      },
    };

    mapbox = {
      getRoute: jest.fn().mockResolvedValue({ distanceKm: 15.5, durationMinutes: 25 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShoppingService,
        { provide: PrismaService, useValue: prisma },
        { provide: MapboxService, useValue: mapbox },
      ],
    }).compile();

    service = module.get<ShoppingService>(ShoppingService);
  });

  describe('MN01 & MN02: Service Areas & Availability Search', () => {
    it('trả về danh sách tỉnh/thành được phục vụ từ ServiceZone đang active', async () => {
      prisma.serviceZone.findMany.mockResolvedValue([
        {
          id: 'zone-north',
          code: 'NORTH',
          name: 'Miền Bắc',
          description: null,
          provinces: [{ provinceCode: 'HN', provinceName: 'Hà Nội' }],
          storeZones: [{ location: { id: 'store-a', active: true } }],
        },
      ]);

      const result = await service.getServiceAreas();
      expect(result.zones).toHaveLength(1);
      expect(result.provinces).toHaveLength(1);
      expect(result.provinces[0].provinceCode).toBe('HN');
      expect(result.provinces[0].activeStoreCount).toBe(1);
    });

    it('tính maxOrderableQuantity theo giới hạn gom tối đa 2 nguồn (POL-M11)', async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: 'prod-1',
          name: 'Xi măng Hà Tiên',
          imageUrl: 'cement.jpg',
          category: { name: 'Vật liệu' },
          skus: [
            {
              id: 'sku-cement',
              skuCode: 'XM-HT-50',
              name: 'Bao 50kg',
              uom: 'BAO',
              salePrice: '90000',
              stockBalances: [
                { locationId: 'store-a', onHand: 10, reserved: 2, safetyBuffer: 1 }, // sellable: 7
                { locationId: 'store-b', onHand: 15, reserved: 0, safetyBuffer: 2 }, // sellable: 13
                { locationId: 'store-far', onHand: 20, reserved: 0, safetyBuffer: 0 }, // sellable: 20
              ],
            },
          ],
        },
      ]);

      const result = await service.searchAvailability({ provinceCode: 'HN' });
      expect(result.data).toHaveLength(1);
      const item = result.data[0];
      // Top 2 sources: 20 (store-far) + 13 (store-b) = 33 (không lấy 33 + 7 = 40 vì giới hạn 2 nguồn)
      expect(item.maxOrderableQuantity).toBe(33);
      expect(item.fulfillmentLabel).toBe('MULTI_STORE');
      expect(item.canAddToCart).toBe(true);
    });
  });

  describe('MN03: Single Source vs Multi Source prioritization', () => {
    it('ưu tiên 1 nguồn khi có 1 cửa hàng đáp ứng trọn vẹn cả giỏ hàng (POL-M09)', async () => {
      // Store A có 10 xi măng và 5 sơn (đáp ứng đủ)
      // Store B có 2 xi măng và 10 sơn
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 10, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-a', skuId: 'sku-paint', onHand: 5, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-b', skuId: 'sku-cement', onHand: 2, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-b', skuId: 'sku-paint', onHand: 10, reserved: 0, safetyBuffer: 0 },
      ]);

      const cartResult = await service.checkCart({
        provinceCode: 'HN',
        items: [
          { skuId: 'sku-cement', quantity: 5 },
          { skuId: 'sku-paint', quantity: 3 },
        ],
      });

      expect(cartResult.isFeasible).toBe(true);
      expect(cartResult.sourceCount).toBe(1);
      expect(cartResult.sources[0].id).toBe('store-a');
      expect(cartResult.warnings).toHaveLength(0);
    });

    it('tự động gom 2 nguồn gần nhau khi 1 nguồn không đủ giỏ hàng', async () => {
      // Store A chỉ có 4 xi măng (khách cần 6) và 0 sơn
      // Store B có 5 xi măng và 5 sơn
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 4, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-a', skuId: 'sku-paint', onHand: 0, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-b', skuId: 'sku-cement', onHand: 5, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-b', skuId: 'sku-paint', onHand: 5, reserved: 0, safetyBuffer: 0 },
      ]);

      const cartResult = await service.checkCart({
        provinceCode: 'HN',
        items: [
          { skuId: 'sku-cement', quantity: 6 },
          { skuId: 'sku-paint', quantity: 2 },
        ],
      });

      expect(cartResult.isFeasible).toBe(true);
      expect(cartResult.sourceCount).toBe(2);
      expect(cartResult.sources.map((s) => s.id)).toEqual(['store-a', 'store-b']);
      expect(cartResult.warnings[0]).toContain('Đơn hàng cần gom từ 2 cửa hàng');
    });
  });

  describe('MN23: Reject pairs exceeding max distance between sources', () => {
    it('từ chối gom hàng nếu khoảng cách giữa 2 nguồn vượt quá 40km (POL-M11)', async () => {
      // Store A chỉ có xi măng
      // Store Far (> 40km từ Store A) có sơn
      // Store B không có hàng
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 10, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-a', skuId: 'sku-paint', onHand: 0, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-far', skuId: 'sku-cement', onHand: 0, reserved: 0, safetyBuffer: 0 },
        { locationId: 'store-far', skuId: 'sku-paint', onHand: 10, reserved: 0, safetyBuffer: 0 },
      ]);

      const cartResult = await service.checkCart({
        provinceCode: 'HN',
        items: [
          { skuId: 'sku-cement', quantity: 5 },
          { skuId: 'sku-paint', quantity: 5 },
        ],
      });

      // Do khoảng cách Store A và Store Far > 40km, không thể gom cùng 1 đơn
      expect(cartResult.isFeasible).toBe(false);
      expect(cartResult.warnings[0]).toContain('Không tìm thấy phương án giao hàng hợp lệ trong giới hạn 2 cửa hàng gần nhau');
      expect(cartResult.suggestedActions).toBeDefined();
    });
  });

  describe('Create Quote validation', () => {
    it('tạo quote với version, expiry 15 phút và trạng thái phí giao chờ đo', async () => {
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 10, reserved: 0, safetyBuffer: 0 },
      ]);

      prisma.sku.findMany.mockResolvedValue([
        {
          id: 'sku-cement',
          skuCode: 'XM-01',
          name: 'Xi măng',
          salePrice: '100000',
        },
      ]);

      const quote = await service.createQuote({
        provinceCode: 'HN',
        deliveryAddress: '123 Đường Láng, Hà Nội',
        deliveryLatitude: 21.015,
        deliveryLongitude: 105.81,
        items: [{ skuId: 'sku-cement', quantity: 3 }],
      });

      expect(quote.quoteId).toMatch(/^QTE-/);
      expect(quote.quoteVersion).toBe(1);
      expect(quote.subtotal).toBe(300000);
      expect(quote.shippingFeeStatus).toBe('ESTIMATED_PENDING_MEASUREMENT');
      expect(quote.conditionsToAccept.length).toBeGreaterThan(0);

      // Kiểm tra lấy lại quote bằng quoteId
      const retrieved = await service.getQuoteById(quote.quoteId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.quoteId).toBe(quote.quoteId);
    });

    it('báo lỗi khi giỏ hàng trống', async () => {
      await expect(
        service.createQuote({
          provinceCode: 'HN',
          deliveryAddress: '123 Đường Láng',
          deliveryLatitude: 21.0,
          deliveryLongitude: 105.0,
          items: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('từ chối báo giá khi khoảng cách đường bộ vượt ngưỡng giao của cửa hàng (Issue 4)', async () => {
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 10, reserved: 0, safetyBuffer: 0 },
      ]);
      prisma.sku.findMany.mockResolvedValue([
        { id: 'sku-cement', skuCode: 'XM-01', name: 'Xi măng', salePrice: '100000' },
      ]);

      // Đường thẳng 80km nhưng đường bộ 140km (> 100km)
      mapbox.getRoute.mockResolvedValue({ distanceKm: 140.0, durationMinutes: 180 });

      await expect(
        service.createQuote({
          provinceCode: 'HN',
          deliveryAddress: 'Khu vực xa, Hà Nội',
          deliveryLatitude: 21.015,
          deliveryLongitude: 105.81,
          items: [{ skuId: 'sku-cement', quantity: 1 }],
        }),
      ).rejects.toThrow('vượt ngưỡng khoảng cách giao hàng đường bộ');
    });

    it('từ chối báo giá khi Mapbox không tìm thấy đường bộ (Issue 4)', async () => {
      prisma.stockBalance.findMany.mockResolvedValue([
        { locationId: 'store-a', skuId: 'sku-cement', onHand: 10, reserved: 0, safetyBuffer: 0 },
      ]);
      prisma.sku.findMany.mockResolvedValue([
        { id: 'sku-cement', skuCode: 'XM-01', name: 'Xi măng', salePrice: '100000' },
      ]);

      mapbox.getRoute.mockRejectedValue(new Error('No route found'));

      await expect(
        service.createQuote({
          provinceCode: 'HN',
          deliveryAddress: 'Điểm không có đường, Hà Nội',
          deliveryLatitude: 21.015,
          deliveryLongitude: 105.81,
          items: [{ skuId: 'sku-cement', quantity: 1 }],
        }),
      ).rejects.toThrow('Không thể xác minh khoảng cách đường bộ qua Mapbox');
    });
  });
});

