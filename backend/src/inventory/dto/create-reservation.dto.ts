import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReservationLineItemDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateReservationDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsOptional()
  salesOrderId?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  ttlMinutes?: number; // Mặc định 15 phút (cho giỏ hàng/checkout), 1440 phút (24h khi đã xác nhận đơn)

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationLineItemDto)
  lines: ReservationLineItemDto[];
}

export class CommitReservationDto {
  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}

export class ReleaseReservationDto {
  @IsString()
  @IsOptional()
  reason?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
