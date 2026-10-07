import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum AutomaticDispatchScheduleMode {
  CURRENT_TIME = 'CURRENT_TIME',
  NEXT_DAY = 'NEXT_DAY',
}

export class RunAutomaticOptimizationDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsEnum(AutomaticDispatchScheduleMode)
  scheduleMode?: AutomaticDispatchScheduleMode;

  @IsOptional()
  @IsISO8601()
  customStartTime?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  searchBudgetSeconds?: number;
}
