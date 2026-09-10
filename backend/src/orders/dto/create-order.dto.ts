import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StopType } from '@prisma/client';

export class CreateOrderItemDto {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsOptional()
  @IsString()
  packageType?: string;

  @IsInt()
  @Min(1)
  @Max(500)
  quantity: number;

  @IsNumber()
  @IsPositive()
  weightKg: number;

  @IsNumber()
  @IsPositive()
  lengthCm: number;

  @IsNumber()
  @IsPositive()
  widthCm: number;

  @IsNumber()
  @IsPositive()
  heightCm: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  volumeM3?: number;
}

export class CreateOrderStopDto {
  @IsEnum(StopType)
  type: StopType;

  @IsNumber()
  sequence: number;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsString()
  @IsNotEmpty()
  contactName: string;

  @IsString()
  @IsNotEmpty()
  contactPhone: string;

  @IsOptional()
  windowStart?: Date;

  @IsOptional()
  windowEnd?: Date;

  @IsOptional()
  @IsNumber()
  serviceDurationMinutes?: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderStopDto)
  stops: CreateOrderStopDto[];
}
