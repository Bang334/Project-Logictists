export interface CurfewWindowConfig {
  startTime: string;
  endTime: string;
}

export interface ZoneCurfewRecord {
  id: string;
  name: string;
  active: boolean;
  maxPayloadKg: number;
  polygon: unknown;
  curfewWindows: unknown;
}

export interface OptimizerCurfewWindow {
  max_payload_kg: number;
  start_sec: number;
  end_sec: number;
}

/**
 * Parse 'HH:mm' into minutes since midnight [0, 1440].
 */
export function parseTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Giờ không hợp lệ: ${value}`);
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh === 24 && mm === 0) return 1440;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`Giờ ngoài phạm vi 00:00–24:00: ${value}`);
  }
  return hh * 60 + mm;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const intersects =
      yi > lat !== yj > lat &&
      lng <= ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Ray-casting check for GeoJSON Polygon coordinates (outer ring + optional holes).
 */
export function isPointInPolygon(
  lng: number,
  lat: number,
  polygon: unknown,
): boolean {
  if (!Array.isArray(polygon) || polygon.length === 0) return false;
  const outer = polygon[0] as number[][];
  if (!pointInRing(lng, lat, outer)) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lng, lat, polygon[h] as number[][])) {
      return false;
    }
  }
  return true;
}

/**
 * Compute UTC epoch timestamp (ms) of local midnight (00:00:00) for the calendar date
 * of `planningEpoch` in `timeZone`.
 */
function getLocalDayStartUtcMs(planningEpoch: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(planningEpoch).map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const offsetFromMidnightMs = (hour * 3600 + minute * 60 + second) * 1000;
  return planningEpoch.getTime() - offsetFromMidnightMs;
}

/**
 * Expand active zone curfew windows matching `(lat, lng)` into seconds relative to `planningEpoch`.
 */
export function expandZoneCurfewsRelativeToEpoch(
  zones: readonly ZoneCurfewRecord[],
  lat: number,
  lng: number,
  planningEpoch: Date,
  totalDays: number,
  timeZone = 'Asia/Ho_Chi_Minh',
): OptimizerCurfewWindow[] {
  if (!zones.length) return [];
  const matching = zones.filter(
    (z) => z.active && isPointInPolygon(lng, lat, z.polygon),
  );
  if (!matching.length) return [];

  const epochMs = planningEpoch.getTime();
  const baseDayStartMs = getLocalDayStartUtcMs(planningEpoch, timeZone);
  const dayCount = Math.max(1, Math.ceil(totalDays) + 1);
  const out: OptimizerCurfewWindow[] = [];

  for (const zone of matching) {
    const windows = Array.isArray(zone.curfewWindows)
      ? (zone.curfewWindows as CurfewWindowConfig[])
      : [];
    for (const win of windows) {
      if (!win || typeof win.startTime !== 'string' || typeof win.endTime !== 'string') {
        continue;
      }
      const startMin = parseTimeToMinutes(win.startTime);
      const endMin = parseTimeToMinutes(win.endTime);
      if (endMin <= startMin) continue;

      for (let d = 0; d < dayCount; d++) {
        const dayMidnightMs = baseDayStartMs + d * 86_400_000;
        const startSec = Math.round((dayMidnightMs + startMin * 60_000 - epochMs) / 1000);
        const endSec = Math.round((dayMidnightMs + endMin * 60_000 - epochMs) / 1000);
        if (endSec <= 0) continue;
        out.push({
          max_payload_kg: Number(zone.maxPayloadKg),
          start_sec: Math.max(0, startSec),
          end_sec: endSec,
        });
      }
    }
  }

  out.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
  return out;
}
