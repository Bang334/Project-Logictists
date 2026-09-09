import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, IsNumber, IsEnum } from 'class-validator';
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

  @IsNumber()
  quantity: number;

  @IsNumber()
  weightKg: number;

  @IsNumber()
  lengthCm: number;

  @IsNumber()
  widthCm: number;

  @IsNumber()
  heightCm: number;

  @IsNumber()
  volumeM3: number;
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
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderStopDto)
  stops: CreateOrderStopDto[];
}
