import { LateDeliveryPenaltyMode } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNumber,
  ValidateIf,
  Length,
  IsTimeZone,
  Matches,
  IsString,
  Max,
  Min,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateBranchDto {
  @IsDateString()
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  expectedUpdatedAt!: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 200)
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 500)
  address?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(0, 40)
  phone?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsTimeZone()
  timezone?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(365)
  deliveryGraceDays?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(LateDeliveryPenaltyMode)
  lateDeliveryPenaltyMode?: LateDeliveryPenaltyMode;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  lateDeliveryPenaltyValue?: number;
}
