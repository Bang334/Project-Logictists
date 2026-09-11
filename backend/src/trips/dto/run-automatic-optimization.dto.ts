import { IsOptional, IsUUID } from 'class-validator';

export class RunAutomaticOptimizationDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
