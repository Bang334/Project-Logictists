import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import axios from 'axios';
import type { Queue } from 'bullmq';

export class MapboxMatrixRateLimitException extends ServiceUnavailableException {
  constructor() {
    super('Mapbox Matrix vẫn giới hạn lượt gọi sau 3 lần thử; vui lòng thử lại sau.');
  }
}

export type MapboxRequestOptions = {
  signal?: AbortSignal;
};

type CachedMatrixPair = {
  distanceMeters: number;
  durationSeconds: number;
  expiresAt: number;
};

const MATRIX_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MATRIX_CACHE_TTL_SECONDS = 12 * 60 * 60;
const MAX_LOCAL_MATRIX_CACHE_ENTRIES = 50_000;
const MATRIX_REDIS_KEY_PREFIX = 'mapbox:matrix:v1:driving:';

function createAbortError(): Error {
  const err = new Error('Mapbox request aborted');
  err.name = 'CanceledError';
  (err as Error & { code?: string }).code = 'ERR_CANCELED';
  return err;
}

function isAbortSignalOrCancel(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof axios.isCancel === 'function' && axios.isCancel(error)) return true;
  const candidate = error as { code?: unknown; name?: unknown } | undefined;
  return (
    candidate?.code === 'ERR_CANCELED' ||
    candidate?.name === 'AbortError' ||
    candidate?.name === 'CanceledError'
  );
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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

type RedisPipelineResult = [Error | null, unknown][];
type RedisPipeline = {
  hmget: (key: string, ...fields: string[]) => unknown;
  hset: (key: string, values: Record<string, string>) => unknown;
  expire: (key: string, seconds: number) => unknown;
  exec: () => Promise<RedisPipelineResult | null>;
};
type RedisMatrixClient = {
  pipeline?: () => RedisPipeline;
};

@Injectable()
export class MapboxService {
  private readonly logger = new Logger(MapboxService.name);
  private readonly accessToken = process.env.MAPBOX_ACCESS_TOKEN || '';
  private readonly baseUrl = 'https://api.mapbox.com';
  private matrixQueue: Promise<unknown> = Promise.resolve();
  private nextMatrixRequestAt = 0;
  private readonly localMatrixCache = new Map<string, CachedMatrixPair>();

  constructor(
    @Optional()
    @InjectQueue('optimization')
    private readonly redisQueue?: Queue,
  ) {}

  private matrixGet(
    url: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const request = this.matrixQueue.then(async () => {
      if (signal?.aborted) {
        throw createAbortError();
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        const delay = Math.max(0, this.nextMatrixRequestAt - Date.now());
        if (delay > 0) await waitWithAbort(delay, signal);
        this.nextMatrixRequestAt = Date.now() + 1100;
        try {
          return await axios.get(url, {
            params,
            timeout: 12000,
            ...(signal ? { signal } : {}),
          });
        } catch (error: unknown) {
          if (isAbortSignalOrCancel(error, signal)) throw error;
          if (!axios.isAxiosError(error) || error.response?.status !== 429) throw error;
          const headers = error.response.headers;
          const retryAfter = headers['retry-after'];
          const seconds = Number(retryAfter);
          const retryDate = typeof retryAfter === 'string' ? Date.parse(retryAfter) : NaN;
          const reset = Number(headers['x-rate-limit-reset']) * 1000;
          const retryAt = Number.isFinite(seconds) && seconds > 0
            ? Date.now() + seconds * 1000
            : Number.isFinite(retryDate) ? retryDate : 0;
          const waitUntil = Math.max(Date.now() + 2000 * 2 ** attempt, retryAt,
            Number.isFinite(reset) ? reset : 0);
          this.nextMatrixRequestAt = Math.max(this.nextMatrixRequestAt, waitUntil);
          if (attempt === 2 || waitUntil - Date.now() > 120000) {
            throw new MapboxMatrixRateLimitException();
          }
        }
      }
      throw new MapboxMatrixRateLimitException();
    });
    this.matrixQueue = request.catch(() => undefined);
    return request;
  }

  private coordCacheKey([lng, lat]: [number, number]): string {
    return `${lng.toFixed(6)},${lat.toFixed(6)}`;
  }

  private async getRedisMatrixClient(): Promise<RedisMatrixClient | null> {
    const clientPromise = this.redisQueue?.client;
    if (!clientPromise || typeof clientPromise.then !== 'function') {
      return null;
    }
    try {
      const client = (await Promise.race([
        clientPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ])) as RedisMatrixClient | null;
      return client && typeof client.pipeline === 'function' ? client : null;
    } catch {
      return null;
    }
  }

  private setLocalMatrixEntry(
    originKey: string,
    destKey: string,
    distanceMeters: number,
    durationSeconds: number,
    now: number,
  ): void {
    const pairKey = `${originKey}->${destKey}`;
    if (this.localMatrixCache.has(pairKey)) {
      this.localMatrixCache.delete(pairKey);
    } else if (this.localMatrixCache.size >= MAX_LOCAL_MATRIX_CACHE_ENTRIES) {
      const evictCount = Math.max(1, Math.floor(MAX_LOCAL_MATRIX_CACHE_ENTRIES * 0.1));
      let removed = 0;
      for (const oldKey of this.localMatrixCache.keys()) {
        this.localMatrixCache.delete(oldKey);
        removed += 1;
        if (removed >= evictCount) break;
      }
    }
    this.localMatrixCache.set(pairKey, {
      distanceMeters,
      durationSeconds,
      expiresAt: now + MATRIX_CACHE_TTL_MS,
    });
  }

  private async populateCachedMatrixPairs(
    coordKeys: string[],
    distances: number[][],
    durations: number[][],
    missing: boolean[][],
  ): Promise<number> {
    const n = coordKeys.length;
    const now = Date.now();
    const missingByRow: { row: number; cols: number[] }[] = [];
    let missingCount = 0;

    for (let i = 0; i < n; i++) {
      missing[i][i] = false;
      distances[i][i] = 0;
      durations[i][i] = 0;
      const rowMissingCols: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cached = this.localMatrixCache.get(`${coordKeys[i]}->${coordKeys[j]}`);
        if (cached && cached.expiresAt > now) {
          distances[i][j] = cached.distanceMeters;
          durations[i][j] = cached.durationSeconds;
          missing[i][j] = false;
        } else {
          if (cached) this.localMatrixCache.delete(`${coordKeys[i]}->${coordKeys[j]}`);
          rowMissingCols.push(j);
        }
      }
      if (rowMissingCols.length > 0) {
        missingByRow.push({ row: i, cols: rowMissingCols });
        missingCount += rowMissingCols.length;
      }
    }

    if (missingCount === 0) return 0;

    const redisClient = await this.getRedisMatrixClient();
    if (!redisClient?.pipeline) return missingCount;

    try {
      const pipeline = redisClient.pipeline();
      for (const { row, cols } of missingByRow) {
        const destFields = cols.map((col) => coordKeys[col]);
        pipeline.hmget(`${MATRIX_REDIS_KEY_PREFIX}${coordKeys[row]}`, ...destFields);
      }
      const results = await pipeline.exec();
      if (!results) return missingCount;

      results.forEach(([err, rawValues], idx) => {
        if (err || !Array.isArray(rawValues)) return;
        const { row, cols } = missingByRow[idx];
        rawValues.forEach((raw, colIdx) => {
          if (typeof raw !== 'string') return;
          const comma = raw.indexOf(',');
          if (comma <= 0) return;
          const dist = Number(raw.slice(0, comma));
          const dur = Number(raw.slice(comma + 1));
          if (!Number.isFinite(dist) || !Number.isFinite(dur) || dist < 0 || dur < 0) {
            return;
          }
          const col = cols[colIdx];
          distances[row][col] = dist;
          durations[row][col] = dur;
          missing[row][col] = false;
          missingCount -= 1;
          this.setLocalMatrixEntry(coordKeys[row], coordKeys[col], dist, dur, now);
        });
      });
    } catch (error) {
      this.logger.debug(
        `Redis matrix cache read skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return missingCount;
  }

  private async persistMatrixPairs(
    entries: Array<{ originKey: string; destKey: string; distanceMeters: number; durationSeconds: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    const byOrigin = new Map<string, Record<string, string>>();

    for (const entry of entries) {
      this.setLocalMatrixEntry(
        entry.originKey,
        entry.destKey,
        entry.distanceMeters,
        entry.durationSeconds,
        now,
      );
      let fields = byOrigin.get(entry.originKey);
      if (!fields) {
        fields = {};
        byOrigin.set(entry.originKey, fields);
      }
      fields[entry.destKey] = `${entry.distanceMeters},${entry.durationSeconds}`;
    }

    const redisClient = await this.getRedisMatrixClient();
    if (!redisClient?.pipeline) return;

    try {
      const pipeline = redisClient.pipeline();
      for (const [originKey, fields] of byOrigin.entries()) {
        const redisKey = `${MATRIX_REDIS_KEY_PREFIX}${originKey}`;
        pipeline.hset(redisKey, fields);
        pipeline.expire(redisKey, MATRIX_CACHE_TTL_SECONDS);
      }
      await pipeline.exec();
    } catch (error) {
      this.logger.debug(
        `Redis matrix cache write skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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
  async getRoute(
    coordinates: [number, number][],
    options?: MapboxRequestOptions,
  ): Promise<DirectionsResult> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw createAbortError();
    }
    this.assertCoordinates(coordinates);
    if (coordinates.length < 2) {
      return {
        distanceKm: 0,
        durationMinutes: 0,
        geometry: null,
        waypoints: [],
      };
    }

    if (coordinates.length > 25) {
      const parts: DirectionsResult[] = [];
      for (let start = 0; start < coordinates.length - 1; start += 24) {
        if (signal?.aborted) throw createAbortError();
        parts.push(await this.getRoute(coordinates.slice(start, start + 25), options));
      }
      return {
        distanceKm: Math.round(parts.reduce((sum, part) => sum + part.distanceKm, 0) * 10) / 10,
        durationMinutes: parts.reduce((sum, part) => sum + part.durationMinutes, 0),
        geometry: {
          type: 'LineString',
          coordinates: parts.flatMap((part, index) =>
            index === 0 ? part.geometry.coordinates : part.geometry.coordinates.slice(1)),
          ...(parts.every(part => Array.isArray(part.geometry.waypoint_indices)) ? {
            waypoint_indices: parts.flatMap((part, index) => {
              const offset = parts.slice(0, index).reduce((sum, previous) => sum + previous.geometry.coordinates.length - 1, 0);
              return part.geometry.waypoint_indices.slice(index === 0 ? 0 : 1).map((point: number) => point + offset);
            }),
          } : {}),
        },
        waypoints: parts.flatMap((part, index) => index === 0 ? part.waypoints : part.waypoints.slice(1)),
      };
    }

    try {
      // Coordinates format for Mapbox: lng,lat;lng,lat;...
      const coordsString = coordinates.map((c) => `${c[0]},${c[1]}`).join(';');
      const url = `${this.baseUrl}/directions/v5/mapbox/driving/${coordsString}?geometries=geojson&overview=full&steps=true&access_token=${this.accessToken}`;

      const response = await axios.get(url, {
        timeout: 10000,
        ...(signal ? { signal } : {}),
      });

      if (!response.data || !response.data.routes || response.data.routes.length === 0) {
        throw new Error('No route found between the provided coordinates');
      }

      const route = response.data.routes[0];
      // Step geometries preserve the exact visit order even when a road or depot is revisited.
      const legPaths: [number, number][][] = Array.isArray(route.legs)
        ? route.legs.map((leg: { steps?: { geometry?: { coordinates?: [number, number][] } }[] }) =>
          leg.steps?.flatMap(step => step.geometry?.coordinates ?? []) ?? [])
        : [];
      let geometry = route.geometry;
      if (legPaths.length === coordinates.length - 1 && legPaths.every(path => path.length >= 2)) {
        const points: [number, number][] = [];
        const waypointIndices = [0];
        for (const path of legPaths) {
          points.push(...path);
          waypointIndices.push(points.length - 1);
        }
        geometry = { type: 'LineString', coordinates: points, waypoint_indices: waypointIndices };
      }
      const distanceKm = Math.round((route.distance / 1000) * 10) / 10;
      const durationMinutes = Math.round(route.duration / 60);

      return {
        distanceKm,
        durationMinutes,
        geometry,
        waypoints: response.data.waypoints || [],
      };
    } catch (error) {
      if (isAbortSignalOrCancel(error, signal)) throw error;
      this.logger.error('Directions API error:', error.message);
      throw new BadGatewayException(
        'Mapbox Directions không trả được tuyến đường; không dùng đường chim bay thay cho tuyến hợp lệ',
      );
    }
  }

  async getRoadMatrix(
    coordinates: [number, number][],
    options?: MapboxRequestOptions,
  ): Promise<RoadMatrixResult> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw createAbortError();
    }
    this.assertCoordinates(coordinates);
    if (!this.accessToken) {
      throw new ServiceUnavailableException('Thiếu MAPBOX_ACCESS_TOKEN cho Matrix API');
    }
    if (coordinates.length === 0) {
      return { distancesMeters: [], durationsSeconds: [] };
    }
    if (coordinates.length === 1) {
      return { distancesMeters: [[0]], durationsSeconds: [[0]] };
    }

    const unique: [number, number][] = [];
    const indices = new Map<string, number>();
    const mapping = coordinates.map(coordinate => {
      const key = JSON.stringify(coordinate);
      let index = indices.get(key);
      if (index === undefined) {
        index = unique.length;
        indices.set(key, index);
        unique.push(coordinate);
      }
      return index;
    });
    if (unique.length < coordinates.length) {
      const matrix = await this.getRoadMatrix(unique, options);
      return {
        distancesMeters: mapping.map(a => mapping.map(b => matrix.distancesMeters[a][b])),
        durationsSeconds: mapping.map(a => mapping.map(b => matrix.durationsSeconds[a][b])),
      };
    }

    const n = coordinates.length;
    const coordKeys = coordinates.map((coord) => this.coordCacheKey(coord));
    const fullDistances: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const fullDurations: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const missing: boolean[][] = Array.from({ length: n }, () => Array(n).fill(true));
    const missingCount = await this.populateCachedMatrixPairs(
      coordKeys,
      fullDistances,
      fullDurations,
      missing,
    );
    if (missingCount === 0) {
      return {
        distancesMeters: fullDistances,
        durationsSeconds: fullDurations,
      };
    }

    const pendingCacheEntries: Array<{
      originKey: string;
      destKey: string;
      distanceMeters: number;
      durationSeconds: number;
    }> = [];

    const collectBlock = (
      rowOffset: number,
      colOffset: number,
      blockDistances: Array<Array<number | null>>,
      blockDurations: Array<Array<number | null>>,
      unreachable: string[],
    ) => {
      for (let r = 0; r < blockDistances.length; r++) {
        const globalRow = rowOffset + r;
        for (let c = 0; c < blockDistances[r].length; c++) {
          const globalCol = colOffset + c;
          const dist = blockDistances[r][c];
          const dur = blockDurations[r]?.[c] ?? null;
          if (dist === null || dur === null) {
            unreachable.push(`${globalRow}->${globalCol}`);
            continue;
          }
          fullDistances[globalRow][globalCol] = dist;
          fullDurations[globalRow][globalCol] = dur;
          if (globalRow !== globalCol) {
            pendingCacheEntries.push({
              originKey: coordKeys[globalRow],
              destKey: coordKeys[globalCol],
              distanceMeters: dist,
              durationSeconds: dur,
            });
          }
        }
      }
    };

    // Nếu số lượng tọa độ <= 25, gọi 1 request trực tiếp tới Mapbox Matrix API
    if (coordinates.length <= 25) {
      const coordsString = coordinates.map(([lng, lat]) => `${lng},${lat}`).join(';');
      const url = `${this.baseUrl}/directions-matrix/v1/mapbox/driving/${coordsString}`;
      try {
        const response = await this.matrixGet(
          url,
          { annotations: 'distance,duration', access_token: this.accessToken },
          signal,
        );
        if (response.data?.code !== 'Ok') {
          throw new Error(response.data?.message || response.data?.code || 'Matrix response invalid');
        }
        const distances = response.data.distances as Array<Array<number | null>>;
        const durations = response.data.durations as Array<Array<number | null>>;
        this.assertMatrixShape(distances, coordinates.length, coordinates.length);
        this.assertMatrixShape(durations, coordinates.length, coordinates.length);
        const unreachable: string[] = [];
        collectBlock(0, 0, distances, durations, unreachable);
        if (unreachable.length > 0) {
          throw new Error(`Không có đường cho các cặp tọa độ: ${unreachable.slice(0, 8).join(', ')}`);
        }
        await this.persistMatrixPairs(pendingCacheEntries);
        return {
          distancesMeters: distances as number[][],
          durationsSeconds: durations as number[][],
        };
      } catch (error) {
        if (isAbortSignalOrCancel(error, signal)) throw error;
        if (error instanceof MapboxMatrixRateLimitException) throw error;
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

    const tasks: { ci: number; cj: number }[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      for (let cj = 0; cj < chunks.length; cj++) {
        const rowStart = ci * CHUNK_SIZE;
        const colStart = cj * CHUNK_SIZE;
        let blockHasMissing = false;
        for (let r = 0; r < chunks[ci].length && !blockHasMissing; r++) {
          for (let c = 0; c < chunks[cj].length; c++) {
            if (missing[rowStart + r][colStart + c]) {
              blockHasMissing = true;
              break;
            }
          }
        }
        if (blockHasMissing) {
          tasks.push({ ci, cj });
        }
      }
    }

    const concurrency = 1;
    let taskIndex = 0;
    const unreachable: string[] = [];

    const worker = async () => {
      while (taskIndex < tasks.length) {
        if (signal?.aborted) throw createAbortError();
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
          const res = await this.matrixGet(
            url,
            { annotations: 'distance,duration', access_token: this.accessToken },
            signal,
          );
          if (res.data?.code !== 'Ok') {
            throw new Error(res.data?.message || res.data?.code || 'Matrix chunk response invalid');
          }
          this.assertMatrixShape(res.data.distances, sChunk.length, sChunk.length);
          this.assertMatrixShape(res.data.durations, sChunk.length, sChunk.length);
          collectBlock(ci * CHUNK_SIZE, ci * CHUNK_SIZE, res.data.distances, res.data.durations, unreachable);
        } else {
          const combined = [...sChunk, ...dChunk];
          const blockCoords = combined.map(([lng, lat]) => `${lng},${lat}`).join(';');
          const sIndices = sChunk.map((_, idx) => idx).join(';');
          const dIndices = dChunk.map((_, idx) => sChunk.length + idx).join(';');
          const url = `${this.baseUrl}/directions-matrix/v1/mapbox/driving/${blockCoords}`;
          const res = await this.matrixGet(
            url,
            {
              sources: sIndices,
              destinations: dIndices,
              annotations: 'distance,duration',
              access_token: this.accessToken,
            },
            signal,
          );
          if (res.data?.code !== 'Ok') {
            throw new Error(res.data?.message || res.data?.code || 'Matrix chunk response invalid');
          }
          this.assertMatrixShape(res.data.distances, sChunk.length, dChunk.length);
          this.assertMatrixShape(res.data.durations, sChunk.length, dChunk.length);
          collectBlock(ci * CHUNK_SIZE, cj * CHUNK_SIZE, res.data.distances, res.data.durations, unreachable);
        }
      }
    };

    try {
      const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
      await Promise.all(workers);

      if (unreachable.length > 0) {
        throw new Error(`Không có đường cho các cặp tọa độ: ${unreachable.slice(0, 8).join(', ')}`);
      }

      await this.persistMatrixPairs(pendingCacheEntries);
      return {
        distancesMeters: fullDistances,
        durationsSeconds: fullDurations,
      };
    } catch (error) {
      if (isAbortSignalOrCancel(error, signal)) throw error;
      if (error instanceof MapboxMatrixRateLimitException) throw error;
      this.logger.error(`Matrix API error (chunked): ${error.message}`);
      throw new BadGatewayException(
        `Mapbox Matrix không khả dụng: ${error.response?.data?.message || error.message}`,
      );
    }
  }

  private assertCoordinates(coordinates: [number, number][]) {
    for (const [index, coordinate] of coordinates.entries()) {
      const [longitude, latitude] = coordinate;
      if (
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90
      ) {
        throw new BadRequestException(`Tọa độ Mapbox tại index ${index} không hợp lệ`);
      }
    }
  }

  private assertMatrixShape(
    matrix: unknown,
    expectedRows: number,
    expectedColumns: number,
  ): asserts matrix is Array<Array<number | null>> {
    if (
      !Array.isArray(matrix) ||
      matrix.length !== expectedRows ||
      matrix.some(
        (row) => !Array.isArray(row) || row.length !== expectedColumns,
      )
    ) {
      throw new Error(
        `Matrix response sai kích thước, cần ${expectedRows}x${expectedColumns}`,
      );
    }
    for (const row of matrix) {
      for (const value of row) {
        if (value !== null && (!Number.isFinite(value) || value < 0)) {
          throw new Error('Matrix response chứa khoảng cách/thời gian không hợp lệ');
        }
      }
    }
  }
}
