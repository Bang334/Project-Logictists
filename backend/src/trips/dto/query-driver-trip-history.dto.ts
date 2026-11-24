import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { TripStatus } from "@prisma/client";

export const DRIVER_HISTORY_STATUSES = [TripStatus.COMPLETED, TripStatus.CANCELLED] as const;

export class QueryDriverTripHistoryDto {
  @IsString()
  @MaxLength(35)
  from!: string;

  @IsString()
  @MaxLength(35)
  to!: string;

  @IsOptional()
  @IsIn(DRIVER_HISTORY_STATUSES)
  status?: (typeof DRIVER_HISTORY_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
