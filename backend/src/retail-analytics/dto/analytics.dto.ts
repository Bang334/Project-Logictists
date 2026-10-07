import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class RecordRetailPaymentDto {
  @IsString()
  @IsNotEmpty()
  salesOrderId: string;

  @IsString()
  @IsNotEmpty()
  paymentMethod: string; // VIETQR_DYNAMIC, CASH_AT_PICKUP, VNPay...

  @IsString()
  @IsOptional()
  transactionRef?: string;

  @IsNumber()
  @Min(0)
  amountPaid: number;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}

export class RefundRetailOrderDto {
  @IsString()
  @IsNotEmpty()
  salesOrderId: string;

  @IsNumber()
  @Min(1)
  refundAmount: number;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsString()
  @IsOptional()
  transactionRef?: string;
}

export class AnalyticsFilterDto {
  @IsString()
  @IsOptional()
  from?: string;

  @IsString()
  @IsOptional()
  to?: string;

  @IsString()
  @IsOptional()
  locationId?: string;
}
