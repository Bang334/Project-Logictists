import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const normalizePhone = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/[\s.-]/g, '') : value;

export class CreateCustomerOrderStopDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address!: string;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  contactName!: string;

  @Transform(normalizePhone)
  @IsString()
  @Matches(/^\+?[0-9]{9,15}$/)
  contactPhone!: string;
}

export class CreateCustomerOrderItemDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  packageType?: string;

  @IsInt()
  @Min(1)
  @Max(500)
  quantity!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.EPSILON)
  @Max(1_000)
  unitWeightKg!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.EPSILON)
  @Max(1_000)
  lengthCm!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.EPSILON)
  @Max(300)
  widthCm!: number;

  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(Number.EPSILON)
  @Max(300)
  heightCm!: number;
}

export class CreateCustomerOrderDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsUUID()
  branchId!: string;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateCustomerOrderStopDto)
  pickup!: CreateCustomerOrderStopDto;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CreateCustomerOrderStopDto)
  delivery!: CreateCustomerOrderStopDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerOrderItemDto)
  items!: CreateCustomerOrderItemDto[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  notes?: string;
}
