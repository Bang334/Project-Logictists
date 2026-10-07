import type { OptimizedRouteUI, OptimizedStopUI } from '../types';

export type DriverScheduleItemType =
  | 'DEPOT_START'
  | 'TRAVEL'
  | 'WAIT'
  | 'TRANSIT'
  | 'STOP'
  | 'DEPOT_END';

export interface DriverScheduleItem {
  id: string;
  type: DriverScheduleItemType;
  startTimeSec: number;
  endTimeSec: number;
  startTimeStr: string;
  endTimeStr: string;
  durationMinutes: number;
  title: string;
  address?: string;
  orderNumber?: string;
  actionType?: 'PICKUP' | 'DELIVERY';
  deltaPackages?: number;
  weightKg?: number;
  stopSequence?: number;
  stopIndex?: number;
  notes?: string;
}

export interface DriverScheduleResult {
  items: DriverScheduleItem[];
  startTime: string;
  endTime: string;
  totalWorkDuration: string;
  drivingDuration: string;
  serviceDuration: string;
  waitingDurationMinutes: number;
  restDurationMinutes: number;
  hasUnclassifiedTransit: boolean;
}

const SECONDS_PER_DAY = 24 * 60 * 60;

const formatSecondsToTime = (seconds: number): string => {
  const secondsOfDay = ((Math.round(seconds) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hours = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
};

const toMinutes = (seconds: number): number =>
  Math.round((Math.max(0, seconds) / 60) * 10) / 10;

const formatHours = (seconds: number): string =>
  `${(Math.max(0, seconds) / 3600).toFixed(1)} giờ`;

const formatShiftDuration = (seconds: number): string => {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}p`;
};

const makeTimedItem = (
  item: Omit<DriverScheduleItem, 'startTimeStr' | 'endTimeStr' | 'durationMinutes'>,
): DriverScheduleItem => ({
  ...item,
  startTimeStr: formatSecondsToTime(item.startTimeSec),
  endTimeStr: formatSecondsToTime(item.endTimeSec),
  durationMinutes: toMinutes(item.endTimeSec - item.startTimeSec),
});

const hasLegBreakdown = (
  stop: OptimizedStopUI,
): stop is OptimizedStopUI & { travel_time_sec: number; waiting_time_sec: number } =>
  Number.isFinite(stop.travel_time_sec) &&
  Number.isFinite(stop.waiting_time_sec) &&
  Number.isFinite(stop.service_time_sec) &&
  Number(stop.travel_time_sec) >= 0 &&
  Number(stop.waiting_time_sec) >= 0 &&
  Number(stop.service_time_sec) >= 0;

const hasReturnBreakdown = (
  route: OptimizedRouteUI,
): route is OptimizedRouteUI & {
  return_travel_time_sec: number;
  return_waiting_time_sec: number;
} =>
  Number.isFinite(route.return_travel_time_sec) &&
  Number.isFinite(route.return_waiting_time_sec) &&
  Number(route.return_travel_time_sec) >= 0 &&
  Number(route.return_waiting_time_sec) >= 0;

/**
 * Builds the visible schedule only from solver timestamps. Every interval is
 * represented explicitly so the UI cannot turn travel or time-window waiting
 * into an unexplained blank gap.
 */
export const buildDriverSchedule = (route: OptimizedRouteUI): DriverScheduleResult => {
  const items: DriverScheduleItem[] = [];
  const routeStartSec = Math.round(route.start_time_sec);
  const routeEndSec = Math.max(routeStartSec, Math.round(route.end_time_sec));
  const depotName = route.depot?.name || 'Chi nhánh / Kho xuất phát';

  items.push(makeTimedItem({
    id: 'depot-start',
    type: 'DEPOT_START',
    startTimeSec: routeStartSec,
    endTimeSec: routeStartSec,
    title: `Xuất bến tại ${depotName}`,
    notes: 'Mốc xuất phát theo lịch do bộ tối ưu trả về',
  }));

  let cursorSec = routeStartSec;
  let previousLocationName = depotName;
  let totalTravelSec = 0;
  let totalWaitSec = 0;
  let totalServiceSec = 0;
  let hasUnclassifiedTransit = false;

  (route.stops || []).forEach((stop, stopIndex) => {
    const arrivalSec = Math.max(cursorSec, Math.round(stop.arrival_time_sec));
    const departureSec = Math.max(arrivalSec, Math.round(stop.departure_time_sec));
    const gapSec = arrivalSec - cursorSec;

    if (gapSec > 0 && hasLegBreakdown(stop)) {
      const travelSec = Math.min(gapSec, Math.round(stop.travel_time_sec));
      const waitSec = gapSec - travelSec;

      if (travelSec > 0) {
        items.push(makeTimedItem({
          id: `travel-${stop.sequence}-${stop.location_id}`,
          type: 'TRAVEL',
          startTimeSec: cursorSec,
          endTimeSec: cursorSec + travelSec,
          title: `Di chuyển đến Điểm #${stop.sequence}`,
          notes: `${previousLocationName} → ${stop.location_name}`,
        }));
        totalTravelSec += travelSec;
      }

      if (waitSec > 0) {
        items.push(makeTimedItem({
          id: `wait-${stop.sequence}-${stop.location_id}`,
          type: 'WAIT',
          startTimeSec: cursorSec + travelSec,
          endTimeSec: arrivalSec,
          title: `Chờ khung giờ trước thao tác Điểm #${stop.sequence}`,
          address: stop.location_name,
          notes: 'Thời gian chờ do ràng buộc khung giờ; lịch tối ưu không xác định chính xác vị trí chờ',
        }));
        totalWaitSec += waitSec;
      }
    } else if (gapSec > 0) {
      items.push(makeTimedItem({
        id: `transit-${stop.sequence}-${stop.location_id}`,
        type: 'TRANSIT',
        startTimeSec: cursorSec,
        endTimeSec: arrivalSec,
        title: `Di chuyển / chờ đến Điểm #${stop.sequence}`,
        notes: `${previousLocationName} → ${stop.location_name} · Kết quả cũ chưa tách thời gian chạy và chờ`,
      }));
      hasUnclassifiedTransit = true;
    }

    const loadedCount = stop.items_loaded?.length || 0;
    const unloadedCount = stop.items_unloaded?.length || 0;
    const serviceSec = departureSec - arrivalSec;
    const orderCode = stop.order_id
      ? (stop.order_id.length > 10 ? `DH-${stop.order_id.slice(-6).toUpperCase()}` : stop.order_id)
      : `Đơn #${stopIndex + 1}`;

    items.push(makeTimedItem({
      id: `stop-${stop.sequence}-${stop.location_id}`,
      type: 'STOP',
      startTimeSec: arrivalSec,
      endTimeSec: departureSec,
      title: `Điểm #${stop.sequence}: ${stop.stop_type === 'PICKUP' ? 'LẤY HÀNG' : 'GIAO HÀNG'}`,
      address: stop.location_name,
      orderNumber: orderCode,
      actionType: stop.stop_type,
      deltaPackages: stop.stop_type === 'PICKUP' ? loadedCount : -unloadedCount,
      weightKg: stop.current_weight_kg,
      stopSequence: stop.sequence,
      stopIndex,
      notes: `${stop.stop_type === 'PICKUP' ? `Bốc ${loadedCount} kiện lên xe` : `Dỡ giao ${unloadedCount} kiện`} · Tải xe: ${stop.current_weight_kg.toFixed(0)} kg`,
    }));
    totalServiceSec += serviceSec;
    cursorSec = departureSec;
    previousLocationName = stop.location_name;
  });

  if (routeEndSec > cursorSec) {
    const returnGapSec = routeEndSec - cursorSec;
    if (hasReturnBreakdown(route)) {
      const returnTravelSec = Math.min(
        returnGapSec,
        Math.round(route.return_travel_time_sec),
      );
      const returnWaitSec = returnGapSec - returnTravelSec;
      if (returnTravelSec > 0) {
        items.push(makeTimedItem({
          id: 'travel-depot-end',
          type: 'TRAVEL',
          startTimeSec: cursorSec,
          endTimeSec: cursorSec + returnTravelSec,
          title: 'Di chuyển về bến kết thúc tuyến',
          notes: `${previousLocationName} → ${depotName}`,
        }));
        totalTravelSec += returnTravelSec;
      }
      if (returnWaitSec > 0) {
        items.push(makeTimedItem({
          id: 'wait-depot-end',
          type: 'WAIT',
          startTimeSec: cursorSec + returnTravelSec,
          endTimeSec: routeEndSec,
          title: 'Chờ trước khi kết thúc tuyến',
          notes: 'Thời gian chờ do lịch tối ưu; vị trí chờ chưa được xác định',
        }));
        totalWaitSec += returnWaitSec;
      }
    } else {
      items.push(makeTimedItem({
        id: 'transit-depot-end',
        type: 'TRANSIT',
        startTimeSec: cursorSec,
        endTimeSec: routeEndSec,
        title: 'Di chuyển / chờ về bến',
        notes: `${previousLocationName} → ${depotName} · Kết quả cũ chưa tách thời gian chạy và chờ`,
      }));
      hasUnclassifiedTransit = true;
    }
  }

  items.push(makeTimedItem({
    id: 'depot-end',
    type: 'DEPOT_END',
    startTimeSec: routeEndSec,
    endTimeSec: routeEndSec,
    title: `Về bến: ${depotName}`,
    notes: 'Mốc kết thúc theo lịch do bộ tối ưu trả về',
  }));

  return {
    items,
    startTime: formatSecondsToTime(routeStartSec),
    endTime: formatSecondsToTime(routeEndSec),
    totalWorkDuration: formatShiftDuration(routeEndSec - routeStartSec),
    drivingDuration: hasUnclassifiedTransit ? 'Chưa tách đủ' : formatHours(totalTravelSec),
    serviceDuration: formatHours(totalServiceSec),
    waitingDurationMinutes: toMinutes(totalWaitSec),
    restDurationMinutes: 0,
    hasUnclassifiedTransit,
  };
};
