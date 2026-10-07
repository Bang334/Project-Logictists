import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdjustmentReason } from '@prisma/client';

export class AdjustmentLineItemDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsInt()
  deltaQuantity: number; // Có thể âm (hao hụt/hỏng) hoặc dương (thừa kiểm kê)
}

export class CreateAdjustmentDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsEnum(AdjustmentReason)
  @IsNotEmpty()
  reason: AdjustmentReason;

  @IsString()
  @IsOptional()
  note?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdjustmentLineItemDto)
  lines: AdjustmentLineItemDto[];
}
