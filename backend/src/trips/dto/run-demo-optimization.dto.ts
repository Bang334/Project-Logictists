import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class RunDemoOptimizationDto {
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
