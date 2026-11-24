import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { driverPodService } from '@/features/driver-trips/services/driver-pod.service';
import { ApiError } from '@/shared/api/api-error';
import { createDriverPodUploadStore, useDriverPod } from './useDriverPod';

const mockHandleError = jest.fn(async (error: unknown) =>
  error instanceof Error ? error.message : 'Lỗi POD',
);

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('@/features/driver-trips/services/driver-pod.service', () => ({
  driverPodService: {
    getPod: jest.fn(),
    uploadPod: jest.fn(),
    getPodView: jest.fn(),
  },
}));
jest.mock('./useDriverTripApiError', () => ({
  useDriverTripApiError: () => mockHandleError,
}));

const collection = {
  deliveryAttempt: {
    id: 'attempt-1',
    result: 'SUCCESS' as const,
    recipientName: 'Người nhận',
  },
  requirements: {
    photoRequired: true,
    photoUploaded: false,
    recipientRequired: true,
    recipientSatisfied: true,
    podSatisfied: false,
  },
  items: [],
};
const file = {
  uri: 'file:///proof.jpg',
  name: 'proof.jpg',
  mediaType: 'image/jpeg' as const,
  sizeBytes: 1024,
};
const options = {
  tripId: 'trip-1',
  stopId: 'stop-1',
  attemptId: 'attempt-1',
};

describe('useDriverPod', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Crypto.randomUUID).mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    );
    jest.mocked(driverPodService.getPod).mockResolvedValue(collection);
    jest.mocked(driverPodService.uploadPod).mockResolvedValue({
      id: 'pod-1',
      evidenceType: 'PHOTO',
      mediaType: 'image/jpeg',
      sizeBytes: 1024,
      uploadStatus: 'UPLOADED',
      capturedAt: '2026-11-16T08:00:00.000Z',
      uploadedAt: '2026-11-16T08:00:02.000Z',
      supersedesId: null,
      isSuperseded: false,
    });
  });

  it('khôi phục POD metadata từ server khi mount', async () => {
    const { result } = await renderHook(() => useDriverPod(options));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(driverPodService.getPod).toHaveBeenCalledWith(
      'trip-1',
      'stop-1',
      'attempt-1',
    );
    expect(result.current.pod).toEqual(collection);
  });

  it('upload thành công rồi refetch metadata', async () => {
    const { result } = await renderHook(() => useDriverPod(options));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(
        await result.current.upload(
          'PHOTO',
          file,
          '2026-11-16T08:00:00.000Z',
        ),
      ).toBe(true);
    });
    expect(driverPodService.uploadPod).toHaveBeenCalledWith(
      'trip-1',
      'stop-1',
      'attempt-1',
      'PHOTO',
      file,
      '2026-11-16T08:00:00.000Z',
      '11111111-1111-4111-8111-111111111111',
      undefined,
    );
    expect(driverPodService.getPod).toHaveBeenCalledTimes(2);
  });

  it('timeout giữ idempotency key và chỉ retry khi người dùng yêu cầu', async () => {
    jest.mocked(driverPodService.uploadPod)
      .mockRejectedValueOnce(new ApiError('Timeout', 0, 'REQUEST_TIMEOUT'))
      .mockResolvedValueOnce({
        id: 'pod-1',
        evidenceType: 'PHOTO',
        mediaType: 'image/jpeg',
        sizeBytes: 1024,
        uploadStatus: 'UPLOADED',
        capturedAt: null,
        uploadedAt: null,
        supersedesId: null,
        isSuperseded: false,
      });
    const { result } = await renderHook(() => useDriverPod(options));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.upload(
        'PHOTO',
        file,
        '2026-11-16T08:00:00.000Z',
      );
    });
    expect(driverPodService.uploadPod).toHaveBeenCalledTimes(1);
    expect(result.current.canRetry).toBe(true);
    await act(async () => void (await result.current.retry()));
    expect(driverPodService.uploadPod).toHaveBeenCalledTimes(2);
    expect(
      jest.mocked(driverPodService.uploadPod).mock.calls[1]?.[6],
    ).toBe(
      jest.mocked(driverPodService.uploadPod).mock.calls[0]?.[6],
    );
  });

  it('mở lại route và thử thay ảnh với đúng yêu cầu của lần upload chưa rõ kết quả', async () => {
    const uploadStore = createDriverPodUploadStore();
    const onUploadChange = jest.fn();
    const scopedOptions = { ...options, uploadStore, onUploadChange };
    const replacementId = 'old-photo';
    jest.mocked(driverPodService.uploadPod).mockRejectedValueOnce(new ApiError('Timeout', 0, 'REQUEST_TIMEOUT'));
    const original = await renderHook(() => useDriverPod(scopedOptions));
    await act(async () => {
      expect(await original.result.current.upload('PHOTO', file, '2026-11-16T08:00:00Z', replacementId)).toBe(false);
    });
    await original.unmount();

    const reopened = await renderHook(() => useDriverPod(scopedOptions));
    expect(reopened.result.current.canRetry).toBe(true);
    expect(driverPodService.uploadPod).toHaveBeenCalledTimes(1);
    await act(async () => expect(await reopened.result.current.retry()).toBe(true));
    expect(jest.mocked(driverPodService.uploadPod).mock.calls[1]).toEqual(
      jest.mocked(driverPodService.uploadPod).mock.calls[0],
    );
    expect(onUploadChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(reopened.result.current.canRetry).toBe(false);
  });

  it('double tap chỉ gửi một upload', async () => {
    let resolveUpload!: () => void;
    jest.mocked(driverPodService.uploadPod).mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = () =>
          resolve({
            id: 'pod-1',
            evidenceType: 'PHOTO',
            mediaType: 'image/jpeg',
            sizeBytes: 1024,
            uploadStatus: 'UPLOADED',
            capturedAt: null,
            uploadedAt: null,
            supersedesId: null,
            isSuperseded: false,
          });
      }),
    );
    const { result } = await renderHook(() => useDriverPod(options));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.upload(
        'PHOTO',
        file,
        '2026-11-16T08:00:00.000Z',
      );
      expect(
        await result.current.upload(
          'PHOTO',
          file,
          '2026-11-16T08:00:00.000Z',
        ),
      ).toBe(false);
      resolveUpload();
      await first;
    });
    expect(driverPodService.uploadPod).toHaveBeenCalledTimes(1);
  });

  it('lấy URL xem private qua service', async () => {
    jest.mocked(driverPodService.getPodView).mockResolvedValue({
      id: 'pod-1',
      url: 'https://signed.example.test/pod',
      expiresAt: '2026-11-16T09:05:00.000Z',
    });
    const { result } = await renderHook(() => useDriverPod(options));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await expect(result.current.getView('pod-1')).resolves.toMatchObject({
        id: 'pod-1',
      });
    });
    expect(driverPodService.getPodView).toHaveBeenCalledWith(
      'trip-1',
      'stop-1',
      'attempt-1',
      'pod-1',
    );
  });
});
