import { IsInt, IsUUID, Max, Min } from 'class-validator';

export const MAX_ORDER_VERSION = 2_147_483_647;

export class ConfirmCustomerOrderDto {
  @IsInt()
  @Min(1)
  @Max(MAX_ORDER_VERSION)
  expectedVersion!: number;

  @IsUUID()
  idempotencyKey!: string;
}
