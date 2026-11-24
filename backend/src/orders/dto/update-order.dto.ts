import {
  ArrayMinSize,
  IsArray,
  IsDate,
  IsNotEmpty,
  IsInt,
  Max,
  ValidateIf,
  IsOptional,
  IsString,
  IsNumber,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateOrderItemDto, CreateOrderStopDto } from './create-order.dto';

import { MAX_ORDER_VERSION } from './confirm-customer-order.dto';

export class UpdateOrderDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_VERSION)
  expectedVersion?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  orderedAt?: Date;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalAmount?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  customerId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderStopDto)
  stops?: CreateOrderStopDto[];
}
