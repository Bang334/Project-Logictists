import { Injectable, Logger } from '@nestjs/common';
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
      // Fallback cự ly đường chim bay x hệ số đường bộ 1.3 nếu Mapbox gặp sự cố
      let fallbackDistance = 0;
      for (let i = 0; i < coordinates.length - 1; i++) {
        fallbackDistance += this.haversineDistance(coordinates[i], coordinates[i + 1]) * 1.3;
      }
      fallbackDistance = Math.round(fallbackDistance * 10) / 10;
      const fallbackDuration = Math.round((fallbackDistance / 40) * 60); // 40 km/h vận tốc xe tải trung bình

      return {
        distanceKm: fallbackDistance,
        durationMinutes: fallbackDuration,
        geometry: {
          type: 'LineString',
          coordinates: coordinates,
        },
        waypoints: [],
      };
    }
  }

  private haversineDistance(c1: [number, number], c2: [number, number]): number {
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371; // km
    const dLat = toRad(c2[1] - c1[1]);
    const dLon = toRad(c2[0] - c1[0]);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(c1[1])) * Math.cos(toRad(c2[1])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
