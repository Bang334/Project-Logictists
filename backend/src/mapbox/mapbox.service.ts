import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';

export interface GeocodeResult {
  address: string;
  latitude: number;
  longitude: number;
  placeName: string;
}

export interface DirectionsResult {
  distanceKm: number;
  durationMinutes: number;
  geometry: any; // GeoJSON LineString
  waypoints: { location: [number, number]; name: string }[];
}

export interface RoadMatrixResult {
  distancesMeters: number[][];
  durationsSeconds: number[][];
}

@Injectable()
export class MapboxService {
  private readonly logger = new Logger(MapboxService.name);
  private readonly accessToken = process.env.MAPBOX_ACCESS_TOKEN || '';
  private readonly baseUrl = 'https://api.mapbox.com';

  /**
   * Geocode một địa chỉ thành tọa độ GPS (kinh độ, vĩ độ)
   */
  async geocode(query: string): Promise<GeocodeResult[]> {
    if (!query || !query.trim()) return [];

    try {
      const encodedQuery = encodeURIComponent(query.trim());
      const url = `${this.baseUrl}/geocoding/v5/mapbox.places/${encodedQuery}.json?access_token=${this.accessToken}&country=vn&limit=5`;
      const response = await axios.get(url, { timeout: 8000 });

      if (!response.data || !response.data.features) {
        return [];
      }

      return response.data.features.map((feature: any) => ({
        address: feature.text || feature.place_name,
        latitude: feature.center[1],
        longitude: feature.center[0],
        placeName: feature.place_name,
      }));
    } catch (error) {
      this.logger.error(`Geocoding error for query "${query}":`, error.message);
      return [];
    }
  }

  /**
   * Tính toán lộ trình thực tế qua danh sách tọa độ (kinh độ, vĩ độ)
   * Sử dụng Mapbox Directions API (profile: mapbox/driving)
   */
  async getRoute(coordinates: [number, number][]): Promise<DirectionsResult> {
    if (coordinates.length < 2) {
      return {
        distanceKm: 0,
        durationMinutes: 0,
        geometry: null,
        waypoints: [],
      };
    }

    try {
      // Coordinates format for Mapbox: lng,lat;lng,lat;...
      const coordsString = coordinates.map((c) => `${c[0]},${c[1]}`).join(';');
      const url = `${this.baseUrl}/directions/v5/mapbox/driving/${coordsString}?geometries=geojson&overview=full&steps=true&access_token=${this.accessToken}`;

      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data || !response.data.routes || response.data.routes.length === 0) {
        throw new Error('No route found between the provided coordinates');
      }

      const route = response.data.routes[0];
      const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
      const durationMinutes = Math.round(route.duration / 60);

      return {
        distanceKm,
        durationMinutes,
        geometry: route.geometry,
        waypoints: response.data.waypoints || [],
      };
    } catch (error) {
      this.logger.error('Directions API error:', error.message);
      throw new BadGatewayException(
        'Mapbox Directions không trả được tuyến đường; không dùng đường chim bay thay cho tuyến hợp lệ',
      );
    }
  }

  async getRoadMatrix(coordinates: [number, number][]): Promise<RoadMatrixResult> {
    if (!this.accessToken) {
      throw new ServiceUnavailableException('Thiếu MAPBOX_ACCESS_TOKEN cho Matrix API');
    }
    if (coordinates.length === 0) {
      return { distancesMeters: [], durationsSeconds: [] };
    }
    if (coordinates.length === 1) {
      return { distancesMeters: [[0]], durationsSeconds: [[0]] };
    }

    // Nếu số lượng tọa độ <= 25, gọi 1 request trực tiếp tới Mapbox Matrix API
    if (coordinates.length <= 25) {
      const coordsString = coordinates.map(([lng, lat]) => `${lng},${lat}`).join(';');
      const url = `${this.baseUrl}/directions-matrix/v1/mapbox/driving/${coordsString}`;
      try {
        const response = await axios.get(url, {
          params: { annotations: 'distance,duration', access_token: this.accessToken },
          timeout: 12000,
        });
        if (response.data?.code !== 'Ok') {
          throw new Error(response.data?.message || response.data?.code || 'Matrix response invalid');
        }
        const distances = response.data.distances as Array<Array<number | null>>;
        const durations = response.data.durations as Array<Array<number | null>>;
        const unreachable: string[] = [];
        distances.forEach((row, from) =>
          row.forEach((value, to) => {
            if (value === null || durations[from]?.[to] === null) {
              unreachable.push(`${from}->${to}`);
            }
          }),
        );
        if (unreachable.length > 0) {
          throw new Error(`Không có đường cho các cặp tọa độ: ${unreachable.slice(0, 8).join(', ')}`);
        }
        return {
          distancesMeters: distances as number[][],
          durationsSeconds: durations as number[][],
        };
      } catch (error) {
        this.logger.error(`Matrix API error: ${error.message}`);
        throw new BadGatewayException(
          `Mapbox Matrix không khả dụng: ${error.response?.data?.message || error.message}`,
        );
      }
    }

    // Khi N > 25, chia tọa độ thành các block tối đa 12 điểm để kết hợp nguồn + đích <= 24 điểm
    const CHUNK_SIZE = 12;
    const chunks: [number, number][][] = [];
    for (let i = 0; i < coordinates.length; i += CHUNK_SIZE) {
      chunks.push(coordinates.slice(i, i + CHUNK_SIZE));
    }

    const n = coordinates.length;
    const fullDistances: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const fullDurations: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

    const tasks: { ci: number; cj: number }[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      for (let cj = 0; cj < chunks.length; cj++) {
        tasks.push({ ci, cj });
      }
    }

    const concurrency = 5;
    let taskIndex = 0;
    const unreachable: string[] = [];

    const worker = async () => {
      while (taskIndex < tasks.length) {
        const currentTask = tasks[taskIndex++];
        if (!currentTask) break;
        const { ci, cj } = currentTask;
        const sChunk = chunks[ci];
        const dChunk = chunks[cj];

        if (ci === cj) {
          if (sChunk.length === 1) {
            fullDistances[ci * CHUNK_SIZE][ci * CHUNK_SIZE] = 0;
            fullDurations[ci * CHUNK_SIZE][ci * CHUNK_SIZE] = 0;
            continue;
          }
          const blockCoords = sChunk.map(([lng, lat]) => `${lng},${lat}`).join(';');
          const url = `${this.baseUrl}/directions-matrix/v1/mapbox/driving/${blockCoords}`;
          const res = await axios.get(url, {
            params: { annotations: 'distance,duration', access_token: this.accessToken },
            timeout: 12000,
          });
          if (res.data?.code !== 'Ok') {
            throw new Error(res.data?.message || res.data?.code || 'Matrix chunk response invalid');
          }
          for (let r = 0; r < sChunk.length; r++) {
            for (let c = 0; c < sChunk.length; c++) {
              const dist = res.data.distances[r][c];
              const dur = res.data.durations[r][c];
              if (dist === null || dur === null) {
                unreachable.push(`${ci * CHUNK_SIZE + r}->${ci * CHUNK_SIZE + c}`);
              }
              fullDistances[ci * CHUNK_SIZE + r][ci * CHUNK_SIZE + c] = dist ?? 0;
              fullDurations[ci * CHUNK_SIZE + r][ci * CHUNK_SIZE + c] = dur ?? 0;
            }
          }
        } else {
          const combined = [...sChunk, ...dChunk];
          const blockCoords = combined.map(([lng, lat]) => `${lng},${lat}`).join(';');
          const sIndices = sChunk.map((_, idx) => idx).join(';');
          const dIndices = dChunk.map((_, idx) => sChunk.length + idx).join(';');
          const url = `${this.baseUrl}/directions-matrix/v1/mapbox/driving/${blockCoords}`;
          const res = await axios.get(url, {
            params: {
              sources: sIndices,
              destinations: dIndices,
              annotations: 'distance,duration',
              access_token: this.accessToken,
            },
            timeout: 12000,
          });
          if (res.data?.code !== 'Ok') {
            throw new Error(res.data?.message || res.data?.code || 'Matrix chunk response invalid');
          }
          for (let r = 0; r < sChunk.length; r++) {
            for (let c = 0; c < dChunk.length; c++) {
              const dist = res.data.distances[r][c];
              const dur = res.data.durations[r][c];
              if (dist === null || dur === null) {
                unreachable.push(`${ci * CHUNK_SIZE + r}->${cj * CHUNK_SIZE + c}`);
              }
              fullDistances[ci * CHUNK_SIZE + r][cj * CHUNK_SIZE + c] = dist ?? 0;
              fullDurations[ci * CHUNK_SIZE + r][cj * CHUNK_SIZE + c] = dur ?? 0;
            }
          }
        }
      }
    };

    try {
      const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
      await Promise.all(workers);

      if (unreachable.length > 0) {
        throw new Error(`Không có đường cho các cặp tọa độ: ${unreachable.slice(0, 8).join(', ')}`);
      }

      return {
        distancesMeters: fullDistances,
        durationsSeconds: fullDurations,
      };
    } catch (error) {
      this.logger.error(`Matrix API error (chunked): ${error.message}`);
      throw new BadGatewayException(
        `Mapbox Matrix không khả dụng: ${error.response?.data?.message || error.message}`,
      );
    }
  }
}
