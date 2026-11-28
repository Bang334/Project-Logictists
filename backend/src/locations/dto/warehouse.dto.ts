import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
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

export class TransferReceivingProfileDto {
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  opensAt!: string;

  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  closesAt!: string;

  @IsInt()
  @Min(1)
  @Max(1440)
  handlingMinutes!: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  feeVndPerHandoff!: number;
}

class WarehouseTransferSettingsDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TransferReceivingProfileDto)
  transferReceivingProfile?: TransferReceivingProfileDto | null;
}

export class CreateWarehouseDto extends WarehouseTransferSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;

  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @IsUUID()
  managingBranchId!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateWarehouseDto extends WarehouseTransferSettingsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address?: string;

  @Type(() => Number)
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @Type(() => Number)
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsUUID()
  managingBranchId?: string;
}
