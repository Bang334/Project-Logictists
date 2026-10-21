import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsISO8601,
  IsNotEmpty, MaxLength, Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../fleet/fleet.dto';
import { VehicleStatus } from '@prisma/client';

export class UpdateVehicleDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(30) @Matches(/^[A-Za-z0-9 .-]*[A-Za-z0-9][A-Za-z0-9 .-]*$/)
  plateNumber?: string;

  @IsOptional()
  @IsString()
  @Transform(trim) @IsNotEmpty() @MaxLength(200)
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
  @IsEnum(VehicleStatus)
  status?: VehicleStatus;
}
