import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class FleetQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsString() @MaxLength(30) status?: string;
}
export class IntervalQueryDto extends FleetQueryDto {
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
}
export class CreateVehicleDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(30) @Matches(/^[A-Za-z0-9 .-]+$/) plateNumber!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) model!: string;
  @IsUUID() vehicleTypeId!: string;
  @IsUUID() homeBranchId!: string;
  @IsOptional() @IsUUID() homeDepotLocationId?: string;
}
export class CreateDriverDto {
  @IsUUID() employeeId!: string;
  @IsInt() @Min(1) employeeVersion!: number;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) licenseNumber!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(30) licenseClass!: string;
  @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) licenseExpiry!: string;
}
export class LinkEmployeeDto {
  @IsUUID() employeeId!: string;
  @IsInt() @Min(1) employeeVersion!: number;
  @IsISO8601({ strict: true }) expectedUpdatedAt!: string;
}
export class ScheduleDto {
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) startsAt!: string;
  @IsISO8601({ strict: true }) @Matches(/T.*(Z|[+-]\d{2}:\d{2})$/) endsAt!: string;
  @IsIn(['SHIFT', 'LEAVE', 'OTHER', 'MAINTENANCE', 'BREAKDOWN']) kind!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
export class UpdateScheduleDto extends ScheduleDto {
  @IsInt() @Min(1) version!: number;
}
export class CancelScheduleDto {
  @IsInt() @Min(1) version!: number;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
