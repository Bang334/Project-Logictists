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
    if (coordinates.length < 2 || coordinates.length > 25) {
      throw new BadGatewayException(
        `Mapbox Matrix yêu cầu 2–25 tọa độ, nhận ${coordinates.length}`,
      );
    }

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
}
