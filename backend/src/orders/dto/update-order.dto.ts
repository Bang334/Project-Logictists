import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';
export class UpdateOrderDto extends CreateOrderDto {
  @IsInt() @Min(1) version: number;
}
export class ConfirmOrderDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsInt() @Min(0) @Max(999999999) acceptedProtectionFeeVnd?: number;
}
