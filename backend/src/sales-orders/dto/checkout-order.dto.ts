import {
  IsArray,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CheckoutOrderItemDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CheckoutOrderDto {
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  customerPhone: string;

  @IsString()
  @IsOptional()
  selectedPickupPointId?: string;

  @IsString()
  @IsOptional()
  deliveryAddress?: string;

  @IsOptional()
  deliveryLatitude?: number;

  @IsOptional()
  deliveryLongitude?: number;

  @IsString()
  @IsOptional()
  deliveryContactName?: string;

  @IsString()
  @IsOptional()
  deliveryContactPhone?: string;

  @IsString()
  @IsOptional()
  fulfillmentSourceId?: string;

  @IsString()
  @IsOptional()
  @IsIn(['MANUAL_PENDING'])
  paymentMethod?: 'MANUAL_PENDING';

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutOrderItemDto)
  items: CheckoutOrderItemDto[];
}
