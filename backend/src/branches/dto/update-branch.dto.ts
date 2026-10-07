import { LateDeliveryPenaltyMode } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  address?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  deliveryGraceDays?: number;

  @IsOptional()
  @IsEnum(LateDeliveryPenaltyMode)
  lateDeliveryPenaltyMode?: LateDeliveryPenaltyMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lateDeliveryPenaltyValue?: number;
}
