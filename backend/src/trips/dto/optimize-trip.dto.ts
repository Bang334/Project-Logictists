import { IsUUID as BranchUUID, IsOptional as OptionalBranch } from 'class-validator';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class OptimizeTripDto {
  @OptionalBranch()
  @BranchUUID()
  branchId?: string;

  @IsUUID()
  vehicleId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @IsUUID(undefined, { each: true })
  orderIds: string[];
}
