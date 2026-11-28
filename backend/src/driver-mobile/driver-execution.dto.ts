import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { FailedDeliveryDto } from './driver-mobile.dto';

export const DELIVERY_FAILURE_CATEGORIES = [
  'CUSTOMER_BUSY',
  'UNREACHABLE',
  'REFUSED',
  'OTHER',
] as const;

export type DeliveryFailureCategory =
  (typeof DELIVERY_FAILURE_CATEGORIES)[number];

export class EnhancedFailedDeliveryDto extends FailedDeliveryDto {
  @IsOptional()
  @IsIn(DELIVERY_FAILURE_CATEGORIES)
  failureCategory?: DeliveryFailureCategory;

  @IsOptional()
  @IsDateString()
  requestedRedeliveryAt?: string;
}

export class ConfirmTaskDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsInt()
  @Min(1)
  expectedTripVersion!: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ReturnToHubDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsInt()
  @Min(1)
  expectedTripVersion!: number;

  @IsOptional()
  @IsUUID()
  hubLocationId?: string;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  notes?: string;
}
