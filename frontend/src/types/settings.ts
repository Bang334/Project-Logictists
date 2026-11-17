export type SettingSource = 'COMPANY' | 'BRANCH';

export type StackingOwnerMode = 'SAME_CUSTOMER' | 'ANY_CUSTOMER';

export type LateDeliveryPenaltyMode =
  | 'NONE'
  | 'FIXED_PER_DAY'
  | 'PERCENT_ORDER_VALUE_PER_DAY';

export type SettingsGroupKey = 'stacking' | 'optimization' | 'costPenalty';

export interface StackingSettings {
  enabled: boolean;
  ownerMode: StackingOwnerMode;
  maxTiers: number;
  liftClearanceMm: number;
}

export interface OptimizationSettings {
  defaultSearchBudgetSeconds: number;
  maxTimeSeconds: number;
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

export interface UpdateCompanySettingsPayload {
  expectedVersion: number;
  stacking?: Partial<StackingSettings>;
  optimization?: Partial<OptimizationSettings>;
  costPenalty?: Partial<CostPenaltySettings>;
}

export interface UpdateBranchSettingsPayload {
  expectedVersion: number;
  overrideStacking?: boolean;
  stacking?: Partial<StackingSettings>;
  overrideOptimization?: boolean;
  optimization?: Partial<OptimizationSettings>;
  overrideCostPenalty?: boolean;
  costPenalty?: Partial<CostPenaltySettings>;
}

export interface ResetBranchOverridesPayload {
  expectedVersion: number;
  groups?: SettingsGroupKey[];
}

export interface SettingAuditLogItem {
  id: string;
  entityId: string;
  action: string;
  performedBy: string;
  actorFullName: string | null;
  timestamp: string;
  details: {
    scopeType?: SettingSource;
    branchId?: string | null;
    branchCode?: string | null;
    branchName?: string | null;
    resetGroups?: SettingsGroupKey[];
  } | null;
  changeSummary: {
    versionFrom?: number;
    versionTo?: number;
    changes?: Record<string, { from: unknown; to: unknown }>;
  } | null;
}

export interface SettingAuditLogsResponse {
  items: SettingAuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const STACKING_OWNER_MODE_LABELS: Record<StackingOwnerMode, string> = {
  SAME_CUSTOMER: 'Chỉ kiện cùng khách hàng',
  ANY_CUSTOMER: 'Cho phép kiện khác khách hàng',
};

export const LATE_PENALTY_MODE_LABELS: Record<LateDeliveryPenaltyMode, string> = {
  NONE: 'Không phạt trễ',
  FIXED_PER_DAY: 'Phạt cố định / ngày trễ (VNĐ)',
  PERCENT_ORDER_VALUE_PER_DAY: 'Phạt % giá trị đơn / ngày trễ',
};

export const SETTING_AUDIT_ACTION_LABELS: Record<string, string> = {
  UPDATE_COMPANY_SETTINGS: 'Cập nhật mặc định công ty',
  UPDATE_BRANCH_SETTINGS: 'Cập nhật cấu hình chi nhánh',
  RESET_BRANCH_OVERRIDES: 'Khôi phục kế thừa công ty',
  SYNC_BRANCH_COST_SETTINGS: 'Đồng bộ từ sửa chi nhánh',
};

export const SETTING_FIELD_LABELS: Record<string, string> = {
  'overrides.stacking': 'Ghi đè nhóm Xếp chồng',
  'overrides.optimization': 'Ghi đè nhóm Tối ưu',
  'overrides.costPenalty': 'Ghi đè nhóm Chi phí & Phạt',
  'stacking.enabled': 'Bật xếp chồng hàng hóa',
  'stacking.ownerMode': 'Quy tắc chủ hàng khi xếp chồng',
  'stacking.maxTiers': 'Số tầng chồng tối đa',
  'stacking.liftClearanceMm': 'Khoảng hở nâng kiện (mm)',
  'optimization.defaultSearchBudgetSeconds': 'Ngân sách tìm kiếm mặc định (giây)',
  'optimization.maxTimeSeconds': 'Trần thời gian tối đa (giây)',
  'optimization.unassignedOrderPenaltyVnd': 'Phạt đơn không xếp được (VNĐ)',
  'optimization.maxRoutesPerDay': 'Giới hạn số chuyến / ngày',
  'optimization.demoAllowOverride': 'Cho phép ghi đè trong màn hình Demo',
  'costPenalty.fuelPricePerLiter': 'Giá nhiên liệu (VNĐ/lít)',
  'costPenalty.monthlyWorkingMinutes': 'Số phút làm việc / tháng',
  'costPenalty.cargoHoldingCostVndPerTonHour': 'Phí lưu kho trên xe (VNĐ/tấn·giờ)',
  'costPenalty.workStartTime': 'Giờ bắt đầu ca',
  'costPenalty.workEndTime': 'Giờ kết thúc ca',
  'costPenalty.deliveryGraceDays': 'Số ngày ân hạn giao hàng',
  'costPenalty.lateDeliveryPenaltyMode': 'Hình thức phạt giao trễ',
  'costPenalty.lateDeliveryPenaltyValue': 'Giá trị phạt trễ',
};
