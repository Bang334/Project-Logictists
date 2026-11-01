import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CheckoutMultiSourceDto {
  @IsString()
  @IsNotEmpty()
  quoteId: string;

  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  customerPhone: string;

  @IsString()
  @IsOptional()
  paymentMethod?: string = 'MANUAL_PENDING';

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsBoolean()
  @IsNotEmpty()
  acceptedConditions: boolean;
}

