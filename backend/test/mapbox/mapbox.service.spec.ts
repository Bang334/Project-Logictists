import axios from 'axios';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { MapboxService } from '../../src/mapbox/mapbox.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MapboxService road matrix contract', () => {
  let service: MapboxService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MAPBOX_ACCESS_TOKEN = 'test-mapbox-token';
    service = new MapboxService();
  });

  it('rejects invalid coordinates before spending provider quota', async () => {
    await expect(
      service.getRoadMatrix([[181, 21]]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('rejects unreachable pairs instead of converting null to zero', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        code: 'Ok',
        distances: [[0, null], [100, 0]],
        durations: [[0, null], [10, 0]],
      },
    });

    await expect(
      service.getRoadMatrix([[105.8, 21], [105.9, 21.1]]),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects a matrix with the wrong dimensions', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        code: 'Ok',
        distances: [[0]],
        durations: [[0]],
      },
    });

    await expect(
      service.getRoadMatrix([[105.8, 21], [105.9, 21.1]]),
    ).rejects.toThrow('2x2');
  });
});
