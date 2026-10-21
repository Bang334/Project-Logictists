import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  IsISO8601,
  IsNotEmpty, MaxLength, Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../fleet/fleet.dto';
import { DriverStatus } from '@prisma/client';

export class UpdateDriverDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(80)
  citizenId?: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(80)
  licenseNumber?: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(30)
  licenseClass?: string;

  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  licenseExpiry?: string;

  @IsOptional()
  @IsUUID()
  homeBranchId?: string;

  @IsOptional()
  @IsEnum(DriverStatus)
  status?: DriverStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fixedSalaryMonthly?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tripBasePay?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  perKmPay?: number;
}
