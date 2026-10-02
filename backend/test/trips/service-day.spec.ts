import {
  buildServiceDayWindows,
  getFullServiceDayPlanningEpoch,
  getNextDayPlanningEpoch,
  getPlanningEpoch,
} from '../../src/trips/service-day';

describe('service day planning', () => {
  it('builds consecutive branch-local work windows relative to local midnight', () => {
    const planningEpoch = getPlanningEpoch(
      [new Date('2026-09-11T04:00:00.000Z')],
      'Asia/Ho_Chi_Minh',
      new Date('2026-09-10T00:00:00.000Z'),
    );
    const windows = buildServiceDayWindows(
      planningEpoch,
      'Asia/Ho_Chi_Minh',
      '08:00',
      '17:00',
      2,
    );

    expect(planningEpoch.toISOString()).toBe('2026-09-10T17:00:00.000Z');
    expect(windows.map((window) => [window.startSec, window.endSec])).toEqual([
      [8 * 3600, 17 * 3600],
      [32 * 3600, 41 * 3600],
    ]);
    expect(windows[1].startsAt.toISOString()).toBe('2026-09-12T01:00:00.000Z');
  });

  it('starts overdue backlog planning from today instead of a past window date', () => {
    const planningEpoch = getPlanningEpoch(
      [new Date('2026-09-10T08:00:00.000Z')],
      'Asia/Ho_Chi_Minh',
      new Date('2026-10-02T08:00:00.000Z'),
    );

    expect(planningEpoch.toISOString()).toBe('2026-10-01T17:00:00.000Z');
  });

  it('starts from the next full service day after today\'s shift has begun', () => {
    const planningEpoch = getFullServiceDayPlanningEpoch(
      [new Date('2026-09-10T08:00:00.000Z')],
      'Asia/Ho_Chi_Minh',
      '08:00',
      new Date('2026-10-02T08:00:00.000Z'),
    );

    expect(planningEpoch.toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });

  it('always starts from next calendar day with getNextDayPlanningEpoch', () => {
    // 09:00 sáng hôm nay (02/10/2026 02:00 UTC)
    const nextDayEpoch = getNextDayPlanningEpoch(
      [new Date('2026-10-02T02:00:00.000Z')],
      'Asia/Ho_Chi_Minh',
      new Date('2026-10-02T02:00:00.000Z'),
    );

    // Mốc 00:00 ngày mai 03/10 giờ VN = 2026-10-02T17:00:00.000Z
    expect(nextDayEpoch.toISOString()).toBe('2026-10-02T17:00:00.000Z');
  });

  it('adjusts day 0 start to 12:00 when system recovers at noon under CURRENT_TIME mode', () => {
    // 12:00 trưa giờ VN ngày 02/10/2026 = 05:00 UTC
    const noonTodayUtc = new Date('2026-10-02T05:00:00.000Z');
    const planningEpoch = getPlanningEpoch(
      [noonTodayUtc],
      'Asia/Ho_Chi_Minh',
      noonTodayUtc,
    );

    // planningEpoch hôm nay: 2026-10-01T17:00:00.000Z (00:00 ngày 02/10 VN)
    expect(planningEpoch.toISOString()).toBe('2026-10-01T17:00:00.000Z');

    const windows = buildServiceDayWindows(
      planningEpoch,
      'Asia/Ho_Chi_Minh',
      '08:00',
      '17:00',
      2,
      {
        scheduleMode: 'CURRENT_TIME',
        effectiveStartTime: noonTodayUtc,
      },
    );

    // Ngày 0: Bắt đầu từ 12:00 (12 * 3600 = 43200s) đến 17:00 (17 * 3600 = 61200s)
    expect(windows[0].startSec).toBe(12 * 3600);
    expect(windows[0].endSec).toBe(17 * 3600);
    expect(windows[0].startsAt.toISOString()).toBe(noonTodayUtc.toISOString());

    // Ngày 1: Vẫn bắt đầu trọn vẹn từ 08:00 ngày mai
    expect(windows[1].startSec).toBe(24 * 3600 + 8 * 3600);
    expect(windows[1].endSec).toBe(24 * 3600 + 17 * 3600);
  });

  it('throws helpful error if CURRENT_TIME is attempted after workEndTime', () => {
    // 17:30 chiều giờ VN = 10:30 UTC
    const afterShiftUtc = new Date('2026-10-02T10:30:00.000Z');
    const planningEpoch = getPlanningEpoch([], 'Asia/Ho_Chi_Minh', afterShiftUtc);

    expect(() =>
      buildServiceDayWindows(
        planningEpoch,
        'Asia/Ho_Chi_Minh',
        '08:00',
        '17:00',
        1,
        {
          scheduleMode: 'CURRENT_TIME',
          effectiveStartTime: afterShiftUtc,
        },
      ),
    ).toThrow('Ca làm việc hôm nay đã kết thúc lúc 17:00');
  });

  it('throws helpful error if remaining time in current shift is less than minimum', () => {
    // 16:50 chiều giờ VN (còn 10 phút, dưới 15 phút tối thiểu) = 09:50 UTC
    const lateShiftUtc = new Date('2026-10-02T09:50:00.000Z');
    const planningEpoch = getPlanningEpoch([], 'Asia/Ho_Chi_Minh', lateShiftUtc);

    expect(() =>
      buildServiceDayWindows(
        planningEpoch,
        'Asia/Ho_Chi_Minh',
        '08:00',
        '17:00',
        1,
        {
          scheduleMode: 'CURRENT_TIME',
          effectiveStartTime: lateShiftUtc,
          minRemainingMinutes: 15,
        },
      ),
    ).toThrow('không đủ tối thiểu 15 phút');
  });
});
