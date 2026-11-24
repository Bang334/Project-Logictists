import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryService } from '../../../src/common/services/cloudinary.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    api: { resource: jest.fn() },
    uploader: { upload_stream: jest.fn(), destroy: jest.fn() },
  },
}));

describe('CloudinaryService POD lookup', () => {
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        CLOUDINARY_CLOUD_NAME: 'test-cloud',
        CLOUDINARY_API_KEY: 'test-key',
        CLOUDINARY_API_SECRET: 'test-secret',
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  beforeEach(() => jest.clearAllMocks());

  it('coi nested Cloudinary 404 là asset chưa tồn tại để tiếp tục upload', async () => {
    jest.mocked(cloudinary.api.resource).mockRejectedValue({
      request_options: {},
      error: { message: 'Resource not found', http_code: 404 },
    });

    const service = new CloudinaryService(config);

    await expect(service.findPodImage('tms/pod/attempt/file')).resolves.toBeNull();
    expect(cloudinary.api.resource).toHaveBeenCalledWith(
      'tms/pod/attempt/file',
      { resource_type: 'image', type: 'authenticated' },
    );
  });

  it('không che giấu lỗi Cloudinary khác 404', async () => {
    jest.mocked(cloudinary.api.resource).mockRejectedValue({
      error: { message: 'Unauthorized', http_code: 401 },
    });

    const service = new CloudinaryService(config);

    await expect(service.findPodImage('tms/pod/attempt/file')).rejects.toMatchObject({
      status: 400,
    });
  });
});
