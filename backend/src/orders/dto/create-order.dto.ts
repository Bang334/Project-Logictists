import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class PackageInputDto {
  @IsOptional() @IsUUID() id?: string;
  @IsInt() @Min(1) @Max(2147483647) lengthMm: number;
  @IsInt() @Min(1) @Max(2147483647) widthMm: number;
  @IsInt() @Min(1) @Max(2147483647) heightMm: number;
  @IsString() @Matches(/^[1-9][0-9]{0,18}$/) weightG: string;
}
export class CreateOrderItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsString() @MaxLength(100) sku?: string;
  @IsString() @IsNotEmpty() @MaxLength(500) description: string;
  @IsString() @IsNotEmpty() @MaxLength(50) packageType: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PackageInputDto)
  packages: PackageInputDto[];
}
export class CreateOrderStopDto {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(['PICKUP', 'DELIVERY']) type: 'PICKUP' | 'DELIVERY';
  @IsString() @IsNotEmpty() @MaxLength(1000) address: string;
  @IsNumber() @Min(-90) @Max(90) latitude: number;
  @IsNumber() @Min(-180) @Max(180) longitude: number;
  @IsString() @IsNotEmpty() @MaxLength(150) contactName: string;
  @IsString() @IsNotEmpty() @MaxLength(50) contactPhone: string;
  @IsOptional() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) windowStart?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) windowEnd?: string | null;
  @IsInt() @Min(0) @Max(2147483647) serviceDurationMinutes: number;
}
export class CreateOrderDto {
  @IsUUID() customerId: string;
  @IsUUID() branchId: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(2) @ValidateNested({ each: true }) @Type(() => CreateOrderStopDto)
  stops: CreateOrderStopDto[];
}
