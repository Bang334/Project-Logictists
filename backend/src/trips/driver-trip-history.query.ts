import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { QueryDriverTripHistoryDto } from "./dto/query-driver-trip-history.dto";

type HistoryRow = {
  tripId: string;
  tripNumber: string;
  status: "COMPLETED" | "CANCELLED";
  historyAt: Date;
  dateBasis: "ACTUAL_END" | "PLANNED_START";
  vehicle: { id: string; plateNumber: string; model: string; vehicleType: string };
  stopCount: number;
  processedStops: number;
  loadTaskCount: number;
  unloadTaskCount: number;
  loadedQuantity: number | null;
  unloadedQuantity: number | null;
  distinctPackageCount: number;
  successAttempts: number;
  partialAttempts: number;
  failedAttempts: number;
};

function decodeCursor(value: string) {
  const cursor = Buffer.from(value, "base64url");
  const [timestamp, id, extra] = cursor.toString("utf8").split("|");
  const date = new Date(timestamp);
  if (cursor.toString("base64url") !== value || extra !== undefined ||
      !Number.isFinite(date.getTime()) || date.toISOString() !== timestamp ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) {
    throw new BadRequestException("Cursor lịch sử không hợp lệ");
  }
  return { date, id };
}

export function driverTripHistoryQuery(
  driverId: string,
  { start, end }: { start: Date; end: Date },
  query: QueryDriverTripHistoryDto,
) {
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const historyAt = Prisma.sql`CASE WHEN t.status = 'COMPLETED'
    THEN COALESCE(t."actualEndTime", t."plannedStartTime") ELSE t."plannedStartTime" END`;
  return Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT t.id AS "tripId", t."tripNumber", t.status, t."vehicleId",
        ${historyAt} AS "historyAt",
        CASE WHEN t.status = 'COMPLETED' AND t."actualEndTime" IS NOT NULL
          THEN 'ACTUAL_END' ELSE 'PLANNED_START' END AS "dateBasis"
      FROM trips t
      WHERE t.status IN ('COMPLETED', 'CANCELLED')
        ${query.status ? Prisma.sql`AND t.status = ${query.status}::"TripStatus"` : Prisma.empty}
        AND EXISTS (
          SELECT 1 FROM driver_assignments a
          WHERE a."tripId" = t.id AND a."driverId" = ${driverId} AND a.status = 'ASSIGNED'
        )
        AND ${historyAt} >= ${start} AND ${historyAt} < ${end}
        ${cursor ? Prisma.sql`AND (${historyAt}, t.id) < (${cursor.date}, ${cursor.id})` : Prisma.empty}
      ORDER BY "historyAt" DESC, t.id DESC
      LIMIT ${query.limit + 1}
    )
    SELECT p."tripId", p."tripNumber", p.status, p."historyAt", p."dateBasis",
      jsonb_build_object('id', v.id, 'plateNumber', v."plateNumber",
        'model', v.model, 'vehicleType', v."vehicleType") AS vehicle,
      stops.*, tasks.*, attempts.*
    FROM page p
    JOIN vehicles v ON v.id = p."vehicleId"
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS "stopCount",
        (COUNT(*) FILTER (WHERE s.status IN ('COMPLETED', 'SKIPPED')))::int AS "processedStops"
      FROM trip_stops s WHERE s."tripId" = p."tripId"
    ) stops
    CROSS JOIN LATERAL (
      SELECT (COUNT(*) FILTER (WHERE k.action = 'LOAD'))::int AS "loadTaskCount",
        (COUNT(*) FILTER (WHERE k.action = 'UNLOAD'))::int AS "unloadTaskCount",
        COUNT(DISTINCT k."packageId")::int AS "distinctPackageCount",
        CASE WHEN COUNT(*) FILTER (WHERE k.action = 'LOAD' AND k."actualQuantity" IS NULL) = 0
          THEN (SUM(k."actualQuantity") FILTER (WHERE k.action = 'LOAD'))::double precision END AS "loadedQuantity",
        CASE WHEN COUNT(*) FILTER (WHERE k.action = 'UNLOAD' AND k."actualQuantity" IS NULL) = 0
          THEN (SUM(k."actualQuantity") FILTER (WHERE k.action = 'UNLOAD'))::double precision END AS "unloadedQuantity"
      FROM trip_stops s JOIN stop_tasks k ON k."tripStopId" = s.id
      WHERE s."tripId" = p."tripId"
    ) tasks
    CROSS JOIN LATERAL (
      SELECT (COUNT(*) FILTER (WHERE a.result = 'SUCCESS'))::int AS "successAttempts",
        (COUNT(*) FILTER (WHERE a.result = 'PARTIAL'))::int AS "partialAttempts",
        (COUNT(*) FILTER (WHERE a.result = 'FAILED'))::int AS "failedAttempts"
      FROM trip_stops s JOIN delivery_attempts a ON a."tripStopId" = s.id
      WHERE s."tripId" = p."tripId"
    ) attempts
    ORDER BY p."historyAt" DESC, p."tripId" DESC
  `;
}

export async function readDriverTripHistory(
  prisma: PrismaService,
  driverId: string,
  range: { start: Date; end: Date },
  query: QueryDriverTripHistoryDto,
) {
  const rows = await prisma.$queryRaw<HistoryRow[]>(driverTripHistoryQuery(driverId, range, query));
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > query.limit && last
      ? Buffer.from(`${last.historyAt.toISOString()}|${last.tripId}`).toString("base64url")
      : null,
  };
}
