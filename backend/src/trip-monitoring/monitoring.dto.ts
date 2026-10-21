import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Matches } from 'class-validator';
import { TripStatus } from '@prisma/client';

export class MonitoringPageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}
export class MonitoringQuery extends MonitoringPageQuery {
  @IsOptional() @IsIn(['plannedStartTime', 'actualStartTime', 'actualEndTime']) timeBasis?: 'plannedStartTime' | 'actualStartTime' | 'actualEndTime';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsEnum(TripStatus) status?: TripStatus;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsUUID() driverId?: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) from?: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) to?: string;
}
