import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TripEndpointDto } from './create-trip.dto';

export class UpdateTripPlanDto {
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @IsString()
  vehicleId: string;

  @IsString()
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
  orderedStopIds: string[];

  @IsOptional()
  @IsString()
  notes?: string;
}
