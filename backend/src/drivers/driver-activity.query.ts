import { Prisma } from '@prisma/client';
import { DRIVER_EXECUTION_EVENT as event, DRIVER_TRIP_COMMAND as command, DELIVERY_RESULTS } from '../trips/driver-trip-execution.constants';

export interface DriverActivityRow {
  asOf: Date;
  completedTripCount: number;
  processedStopCount: number;
  depotStopCount: number;
  success: number;
  partial: number;
  failed: number;
  unclassified: number;
  hasEvidenceGap: boolean;
}

export function driverActivityQuery(actorUserId: string, start: Date, end: Date) {
  return Prisma.sql`
    WITH owned_events AS MATERIALIZED (
      SELECT e."tripId", e."tripStopId", e."commandId", e."eventType", e."occurredAt",
        s."stopType", t.status AS "tripStatus"
      FROM execution_events e
      JOIN trips t ON t.id = e."tripId"
      LEFT JOIN trip_stops s ON s.id = e."tripStopId" AND s."tripId" = e."tripId"
      WHERE e."actorUserId" = ${actorUserId}
        AND e."occurredAt" >= ${start} AND e."occurredAt" < ${end}
        AND e."eventType" IN (${Prisma.join([
          event.COMPLETE_TRIP, event.TRIP_COMPLETED, event.PICKUP_COMPLETED, event.DELIVERY_COMPLETED,
          event.DELIVERY_FAILED, event.DEPOT_STOP_COMPLETED,
        ])})
        AND (e."eventType" <> ${event.TRIP_COMPLETED} OR EXISTS (
          SELECT 1 FROM driver_assignments a
          WHERE a."completionEventId" = e.id AND a."tripId" = e."tripId"
        ))
        AND (e."eventType" <> ${event.COMPLETE_TRIP} OR NOT EXISTS (
          SELECT 1 FROM driver_assignments a
          JOIN execution_events completion ON completion.id = a."completionEventId"
          WHERE a."tripId" = e."tripId" AND completion."eventType" = ${event.TRIP_COMPLETED}
        ))
    ), delivery_evidence AS (
      SELECT CASE WHEN a."tripStopId" = e."tripStopId" AND a."occurredAt" = e."occurredAt"
        AND (c."actorUserId" IS NULL OR c."actorUserId" = ${actorUserId})
        THEN a.id END AS id,
        CASE WHEN a."tripStopId" = e."tripStopId" AND a."occurredAt" = e."occurredAt"
          AND e."stopType" = 'DELIVERY'
          AND c."actorUserId" = ${actorUserId} AND c."commandType" = ${command.COMPLETE_STOP}
          AND c.status = 'COMPLETED'
          AND c.result #>> '{deliveryAttempt,id}' = a.id
          AND c.result #>> '{deliveryAttempt,result}' = a.result
          AND c.result #>> '{stop,id}' = e."tripStopId"
          AND c.result ->> 'tripId' = e."tripId"
          AND ((a.result = 'FAILED' AND e."eventType" = ${event.DELIVERY_FAILED})
            OR (a.result IN ('SUCCESS','PARTIAL') AND e."eventType" = ${event.DELIVERY_COMPLETED}))
          THEN a.result END AS outcome
      FROM owned_events e
      LEFT JOIN delivery_attempts a ON a."commandId" = e."commandId"
      LEFT JOIN processed_commands c ON c.id = e."commandId"
      WHERE e."eventType" IN (${event.DELIVERY_COMPLETED}, ${event.DELIVERY_FAILED})

      UNION ALL

      SELECT a.id, NULL
      FROM delivery_attempts a
      JOIN processed_commands c ON c.id = a."commandId"
      JOIN trip_stops s ON s.id = a."tripStopId" AND s."stopType" = 'DELIVERY'
      WHERE a."occurredAt" >= ${start} AND a."occurredAt" < ${end}
        AND c."actorUserId" = ${actorUserId} AND c."commandType" = ${command.COMPLETE_STOP}
        AND c.status = 'COMPLETED'
        AND c.result #>> '{deliveryAttempt,id}' = a.id
        AND c.result #>> '{stop,id}' = s.id AND c.result ->> 'tripId' = s."tripId"
        AND NOT EXISTS (SELECT 1 FROM execution_events e WHERE e."commandId" = a."commandId")
    ), totals AS (
      SELECT
        (COUNT(DISTINCT "tripId") FILTER (WHERE "eventType" IN (${event.COMPLETE_TRIP}, ${event.TRIP_COMPLETED})
          AND "tripStatus" <> 'CANCELLED' AND "tripStopId" IS NULL))::int AS "completedTripCount",
        (COUNT(DISTINCT "tripStopId") FILTER (WHERE
          ("stopType" = 'PICKUP' AND "eventType" = ${event.PICKUP_COMPLETED}) OR
          ("stopType" = 'DELIVERY' AND "eventType" IN (${event.DELIVERY_COMPLETED}, ${event.DELIVERY_FAILED}))))::int AS "processedStopCount",
        (COUNT(DISTINCT "tripStopId") FILTER (WHERE "stopType" IN ('DEPOT_START','DEPOT_END')
          AND "eventType" = ${event.DEPOT_STOP_COMPLETED}))::int AS "depotStopCount",
        COALESCE(BOOL_OR(CASE
          WHEN "eventType" IN (${event.COMPLETE_TRIP}, ${event.TRIP_COMPLETED}) THEN "tripStopId" IS NOT NULL
          WHEN "eventType" = ${event.PICKUP_COMPLETED} THEN "stopType" IS DISTINCT FROM 'PICKUP'
          WHEN "eventType" = ${event.DEPOT_STOP_COMPLETED}
            THEN "stopType" IS NULL OR "stopType" NOT IN ('DEPOT_START', 'DEPOT_END')
          ELSE "stopType" IS DISTINCT FROM 'DELIVERY'
        END), false) AS "missingStop"
      FROM owned_events
    ), deliveries AS (
      SELECT
        (COUNT(DISTINCT id) FILTER (WHERE outcome = ${DELIVERY_RESULTS[0]}))::int AS success,
        (COUNT(DISTINCT id) FILTER (WHERE outcome = ${DELIVERY_RESULTS[1]}))::int AS partial,
        (COUNT(DISTINCT id) FILTER (WHERE outcome = ${DELIVERY_RESULTS[2]}))::int AS failed,
        (COUNT(DISTINCT id) FILTER (WHERE outcome IS NULL))::int AS unclassified,
        COALESCE(BOOL_OR(outcome IS NULL), false) AS "missingOutcome"
      FROM delivery_evidence
    )
    SELECT statement_timestamp() AS "asOf", "completedTripCount", "processedStopCount",
      "depotStopCount", success, partial, failed, unclassified,
      "missingStop" OR "missingOutcome" AS "hasEvidenceGap"
    FROM totals CROSS JOIN deliveries
  `;
}
