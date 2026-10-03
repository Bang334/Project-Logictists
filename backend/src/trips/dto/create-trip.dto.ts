import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsDateString,
  IsOptional,
  IsUUID,
  IsLatitude,
  IsLongitude,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TripEndpointDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsLatitude()
  latitude: number;

  @IsLongitude()
  longitude: number;
}

export class TripStopInputDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  orderStopId: string;
}

export class CreateTripDto {
  @IsUUID()
  idempotencyKey: string;

  @IsString()
  @IsNotEmpty()
  vehicleId: string;

  @IsString()
  @IsNotEmpty()
  driverId: string;

  @IsDateString()
  plannedStartTime: string;

  @IsDateString()
  plannedEndTime: string;

  @ValidateNested()
  @Type(() => TripEndpointDto)
  startLocation: TripEndpointDto;

  @ValidateNested()
  @Type(() => TripEndpointDto)
  endLocation: TripEndpointDto;

  @IsArray()
  @IsString({ each: true })
  orderIds: string[];

  @IsOptional()
  @IsArray()
  orderedStopIds?: string[]; // Thứ tự dừng tùy chỉnh nếu điều phối viên tự sắp xếp

  @IsOptional()
  @IsString()
  notes?: string;
}
