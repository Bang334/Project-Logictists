import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { StorageCondition } from '@prisma/client';

export class QueryCatalogDto {
  @IsString()
  @IsOptional()
  search?: string;

  @IsString()
  @IsOptional()
  categoryId?: string;

  @IsEnum(StorageCondition)
  @IsOptional()
  storageCondition?: StorageCondition;

  @IsString()
  @IsOptional()
  locationId?: string; // Để resolve giá tương ứng theo location

  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;
}
