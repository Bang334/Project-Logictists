import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class OptimizeTripDto {
  @IsUUID()
  vehicleId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsUUID(undefined, { each: true })
  orderIds: string[];
}
