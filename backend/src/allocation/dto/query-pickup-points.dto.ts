import { IsArray, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryPickupPointsDto {
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  latitude?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  longitude?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredStorageConditions?: string[]; // AMBIENT, COOL, CHILLED
}
