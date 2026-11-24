import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import {
  driverIncidentsService,
  parseDriverIncident,
  parseDriverIncidentPage,
} from './driver-incidents.service';

jest.mock('@/shared/api/api-client', () => ({
  apiClient: { request: jest.fn() },
}));
jest.mock('@/shared/storage/token-storage', () => ({
  tokenStorage: { get: jest.fn() },
}));

const incident = {
  id: 'incident-1',
  tripId: 'trip-1',
  type: 'VEHICLE_BREAKDOWN',
  severity: 'HIGH',
  status: 'OPEN',
  description: 'Động cơ quá nhiệt, xe cần dừng kiểm tra.',
  occurredAt: '2026-11-18T01:00:00.000Z',
  createdAt: '2026-11-18T01:01:00.000Z',
  updatedAt: '2026-11-18T01:01:00.000Z',
  resolution: null,
  affectedOrders: [{ id: 'order-1', orderNumber: 'ORD-001' }],
};

describe('driverIncidentsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(tokenStorage.get).mockResolvedValue('jwt-token');
  });

  it('gọi đúng create endpoint và body', async () => {
    jest.mocked(apiClient.request).mockResolvedValue(incident);
    const payload = {
      idempotencyKey: 'key-1',
      type: 'VEHICLE_BREAKDOWN' as const,
      severity: 'HIGH' as const,
      description: incident.description,
      occurredAt: incident.occurredAt,
      affectedOrderIds: ['order-1'],
    };
    await expect(
      driverIncidentsService.create('trip/1', payload),
    ).resolves.toMatchObject({
      id: 'incident-1',
      resolution: null,
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      '/driver/trips/trip%2F1/incidents',
      { method: 'POST', token: 'jwt-token', body: payload },
    );
  });

  it('gọi đúng list query và parse pagination', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      items: [incident],
      page: 2,
      limit: 10,
      total: 11,
      totalPages: 2,
    });
    const result = await driverIncidentsService.getPage('trip-1', {
      page: 2,
      limit: 10,
      type: 'ACCIDENT',
      status: 'OPEN',
    });
    expect(result.items[0]?.affectedOrders[0]?.orderNumber).toBe('ORD-001');
    expect(apiClient.request).toHaveBeenCalledWith(
      '/driver/trips/trip-1/incidents?page=2&limit=10&type=ACCIDENT&status=OPEN',
      { token: 'jwt-token' },
    );
  });

  it('gọi đúng detail endpoint', async () => {
    jest
      .mocked(apiClient.request)
      .mockResolvedValue({ ...incident, status: 'CUSTOM_STATUS' });
    await expect(
      driverIncidentsService.getOne('trip-1', 'incident/1'),
    ).resolves.toMatchObject({
      status: 'CUSTOM_STATUS',
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      '/driver/trips/trip-1/incidents/incident%2F1',
      { token: 'jwt-token' },
    );
  });

  it('parser hỗ trợ resolution và status tương lai', () => {
    expect(
      parseDriverIncident({
        ...incident,
        status: 'ACKNOWLEDGED',
        resolution: 'Đã điều xe cứu hộ.',
      }),
    ).toMatchObject({
      status: 'ACKNOWLEDGED',
      resolution: 'Đã điều xe cứu hộ.',
    });
  });

  it.each([
    null,
    { ...incident, type: 'UNKNOWN' },
    { ...incident, severity: 'URGENT' },
    { ...incident, occurredAt: 'not-date' },
    { ...incident, affectedOrders: [{ id: 1, orderNumber: 'ORD' }] },
  ])('từ chối Incident response sai định dạng %#', (value) => {
    expect(() => parseDriverIncident(value)).toThrow(ApiError);
  });

  it('từ chối page response sai định dạng', () => {
    expect(() => parseDriverIncidentPage({ items: {}, page: 1 })).toThrow(
      'Dữ liệu sự cố từ máy chủ không đúng định dạng.',
    );
  });

  it('không gọi API khi thiếu JWT', async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue(null);
    await expect(
      driverIncidentsService.getPage('trip-1'),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });
});
