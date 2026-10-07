import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ScopeType } from '@prisma/client';

export class CreatePriceListDto {
  @IsString()
  @IsOptional()
  organizationId?: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  currency?: string;

  @IsEnum(ScopeType)
  @IsOptional()
  scopeType?: ScopeType;

  @IsString()
  @IsOptional()
  locationId?: string;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsDateString()
  @IsNotEmpty()
  validFrom: string;

  @IsDateString()
  @IsOptional()
  validTo?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class SetSkuPriceDto {
  @IsString()
  @IsNotEmpty()
  priceListId: string;

  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  salePrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  vatRate?: number;
}
