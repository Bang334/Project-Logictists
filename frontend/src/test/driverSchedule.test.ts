import { describe, expect, it } from 'vitest';
import { buildDriverSchedule } from '../utils/driverSchedule';
import type { OptimizedRouteUI } from '../types';

const makeRoute = (): OptimizedRouteUI => ({
  route_id: 'route-1',
  vehicle_id: 'vehicle-1',
  service_day_index: 0,
  start_time_sec: 8 * 60 * 60,
  end_time_sec: 17 * 60 * 60,
  plate_number: '43C-189.24',
  vehicle_length_cm: 530,
  vehicle_width_cm: 210,
  total_distance_km: 318.09,
  total_duration_minutes: 540,
  return_travel_time_sec: 98 * 60,
  return_waiting_time_sec: 0,
  depot: {
    id: 'depot-1',
    name: 'Tổng Kho VLXD Miền Trung - Hòa Cầm',
    latitude: 16.0125,
    longitude: 108.1874,
  },
  stops: [
    {
      sequence: 1,
      location_id: 'pickup-1',
      location_name: 'Nhà máy Scavi Huế',
      order_id: 'EF417F',
      stop_type: 'PICKUP',
      latitude: 16.5872,
      longitude: 107.3054,
      arrival_time_sec: 11 * 60 * 60 + 7 * 60,
      departure_time_sec: 11 * 60 * 60 + 22 * 60,
      travel_time_sec: 172 * 60,
      waiting_time_sec: 15 * 60,
      service_time_sec: 15 * 60,
      items_loaded: ['package-1'],
      items_unloaded: [],
      current_weight_kg: 180,
    },
    {
      sequence: 2,
      location_id: 'delivery-1',
      location_name: 'Cảng Tiên Sa Đà Nẵng',
      order_id: 'EF417F',
      stop_type: 'DELIVERY',
      latitude: 16.1264,
      longitude: 108.2198,
      arrival_time_sec: 15 * 60 * 60 + 7 * 60,
      departure_time_sec: 15 * 60 * 60 + 22 * 60,
      travel_time_sec: 180 * 60,
      waiting_time_sec: 45 * 60,
      service_time_sec: 15 * 60,
      items_loaded: [],
      items_unloaded: ['package-1'],
      current_weight_kg: 0,
    },
  ],
  spatial_validation: {
    is_valid: true,
    max_weight_kg: 180,
    max_area_cm2: 12_600,
    step_states: [],
  },
});

describe('buildDriverSchedule', () => {
  it('renders travel, waiting and service as one continuous solver-backed timeline', () => {
    const schedule = buildDriverSchedule(makeRoute());

    expect(schedule.items.map((item) => item.type)).toEqual([
      'DEPOT_START',
      'TRAVEL',
      'WAIT',
      'STOP',
      'TRAVEL',
      'WAIT',
      'STOP',
      'TRAVEL',
      'DEPOT_END',
    ]);
    expect(schedule.items.slice(1, -1).map((item) => [item.startTimeStr, item.endTimeStr])).toEqual([
      ['08:00', '10:52'],
      ['10:52', '11:07'],
      ['11:07', '11:22'],
      ['11:22', '14:22'],
      ['14:22', '15:07'],
      ['15:07', '15:22'],
      ['15:22', '17:00'],
    ]);

    for (let index = 1; index < schedule.items.length; index += 1) {
      expect(schedule.items[index].startTimeSec).toBe(
        schedule.items[index - 1].endTimeSec,
      );
    }
    expect(schedule.restDurationMinutes).toBe(0);
    expect(schedule.waitingDurationMinutes).toBe(60);
  });

  it('shows a neutral transit block for historical results without travel/wait fields', () => {
    const route = makeRoute();
    route.stops = route.stops.map((stop) => {
      const legacyStop = { ...stop };
      delete legacyStop.travel_time_sec;
      delete legacyStop.waiting_time_sec;
      delete legacyStop.service_time_sec;
      return legacyStop;
    });
    delete route.return_travel_time_sec;
    delete route.return_waiting_time_sec;

    const schedule = buildDriverSchedule(route);

    expect(schedule.items.some((item) => item.type === 'TRANSIT')).toBe(true);
    for (let index = 1; index < schedule.items.length; index += 1) {
      expect(schedule.items[index].startTimeSec).toBe(
        schedule.items[index - 1].endTimeSec,
      );
    }
  });
});
