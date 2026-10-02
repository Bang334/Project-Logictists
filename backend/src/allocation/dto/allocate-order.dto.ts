import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AllocateOrderDto {
  @IsString()
  @IsNotEmpty()
  salesOrderId: string;

  @IsString()
  @IsOptional()
  overrideSourceId?: string; // Cho phép điều phối viên override thủ công nếu cần

  @IsString()
  @IsOptional()
  overrideReason?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
