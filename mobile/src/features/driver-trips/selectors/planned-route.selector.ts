import type { LineString } from 'geojson';

export type PlannedRoute = Pick<LineString, 'type'> & { coordinates: [number, number][] };

export function parsePlannedRoute(stored: string | null | undefined): PlannedRoute | null {
  if (!stored) return null;

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' ||
        !('type' in parsed) || parsed.type !== 'LineString' ||
        !('coordinates' in parsed) || !Array.isArray(parsed.coordinates) ||
        parsed.coordinates.length < 2) return null;

    const coordinates: PlannedRoute['coordinates'] = [];
    for (const position of parsed.coordinates as unknown[]) {
      if (!Array.isArray(position)) return null;
      const [longitude, latitude] = position as unknown[];
      if (typeof longitude !== 'number' || !Number.isFinite(longitude) ||
          longitude < -180 || longitude > 180 ||
          typeof latitude !== 'number' || !Number.isFinite(latitude) ||
          latitude < -90 || latitude > 90) return null;
      coordinates.push([longitude, latitude]);
    }
    return { type: 'LineString', coordinates };
  } catch {
    return null;
  }
}
