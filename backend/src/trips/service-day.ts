export type ServiceDayWindow = {
  serviceDayIndex: number;
  startsAt: Date;
  endsAt: Date;
  startSec: number;
  endSec: number;
};

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getLocalParts(value: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

function zonedDateTimeToUtc(parts: LocalDateParts, timeZone: string): Date {
  const targetUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = targetUtc;

  for (let attempt = 0; attempt < 3; attempt++) {
    const represented = getLocalParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    candidate += targetUtc - representedUtc;
  }
  return new Date(candidate);
}

function parseClock(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Giờ làm việc không hợp lệ: ${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function getPlanningEpoch(
  referenceDates: Date[],
  timeZone: string,
  now: Date = new Date(),
): Date {
  const earliestWindowTime = referenceDates.length > 0
    ? Math.min(...referenceDates.map((value) => value.getTime()))
    : now.getTime();
  const reference = new Date(Math.max(earliestWindowTime, now.getTime()));
  const local = getLocalParts(reference, timeZone);
  return zonedDateTimeToUtc(
    { ...local, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

export function getNextDayPlanningEpoch(
  referenceDates: Date[],
  timeZone: string,
  now: Date = new Date(),
): Date {
  const todayEpoch = getPlanningEpoch(referenceDates, timeZone, now);
  const localDate = getLocalParts(todayEpoch, timeZone);
  const nextCalendarDate = new Date(
    Date.UTC(localDate.year, localDate.month - 1, localDate.day + 1),
  );
  return zonedDateTimeToUtc(
    {
      year: nextCalendarDate.getUTCFullYear(),
      month: nextCalendarDate.getUTCMonth() + 1,
      day: nextCalendarDate.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

export function getFullServiceDayPlanningEpoch(
  referenceDates: Date[],
  timeZone: string,
  workStartTime: string,
  now: Date = new Date(),
): Date {
  const planningEpoch = getPlanningEpoch(referenceDates, timeZone, now);
  const localDate = getLocalParts(planningEpoch, timeZone);
  const startClock = parseClock(workStartTime);
  const serviceDayStart = zonedDateTimeToUtc(
    { ...localDate, ...startClock, second: 0 },
    timeZone,
  );
  if (now < serviceDayStart) return planningEpoch;

  const nextCalendarDate = new Date(
    Date.UTC(localDate.year, localDate.month - 1, localDate.day + 1),
  );
  return zonedDateTimeToUtc(
    {
      year: nextCalendarDate.getUTCFullYear(),
      month: nextCalendarDate.getUTCMonth() + 1,
      day: nextCalendarDate.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
}

export type BuildServiceDayWindowsOptions = {
  scheduleMode?: 'CURRENT_TIME' | 'NEXT_DAY' | string;
  effectiveStartTime?: Date;
  minRemainingMinutes?: number;
};

export function buildServiceDayWindows(
  planningEpoch: Date,
  timeZone: string,
  workStartTime: string,
  workEndTime: string,
  dayCount: number,
  options?: BuildServiceDayWindowsOptions,
): ServiceDayWindow[] {
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    throw new Error('Số ngày lập kế hoạch phải là số nguyên dương');
  }
  const startClock = parseClock(workStartTime);
  const endClock = parseClock(workEndTime);
  const base = getLocalParts(planningEpoch, timeZone);

  return Array.from({ length: dayCount }, (_, serviceDayIndex) => {
    const calendarDate = new Date(Date.UTC(base.year, base.month - 1, base.day + serviceDayIndex));
    const year = calendarDate.getUTCFullYear();
    const month = calendarDate.getUTCMonth() + 1;
    const day = calendarDate.getUTCDate();
    let startsAt = zonedDateTimeToUtc(
      { year, month, day, ...startClock, second: 0 },
      timeZone,
    );
    const endsAt = zonedDateTimeToUtc(
      { year, month, day, ...endClock, second: 0 },
      timeZone,
    );
    if (endsAt <= startsAt) {
      throw new Error('workEndTime phải sau workStartTime trong cùng ngày');
    }

    if (
      serviceDayIndex === 0 &&
      options?.scheduleMode === 'CURRENT_TIME' &&
      options?.effectiveStartTime
    ) {
      if (options.effectiveStartTime > startsAt) {
        if (options.effectiveStartTime >= endsAt) {
          throw new Error(
            `Ca làm việc hôm nay đã kết thúc lúc ${workEndTime}. Vui lòng chọn tùy chọn 'Bắt đầu từ ngày tiếp theo'.`,
          );
        }
        const minRemainingMinutes = options.minRemainingMinutes ?? 15;
        const remainingMinutes =
          (endsAt.getTime() - options.effectiveStartTime.getTime()) / (60 * 1000);
        if (remainingMinutes < minRemainingMinutes) {
          throw new Error(
            `Thời gian còn lại trong ca hôm nay (${Math.round(remainingMinutes)} phút) không đủ tối thiểu ${minRemainingMinutes} phút để sắp xếp chuyến xe. Vui lòng chọn tùy chọn 'Bắt đầu từ ngày tiếp theo'.`,
          );
        }
        startsAt = options.effectiveStartTime;
      }
    }

    return {
      serviceDayIndex,
      startsAt,
      endsAt,
      startSec: Math.round((startsAt.getTime() - planningEpoch.getTime()) / 1000),
      endSec: Math.round((endsAt.getTime() - planningEpoch.getTime()) / 1000),
    };
  });
}
