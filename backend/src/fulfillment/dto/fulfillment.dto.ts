import { IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class RecordPreparedItemDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsString()
  @IsNotEmpty()
  barcode: string;

  @IsInt()
  @Min(0)
  preparedQty: number;

  @IsString()
  @IsOptional()
  shortageReason?: string;
}

export class PackOrderDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsNumber()
  @IsOptional()
  weightKg?: number;

  @IsString()
  @IsOptional()
  dimensionCm?: string;
}

export class CreateHandoverDto {
  @IsString()
  @IsNotEmpty()
  sourceLocationId: string;

  @IsString()
  @IsOptional()
  driverUserId?: string;

  @IsString()
  @IsOptional()
  tripId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  packageCodes: string[];

  @IsString()
  @IsOptional()
  notes?: string;
}

export class QueryOrderPreparationDto {
  @IsString()
  @IsOptional()
  locationId?: string;
}
