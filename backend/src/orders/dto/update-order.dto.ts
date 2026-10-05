import { IsInt, Min } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';
export class UpdateOrderDto extends CreateOrderDto {
  @IsInt() @Min(1) version: number;
}
export class ConfirmOrderDto {
  @IsInt() @Min(1) version: number;
}
