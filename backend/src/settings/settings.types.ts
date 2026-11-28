import { LateDeliveryPenaltyMode, StackingOwnerMode } from '@prisma/client';

export type SettingSource = 'COMPANY' | 'BRANCH';

export interface StackingSettings {
  enabled: boolean;
  ownerMode: StackingOwnerMode;
  maxTiers: number;
  liftClearanceMm: number;
  maxTopLoadPercent: number;
}

export interface OptimizationSettings {
  defaultSearchBudgetSeconds: number;
  maxTimeSeconds: number;
  hybridSeedCount: number;
  earlyStopPatience: number;
  dispatchPreparationMinutes: number;
  unassignedOrderPenaltyVnd: number;
  maxRoutesPerDay: number | null;
  demoAllowOverride: boolean;
}

export interface CostPenaltySettings {
  fuelPricePerLiter: number;
  monthlyWorkingMinutes: number;
  cargoHoldingCostVndPerTonHour: number;
  workStartTime: string;
  workEndTime: string;
  deliveryGraceDays: number;
  lateDeliveryPenaltyMode: LateDeliveryPenaltyMode;
  lateDeliveryPenaltyValue: number;
}

export interface EffectiveSettings {
  scopeType: SettingSource;
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
  companyVersion: number;
  branchVersion: number;
  policyVersion: string;
  updatedAt: string;
  overrides: {
    stacking: boolean;
    optimization: boolean;
    costPenalty: boolean;
  };
  sources: {
    stacking: SettingSource;
    optimization: SettingSource;
    costPenalty: SettingSource;
  };
  stacking: StackingSettings;
  optimization: OptimizationSettings;
  costPenalty: CostPenaltySettings;
}

export interface ScopedSettingsResponse {
  company: {
    version: number;
    updatedAt: string | null;
    stacking: StackingSettings;
    optimization: OptimizationSettings;
    costPenalty: CostPenaltySettings;
  };
  branch: {
    branchId: string;
    branchCode: string;
    branchName: string;
    version: number;
    updatedAt: string | null;
    overrides: {
      stacking: boolean;
      optimization: boolean;
      costPenalty: boolean;
    };
    stacking: Partial<StackingSettings>;
    optimization: Partial<OptimizationSettings>;
    costPenalty: Partial<CostPenaltySettings>;
  } | null;
  effective: EffectiveSettings;
}

export interface ResolvedStackingPolicy {
  max_tiers: number;
  lift_clearance_cm: number;
  owner_mode: 'SAME_CUSTOMER' | 'ANY_CUSTOMER';
  max_top_load_percent: number;
}

export const COMPANY_SETTING_DEFAULTS: {
  stacking: StackingSettings;
  optimization: OptimizationSettings;
  costPenalty: CostPenaltySettings;
} = {
  stacking: {
    enabled: true,
    ownerMode: StackingOwnerMode.ANY_CUSTOMER,
    maxTiers: 3,
    liftClearanceMm: 50,
    maxTopLoadPercent: 30,
  },
  optimization: {
    defaultSearchBudgetSeconds: 60,
    maxTimeSeconds: 240,
    hybridSeedCount: 0,
    earlyStopPatience: 0,
    dispatchPreparationMinutes: 20,
    unassignedOrderPenaltyVnd: 1_000_000_000,
    maxRoutesPerDay: null,
    demoAllowOverride: true,
  },
  costPenalty: {
    fuelPricePerLiter: 23_500,
    monthlyWorkingMinutes: 10_560,
    cargoHoldingCostVndPerTonHour: 0,
    workStartTime: '08:00',
    workEndTime: '17:00',
    deliveryGraceDays: 2,
    lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.NONE,
    lateDeliveryPenaltyValue: 0,
  },
};
