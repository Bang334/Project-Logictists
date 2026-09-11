/**
 * Utility functions and sample data for Realtime Vehicle Tracking & Simulation
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface SimulationState {
  isPlaying: boolean;
  progress: number; // 0 to 1
  speedMultiplier: number;
  followVehicle: boolean;
  currentCoord: [number, number]; // [lng, lat]
  currentBearing: number; // 0 to 360 degrees
  currentSpeedKmh: number;
  traveledDistanceKm: number;
  totalDistanceKm: number;
}

/**
 * Calculate Haversine distance between two coordinates in kilometers
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate bearing/heading angle in degrees (0 = North, 90 = East, 180 = South, 270 = West)
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const dLonRad = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(dLonRad) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLonRad);

  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

export interface RouteProfile {
  coordinates: [number, number][]; // Array of [lng, lat]
  cumulativeDistances: number[]; // Distances from start to point i in km
  totalDistanceKm: number;
}

/**
 * Pre-process line coordinates into cumulative distance array for smooth O(log N) interpolation
 */
export function buildRouteProfile(coordinates: [number, number][]): RouteProfile {
  if (!coordinates || coordinates.length < 2) {
    return {
      coordinates: coordinates || [],
      cumulativeDistances: [0],
      totalDistanceKm: 0,
    };
  }

  const cumulativeDistances: number[] = [0];
  let total = 0;

  for (let i = 0; i < coordinates.length - 1; i++) {
    const [lon1, lat1] = coordinates[i];
    const [lon2, lat2] = coordinates[i + 1];
    const d = calculateDistanceKm(lat1, lon1, lat2, lon2);
    total += d;
    cumulativeDistances.push(total);
  }

  return {
    coordinates,
    cumulativeDistances,
    totalDistanceKm: total,
  };
}

/**
 * Interpolate coordinate and bearing along the route at progress [0..1]
 */
export function interpolateAlongRoute(
  profile: RouteProfile,
  progress: number,
): {
  coord: [number, number];
  bearing: number;
  segmentIndex: number;
  traveledKm: number;
  traveledCoordinates: [number, number][];
} {
  const { coordinates, cumulativeDistances, totalDistanceKm } = profile;

  if (!coordinates || coordinates.length === 0) {
    return {
      coord: [105.854, 21.028],
      bearing: 0,
      segmentIndex: 0,
      traveledKm: 0,
      traveledCoordinates: [],
    };
  }

  if (coordinates.length === 1 || totalDistanceKm === 0) {
    return {
      coord: coordinates[0],
      bearing: 0,
      segmentIndex: 0,
      traveledKm: 0,
      traveledCoordinates: [coordinates[0]],
    };
  }

  const clampedProgress = Math.max(0, Math.min(1, progress));
  const targetDistance = clampedProgress * totalDistanceKm;

  // Find the segment where targetDistance falls
  let segIndex = 0;
  for (let i = 0; i < cumulativeDistances.length - 1; i++) {
    if (
      targetDistance >= cumulativeDistances[i] &&
      targetDistance <= cumulativeDistances[i + 1]
    ) {
      segIndex = i;
      break;
    }
  }

  if (targetDistance >= totalDistanceKm) {
    segIndex = coordinates.length - 2;
  }

  const startCoord = coordinates[segIndex];
  const endCoord = coordinates[segIndex + 1];
  const segStartDist = cumulativeDistances[segIndex];
  const segEndDist = cumulativeDistances[segIndex + 1];
  const segLength = segEndDist - segStartDist;

  const t = segLength > 0 ? (targetDistance - segStartDist) / segLength : 0;

  const interpolatedLng = startCoord[0] + t * (endCoord[0] - startCoord[0]);
  const interpolatedLat = startCoord[1] + t * (endCoord[1] - startCoord[1]);

  const bearing = calculateBearing(
    startCoord[1],
    startCoord[0],
    endCoord[1],
    endCoord[0],
  );

  const currentPoint: [number, number] = [interpolatedLng, interpolatedLat];
  const traveledCoords = coordinates.slice(0, segIndex + 1);
  traveledCoords.push(currentPoint);

  return {
    coord: currentPoint,
    bearing,
    segmentIndex: segIndex,
    traveledKm: targetDistance,
    traveledCoordinates: traveledCoords,
  };
}

/**
 * Realistic detailed delivery route across Hanoi (Hub Sài Đồng -> Long Biên -> Hoàn Kiếm -> Cầu Giấy -> Mỹ Đình -> Hub)
 */
export const HANOI_SAMPLE_DEMO_ROUTE: [number, number][] = [
  [105.9082, 21.0345], // Kho Sài Đồng B, Long Biên
  [105.9055, 21.0362],
  [105.8988, 21.0385],
  [105.8921, 21.0412],
  [105.8850, 21.0420], // Điểm nhận 1: KCN Hanel Long Biên
  [105.8812, 21.0398],
  [105.8755, 21.0350],
  [105.8710, 21.0280], // Đầu cầu Vĩnh Tuy
  [105.8670, 21.0220],
  [105.8610, 21.0150], // Qua sông Hồng (Cầu Vĩnh Tuy)
  [105.8560, 21.0125], // Đường Minh Khai
  [105.8520, 21.0180], // Phố Huế
  [105.8524, 21.0285], // Điểm nhận 2: Kho Trung chuyển Hoàn Kiếm
  [105.8505, 21.0320], // Tràng Thi - Cửa Nam
  [105.8410, 21.0335], // Điện Biên Phủ
  [105.8320, 21.0340], // Kim Mã
  [105.8150, 21.0338], // Kim Mã - Cầu Giấy
  [105.8030, 21.0350], // Đường Cầu Giấy
  [105.7900, 21.0360], // Điểm giao 1: Tòa nhà FPT Cầu Giấy
  [105.7820, 21.0340], // Xuân Thủy
  [105.7790, 21.0300], // Phạm Hùng
  [105.7725, 21.0250], // Điểm giao 2: Trung tâm Logistics Mỹ Đình
  [105.7700, 21.0280], // Lê Đức Thọ
  [105.7750, 21.0380], // Hồ Tùng Mậu
  [105.7850, 21.0450], // Hoàng Quốc Việt
  [105.8050, 21.0470], // Đường Bưởi - Lạc Long Quân
  [105.8300, 21.0500], // Âu Cơ - Nghi Tàm
  [105.8580, 21.0440], // Cầu Chương Dương
  [105.8720, 21.0410], // Nguyễn Văn Cừ
  [105.8900, 21.0380], // Ngô Gia Tự / Chu Huy Mân
  [105.9082, 21.0345], // Quay về Tổng kho Sài Đồng B
];

export const HANOI_DEMO_STOPS = [
  {
    id: 'stop-depot-start',
    name: 'Tổng Kho Vận Miền Bắc (KCN Sài Đồng B)',
    type: 'DEPOT' as const,
    latitude: 21.0345,
    longitude: 105.9082,
    address: 'Số 1 Huỳnh Tấn Phát, Long Biên, Hà Nội',
    actionText: 'Xuất bến & kiểm tra an toàn kỹ thuật',
    packageCount: 0,
    weightKg: 0,
  },
  {
    id: 'stop-pickup-1',
    name: 'Kho Hàng Điện Tử Hanel Long Biên',
    type: 'PICKUP' as const,
    latitude: 21.0420,
    longitude: 105.8850,
    address: 'KCN Hanel, P. Sài Đồng, Long Biên',
    actionText: 'Bốc 15 kiện linh kiện máy tính (+480 kg)',
    packageCount: 15,
    weightKg: 480,
  },
  {
    id: 'stop-pickup-2',
    name: 'Điểm Gom Hàng Bưu Chính Hoàn Kiếm',
    type: 'PICKUP' as const,
    latitude: 21.0285,
    longitude: 105.8524,
    address: '66 Tràng Tiền, Hoàn Kiếm, Hà Nội',
    actionText: 'Bốc 25 thùng tài liệu và đồ gốm sứ (+320 kg)',
    packageCount: 25,
    weightKg: 320,
  },
  {
    id: 'stop-delivery-1',
    name: 'Trung Tâm Phân Phối Cầu Giấy',
    type: 'DELIVERY' as const,
    latitude: 21.0360,
    longitude: 105.7900,
    address: 'Duy Tân, Dịch Vọng Hậu, Cầu Giấy',
    actionText: 'Giao 15 kiện linh kiện máy tính (-480 kg)',
    packageCount: 15,
    weightKg: 480,
  },
  {
    id: 'stop-delivery-2',
    name: 'Trung Tâm Logistics Mỹ Đình',
    type: 'DELIVERY' as const,
    latitude: 21.0250,
    longitude: 105.7725,
    address: 'Đường Lê Đức Thọ, Mỹ Đình 2, Nam Từ Liêm',
    actionText: 'Giao 25 thùng bưu phẩm (-320 kg)',
    packageCount: 25,
    weightKg: 320,
  },
  {
    id: 'stop-depot-end',
    name: 'Tổng Kho Vận Miền Bắc (KCN Sài Đồng B)',
    type: 'DEPOT' as const,
    latitude: 21.0345,
    longitude: 105.9082,
    address: 'Số 1 Huỳnh Tấn Phát, Long Biên, Hà Nội',
    actionText: 'Hoàn thành chuyến, về bến đỗ & nộp POD',
    packageCount: 0,
    weightKg: 0,
  },
];

/**
 * Calculate the accumulated distance (km) along the route for each stop in order
 */
export function calculateStopMilestonesKm(
  profile: RouteProfile,
  stops: Array<{ latitude: number; longitude: number }>,
): number[] {
  if (!stops || stops.length === 0) return [];
  if (!profile || profile.coordinates.length < 2) {
    const total = profile?.totalDistanceKm || stops.length;
    return stops.map((_, i) => ((i + 1) * total) / (stops.length + 1));
  }

  const { coordinates, cumulativeDistances, totalDistanceKm } = profile;
  const milestones: number[] = [];

  let lastIndex = 0;
  for (let s = 0; s < stops.length; s++) {
    const stop = stops[s];

    // Tìm điểm trên route coordinates gần stop này nhất (tìm từ lastIndex trở đi)
    let bestDist = Infinity;
    let bestIdx = lastIndex;

    for (let c = lastIndex; c < coordinates.length; c++) {
      const [lon, lat] = coordinates[c];
      const d = calculateDistanceKm(lat, lon, stop.latitude, stop.longitude);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = c;
      }
    }

    const distAlongRoute = cumulativeDistances[bestIdx] || 0;
    const prevMilestone = milestones.length > 0 ? milestones[milestones.length - 1] : 0;
    // Đảm bảo khoảng cách tăng dần không bị lùi và không vượt quá totalDistanceKm
    const validDist = Math.max(prevMilestone, Math.min(totalDistanceKm, distAlongRoute));
    milestones.push(validDist);
    lastIndex = Math.max(lastIndex, bestIdx);
  }

  return milestones;
}

/**
 * Determine the exact active step index:
 * - Step 0: Truck departed from depot, moving towards Stop 1 (cargo floor is EMPTY)
 * - Step s + 1: Truck reached Stop s and loaded/unloaded cargo
 */
export function getStepIndexForDistance(
  milestonesKm: number[],
  traveledKm: number,
): number {
  if (!milestonesKm || milestonesKm.length === 0) return 0;

  // Nếu xe chưa chạm tới Stop 1 (dung sai 0.15 km): xe vẫn đang ở Bước 0 (Xuất bến, xe rỗng)
  let activeStep = 0;
  for (let i = 0; i < milestonesKm.length; i++) {
    if (traveledKm >= milestonesKm[i] - 0.15) {
      activeStep = i + 1;
    } else {
      break;
    }
  }

  return activeStep;
}

