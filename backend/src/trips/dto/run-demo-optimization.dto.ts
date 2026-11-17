import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class RunDemoOptimizationDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
  @IsOptional()
  @IsBoolean()
  demoStackingEnabled?: boolean;
  @IsOptional()
  @IsIn(['SAME_CUSTOMER', 'ANY_CUSTOMER'])
  demoStackingOwnerMode?: 'SAME_CUSTOMER' | 'ANY_CUSTOMER';
  @IsOptional()
  @IsString()
  caseId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(120)
  timeBudgetSeconds?: number;

  @IsOptional()
  customRequest?: Record<string, unknown>;
}
