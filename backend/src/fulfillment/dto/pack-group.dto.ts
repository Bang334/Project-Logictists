import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PackageItemMeasureDto {
  @IsString()
  @IsNotEmpty()
  fulfillmentLineId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;
}

export class MeasuredPackageDto {
  @IsOptional()
  @IsString()
  packageCode?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  lengthMm: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  widthMm: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  heightMm: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  weightG: number;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PackageItemMeasureDto)
  items: PackageItemMeasureDto[];
}

export class PackAndMeasureGroupDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MeasuredPackageDto)
  packages: MeasuredPackageDto[];
}

