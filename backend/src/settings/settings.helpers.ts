import { BadRequestException } from '@nestjs/common';
import { LateDeliveryPenaltyMode, Prisma, ScopeType, StackingOwnerMode, SystemSetting } from '@prisma/client';
import {
  COMPANY_SETTING_DEFAULTS,
  CostPenaltySettings,
  EffectiveSettings,
  OptimizationSettings,
  ResolvedStackingPolicy,
  ScopedSettingsResponse,
  SettingSource,
  StackingSettings,
} from './settings.types';

export function parseTimeToMinutes(hhmm: string): number {
  const [hoursStr, minutesStr] = hhmm.split(':');
  return Number(hoursStr) * 60 + Number(minutesStr);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function extractCompanySettingValues(companyRow: SystemSetting | null): {
  version: number;
  updatedAt: string | null;
  stacking: StackingSettings;
  optimization: OptimizationSettings;
  costPenalty: CostPenaltySettings;
} {
  const defaults = COMPANY_SETTING_DEFAULTS;
  if (!companyRow) {
    return {
      version: 1,
      updatedAt: null,
      stacking: { ...defaults.stacking },
      optimization: { ...defaults.optimization },
      costPenalty: { ...defaults.costPenalty },
    };
  }

  return {
    version: companyRow.version,
    updatedAt: companyRow.updatedAt ? companyRow.updatedAt.toISOString() : null,
    stacking: {
      enabled: companyRow.stackingEnabled ?? defaults.stacking.enabled,
      ownerMode: companyRow.stackingOwnerMode ?? defaults.stacking.ownerMode,
      maxTiers: companyRow.stackingMaxTiers ?? defaults.stacking.maxTiers,
      liftClearanceMm: companyRow.stackingLiftClearanceMm ?? defaults.stacking.liftClearanceMm,
    },
    optimization: {
      defaultSearchBudgetSeconds:
        companyRow.defaultSearchBudgetSeconds ?? defaults.optimization.defaultSearchBudgetSeconds,
      maxTimeSeconds: companyRow.maxOptimizationTimeSeconds ?? defaults.optimization.maxTimeSeconds,
      unassignedOrderPenaltyVnd: toFiniteNumber(
        companyRow.unassignedOrderPenaltyVnd,
        defaults.optimization.unassignedOrderPenaltyVnd,
      ),
      maxRoutesPerDay: companyRow.maxRoutesPerDay ?? defaults.optimization.maxRoutesPerDay,
      demoAllowOverride: companyRow.demoAllowOverride ?? defaults.optimization.demoAllowOverride,
    },
    costPenalty: {
      fuelPricePerLiter: toFiniteNumber(companyRow.fuelPricePerLiter, defaults.costPenalty.fuelPricePerLiter),
      monthlyWorkingMinutes:
        companyRow.monthlyWorkingMinutes ?? defaults.costPenalty.monthlyWorkingMinutes,
      cargoHoldingCostVndPerTonHour: toFiniteNumber(
        companyRow.cargoHoldingCostVndPerTonHour,
        defaults.costPenalty.cargoHoldingCostVndPerTonHour,
      ),
      workStartTime: companyRow.workStartTime ?? defaults.costPenalty.workStartTime,
      workEndTime: companyRow.workEndTime ?? defaults.costPenalty.workEndTime,
      deliveryGraceDays: companyRow.deliveryGraceDays ?? defaults.costPenalty.deliveryGraceDays,
      lateDeliveryPenaltyMode:
        companyRow.lateDeliveryPenaltyMode ?? defaults.costPenalty.lateDeliveryPenaltyMode,
      lateDeliveryPenaltyValue: toFiniteNumber(
        companyRow.lateDeliveryPenaltyValue,
        defaults.costPenalty.lateDeliveryPenaltyValue,
      ),
    },
  };
}

export function buildCompanyEffective(companyRow: SystemSetting | null): EffectiveSettings {
  const company = extractCompanySettingValues(companyRow);
  const nowIso = new Date().toISOString();
  return {
    scopeType: 'COMPANY',
    branchId: null,
    branchCode: null,
    branchName: null,
    companyVersion: company.version,
    branchVersion: 0,
    policyVersion: `company:v${company.version}`,
    updatedAt: company.updatedAt ?? nowIso,
    overrides: {
      stacking: false,
      optimization: false,
      costPenalty: false,
    },
    sources: {
      stacking: 'COMPANY',
      optimization: 'COMPANY',
      costPenalty: 'COMPANY',
    },
    stacking: { ...company.stacking },
    optimization: { ...company.optimization },
    costPenalty: { ...company.costPenalty },
  };
}

export function buildBranchScopedResponse(
  companyRow: SystemSetting | null,
  branchRow: SystemSetting | null,
  branch: { id: string; code: string; name: string },
): ScopedSettingsResponse {
  const company = extractCompanySettingValues(companyRow);
  const overrideStacking = branchRow?.overrideStacking ?? false;
  const overrideOptimization = branchRow?.overrideOptimization ?? false;
  const overrideCostPenalty = branchRow?.overrideCostPenalty ?? false;

  const effectiveStacking: StackingSettings = overrideStacking && branchRow
    ? {
        enabled: branchRow.stackingEnabled ?? company.stacking.enabled,
        ownerMode: branchRow.stackingOwnerMode ?? company.stacking.ownerMode,
        maxTiers: branchRow.stackingMaxTiers ?? company.stacking.maxTiers,
        liftClearanceMm: branchRow.stackingLiftClearanceMm ?? company.stacking.liftClearanceMm,
      }
    : { ...company.stacking };

  const effectiveOptimization: OptimizationSettings = overrideOptimization && branchRow
    ? {
        defaultSearchBudgetSeconds:
          branchRow.defaultSearchBudgetSeconds ?? company.optimization.defaultSearchBudgetSeconds,
        maxTimeSeconds: branchRow.maxOptimizationTimeSeconds ?? company.optimization.maxTimeSeconds,
        unassignedOrderPenaltyVnd: toFiniteNumber(
          branchRow.unassignedOrderPenaltyVnd,
          company.optimization.unassignedOrderPenaltyVnd,
        ),
        // Preserve explicit null (unlimited routes/day) when branch overrides optimization.
        maxRoutesPerDay: branchRow.maxRoutesPerDay ?? null,
        demoAllowOverride: branchRow.demoAllowOverride ?? company.optimization.demoAllowOverride,
      }
    : { ...company.optimization };

  const effectiveCostPenalty: CostPenaltySettings = overrideCostPenalty && branchRow
    ? {
        fuelPricePerLiter: toFiniteNumber(
          branchRow.fuelPricePerLiter,
          company.costPenalty.fuelPricePerLiter,
        ),
        monthlyWorkingMinutes:
          branchRow.monthlyWorkingMinutes ?? company.costPenalty.monthlyWorkingMinutes,
        cargoHoldingCostVndPerTonHour: toFiniteNumber(
          branchRow.cargoHoldingCostVndPerTonHour,
          company.costPenalty.cargoHoldingCostVndPerTonHour,
        ),
        workStartTime: branchRow.workStartTime ?? company.costPenalty.workStartTime,
        workEndTime: branchRow.workEndTime ?? company.costPenalty.workEndTime,
        deliveryGraceDays: branchRow.deliveryGraceDays ?? company.costPenalty.deliveryGraceDays,
        lateDeliveryPenaltyMode:
          branchRow.lateDeliveryPenaltyMode ?? company.costPenalty.lateDeliveryPenaltyMode,
        lateDeliveryPenaltyValue: toFiniteNumber(
          branchRow.lateDeliveryPenaltyValue,
          company.costPenalty.lateDeliveryPenaltyValue,
        ),
      }
    : { ...company.costPenalty };

  const branchVersion = branchRow?.version ?? 0;
  const branchUpdatedAt = branchRow?.updatedAt ? branchRow.updatedAt.toISOString() : null;
  const latestUpdatedAt =
    branchUpdatedAt && (!company.updatedAt || branchUpdatedAt > company.updatedAt)
      ? branchUpdatedAt
      : company.updatedAt ?? new Date().toISOString();

  const sourceStacking: SettingSource = overrideStacking ? 'BRANCH' : 'COMPANY';
  const sourceOptimization: SettingSource = overrideOptimization ? 'BRANCH' : 'COMPANY';
  const sourceCostPenalty: SettingSource = overrideCostPenalty ? 'BRANCH' : 'COMPANY';

  const effective: EffectiveSettings = {
    scopeType: 'BRANCH',
    branchId: branch.id,
    branchCode: branch.code,
    branchName: branch.name,
    companyVersion: company.version,
    branchVersion,
    policyVersion: `company:v${company.version}|branch:${branch.id}:v${branchVersion}`,
    updatedAt: latestUpdatedAt,
    overrides: {
      stacking: overrideStacking,
      optimization: overrideOptimization,
      costPenalty: overrideCostPenalty,
    },
    sources: {
      stacking: sourceStacking,
      optimization: sourceOptimization,
      costPenalty: sourceCostPenalty,
    },
    stacking: effectiveStacking,
    optimization: effectiveOptimization,
    costPenalty: effectiveCostPenalty,
  };

  return {
    company,
    branch: {
      branchId: branch.id,
      branchCode: branch.code,
      branchName: branch.name,
      version: branchVersion,
      updatedAt: branchUpdatedAt,
      overrides: {
        stacking: overrideStacking,
        optimization: overrideOptimization,
        costPenalty: overrideCostPenalty,
      },
      stacking: overrideStacking ? effectiveStacking : {},
      optimization: overrideOptimization ? effectiveOptimization : {},
      costPenalty: overrideCostPenalty ? effectiveCostPenalty : {},
    },
    effective,
  };
}

export function assertSettingsInvariants(params: {
  optimization: OptimizationSettings;
  costPenalty: CostPenaltySettings;
}): void {
  const { optimization, costPenalty } = params;
  if (optimization.defaultSearchBudgetSeconds > optimization.maxTimeSeconds) {
    throw new BadRequestException({
      code: 'INVALID_OPTIMIZATION_BUDGET',
      message: 'Thời gian tìm phương án mặc định không được vượt quá thời gian chạy tối đa',
    });
  }
  if (parseTimeToMinutes(costPenalty.workStartTime) >= parseTimeToMinutes(costPenalty.workEndTime)) {
    throw new BadRequestException({
      code: 'INVALID_WORK_SHIFT',
      message: 'Giờ bắt đầu ca phải trước giờ kết thúc ca',
    });
  }
  if (
    costPenalty.lateDeliveryPenaltyMode === LateDeliveryPenaltyMode.PERCENT_ORDER_VALUE_PER_DAY &&
    costPenalty.lateDeliveryPenaltyValue > 100
  ) {
    throw new BadRequestException({
      code: 'INVALID_PENALTY_PERCENT',
      message: 'Mức phạt phần trăm mỗi ngày không được vượt quá 100%',
    });
  }
}

export function toResolvedStackingPolicy(stacking: StackingSettings): ResolvedStackingPolicy | undefined {
  if (!stacking.enabled) return undefined;
  return {
    max_tiers: stacking.maxTiers,
    lift_clearance_cm: Number((stacking.liftClearanceMm / 10).toFixed(2)),
    owner_mode: stacking.ownerMode,
  };
}

export function computeSettingsDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const prev = before[key];
    const next = after[key];
    const bothPlainObjects =
      typeof prev === 'object' &&
      prev !== null &&
      !Array.isArray(prev) &&
      typeof next === 'object' &&
      next !== null &&
      !Array.isArray(next);
    if (bothPlainObjects) {
      Object.assign(
        diff,
        computeSettingsDiff(prev as Record<string, unknown>, next as Record<string, unknown>, path),
      );
    } else if (prev !== next) {
      diff[path] = { from: prev ?? null, to: next ?? null };
    }
  }
  return diff;
}

export function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export function buildCompanySeedCreateData(
  actorUserId?: string | null,
): Prisma.SystemSettingUncheckedCreateInput {
  const d = COMPANY_SETTING_DEFAULTS;
  return {
    scopeType: ScopeType.COMPANY,
    branchId: null,
    version: 1,
    overrideStacking: false,
    stackingEnabled: d.stacking.enabled,
    stackingOwnerMode: d.stacking.ownerMode as StackingOwnerMode,
    stackingMaxTiers: d.stacking.maxTiers,
    stackingLiftClearanceMm: d.stacking.liftClearanceMm,
    overrideOptimization: false,
    defaultSearchBudgetSeconds: d.optimization.defaultSearchBudgetSeconds,
    maxOptimizationTimeSeconds: d.optimization.maxTimeSeconds,
    unassignedOrderPenaltyVnd: BigInt(Math.round(d.optimization.unassignedOrderPenaltyVnd)),
    maxRoutesPerDay: d.optimization.maxRoutesPerDay,
    demoAllowOverride: d.optimization.demoAllowOverride,
    overrideCostPenalty: false,
    fuelPricePerLiter: d.costPenalty.fuelPricePerLiter,
    monthlyWorkingMinutes: d.costPenalty.monthlyWorkingMinutes,
    cargoHoldingCostVndPerTonHour: d.costPenalty.cargoHoldingCostVndPerTonHour,
    workStartTime: d.costPenalty.workStartTime,
    workEndTime: d.costPenalty.workEndTime,
    deliveryGraceDays: d.costPenalty.deliveryGraceDays,
    lateDeliveryPenaltyMode: d.costPenalty.lateDeliveryPenaltyMode,
    lateDeliveryPenaltyValue: d.costPenalty.lateDeliveryPenaltyValue,
    updatedById: actorUserId ?? null,
  };
}
