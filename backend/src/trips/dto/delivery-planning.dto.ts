import { IsEnum, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class ProposeDeliveryBatchDto {
  @IsUUID() jobId!: string;
  @IsInt() @Min(1) @Max(10) candidateNumber!: number;
  @IsInt() @Min(1) @Max(1440) windowMinutes!: number;
  @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) expiresAt!: string;
  @IsUUID() idempotencyKey!: string;
}

export enum DeliveryResponse { CONFIRMED = 'CONFIRMED', DECLINED = 'DECLINED', CHANGE_REQUESTED = 'CHANGE_REQUESTED' }
export class RespondDeliveryAppointmentDto {
  @IsInt() @Min(1) version!: number;
  @IsUUID() idempotencyKey!: string;
  @IsEnum(DeliveryResponse) decision!: DeliveryResponse;
  @IsOptional() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) requestedStart?: string;
  @IsOptional() @IsISO8601({ strict: true }) @Matches(/(Z|[+-]\d{2}:\d{2})$/) requestedEnd?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class OptimizeDeliveryBatchDto {
  @IsUUID() idempotencyKey!: string;
  @IsOptional() @IsInt() @Min(1) @Max(120) searchBudgetSeconds?: number;
}
