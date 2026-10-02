import {
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateTransferShipmentDto {
  @IsString()
  @IsNotEmpty()
  packageId: string;

  @IsString()
  @IsOptional()
  tripId?: string;
}

export class InboundScanDto {
  @IsString()
  @IsNotEmpty()
  packageCode: string;

  @IsString()
  @IsNotEmpty()
  holdingSlot: string;

  @IsString()
  @IsOptional()
  storageCondition?: string;
}

export class VerifyCollectionDto {
  @IsString()
  @IsNotEmpty()
  salesOrderId: string;

  @IsString()
  @IsNotEmpty()
  pickupPointId: string;

  @IsString()
  @IsOptional()
  otpCode?: string;

  @IsString()
  @IsOptional()
  qrToken?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class QueryHoldingsDto {
  @IsString()
  @IsOptional()
  locationId?: string;

  @IsString()
  @IsOptional()
  status?: string;
}
