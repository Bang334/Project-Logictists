import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ReceiptLineItemDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateReceiptDto {
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsOptional()
  supplierName?: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineItemDto)
  lines: ReceiptLineItemDto[];
}
