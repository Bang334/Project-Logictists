import { apiClient } from '@/shared/api/api-client';
import { tokenStorage } from '@/shared/storage/token-storage';
import { ordersService } from './orders.service';

jest.mock('@/shared/api/api-client', () => ({
  apiClient: { request: jest.fn() },
}));

jest.mock('@/shared/storage/token-storage', () => ({
  tokenStorage: { get: jest.fn() },
}));

const stop = (type: 'PICKUP' | 'DELIVERY', sequence: number) => ({
  id: `${type}-${sequence}`,
  type,
  sequence,
  address: type,
  latitude: 10,
  longitude: 106,
  contactName: 'Contact',
  contactPhone: '0900000000',
  serviceDurationMinutes: 15,
});

const summary = {
  id: 'order-1',
  orderNumber: 'ORD-CUS-1',
  status: 'DRAFT',
  version: 1,
  notes: null,
  totalPackages: 2,
  totalWeightKg: 1560,
  totalVolumeM3: 5.808,
  orderedAt: '2026-11-15T00:00:00.000Z',
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
  stops: [stop('DELIVERY', 2), stop('PICKUP', 1)],
};

const trackingResponse = {
  orderId: 'order-1',
  orderStatus: 'IN_TRANSIT',
  trackingStatus: 'AVAILABLE',
  trips: [
    {
      id: 'trip-1',
      tripNumber: 'TRIP-001',
      status: 'IN_PROGRESS',
      version: 4,
      plannedDeliveryAt: '2026-11-17T09:00:00.000Z',
      etaSource: 'PLANNED',
      vehicleLocation: {
        latitude: 10.1234567,
        longitude: 106.7654321,
        accuracyM: 8.5,
        measuredAt: '2026-11-17T08:04:30.000Z',
        receivedAt: '2026-11-17T08:04:32.000Z',
        isStale: false,
      },
    },
  ],
};

describe('ordersService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(tokenStorage.get).mockResolvedValue('secure-token');
  });

  it('gọi list với pagination/status và map stops theo sequence', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      items: [summary],
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    });
    const result = await ordersService.getOrders(2, 20, 'DRAFT');
    expect(apiClient.request).toHaveBeenCalledWith(
      '/customer/orders?page=2&limit=20&status=DRAFT',
      { token: 'secure-token' },
    );
    expect(result.items[0]?.stops.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('map detail line/unit weight và không yêu cầu field giá/branch', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      ...summary,
      items: [
        {
          id: 'item-1',
          description: 'Crate',
          packageType: 'CRATE',
          quantity: 2,
          lineWeightKg: 1560,
          unitWeightKg: 780,
          lengthCm: 220,
          widthCm: 120,
          heightCm: 110,
          lineVolumeM3: 5.808,
          unitVolumeM3: 2.904,
        },
      ],
    });
    const result = await ordersService.getOrder('order-1');
    expect(result.items[0]).toMatchObject({
      quantity: 2,
      unitWeightKg: 780,
      lineWeightKg: 1560,
    });
  });

  it('gửi đúng create contract và không tự retry', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-CUS-1',
      status: 'DRAFT',
      version: 1,
      totalPackages: 1,
      totalWeightKg: 10,
      totalVolumeM3: 0.01,
      createdAt: '2026-11-15T00:00:00.000Z',
      orderedAt: '2026-11-15T00:00:00.000Z',
      branch: { id: 'branch-1', code: 'DAD', name: 'Đà Nẵng' },
    });
    const body = {
      idempotencyKey: 'key-1',
      branchId: 'branch-1',
      pickup: {
        address: 'A', latitude: 10, longitude: 106, contactName: 'A', contactPhone: '0900000001',
      },
      delivery: {
        address: 'B', latitude: 11, longitude: 107, contactName: 'B', contactPhone: '0900000002',
      },
      items: [
        {
          description: 'Box', packageType: 'CARTON' as const, quantity: 1,
          unitWeightKg: 10, lengthCm: 10, widthCm: 10, heightCm: 10,
        },
      ],
    };
    await ordersService.createOrder(body);
    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(apiClient.request).toHaveBeenCalledWith('/customer/orders', {
      method: 'POST',
      token: 'secure-token',
      body,
    });
  });

  it('gọi đúng tracking path và parse đầy đủ nhiều Trip', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      ...trackingResponse,
      trips: [
        trackingResponse.trips[0],
        {
          ...trackingResponse.trips[0],
          id: 'trip-2',
          tripNumber: 'TRIP-002',
          status: 'COMPLETED',
          plannedDeliveryAt: null,
          vehicleLocation: null,
        },
      ],
    });

    const result = await ordersService.getCustomerOrderTracking('order/1');

    expect(apiClient.request).toHaveBeenCalledWith(
      '/customer/orders/order%2F1/tracking',
      { token: 'secure-token' },
    );
    expect(result.trips).toHaveLength(2);
    expect(result.trips[0]?.vehicleLocation).toMatchObject({
      isStale: false,
      latitude: 10.1234567,
    });
    expect(result.trips[1]?.vehicleLocation).toBeNull();
  });

  it('parse NOT_ASSIGNED và giữ đúng enum Backend', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      orderId: 'order-1',
      orderStatus: 'DRAFT',
      trackingStatus: 'NOT_ASSIGNED',
      trips: [],
    });

    await expect(
      ordersService.getCustomerOrderTracking('order-1'),
    ).resolves.toMatchObject({ trackingStatus: 'NOT_ASSIGNED', trips: [] });
  });

  it.each([
    ['thiếu orderId', { ...trackingResponse, orderId: undefined }],
    ['trackingStatus lạ', { ...trackingResponse, trackingStatus: 'UNKNOWN' }],
    ['trips không phải array', { ...trackingResponse, trips: {} }],
    [
      'Trip thiếu id',
      { ...trackingResponse, trips: [{ ...trackingResponse.trips[0]!, id: undefined }] },
    ],
    [
      'latitude không finite',
      {
        ...trackingResponse,
        trips: [
          {
            ...trackingResponse.trips[0]!,
            vehicleLocation: {
              ...trackingResponse.trips[0]!.vehicleLocation,
              latitude: Number.NaN,
            },
          },
        ],
      },
    ],
    [
      'NOT_ASSIGNED nhưng có Trip',
      { ...trackingResponse, trackingStatus: 'NOT_ASSIGNED' },
    ],
  ])('từ chối tracking response malformed: %s', async (_label, response) => {
    jest.mocked(apiClient.request).mockResolvedValue(response);
    await expect(
      ordersService.getCustomerOrderTracking('order-1'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('từ chối response sai contract và phiên không có token', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({ items: 'invalid' });
    await expect(ordersService.getOrders()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    jest.mocked(tokenStorage.get).mockResolvedValue(null);
    await expect(ordersService.getBranches()).rejects.toEqual(
      expect.objectContaining({ status: 401 }),
    );
  });
});
