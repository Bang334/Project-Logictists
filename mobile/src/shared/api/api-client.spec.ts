import * as FileSystem from 'expo-file-system/legacy';
import { apiClient } from './api-client';

jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { MULTIPART: 1 },
  createUploadTask: jest.fn(),
}));

describe('apiClient', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:4000';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('chuẩn hóa HTTP error envelope của backend', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          statusCode: 409,
          errorCode: 'USERNAME_ALREADY_EXISTS',
          message: 'Tên đăng nhập đã được sử dụng',
          correlationId: 'correlation-1',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      apiClient.request('/auth/register/customer', {
        method: 'POST',
        body: { username: 'customer' },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'USERNAME_ALREADY_EXISTS',
      message: 'Tên đăng nhập đã được sử dụng',
      correlationId: 'correlation-1',
    });
  });

  it('chuẩn hóa lỗi mạng và không tự retry', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network request failed'));

    await expect(apiClient.request('/auth/login')).rejects.toEqual(
      expect.objectContaining({
        status: 0,
        code: 'NETWORK_ERROR',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gửi bearer token nhưng không biến token thành query parameter', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await apiClient.request('/auth/profile', { token: 'secret-token' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('fetch chưa được gọi');
    const [url, options] = firstCall;
    expect(String(url)).not.toContain('secret-token');
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
  });

  it('gửi FormData nguyên trạng và để fetch tự tạo multipart boundary', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const body = new FormData();
    body.append('evidenceType', 'PHOTO');

    await apiClient.request('/driver/pod', {
      method: 'POST',
      token: 'driver-token',
      body,
    });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.body).toBe(body);
    expect(options?.headers).not.toMatchObject({
      'Content-Type': expect.any(String),
    });
  });

  it('upload file bằng multipart native và không tự đặt Content-Type', async () => {
    const uploadAsync = jest.fn().mockResolvedValue({
      status: 201,
      body: JSON.stringify({ id: 'pod-1' }),
      headers: {},
      mimeType: 'application/json',
    });
    jest.mocked(FileSystem.createUploadTask).mockReturnValue({
      uploadAsync,
      cancelAsync: jest.fn(),
    } as unknown as FileSystem.UploadTask);

    await expect(
      apiClient.uploadMultipartFile('/driver/pod', {
        token: 'driver-token',
        fileUri: 'file:///proof.jpg',
        mediaType: 'image/jpeg',
        fields: { evidenceType: 'PHOTO' },
      }),
    ).resolves.toEqual({ id: 'pod-1' });

    expect(FileSystem.createUploadTask).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/driver/pod',
      'file:///proof.jpg',
      expect.objectContaining({
        fieldName: 'file',
        mimeType: 'image/jpeg',
        parameters: { evidenceType: 'PHOTO' },
        headers: expect.objectContaining({
          Authorization: 'Bearer driver-token',
        }),
      }),
    );
    const uploadOptions = jest.mocked(FileSystem.createUploadTask).mock
      .calls[0]?.[2];
    expect(uploadOptions?.headers).not.toHaveProperty('Content-Type');
    expect(uploadAsync).toHaveBeenCalledTimes(1);
  });
});
