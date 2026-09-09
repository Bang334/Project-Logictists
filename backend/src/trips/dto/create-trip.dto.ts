import { IsString, IsNotEmpty, IsArray, IsDateString, IsOptional } from 'class-validator';

export class TripStopInputDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  orderStopId: string;
}

export class CreateTripDto {
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
