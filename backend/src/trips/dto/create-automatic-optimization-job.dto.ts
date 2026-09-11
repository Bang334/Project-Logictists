import { IsOptional, IsUUID } from 'class-validator';

export class CreateAutomaticOptimizationJobDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
