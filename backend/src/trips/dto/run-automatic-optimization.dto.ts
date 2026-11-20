import {
  IsBoolean,
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
  @IsOptional()
  @IsUUID()
  deliveryBatchId?: string;

  @IsOptional()
  @IsBoolean()
  replanWithFleet?: boolean;

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
  @Max(1000)
  searchBudgetSeconds?: number;
}
