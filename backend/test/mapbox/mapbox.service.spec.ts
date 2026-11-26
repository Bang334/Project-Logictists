import axios from 'axios';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { MapboxMatrixRateLimitException, MapboxService } from '../../src/mapbox/mapbox.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MapboxService road matrix contract', () => {
  let service: MapboxService;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.MAPBOX_ACCESS_TOKEN = 'test-mapbox-token';
    service = new MapboxService();
  });

  it.each([25, 26, 49, 50])('routes %i coordinates in overlapping batches of at most 25', async count => {
    mockedAxios.get.mockImplementation(async url => {
      const points = String(url).split('/driving/')[1].split('?')[0]
        .split(';').map(pair => pair.split(',').map(Number));
      if (points.length > 25) throw new Error('Mapbox coordinate limit exceeded');
      return { data: { routes: [{
        distance: (points.length - 1) * 1000,
        duration: (points.length - 1) * 60,
        geometry: { type: 'LineString', coordinates: points },
      }], waypoints: points.map(location => ({ location, name: '' })) } };
    });
    const coordinates: [number, number][] = Array.from({ length: count }, (_, i) => [105 + i / 100, 21]);
    const result = await service.getRoute(coordinates);
    expect(result.geometry.coordinates).toEqual(coordinates);
    expect(result.waypoints.map(w => w.location)).toEqual(coordinates);
    expect(result.distanceKm).toBe(count - 1);
    expect(result.durationMinutes).toBe(count - 1);
    expect(mockedAxios.get).toHaveBeenCalledTimes(Math.ceil((count - 1) / 24));
  });

  it('keeps separate visit indices when a route returns to the same pickup', async () => {
    const a = [105, 21], b = [106, 21];
    mockedAxios.get.mockResolvedValue({ data: { routes: [{
      distance: 2000, duration: 120, geometry: { type: 'LineString', coordinates: [a, b, a] },
      legs: [
        { steps: [{ geometry: { coordinates: [a, b] } }] },
        { steps: [{ geometry: { coordinates: [b, a] } }] },
      ],
    }] } });
    const result = await service.getRoute([[105, 21], [106, 21], [105, 21]]);
    expect(result.geometry.waypoint_indices).toEqual([0, 1, 3]);
    expect(result.geometry.coordinates[3]).toEqual(a);
  });

  it('rejects the whole route if a later Directions batch fails', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { routes: [{
      distance: 1000, duration: 60,
      geometry: { type: 'LineString', coordinates: [[105, 21], [106, 21]] },
    }], waypoints: [] } }).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(service.getRoute(Array.from({ length: 26 }, (_, i) => [105 + i / 100, 21])))
      .rejects.toBeInstanceOf(BadGatewayException);
  });

  it('deduplicates repeated locations and restores the original node order', async () => {
    mockedAxios.get.mockResolvedValue({ data: {
      code: 'Ok', distances: [[0, 120], [250, 0]], durations: [[0, 12], [25, 0]],
    } });
    const coordinates: [number, number][] = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? [105.8, 21] : [105.9, 21.1]);
    const result = await service.getRoadMatrix(coordinates);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(result.distancesMeters).toHaveLength(60);
    expect(result.distancesMeters[0][3]).toBe(120);
    expect(result.distancesMeters[3][0]).toBe(250);
    expect(result.durationsSeconds[2][4]).toBe(0);
  });

  it('waits for the provider cooldown and retries a 429 without restarting the matrix', async () => {
    jest.useFakeTimers();
    try {
      mockedAxios.isAxiosError.mockReturnValue(true);
      mockedAxios.get.mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '2' } } });
      mockedAxios.get.mockResolvedValueOnce({ data: {
        code: 'Ok', distances: [[0, 10], [20, 0]], durations: [[0, 1], [2, 0]],
      } });
      const promise = service.getRoadMatrix([[105.8, 21], [105.9, 21.1]]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1999);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(101);
      expect((await promise).distancesMeters[1][0]).toBe(20);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects invalid coordinates before spending provider quota', async () => {
    await expect(
      service.getRoadMatrix([[181, 21]]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('caps repeated 429 responses at three requests', async () => {
    jest.useFakeTimers();
    try {
      mockedAxios.isAxiosError.mockReturnValue(true);
      mockedAxios.get.mockRejectedValue({ response: { status: 429, headers: {} } });
      const outcome = service.getRoadMatrix([[105, 21], [106, 21]])
        .then(() => null, error => error);
      await jest.advanceTimersByTimeAsync(10000);
      expect(await outcome).toBeInstanceOf(MapboxMatrixRateLimitException);
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops sending remaining chunks after a block fails', async () => {
    mockedAxios.get.mockRejectedValue(new Error('provider unavailable'));
    const points: [number, number][] = Array.from({ length: 30 }, (_, i) => [105 + i / 100, 21]);
    await expect(service.getRoadMatrix(points)).rejects.toBeInstanceOf(BadGatewayException);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('paces concurrent callers through the same matrix queue', async () => {
    jest.useFakeTimers();
    try {
      const starts: number[] = [];
      mockedAxios.get.mockImplementation(async () => {
        starts.push(Date.now());
        return { data: { code: 'Ok', distances: [[0, 10], [20, 0]], durations: [[0, 1], [2, 0]] } };
      });
      const a = service.getRoadMatrix([[105, 21], [106, 21]]);
      const b = service.getRoadMatrix([[105, 20], [106, 20]]);
      await jest.advanceTimersByTimeAsync(1100);
      await Promise.all([a, b]);
      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
    } finally {
      jest.useRealTimers();
    }
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
