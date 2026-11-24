import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { TripStatus } from "@prisma/client";

export const DRIVER_VISIBLE_TRIP_STATUSES = [
  TripStatus.DISPATCHED,
  TripStatus.IN_PROGRESS,
  TripStatus.COMPLETED,
  TripStatus.CANCELLED,
] as const;

export class QueryDriverTripsDto {
  @IsOptional()
  @IsString()
  @MaxLength(35)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(35)
  to?: string;

  @IsOptional()
  @IsIn(DRIVER_VISIBLE_TRIP_STATUSES)
  status?: TripStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
