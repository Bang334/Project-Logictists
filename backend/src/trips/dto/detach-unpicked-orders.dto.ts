import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class DetachUnpickedOrdersDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  orderIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
