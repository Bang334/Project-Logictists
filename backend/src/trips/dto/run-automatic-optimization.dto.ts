import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';

export enum AutomaticDispatchScheduleMode {
  CURRENT_TIME = 'CURRENT_TIME',
  NEXT_DAY = 'NEXT_DAY',
}

export class RunAutomaticOptimizationDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsEnum(AutomaticDispatchScheduleMode)
  scheduleMode?: AutomaticDispatchScheduleMode;

  @IsOptional()
  @IsISO8601()
  customStartTime?: string;
}
