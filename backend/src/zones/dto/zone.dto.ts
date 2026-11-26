import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CurfewWindowDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'startTime phải theo định dạng HH:mm (00:00–23:59)',
  })
  startTime!: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d|24:00$/, {
    message: 'endTime phải theo định dạng HH:mm (00:00–24:00)',
  })
  endTime!: string;
}

export class CreateLoadRestrictionZoneDto {
  @IsUUID()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsNumber()
  @IsPositive()
  maxPayloadKg!: number;

  @IsArray()
  @ArrayMinSize(1)
  polygon!: number[][][];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CurfewWindowDto)
  curfewWindows!: CurfewWindowDto[];
}

export class UpdateLoadRestrictionZoneDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxPayloadKg?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  polygon?: number[][][];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CurfewWindowDto)
  curfewWindows?: CurfewWindowDto[];
}
