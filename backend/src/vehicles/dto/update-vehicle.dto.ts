import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { VehicleStatus } from '@prisma/client';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  plateNumber?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsUUID()
  vehicleTypeId?: string;

  @IsOptional()
  @IsUUID()
  homeBranchId?: string;

  @IsOptional()
  @IsUUID()
  homeDepotLocationId?: string;

  @IsOptional()
  @IsBoolean()
  returnToDepot?: boolean;

  @IsOptional()
  @IsUUID()
  endDepotLocationId?: string | null;

  @IsOptional()
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}
