import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LateDeliveryPenaltyMode,
  Prisma,
  ScopeType,
  StackingOwnerMode,
  SystemSetting,
} from '@prisma/client';
import { Principal, assertPermission } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import {
  ResetBranchOverridesDto,
  SettingAuditLogsQueryDto,
  SettingsGroupKey,
  UpdateBranchSettingsDto,
  UpdateCompanySettingsDto,
} from './dto/settings.dto';
import {
  assertSettingsInvariants,
  buildBranchScopedResponse,
  buildCompanyEffective,
  buildCompanySeedCreateData,
  computeSettingsDiff,
  extractCompanySettingValues,
  isPrismaUniqueViolation,
  toResolvedStackingPolicy,
} from './settings.helpers';
import {
  CostPenaltySettings,
  EffectiveSettings,
  OptimizationSettings,
  ResolvedStackingPolicy,
  ScopedSettingsResponse,
  StackingSettings,
} from './settings.types';

type PrismaDbClient = PrismaService | Prisma.TransactionClient;

const SETTING_AUDIT_ENTITY = 'SYSTEM_SETTING';

export interface BranchCostSyncInput {
  fuelPricePerLiter: unknown;
  monthlyWorkingMinutes: number;
  cargoHoldingCostVndPerTonHour: unknown;
  workStartTime: string;
  workEndTime: string;
  deliveryGraceDays: number;
  lateDeliveryPenaltyMode: LateDeliveryPenaltyMode;
  lateDeliveryPenaltyValue: unknown;
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCompanyScoped(user: Principal): Promise<ScopedSettingsResponse> {
    assertPermission(user, 'settings.read');
    const companyRow = await this.prisma.systemSetting.findFirst({
      where: { scopeType: ScopeType.COMPANY },
    });
    const company = extractCompanySettingValues(companyRow);
    return {
      company,
      branch: null,
      effective: buildCompanyEffective(companyRow),
    };
  }

  async getBranchScoped(branchId: string, user: Principal): Promise<ScopedSettingsResponse> {
    assertPermission(user, 'settings.read', branchId);
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, code: true, name: true },
    });
    if (!branch) {
      throw new NotFoundException('Chi nhánh không tồn tại');
    }
    const [companyRow, branchRow] = await Promise.all([
      this.prisma.systemSetting.findFirst({ where: { scopeType: ScopeType.COMPANY } }),
      this.prisma.systemSetting.findUnique({ where: { branchId } }),
    ]);
    return buildBranchScopedResponse(companyRow, branchRow, branch);
  }

  async getEffectiveForUser(user: Principal, branchId?: string): Promise<EffectiveSettings> {
    assertPermission(user, 'settings.read', branchId ?? undefined);
    return this.resolveEffectiveSettings(branchId ?? null);
  }

  async resolveEffectiveSettings(
    branchId?: string | null,
    db: PrismaDbClient = this.prisma,
  ): Promise<EffectiveSettings> {
    const companyRow = await db.systemSetting.findFirst({
      where: { scopeType: ScopeType.COMPANY },
    });
    if (!branchId) {
      return buildCompanyEffective(companyRow);
    }
    const [branch, branchRow] = await Promise.all([
      db.branch.findUnique({
        where: { id: branchId },
        select: { id: true, code: true, name: true },
      }),
      db.systemSetting.findUnique({
        where: { branchId },
      }),
    ]);
    if (!branch) {
      throw new NotFoundException('Chi nhánh không tồn tại');
    }
    return buildBranchScopedResponse(companyRow, branchRow, branch).effective;
  }

  async resolveStackingPolicy(
    branchId?: string | null,
    db: PrismaDbClient = this.prisma,
  ): Promise<{
    enabled: boolean;
    policy: ResolvedStackingPolicy | undefined;
    ownerMode: StackingOwnerMode;
    maxTiers: number;
    liftClearanceMm: number;
    maxTopLoadPercent: number;
    policyVersion: string;
  }> {
    const effective = await this.resolveEffectiveSettings(branchId, db);
    return {
      enabled: effective.stacking.enabled,
      policy: toResolvedStackingPolicy(effective.stacking),
      ownerMode: effective.stacking.ownerMode,
      maxTiers: effective.stacking.maxTiers,
      liftClearanceMm: effective.stacking.liftClearanceMm,
      maxTopLoadPercent: effective.stacking.maxTopLoadPercent,
      policyVersion: effective.policyVersion,
    };
  }

  async updateCompanySettings(
    dto: UpdateCompanySettingsDto,
    user: Principal,
  ): Promise<ScopedSettingsResponse> {
    assertPermission(user, 'settings.manage');

    try {
      return await this.prisma.$transaction(async (tx) => {
        let companyRow = await tx.systemSetting.findFirst({
          where: { scopeType: ScopeType.COMPANY },
        });
        if (!companyRow) {
          if (dto.expectedVersion !== 1) {
            throw new ConflictException(
              'Cấu hình chung đã thay đổi ở phiên bản mới hơn, vui lòng tải lại trước khi lưu',
            );
          }
          companyRow = await tx.systemSetting.create({
            data: buildCompanySeedCreateData(user.id),
          });
        }
        if (companyRow.version !== dto.expectedVersion) {
          throw new ConflictException(
            'Cấu hình công ty đã được cập nhật bởi người khác, vui lòng tải lại trang',
          );
        }

        const before = extractCompanySettingValues(companyRow);
        const nextStacking: StackingSettings = {
          ...before.stacking,
          ...(dto.stacking ?? {}),
        };
        const nextOptimization: OptimizationSettings = {
          ...before.optimization,
          ...(dto.optimization ?? {}),
        };
        const nextCostPenalty: CostPenaltySettings = {
          ...before.costPenalty,
          ...(dto.costPenalty ?? {}),
        };

        assertSettingsInvariants({
          optimization: nextOptimization,
          costPenalty: nextCostPenalty,
        });

        const updatedCount = await tx.systemSetting.updateMany({
          where: { id: companyRow.id, version: dto.expectedVersion },
          data: {
            version: { increment: 1 },
            stackingEnabled: nextStacking.enabled,
            stackingOwnerMode: nextStacking.ownerMode,
            stackingMaxTiers: nextStacking.maxTiers,
            stackingLiftClearanceMm: nextStacking.liftClearanceMm,
            stackingMaxTopLoadPercent: nextStacking.maxTopLoadPercent,
            defaultSearchBudgetSeconds: nextOptimization.defaultSearchBudgetSeconds,
            maxOptimizationTimeSeconds: nextOptimization.maxTimeSeconds,
            hybridSeedCount: nextOptimization.hybridSeedCount,
            earlyStopPatience: nextOptimization.earlyStopPatience,
            unassignedOrderPenaltyVnd: BigInt(Math.round(nextOptimization.unassignedOrderPenaltyVnd)),
            maxRoutesPerDay: nextOptimization.maxRoutesPerDay,
            demoAllowOverride: nextOptimization.demoAllowOverride,
            fuelPricePerLiter: nextCostPenalty.fuelPricePerLiter,
            monthlyWorkingMinutes: nextCostPenalty.monthlyWorkingMinutes,
            cargoHoldingCostVndPerTonHour: nextCostPenalty.cargoHoldingCostVndPerTonHour,
            workStartTime: nextCostPenalty.workStartTime,
            workEndTime: nextCostPenalty.workEndTime,
            deliveryGraceDays: nextCostPenalty.deliveryGraceDays,
            lateDeliveryPenaltyMode: nextCostPenalty.lateDeliveryPenaltyMode,
            lateDeliveryPenaltyValue: nextCostPenalty.lateDeliveryPenaltyValue,
            updatedById: user.id,
          },
        });
        if (updatedCount.count !== 1) {
          throw new ConflictException(
            'Cấu hình công ty đã được cập nhật bởi người khác, vui lòng tải lại trang',
          );
        }

        if (dto.costPenalty) {
          await this.syncNonOverriddenBranchesCost(tx, nextCostPenalty);
        }

        const freshCompanyRow = await tx.systemSetting.findUniqueOrThrow({
          where: { id: companyRow.id },
        });
        const after = extractCompanySettingValues(freshCompanyRow);
        const changes = computeSettingsDiff(
          {
            stacking: before.stacking,
            optimization: before.optimization,
            costPenalty: before.costPenalty,
          },
          {
            stacking: after.stacking,
            optimization: after.optimization,
            costPenalty: after.costPenalty,
          },
        );

        await tx.auditLog.create({
          data: {
            entityType: SETTING_AUDIT_ENTITY,
            entityId: 'COMPANY',
            action: 'UPDATE_COMPANY_SETTINGS',
            performedBy: user.username,
            actorUserId: user.id,
            details: JSON.stringify({
              scopeType: 'COMPANY',
              branchId: null,
              settingsId: freshCompanyRow.id,
            }),
            changeSummary: {
              versionFrom: before.version,
              versionTo: after.version,
              changes,
            } as Prisma.InputJsonValue,
          },
        });

        return {
          company: after,
          branch: null,
          effective: buildCompanyEffective(freshCompanyRow),
        };
      });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          'Cấu hình công ty đang được cập nhật đồng thời, vui lòng tải lại trang',
        );
      }
      throw error;
    }
  }

  async updateBranchSettings(
    branchId: string,
    dto: UpdateBranchSettingsDto,
    user: Principal,
  ): Promise<ScopedSettingsResponse> {
    assertPermission(user, 'settings.manage', branchId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findUnique({
          where: { id: branchId },
          select: { id: true, code: true, name: true },
        });
        if (!branch) {
          throw new NotFoundException('Chi nhánh không tồn tại');
        }

        const [companyRow, existingBranchRow] = await Promise.all([
          tx.systemSetting.findFirst({ where: { scopeType: ScopeType.COMPANY } }),
          tx.systemSetting.findUnique({ where: { branchId } }),
        ]);

        const currentVersion = existingBranchRow?.version ?? 0;
        if (currentVersion !== dto.expectedVersion) {
          throw new ConflictException(
            'Cấu hình chi nhánh đã được cập nhật bởi người khác, vui lòng tải lại trang',
          );
        }

        const beforeScoped = buildBranchScopedResponse(companyRow, existingBranchRow, branch);
        const beforeEff = beforeScoped.effective;

        const nextOverrideStacking =
          dto.overrideStacking ?? existingBranchRow?.overrideStacking ?? false;
        const nextOverrideOptimization =
          dto.overrideOptimization ?? existingBranchRow?.overrideOptimization ?? false;
        const nextOverrideCostPenalty =
          dto.overrideCostPenalty ?? existingBranchRow?.overrideCostPenalty ?? false;

        const nextStacking: StackingSettings = {
          ...beforeEff.stacking,
          ...(dto.stacking ?? {}),
        };
        const nextOptimization: OptimizationSettings = {
          ...beforeEff.optimization,
          ...(dto.optimization ?? {}),
        };
        const nextCostPenalty: CostPenaltySettings = {
          ...beforeEff.costPenalty,
          ...(dto.costPenalty ?? {}),
        };

        assertSettingsInvariants({
          optimization: nextOptimization,
          costPenalty: nextCostPenalty,
        });

        const companyValues = extractCompanySettingValues(companyRow);
        const dataPayload = {
          overrideStacking: nextOverrideStacking,
          stackingEnabled: nextOverrideStacking ? nextStacking.enabled : null,
          stackingOwnerMode: nextOverrideStacking ? nextStacking.ownerMode : null,
          stackingMaxTiers: nextOverrideStacking ? nextStacking.maxTiers : null,
          stackingLiftClearanceMm: nextOverrideStacking ? nextStacking.liftClearanceMm : null,
          stackingMaxTopLoadPercent: nextOverrideStacking ? nextStacking.maxTopLoadPercent : null,

          overrideOptimization: nextOverrideOptimization,
          defaultSearchBudgetSeconds: nextOverrideOptimization
            ? nextOptimization.defaultSearchBudgetSeconds
            : null,
          maxOptimizationTimeSeconds: nextOverrideOptimization
            ? nextOptimization.maxTimeSeconds
            : null,
          unassignedOrderPenaltyVnd: nextOverrideOptimization
            ? BigInt(Math.round(nextOptimization.unassignedOrderPenaltyVnd))
            : null,
          maxRoutesPerDay: nextOverrideOptimization ? nextOptimization.maxRoutesPerDay : null,
          hybridSeedCount: nextOverrideOptimization ? nextOptimization.hybridSeedCount : null,
          earlyStopPatience: nextOverrideOptimization ? nextOptimization.earlyStopPatience : null,
          demoAllowOverride: nextOverrideOptimization ? nextOptimization.demoAllowOverride : null,

          overrideCostPenalty: nextOverrideCostPenalty,
          fuelPricePerLiter: nextOverrideCostPenalty ? nextCostPenalty.fuelPricePerLiter : null,
          monthlyWorkingMinutes: nextOverrideCostPenalty
            ? nextCostPenalty.monthlyWorkingMinutes
            : null,
          cargoHoldingCostVndPerTonHour: nextOverrideCostPenalty
            ? nextCostPenalty.cargoHoldingCostVndPerTonHour
            : null,
          workStartTime: nextOverrideCostPenalty ? nextCostPenalty.workStartTime : null,
          workEndTime: nextOverrideCostPenalty ? nextCostPenalty.workEndTime : null,
          deliveryGraceDays: nextOverrideCostPenalty ? nextCostPenalty.deliveryGraceDays : null,
          lateDeliveryPenaltyMode: nextOverrideCostPenalty
            ? nextCostPenalty.lateDeliveryPenaltyMode
            : null,
          lateDeliveryPenaltyValue: nextOverrideCostPenalty
            ? nextCostPenalty.lateDeliveryPenaltyValue
            : null,
          updatedById: user.id,
        };

        let savedBranchRow: SystemSetting;
        if (!existingBranchRow) {
          savedBranchRow = await tx.systemSetting.create({
            data: {
              scopeType: ScopeType.BRANCH,
              branchId,
              version: 1,
              ...dataPayload,
            },
          });
        } else {
          const updated = await tx.systemSetting.updateMany({
            where: { id: existingBranchRow.id, version: dto.expectedVersion },
            data: {
              version: { increment: 1 },
              ...dataPayload,
            },
          });
          if (updated.count !== 1) {
            throw new ConflictException(
              'Cấu hình chi nhánh đã được cập nhật bởi người khác, vui lòng tải lại trang',
            );
          }
          savedBranchRow = await tx.systemSetting.findUniqueOrThrow({
            where: { id: existingBranchRow.id },
          });
        }

        const syncedCost = nextOverrideCostPenalty ? nextCostPenalty : companyValues.costPenalty;
        await tx.branch.update({
          where: { id: branchId },
          data: {
            fuelPricePerLiter: syncedCost.fuelPricePerLiter,
            monthlyWorkingMinutes: syncedCost.monthlyWorkingMinutes,
            cargoHoldingCostVndPerTonHour: syncedCost.cargoHoldingCostVndPerTonHour,
            workStartTime: syncedCost.workStartTime,
            workEndTime: syncedCost.workEndTime,
            deliveryGraceDays: syncedCost.deliveryGraceDays,
            lateDeliveryPenaltyMode: syncedCost.lateDeliveryPenaltyMode,
            lateDeliveryPenaltyValue: syncedCost.lateDeliveryPenaltyValue,
          },
        });

        const afterScoped = buildBranchScopedResponse(companyRow, savedBranchRow, branch);
        const changes = computeSettingsDiff(
          {
            overrides: beforeEff.overrides,
            stacking: beforeEff.stacking,
            optimization: beforeEff.optimization,
            costPenalty: beforeEff.costPenalty,
          },
          {
            overrides: afterScoped.effective.overrides,
            stacking: afterScoped.effective.stacking,
            optimization: afterScoped.effective.optimization,
            costPenalty: afterScoped.effective.costPenalty,
          },
        );

        await tx.auditLog.create({
          data: {
            entityType: SETTING_AUDIT_ENTITY,
            entityId: branchId,
            action: 'UPDATE_BRANCH_SETTINGS',
            performedBy: user.username,
            actorUserId: user.id,
            details: JSON.stringify({
              scopeType: 'BRANCH',
              branchId: branch.id,
              branchCode: branch.code,
              branchName: branch.name,
              settingsId: savedBranchRow.id,
            }),
            changeSummary: {
              versionFrom: currentVersion,
              versionTo: savedBranchRow.version,
              changes,
            } as Prisma.InputJsonValue,
          },
        });

        return afterScoped;
      });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          'Cấu hình chi nhánh đang được cập nhật đồng thời, vui lòng tải lại trang',
        );
      }
      throw error;
    }
  }

  async resetBranchOverrides(
    branchId: string,
    dto: ResetBranchOverridesDto,
    user: Principal,
  ): Promise<ScopedSettingsResponse> {
    assertPermission(user, 'settings.manage', branchId);
    const groups: SettingsGroupKey[] =
      dto.groups && dto.groups.length > 0
        ? dto.groups
        : ['stacking', 'optimization', 'costPenalty'];

    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, code: true, name: true },
      });
      if (!branch) {
        throw new NotFoundException('Chi nhánh không tồn tại');
      }

      const [companyRow, existingBranchRow] = await Promise.all([
        tx.systemSetting.findFirst({ where: { scopeType: ScopeType.COMPANY } }),
        tx.systemSetting.findUnique({ where: { branchId } }),
      ]);

      const currentVersion = existingBranchRow?.version ?? 0;
      if (currentVersion !== dto.expectedVersion) {
        throw new ConflictException(
          'Cấu hình chi nhánh đã được cập nhật bởi người khác, vui lòng tải lại trang',
        );
      }

      if (!existingBranchRow) {
        return buildBranchScopedResponse(companyRow, null, branch);
      }

      const beforeScoped = buildBranchScopedResponse(companyRow, existingBranchRow, branch);
      const resetStacking = groups.includes('stacking');
      const resetOptimization = groups.includes('optimization');
      const resetCostPenalty = groups.includes('costPenalty');

      const updateData: Prisma.SystemSettingUncheckedUpdateManyInput = {
        version: { increment: 1 },
        updatedById: user.id,
        ...(resetStacking
          ? {
              overrideStacking: false,
              stackingEnabled: null,
              stackingOwnerMode: null,
              stackingMaxTiers: null,
              stackingLiftClearanceMm: null,
              stackingMaxTopLoadPercent: null,
            }
          : {}),
        ...(resetOptimization
          ? {
              overrideOptimization: false,
              defaultSearchBudgetSeconds: null,
              maxOptimizationTimeSeconds: null,
              hybridSeedCount: null,
              earlyStopPatience: null,
              unassignedOrderPenaltyVnd: null,
              maxRoutesPerDay: null,
              demoAllowOverride: null,
            }
          : {}),
        ...(resetCostPenalty
          ? {
              overrideCostPenalty: false,
              fuelPricePerLiter: null,
              monthlyWorkingMinutes: null,
              cargoHoldingCostVndPerTonHour: null,
              workStartTime: null,
              workEndTime: null,
              deliveryGraceDays: null,
              lateDeliveryPenaltyMode: null,
              lateDeliveryPenaltyValue: null,
            }
          : {}),
      };

      const updated = await tx.systemSetting.updateMany({
        where: { id: existingBranchRow.id, version: dto.expectedVersion },
        data: updateData,
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'Cấu hình chi nhánh đã được cập nhật bởi người khác, vui lòng tải lại trang',
        );
      }

      const companyValues = extractCompanySettingValues(companyRow);
      if (resetCostPenalty) {
        await tx.branch.update({
          where: { id: branchId },
          data: {
            fuelPricePerLiter: companyValues.costPenalty.fuelPricePerLiter,
            monthlyWorkingMinutes: companyValues.costPenalty.monthlyWorkingMinutes,
            cargoHoldingCostVndPerTonHour: companyValues.costPenalty.cargoHoldingCostVndPerTonHour,
            workStartTime: companyValues.costPenalty.workStartTime,
            workEndTime: companyValues.costPenalty.workEndTime,
            deliveryGraceDays: companyValues.costPenalty.deliveryGraceDays,
            lateDeliveryPenaltyMode: companyValues.costPenalty.lateDeliveryPenaltyMode,
            lateDeliveryPenaltyValue: companyValues.costPenalty.lateDeliveryPenaltyValue,
          },
        });
      }

      const freshBranchRow = await tx.systemSetting.findUniqueOrThrow({
        where: { id: existingBranchRow.id },
      });
      const afterScoped = buildBranchScopedResponse(companyRow, freshBranchRow, branch);
      const changes = computeSettingsDiff(
        {
          overrides: beforeScoped.effective.overrides,
          stacking: beforeScoped.effective.stacking,
          optimization: beforeScoped.effective.optimization,
          costPenalty: beforeScoped.effective.costPenalty,
        },
        {
          overrides: afterScoped.effective.overrides,
          stacking: afterScoped.effective.stacking,
          optimization: afterScoped.effective.optimization,
          costPenalty: afterScoped.effective.costPenalty,
        },
      );

      await tx.auditLog.create({
        data: {
          entityType: SETTING_AUDIT_ENTITY,
          entityId: branchId,
          action: 'RESET_BRANCH_OVERRIDES',
          performedBy: user.username,
          actorUserId: user.id,
          details: JSON.stringify({
            scopeType: 'BRANCH',
            branchId: branch.id,
            branchCode: branch.code,
            branchName: branch.name,
            resetGroups: groups,
            settingsId: freshBranchRow.id,
          }),
          changeSummary: {
            versionFrom: currentVersion,
            versionTo: freshBranchRow.version,
            changes,
          } as Prisma.InputJsonValue,
        },
      });

      return afterScoped;
    });
  }

  async syncBranchCostOverrideFromBranchUpdate(
    tx: Prisma.TransactionClient,
    branchId: string,
    branchData: BranchCostSyncInput,
    actor: Pick<Principal, 'id' | 'username'>,
  ): Promise<void> {
    const [branch, existingBranchRow] = await Promise.all([
      tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true, code: true, name: true },
      }),
      tx.systemSetting.findUnique({ where: { branchId } }),
    ]);

    const fuelPricePerLiter = Number(branchData.fuelPricePerLiter);
    const cargoHoldingCostVndPerTonHour = Number(branchData.cargoHoldingCostVndPerTonHour);
    const lateDeliveryPenaltyValue = Number(branchData.lateDeliveryPenaltyValue);
    const currentVersion = existingBranchRow?.version ?? 0;

    let savedRow: SystemSetting;
    if (!existingBranchRow) {
      savedRow = await tx.systemSetting.create({
        data: {
          scopeType: ScopeType.BRANCH,
          branchId,
          version: 1,
          overrideCostPenalty: true,
          fuelPricePerLiter,
          monthlyWorkingMinutes: branchData.monthlyWorkingMinutes,
          cargoHoldingCostVndPerTonHour,
          workStartTime: branchData.workStartTime,
          workEndTime: branchData.workEndTime,
          deliveryGraceDays: branchData.deliveryGraceDays,
          lateDeliveryPenaltyMode: branchData.lateDeliveryPenaltyMode,
          lateDeliveryPenaltyValue,
          updatedById: actor.id,
        },
      });
    } else {
      savedRow = await tx.systemSetting.update({
        where: { id: existingBranchRow.id },
        data: {
          version: { increment: 1 },
          overrideCostPenalty: true,
          fuelPricePerLiter,
          monthlyWorkingMinutes: branchData.monthlyWorkingMinutes,
          cargoHoldingCostVndPerTonHour,
          workStartTime: branchData.workStartTime,
          workEndTime: branchData.workEndTime,
          deliveryGraceDays: branchData.deliveryGraceDays,
          lateDeliveryPenaltyMode: branchData.lateDeliveryPenaltyMode,
          lateDeliveryPenaltyValue,
          updatedById: actor.id,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        entityType: SETTING_AUDIT_ENTITY,
        entityId: branchId,
        action: 'SYNC_BRANCH_COST_SETTINGS',
        performedBy: actor.username,
        actorUserId: actor.id,
        details: JSON.stringify({
          scopeType: 'BRANCH',
          branchId,
          branchCode: branch?.code ?? null,
          branchName: branch?.name ?? null,
          settingsId: savedRow.id,
        }),
        changeSummary: {
          versionFrom: currentVersion,
          versionTo: savedRow.version,
          changes: {
            'overrides.costPenalty': {
              from: existingBranchRow?.overrideCostPenalty ?? false,
              to: true,
            },
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  async getAuditLogs(user: Principal, query: SettingAuditLogsQueryDto) {
    assertPermission(user, 'settings.read', query.branchId ?? undefined);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const isCompanyAdmin = user.grants.some(
      (grant) =>
        grant.role === 'ADMIN' &&
        grant.scopeType === 'COMPANY' &&
        grant.branchId === null &&
        grant.permissions.includes('settings.read'),
    );

    let entityFilter: Prisma.StringFilter | string | undefined;
    if (query.branchId) {
      entityFilter = query.branchId;
    } else if (!isCompanyAdmin) {
      const allowedBranchIds = user.grants
        .filter(
          (grant) =>
            grant.scopeType === 'BRANCH' &&
            Boolean(grant.branchId) &&
            grant.permissions.includes('settings.read'),
        )
        .map((grant) => grant.branchId as string);
      entityFilter = { in: ['COMPANY', ...allowedBranchIds] };
    }

    const where: Prisma.AuditLogWhereInput = {
      entityType: SETTING_AUDIT_ENTITY,
      ...(entityFilter ? { entityId: entityFilter } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          actorUser: {
            select: { id: true, username: true, fullName: true },
          },
        },
      }),
    ]);

    return {
      items: items.map((row) => {
        let parsedDetails: Record<string, unknown> | null = null;
        if (row.details) {
          try {
            parsedDetails = JSON.parse(row.details) as Record<string, unknown>;
          } catch {
            parsedDetails = null;
          }
        }
        return {
          id: row.id,
          entityId: row.entityId,
          action: row.action,
          performedBy: row.performedBy,
          actorFullName: row.actorUser?.fullName ?? null,
          timestamp: row.timestamp.toISOString(),
          details: parsedDetails,
          changeSummary: row.changeSummary ?? null,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  private async syncNonOverriddenBranchesCost(
    tx: Prisma.TransactionClient,
    cost: CostPenaltySettings,
  ): Promise<void> {
    const overriddenRows = await tx.systemSetting.findMany({
      where: { scopeType: ScopeType.BRANCH, overrideCostPenalty: true },
      select: { branchId: true },
    });
    const overriddenIds = overriddenRows
      .map((row) => row.branchId)
      .filter((id): id is string => Boolean(id));

    await tx.branch.updateMany({
      where: overriddenIds.length > 0 ? { id: { notIn: overriddenIds } } : {},
      data: {
        fuelPricePerLiter: cost.fuelPricePerLiter,
        monthlyWorkingMinutes: cost.monthlyWorkingMinutes,
        cargoHoldingCostVndPerTonHour: cost.cargoHoldingCostVndPerTonHour,
        workStartTime: cost.workStartTime,
        workEndTime: cost.workEndTime,
        deliveryGraceDays: cost.deliveryGraceDays,
        lateDeliveryPenaltyMode: cost.lateDeliveryPenaltyMode,
        lateDeliveryPenaltyValue: cost.lateDeliveryPenaltyValue,
      },
    });
  }
}
