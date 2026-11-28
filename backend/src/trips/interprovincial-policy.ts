import { BadRequestException } from '@nestjs/common';

export type WarehouseRoleCode = 'HUB' | 'WAREHOUSE' | 'TRANSIT';
export type TemperatureModeCode = 'DRY' | 'CHILLED' | 'FROZEN' | 'ISOTHERMAL' | 'HAZMAT';
export type CargoTemperatureCode = 'DRY' | 'CHILLED' | 'FROZEN' | 'HAZMAT';

export interface WarehouseOperatingWindowPayload {
  start_sec: number;
  end_sec: number;
}

export interface InterprovincialLocationPayload {
  warehouse_location_id?: string;
  province_code?: string;
  province_name?: string;
  warehouse_role?: WarehouseRoleCode;
  docking_time_sec?: number;
  max_vehicle_payload_kg?: number;
  max_vehicle_length_cm?: number;
  has_forklift?: boolean;
  allows_hazmat?: boolean;
  operating_windows?: WarehouseOperatingWindowPayload[];
  handling_sec_per_ton?: number;
  handling_sec_per_package?: number;
}

export interface LocationConstraintSource {
  id: string;
  provinceCode?: string | null;
  provinceName?: string | null;
  warehouseRole?: WarehouseRoleCode | string | null;
  dockingTimeSec?: number | null;
  maxVehiclePayloadKg?: number | null;
  maxVehicleLengthCm?: number | null;
  hasForklift?: boolean | null;
  operatingWindows?: unknown;
  handlingSecPerTon?: number | null;
  handlingSecPerPackage?: number | null;
  capabilities?: unknown;
}

export interface DrivingRestPolicyPayload {
  policy_code: string;
  effective_from: string;
  jurisdiction: string;
  enabled: boolean;
  max_continuous_driving_sec: number;
  short_rest_duration_sec: number;
  max_daily_driving_sec: number;
  daily_rest_duration_sec: number;
  max_weekly_driving_sec?: number;
  min_inter_trip_rest_sec: number;
  overnight_allowance_vnd: number;
  rest_allowance_during_service: boolean;
}

export interface WorkPolicyRow {
  code: string;
  revision: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  jurisdiction: string;
  limits: unknown;
}

export interface TollCorridorRecord {
  fromProvinceCode: string;
  toProvinceCode: string;
  baseTollVnd: number;
  active?: boolean;
}

export const DEFAULT_VN_2024_DRIVING_REST_POLICY: DrivingRestPolicyPayload = {
  policy_code: 'VN_TTATGTDB_2024',
  effective_from: '2025-01-01',
  jurisdiction: 'VN',
  enabled: true,
  max_continuous_driving_sec: 4 * 3600,
  short_rest_duration_sec: 15 * 60,
  max_daily_driving_sec: 10 * 3600,
  daily_rest_duration_sec: 8 * 3600,
  max_weekly_driving_sec: 48 * 3600,
  min_inter_trip_rest_sec: 0,
  overnight_allowance_vnd: 0,
  rest_allowance_during_service: true,
};

const CLOCK_REGEX = /^(\d{2}):(\d{2})$/;
const VALID_WAREHOUSE_ROLES = new Set<string>(['HUB', 'WAREHOUSE', 'TRANSIT']);

export function parseClockToSeconds(clock: string): number | null {
  const match = CLOCK_REGEX.exec(clock.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour === 24 && minute === 0) return 86_400;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 3600 + minute * 60;
}

export function parseOperatingWindows(raw: unknown): WarehouseOperatingWindowPayload[] {
  if (!Array.isArray(raw)) return [];
  const parsed: WarehouseOperatingWindowPayload[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    let startSec: number | null = null;
    let endSec: number | null = null;

    const rawStart = obj.start_sec ?? obj.startSec;
    const rawEnd = obj.end_sec ?? obj.endSec;
    if (
      typeof rawStart === 'number' &&
      Number.isFinite(rawStart) &&
      typeof rawEnd === 'number' &&
      Number.isFinite(rawEnd)
    ) {
      startSec = Math.trunc(rawStart);
      endSec = Math.trunc(rawEnd);
    } else if (
      typeof obj.startTime === 'string' &&
      typeof obj.endTime === 'string'
    ) {
      startSec = parseClockToSeconds(obj.startTime);
      endSec = parseClockToSeconds(obj.endTime);
    }

    if (
      startSec !== null &&
      endSec !== null &&
      startSec >= 0 &&
      endSec <= 86_400 &&
      endSec > startSec
    ) {
      parsed.push({ start_sec: startSec, end_sec: endSec });
    }
  }
  return parsed.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
}

export function extractLocationConstraintFields(
  location: LocationConstraintSource | null | undefined,
): InterprovincialLocationPayload {
  if (!location) return {};
  const payload: InterprovincialLocationPayload = {};

  if (location.provinceCode) {
    payload.province_code = location.provinceCode.trim().toUpperCase();
  }
  if (location.provinceName) {
    payload.province_name = location.provinceName.trim();
  }
  if (
    location.warehouseRole &&
    VALID_WAREHOUSE_ROLES.has(String(location.warehouseRole).toUpperCase())
  ) {
    payload.warehouse_role = String(location.warehouseRole).toUpperCase() as WarehouseRoleCode;
  }
  if (typeof location.dockingTimeSec === 'number' && location.dockingTimeSec > 0) {
    payload.docking_time_sec = Math.trunc(location.dockingTimeSec);
  }
  if (
    typeof location.maxVehiclePayloadKg === 'number' &&
    location.maxVehiclePayloadKg > 0
  ) {
    payload.max_vehicle_payload_kg = location.maxVehiclePayloadKg;
  }
  if (
    typeof location.maxVehicleLengthCm === 'number' &&
    location.maxVehicleLengthCm > 0
  ) {
    payload.max_vehicle_length_cm = location.maxVehicleLengthCm;
  }
  if (typeof location.hasForklift === 'boolean') {
    payload.has_forklift = location.hasForklift;
  }
  if (
    location.capabilities &&
    typeof location.capabilities === 'object' &&
    !Array.isArray(location.capabilities)
  ) {
    const caps = location.capabilities as Record<string, unknown>;
    const rawAllowsHazmat = caps.allowsHazmat ?? caps.allows_hazmat;
    if (typeof rawAllowsHazmat === 'boolean') {
      payload.allows_hazmat = rawAllowsHazmat;
    }
  }
  const operatingWindows = parseOperatingWindows(location.operatingWindows);
  if (operatingWindows.length > 0) {
    payload.operating_windows = operatingWindows;
  }
  if (
    typeof location.handlingSecPerTon === 'number' &&
    location.handlingSecPerTon > 0
  ) {
    payload.handling_sec_per_ton = Math.trunc(location.handlingSecPerTon);
  }
  if (
    typeof location.handlingSecPerPackage === 'number' &&
    location.handlingSecPerPackage > 0
  ) {
    payload.handling_sec_per_package = Math.trunc(location.handlingSecPerPackage);
  }
  return payload;
}

export function parseWorkPolicyToDrivingRest(
  policy: WorkPolicyRow | null | undefined,
): DrivingRestPolicyPayload | null {
  if (!policy || !policy.limits || typeof policy.limits !== 'object' || Array.isArray(policy.limits)) {
    return null;
  }
  const raw = policy.limits as Record<string, unknown>;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;

  const readInt = (
    keys: string[],
    fallback: number,
    min: number,
  ): number => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= min) {
        return value;
      }
    }
    return fallback;
  };

  const maxContinuous = readInt(
    ['maxContinuousDrivingSec', 'max_continuous_driving_sec'],
    4 * 3600,
    1,
  );
  const shortRest = readInt(
    ['shortRestDurationSec', 'short_rest_duration_sec'],
    15 * 60,
    0,
  );
  const maxDaily = readInt(
    ['maxDailyDrivingSec', 'max_daily_driving_sec'],
    10 * 3600,
    1,
  );
  const dailyRest = readInt(
    ['dailyRestDurationSec', 'daily_rest_duration_sec'],
    8 * 3600,
    0,
  );
  const rawWeekly = raw.maxWeeklyDrivingSec ?? raw.max_weekly_driving_sec;
  const maxWeekly =
    rawWeekly === null
      ? undefined
      : typeof rawWeekly === 'number' && Number.isInteger(rawWeekly) && rawWeekly > 0
        ? rawWeekly
        : 48 * 3600;
  const minInterTripRest = readInt(
    ['minInterTripRestSec', 'min_inter_trip_rest_sec'],
    0,
    0,
  );
  const overnightAllowance = readInt(
    ['overnightAllowanceVnd', 'overnight_allowance_vnd'],
    0,
    0,
  );
  const restDuringService =
    typeof (raw.restAllowanceDuringService ?? raw.rest_allowance_during_service) ===
    'boolean'
      ? Boolean(raw.restAllowanceDuringService ?? raw.rest_allowance_during_service)
      : true;

  if (maxDaily < maxContinuous) {
    throw new BadRequestException(
      `WorkPolicy ${policy.code} không hợp lệ: maxDailyDrivingSec phải >= maxContinuousDrivingSec`,
    );
  }
  if (maxWeekly !== undefined && maxWeekly < maxDaily) {
    throw new BadRequestException(
      `WorkPolicy ${policy.code} không hợp lệ: maxWeeklyDrivingSec phải >= maxDailyDrivingSec`,
    );
  }

  return {
    policy_code: policy.code,
    effective_from: policy.effectiveFrom.toISOString().slice(0, 10),
    jurisdiction: policy.jurisdiction || 'VN',
    enabled,
    max_continuous_driving_sec: maxContinuous,
    short_rest_duration_sec: shortRest,
    max_daily_driving_sec: maxDaily,
    daily_rest_duration_sec: dailyRest,
    ...(maxWeekly !== undefined ? { max_weekly_driving_sec: maxWeekly } : {}),
    min_inter_trip_rest_sec: minInterTripRest,
    overnight_allowance_vnd: overnightAllowance,
    rest_allowance_during_service: restDuringService,
  };
}

export function resolveVietnamDrivingRestPolicy(
  policies: readonly WorkPolicyRow[],
  at: Date,
): DrivingRestPolicyPayload {
  const day = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
  const active = policies.find(policy =>
    policy.effectiveFrom.toISOString().slice(0, 10) <= day &&
    (!policy.effectiveTo || policy.effectiveTo.toISOString().slice(0, 10) >= day),
  );
  return parseWorkPolicyToDrivingRest(active) ?? DEFAULT_VN_2024_DRIVING_REST_POLICY;
}

/**
 * Compute base (Group-1) BOT highway toll matrix for node coordinates.
 * Returns undefined when the snapshot does not span multiple distinct provinces.
 */
export function buildInterprovincialTollMatrix(
  nodeProvinceCodes: Array<string | null | undefined>,
  distanceMatrixMeters: number[][],
  corridors: readonly TollCorridorRecord[],
): number[][] | undefined {
  const normalizedProvinces = nodeProvinceCodes.map((code) =>
    code ? code.trim().toUpperCase() : null,
  );
  const distinctProvinces = new Set(
    normalizedProvinces.filter((code): code is string => Boolean(code)),
  );
  if (distinctProvinces.size < 2) {
    return undefined;
  }

  const corridorLookup = new Map<string, number>();
  for (const row of corridors) {
    if (row.active === false) continue;
    const from = row.fromProvinceCode.trim().toUpperCase();
    const to = row.toProvinceCode.trim().toUpperCase();
    if (!from || !to) continue;
    corridorLookup.set(`${from}->${to}`, Math.max(0, Math.round(row.baseTollVnd)));
  }

  const size = normalizedProvinces.length;
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (__, j) => {
      if (i === j) return 0;
      const from = normalizedProvinces[i];
      const to = normalizedProvinces[j];
      if (!from || !to || from === to) return 0;

      const direct = corridorLookup.get(`${from}->${to}`);
      if (direct !== undefined) return direct;

      const reverse = corridorLookup.get(`${to}->${from}`);
      if (reverse !== undefined) return reverse;

      // Fallback highway BOT tariff (~1,000 VND/km past 20km urban approach) when pair is uncatalogued.
      const distMeters = distanceMatrixMeters[i]?.[j] ?? 0;
      if (!Number.isFinite(distMeters) || distMeters <= 20_000) return 0;
      return Math.round(((distMeters / 1000) - 20) * 1000);
    }),
  );
}

export function expectedWarehouseStopServiceSec(params: {
  baseServiceSec: number;
  location: LocationConstraintSource | null | undefined;
  previousLocationKey: string | null;
  totalWeightKg: number;
  packageCount: number;
}): { expectedSec: number; locationKey: string | null } {
  const { baseServiceSec, location, previousLocationKey, totalWeightKg, packageCount } = params;
  if (!location) {
    return { expectedSec: baseServiceSec, locationKey: null };
  }
  const perTon = Math.max(0, location.handlingSecPerTon ?? 0);
  const perPkg = Math.max(0, location.handlingSecPerPackage ?? 0);
  const dynamicHandling =
    perTon > 0 || perPkg > 0
      ? Math.max(0, Math.round(perTon * (totalWeightKg / 1000)) + perPkg * packageCount)
      : 0;
  const docking = Math.max(0, location.dockingTimeSec ?? 0);
  const locationKey = location.id;
  const includeDocking = docking > 0 && Boolean(locationKey) && locationKey !== previousLocationKey;
  return {
    expectedSec: baseServiceSec + dynamicHandling + (includeDocking ? docking : 0),
    locationKey,
  };
}

export function findMatchingWarehouseLocation<T extends LocationConstraintSource & {
  latitude: number;
  longitude: number;
}>(
  latitude: number,
  longitude: number,
  locations: readonly T[],
): T | null {
  for (const loc of locations) {
    if (
      Math.abs(loc.latitude - latitude) <= 0.0002 &&
      Math.abs(loc.longitude - longitude) <= 0.0002
    ) {
      return loc;
    }
  }
  return null;
}

export function startOfWeekInTimeZone(epoch: Date, timeZone = 'Asia/Ho_Chi_Minh'): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(epoch);
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const localUtcMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    const tzOffsetMs = localUtcMs - epoch.getTime();
    const localDate = new Date(localUtcMs);
    const mondayDeltaDays = (localDate.getUTCDay() + 6) % 7;
    const localMondayMidnightMs = Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate() - mondayDeltaDays,
      0,
      0,
      0,
    );
    return new Date(localMondayMidnightMs - tzOffsetMs);
  } catch {
    const mondayDeltaDays = (epoch.getUTCDay() + 6) % 7;
    return new Date(
      Date.UTC(
        epoch.getUTCFullYear(),
        epoch.getUTCMonth(),
        epoch.getUTCDate() - mondayDeltaDays,
        0,
        0,
        0,
      ),
    );
  }
}
