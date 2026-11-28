import { Type } from 'class-transformer';
import {
  IsBoolean, IsDateString, IsDefined, IsInt, IsNumber, IsOptional, IsString,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Za-z0-9_-]{1,32}$/;

class DrivingLimitsDto {
  @IsBoolean() enabled!: boolean;
  @IsInt() @Min(1) @Max(604800) maxContinuousDrivingSec!: number;
  @IsInt() @Min(0) @Max(604800) shortRestDurationSec!: number;
  @IsInt() @Min(1) @Max(604800) maxDailyDrivingSec!: number;
  @IsInt() @Min(0) @Max(604800) dailyRestDurationSec!: number;
  @IsInt() @Min(1) @Max(604800) maxWeeklyDrivingSec!: number;
  @IsInt() @Min(0) @Max(604800) minInterTripRestSec!: number;
  @IsInt() @Min(0) @Max(2147483647) overnightAllowanceVnd!: number;
  @IsBoolean() restAllowanceDuringService!: boolean;
}

export class WorkPolicyInputDto {
  @Matches(CODE) code!: string;
  @IsInt() @Min(1) @Max(2147483647) revision!: number;
  @Matches(DATE_ONLY) @IsDateString({ strict: true }) effectiveFrom!: string;
  @IsOptional() @Matches(DATE_ONLY) @IsDateString({ strict: true }) effectiveTo?: string | null;
  @IsOptional() @IsString() @MaxLength(255) approvalReference?: string | null;
  @IsDefined() @ValidateNested() @Type(() => DrivingLimitsDto) limits!: DrivingLimitsDto;
}

export class TollCorridorInputDto {
  @Matches(CODE) fromProvinceCode!: string;
  @Matches(CODE) toProvinceCode!: string;
  @IsOptional() @IsString() @MaxLength(120) highwayName?: string | null;
  @IsInt() @Min(0) @Max(2147483647) baseTollVnd!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10000) distanceHintKm?: number | null;
  @IsBoolean() active!: boolean;
}
