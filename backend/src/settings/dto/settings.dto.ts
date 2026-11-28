import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { LateDeliveryPenaltyMode, StackingOwnerMode } from '@prisma/client';

const TIME_HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class StackingSettingsInputDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(StackingOwnerMode)
  ownerMode?: StackingOwnerMode;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  maxTiers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  liftClearanceMm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxTopLoadPercent?: number;
}

export class OptimizationSettingsInputDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  defaultSearchBudgetSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1000)
  maxTimeSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  hybridSeedCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  earlyStopPatience?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  dispatchPreparationMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1_000_000_000_000)
  unassignedOrderPenaltyVnd?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxRoutesPerDay?: number | null;

  @IsOptional()
  @IsBoolean()
  enforceWeightBalance?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  weightBalancePenaltyVndPerPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  maxLateralImbalancePercent?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  maxLongitudinalImbalancePercent?: number | null;

  @IsOptional()
  @IsBoolean()
  demoAllowOverride?: boolean;
}

export class CostPenaltySettingsInputDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10_000_000)
  fuelPricePerLiter?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(44_640)
  monthlyWorkingMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000_000)
  cargoHoldingCostVndPerTonHour?: number;

  @IsOptional()
  @Matches(TIME_HH_MM_REGEX, {
    message: 'Giờ bắt đầu ca phải đúng định dạng HH:mm',
  })
  workStartTime?: string;

  @IsOptional()
  @Matches(TIME_HH_MM_REGEX, {
    message: 'Giờ kết thúc ca phải đúng định dạng HH:mm',
  })
  workEndTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  deliveryGraceDays?: number;

  @IsOptional()
  @IsEnum(LateDeliveryPenaltyMode)
  lateDeliveryPenaltyMode?: LateDeliveryPenaltyMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  lateDeliveryPenaltyValue?: number;
}

export class UpdateCompanySettingsDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => StackingSettingsInputDto)
  stacking?: StackingSettingsInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptimizationSettingsInputDto)
  optimization?: OptimizationSettingsInputDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CostPenaltySettingsInputDto)
  costPenalty?: CostPenaltySettingsInputDto;
}

export class UpdateBranchSettingsDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @IsBoolean()
  overrideStacking?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => StackingSettingsInputDto)
  stacking?: StackingSettingsInputDto;

  @IsOptional()
  @IsBoolean()
  overrideOptimization?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptimizationSettingsInputDto)
  optimization?: OptimizationSettingsInputDto;

  @IsOptional()
  @IsBoolean()
  overrideCostPenalty?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CostPenaltySettingsInputDto)
  costPenalty?: CostPenaltySettingsInputDto;
}

export type SettingsGroupKey = 'stacking' | 'optimization' | 'costPenalty';

export class ResetBranchOverridesDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(['stacking', 'optimization', 'costPenalty'], { each: true })
  groups?: SettingsGroupKey[];
}

export class SettingAuditLogsQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
