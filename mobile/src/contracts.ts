import { z } from "zod";
const nullableDate = z.string().datetime().nullable();
const assignment = z.object({
  id: z.string(),
  status: z.enum(["ASSIGNED", "ACCEPTED", "REJECTED"]),
  version: z.number().int().positive(),
  offeredAt: z.string().datetime(),
  respondedAt: nullableDate,
  rejectionReason: z.string().nullable(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  role: z.string(),
});
const trip = z.object({
  id: z.string(),
  tripNumber: z.string(),
  status: z.enum(["DISPATCHED", "IN_PROGRESS", "COMPLETED"]),
  version: z.number().int().positive(),
  plannedStartTime: z.string().datetime(),
  plannedEndTime: z.string().datetime(),
  vehicle: z.object({
    id: z.string(),
    plateNumber: z.string(),
    model: z.string(),
  }),
});
const endpoint = z
  .object({ id: z.string(), sequence: z.number(), address: z.string() })
  .nullable();
export const profileSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  phone: z.string(),
  homeBranchId: z.string(),
  homeBranch: z.object({ id: z.string(), code: z.string(), name: z.string() }),
});
export const listSchema = z.object({
  data: z.array(
    assignment.extend({
      trip: trip.extend({ start: endpoint, end: endpoint }),
    }),
  ),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});
export const detailSchema = assignment.extend({
  trip: trip.extend({
    stops: z.array(
      z.object({
        id: z.string(),
        sequence: z.number(),
        stopType: z.string(),
        address: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        contactName: z.string().nullable(),
        contactPhone: z.string().nullable(),
        plannedArrivalTime: nullableDate,
        plannedDepartureTime: nullableDate,
        tasks: z.array(
          z.object({
            id: z.string(),
            action: z.enum(["LOAD", "UNLOAD"]),
            plannedQuantity: z.number(),
            allocationId: z.string().nullable(),
            description: z.string().nullable(),
            order: z
              .object({ id: z.string(), orderNumber: z.string() })
              .nullable(),
            package: z
              .object({
                id: z.string(),
                packageCode: z.string(),
                lengthMm: z.number().nullable(),
                widthMm: z.number().nullable(),
                heightMm: z.number().nullable(),
                weightG: z.string().nullable(),
              })
              .nullable(),
            windowStart: nullableDate,
            windowEnd: nullableDate,
            windowBasis: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
});
export const loginSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export const responseSchema = z.object({
  id: z.string(),
  status: z.enum(["ACCEPTED", "REJECTED"]),
  version: z.number(),
  tripId: z.string(),
  tripVersion: z.number(),
  respondedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof profileSchema>;
export type AssignmentList = z.infer<typeof listSchema>;
export type AssignmentDetail = z.infer<typeof detailSchema>;
