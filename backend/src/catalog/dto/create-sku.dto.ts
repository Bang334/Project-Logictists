import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { SkuStatus, StorageCondition } from '@prisma/client';

export class CreateSkuDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsString()
  @IsNotEmpty()
  skuCode: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  uom?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  weightGrams?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  lengthMm?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  widthMm?: number;

  @IsInt()
  @Min(0)
  @IsOptional()
  heightMm?: number;

  @IsEnum(StorageCondition)
  @IsOptional()
  storageCondition?: StorageCondition;

  @IsBoolean()
  @IsOptional()
  isSellable?: boolean;

  @IsBoolean()
  @IsOptional()
  allowPickup?: boolean;

  @IsEnum(SkuStatus)
  @IsOptional()
  status?: SkuStatus;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  barcodes?: string[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  basePrice?: number;
}
