import { apiClient } from '@/shared/api/api-client';
import { tokenStorage } from '@/shared/storage/token-storage';
import { driverPodService } from './driver-pod.service';

jest.mock('@/shared/api/api-client', () => ({
  apiClient: { request: jest.fn(), uploadMultipartFile: jest.fn() },
}));
jest.mock('@/shared/storage/token-storage', () => ({
  tokenStorage: { get: jest.fn() },
}));

const podFile = {
  id: 'pod-1',
  evidenceType: 'PHOTO',
  mediaType: 'image/jpeg',
  sizeBytes: 1024,
  uploadStatus: 'UPLOADED',
  capturedAt: '2026-11-16T08:00:00.000Z',
  uploadedAt: '2026-11-16T08:00:02.000Z',
  supersedesId: null,
  isSuperseded: false,
};

describe('driverPodService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(tokenStorage.get).mockResolvedValue('driver-token');
  });

  it('đọc POD metadata allowlist', async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      deliveryAttempt: {
        id: 'attempt-1',
        result: 'SUCCESS',
        recipientName: 'Người nhận',
      },
      requirements: {
        photoRequired: true,
        photoUploaded: true,
        recipientRequired: true,
        recipientSatisfied: true,
        podSatisfied: true,
      },
      items: [{ ...podFile, storageKey: 'must-not-survive' }],
    });

    const result = await driverPodService.getPod(
      'trip-1',
      'stop-1',
      'attempt-1',
    );
    expect(result.items[0]).toEqual(podFile);
    expect(JSON.stringify(result)).not.toContain('storageKey');
  });

  it('upload multipart, không gửi ownership/storage fields', async () => {
    jest.mocked(apiClient.uploadMultipartFile).mockResolvedValue(podFile);

    await driverPodService.uploadPod(
      'trip-1',
      'stop-1',
      'attempt-1',
      'PHOTO',
      {
        uri: 'file:///proof.jpg',
        name: 'proof.jpg',
        mediaType: 'image/jpeg',
        sizeBytes: 1024,
      },
      '2026-11-16T08:00:00.000Z',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(apiClient.uploadMultipartFile).toHaveBeenCalledWith(
      '/driver/trips/trip-1/stops/stop-1/delivery-attempts/attempt-1/pod',
      expect.objectContaining({
        token: 'driver-token',
        fileUri: 'file:///proof.jpg',
        mediaType: 'image/jpeg',
        fields: {
          evidenceType: 'PHOTO',
          capturedAt: '2026-11-16T08:00:00.000Z',
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
        },
        timeoutMs: 30_000,
      }),
    );
    const serialized = JSON.stringify(
      jest.mocked(apiClient.uploadMultipartFile).mock.calls[0],
    );
    expect(serialized).not.toContain('driverId');
    expect(serialized).not.toContain('branchId');
    expect(serialized).not.toContain('storageKey');
  });

  it('gửi supersedesId khi thay thế và đọc URL xem ngắn hạn', async () => {
    jest.mocked(apiClient.uploadMultipartFile).mockResolvedValue({
      ...podFile,
      id: 'pod-2',
      supersedesId: 'pod-1',
    });
    await driverPodService.uploadPod(
      'trip-1',
      'stop-1',
      'attempt-1',
      'PHOTO',
      {
        uri: 'file:///replacement.jpg',
        name: 'replacement.jpg',
        mediaType: 'image/jpeg',
      },
      '2026-11-16T09:00:00.000Z',
      '22222222-2222-4222-8222-222222222222',
      'pod-1',
    );
    expect(apiClient.uploadMultipartFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fields: expect.objectContaining({ supersedesId: 'pod-1' }),
      }),
    );

    jest.mocked(apiClient.request).mockResolvedValue({
      id: 'pod-2',
      url: 'https://signed.example.test/pod',
      expiresAt: '2026-11-16T09:05:00.000Z',
    });
    await expect(
      driverPodService.getPodView('trip-1', 'stop-1', 'attempt-1', 'pod-2'),
    ).resolves.toMatchObject({ id: 'pod-2' });
  });

  it('từ chối response sai và không gọi API khi thiếu token', async () => {
    jest
      .mocked(apiClient.uploadMultipartFile)
      .mockResolvedValue({ ...podFile, sizeBytes: -1 });
    await expect(
      driverPodService.uploadPod(
        'trip-1',
        'stop-1',
        'attempt-1',
        'PHOTO',
        { uri: 'file:///p.jpg', name: 'p.jpg', mediaType: 'image/jpeg' },
        new Date().toISOString(),
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    jest.clearAllMocks();
    jest.mocked(tokenStorage.get).mockResolvedValue(null);
    await expect(
      driverPodService.getPod('trip-1', 'stop-1', 'attempt-1'),
    ).rejects.toMatchObject({ status: 401 });
    expect(apiClient.request).not.toHaveBeenCalled();
  });
});
