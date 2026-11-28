import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { DriverStatus } from '@prisma/client';

export class UpdateDriverDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  citizenId?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @IsOptional()
  @IsString()
  licenseClass?: string;

  @IsOptional()
  @IsDateString()
  licenseExpiry?: string;

  @IsOptional()
  @IsUUID()
  homeBranchId?: string;

  @IsOptional()
  @IsUUID()
  homeLocationId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  homeProvinceCode?: string | null;

  @IsOptional()
  @IsBoolean()
  strictHomeLocation?: boolean;

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
