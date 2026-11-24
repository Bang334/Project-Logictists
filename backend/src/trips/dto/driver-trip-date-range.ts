import { BadRequestException } from "@nestjs/common";
import { isISO8601 } from "class-validator";

const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function driverTripDateRange(from: string | undefined, to: string | undefined, maxDays: number) {
  if (!from || !to || ![from, to].every((value) =>
    OFFSET_TIMESTAMP.test(value) && isISO8601(value, { strict: true, strictSeparator: true }) &&
    Number.isFinite(Date.parse(value)),
  )) {
    throw new BadRequestException("from và to phải là cặp thời điểm ISO-8601 có múi giờ");
  }
  const start = new Date(from);
  const end = new Date(to);
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || duration > maxDays * 86_400_000) {
    throw new BadRequestException(`Khoảng thời gian phải dương và không quá ${maxDays} ngày`);
  }
  return { start, end };
}
