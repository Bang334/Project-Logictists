import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { CartItemDto } from './check-cart.dto';

export class CreateQuoteDto {
  @IsString()
  provinceCode: string;

  @IsString()
  deliveryAddress: string;

  @Type(() => Number)
  @IsNumber()
  deliveryLatitude: number;

  @Type(() => Number)
  @IsNumber()
  deliveryLongitude: number;

  @IsOptional()
  @IsDateString()
  deliveryWindowStart?: string;

  @IsOptional()
  @IsDateString()
  deliveryWindowEnd?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

