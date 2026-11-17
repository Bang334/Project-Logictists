import React from 'react';
import {
  Alert,
  Card,
  Checkbox,
  Col,
  Divider,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  CostPenaltySettings,
  LATE_PENALTY_MODE_LABELS,
  LateDeliveryPenaltyMode,
  OptimizationSettings,
  STACKING_OWNER_MODE_LABELS,
  SettingsGroupKey,
  StackingOwnerMode,
  StackingSettings,
} from '../../types/settings';

const { Text } = Typography;

export interface SettingsDraftState {
  overrides: {
    stacking: boolean;
    optimization: boolean;
    costPenalty: boolean;
  };
  stacking: StackingSettings;
  optimization: OptimizationSettings;
  costPenalty: CostPenaltySettings;
}

interface SettingsGroupsFormProps {
  scopeType: 'COMPANY' | 'BRANCH';
  canManage: boolean;
  loading: boolean;
  companyDefaults: {
    stacking: StackingSettings;
    optimization: OptimizationSettings;
    costPenalty: CostPenaltySettings;
  };
  draft: SettingsDraftState;
  onChangeDraft: (updater: (prev: SettingsDraftState) => SettingsDraftState) => void;
  onToggleOverride?: (group: SettingsGroupKey, checked: boolean) => void;
}

function renderScopeBadge(scopeType: 'COMPANY' | 'BRANCH', isOverridden: boolean) {
  if (scopeType === 'COMPANY') {
    return <Tag color="geekblue">Mặc định toàn công ty</Tag>;
  }
  return isOverridden ? (
    <Tag color="gold">Đang ghi đè riêng chi nhánh</Tag>
  ) : (
    <Tag color="blue">Kế thừa mặc định công ty</Tag>
  );
}

export const SettingsGroupsForm: React.FC<SettingsGroupsFormProps> = ({
  scopeType,
  canManage,
  loading,
  companyDefaults,
  draft,
  onChangeDraft,
  onToggleOverride,
}) => {
  const isStackingEditable =
    canManage && !loading && (scopeType === 'COMPANY' || draft.overrides.stacking);
  const isOptimizationEditable =
    canManage && !loading && (scopeType === 'COMPANY' || draft.overrides.optimization);
  const isCostEditable =
    canManage && !loading && (scopeType === 'COMPANY' || draft.overrides.costPenalty);

  const displayedStacking =
    scopeType === 'BRANCH' && !draft.overrides.stacking
      ? companyDefaults.stacking
      : draft.stacking;
  const displayedOptimization =
    scopeType === 'BRANCH' && !draft.overrides.optimization
      ? companyDefaults.optimization
      : draft.optimization;
  const displayedCostPenalty =
    scopeType === 'BRANCH' && !draft.overrides.costPenalty
      ? companyDefaults.costPenalty
      : draft.costPenalty;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space wrap>
            <span>1. Quy tắc xếp chồng hàng hóa</span>
            {renderScopeBadge(scopeType, draft.overrides.stacking)}
          </Space>
        }
        extra={
          scopeType === 'BRANCH' ? (
            <Space>
              <Text type="secondary">Ghi đè riêng</Text>
              <Switch
                aria-label="Ghi đè cấu hình xếp chồng tại chi nhánh"
                checked={draft.overrides.stacking}
                disabled={!canManage || loading}
                onChange={(checked) => onToggleOverride?.('stacking', checked)}
              />
            </Space>
          ) : null
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Ràng buộc vật lý & lối dỡ hàng 3D luôn được bảo vệ tự động"
          description="Khi bật xếp chồng, optimizer vẫn bắt buộc kiểm tra cùng chuẩn hàng tiêu chuẩn, cho phép đặt tầng trên, tải đè dưới 30% giới hạn, khớp diện tích đáy và không chắn lối dỡ các kiện khác."
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text strong>Cho phép xếp chồng hàng hóa</Text>
              <Space>
                <Switch
                  aria-label="Bật xếp chồng hàng hóa"
                  checked={displayedStacking.enabled}
                  disabled={!isStackingEditable}
                  onChange={(checked) =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      stacking: { ...prev.stacking, enabled: checked },
                    }))
                  }
                />
                <Text type="secondary">
                  {displayedStacking.enabled
                    ? 'Đang bật xếp nhiều tầng trong điều phối thực & tối ưu'
                    : 'Đang tắt (chỉ xếp 1 lớp trên sàn xe)'}
                </Text>
              </Space>
            </Space>
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Quy tắc chủ hàng khi xếp chồng
            </Text>
            <Select<StackingOwnerMode>
              aria-label="Quy tắc chủ hàng khi xếp chồng"
              value={displayedStacking.ownerMode}
              disabled={!isStackingEditable || !displayedStacking.enabled}
              style={{ width: '100%' }}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  stacking: { ...prev.stacking, ownerMode: value },
                }))
              }
              options={[
                { value: 'SAME_CUSTOMER', label: STACKING_OWNER_MODE_LABELS.SAME_CUSTOMER },
                { value: 'ANY_CUSTOMER', label: STACKING_OWNER_MODE_LABELS.ANY_CUSTOMER },
              ]}
            />
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Số tầng chồng tối đa (2 - 20 tầng)
            </Text>
            <InputNumber
              aria-label="Số tầng chồng tối đa"
              min={2}
              max={20}
              precision={0}
              style={{ width: '100%' }}
              value={displayedStacking.maxTiers}
              disabled={!isStackingEditable || !displayedStacking.enabled}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  stacking: { ...prev.stacking, maxTiers: value ?? 2 },
                }))
              }
            />
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Khoảng hở nâng kiện qua cửa (mm)
            </Text>
            <InputNumber
              aria-label="Khoảng hở nâng kiện qua cửa"
              min={1}
              max={5000}
              precision={0}
              addonAfter="mm"
              style={{ width: '100%' }}
              value={displayedStacking.liftClearanceMm}
              disabled={!isStackingEditable || !displayedStacking.enabled}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  stacking: { ...prev.stacking, liftClearanceMm: value ?? 50 },
                }))
              }
            />
          </Col>
        </Row>
      </Card>

      <Card
        title={
          <Space wrap>
            <span>2. Điều phối & Tối ưu tự động</span>
            {renderScopeBadge(scopeType, draft.overrides.optimization)}
          </Space>
        }
        extra={
          scopeType === 'BRANCH' ? (
            <Space>
              <Text type="secondary">Ghi đè riêng</Text>
              <Switch
                aria-label="Ghi đè cấu hình tối ưu tại chi nhánh"
                checked={draft.overrides.optimization}
                disabled={!canManage || loading}
                onChange={(checked) => onToggleOverride?.('optimization', checked)}
              />
            </Space>
          ) : null
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Ngân sách tìm kiếm mặc định (giây)
            </Text>
            <InputNumber
              aria-label="Ngân sách tìm kiếm mặc định"
              min={1}
              max={120}
              precision={0}
              addonAfter="giây"
              style={{ width: '100%' }}
              value={displayedOptimization.defaultSearchBudgetSeconds}
              disabled={!isOptimizationEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  optimization: {
                    ...prev.optimization,
                    defaultSearchBudgetSeconds: value ?? 10,
                  },
                }))
              }
            />
          </Col>

          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Trần thời gian tối ưu tối đa (giây)
            </Text>
            <InputNumber
              aria-label="Trần thời gian tối ưu tối đa"
              min={5}
              max={600}
              precision={0}
              addonAfter="giây"
              style={{ width: '100%' }}
              value={displayedOptimization.maxTimeSeconds}
              disabled={!isOptimizationEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  optimization: {
                    ...prev.optimization,
                    maxTimeSeconds: value ?? 120,
                  },
                }))
              }
            />
          </Col>

          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Phạt đơn không thể xếp chuyến (VNĐ)
            </Text>
            <InputNumber
              aria-label="Phạt đơn không thể xếp chuyến"
              min={1}
              max={1_000_000_000_000}
              precision={0}
              addonAfter="VNĐ"
              style={{ width: '100%' }}
              formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(value) => Number((value || '').replace(/,/g, ''))}
              value={displayedOptimization.unassignedOrderPenaltyVnd}
              disabled={!isOptimizationEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  optimization: {
                    ...prev.optimization,
                    unassignedOrderPenaltyVnd: value ?? 1_000_000_000,
                  },
                }))
              }
            />
          </Col>

          <Col xs={24} md={12}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Checkbox
                checked={displayedOptimization.maxRoutesPerDay !== null}
                disabled={!isOptimizationEditable}
                onChange={(event) =>
                  onChangeDraft((prev) => ({
                    ...prev,
                    optimization: {
                      ...prev.optimization,
                      maxRoutesPerDay: event.target.checked ? 5 : null,
                    },
                  }))
                }
              >
                <Text strong>Giới hạn số chuyến tối đa / ngày</Text>
              </Checkbox>
              {displayedOptimization.maxRoutesPerDay !== null ? (
                <InputNumber
                  aria-label="Giới hạn số chuyến tối đa mỗi ngày"
                  min={1}
                  max={500}
                  precision={0}
                  addonAfter="chuyến / ngày"
                  style={{ width: '100%' }}
                  value={displayedOptimization.maxRoutesPerDay}
                  disabled={!isOptimizationEditable}
                  onChange={(value) =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      optimization: {
                        ...prev.optimization,
                        maxRoutesPerDay: value ?? 1,
                      },
                    }))
                  }
                />
              ) : (
                <Text type="secondary">Đang không giới hạn số chuyến trong ngày</Text>
              )}
            </Space>
          </Col>

          <Col xs={24} md={12}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text strong>Cho phép thay đổi thông số khi chạy Demo</Text>
              <Space>
                <Switch
                  aria-label="Cho phép ghi đè trong màn hình Demo"
                  checked={displayedOptimization.demoAllowOverride}
                  disabled={!isOptimizationEditable}
                  onChange={(checked) =>
                    onChangeDraft((prev) => ({
                      ...prev,
                      optimization: { ...prev.optimization, demoAllowOverride: checked },
                    }))
                  }
                />
                <Text type="secondary">
                  {displayedOptimization.demoAllowOverride
                    ? 'Người dùng có thể bật/tắt xếp chồng thử nghiệm trên màn hình Demo'
                    : 'Màn hình Demo khóa theo cấu hình hệ thống'}
                </Text>
              </Space>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card
        title={
          <Space wrap>
            <span>3. Chi phí & Phạt trễ vận hành</span>
            {renderScopeBadge(scopeType, draft.overrides.costPenalty)}
          </Space>
        }
        extra={
          scopeType === 'BRANCH' ? (
            <Space>
              <Text type="secondary">Ghi đè riêng</Text>
              <Switch
                aria-label="Ghi đè cấu hình chi phí và phạt trễ tại chi nhánh"
                checked={draft.overrides.costPenalty}
                disabled={!canManage || loading}
                onChange={(checked) => onToggleOverride?.('costPenalty', checked)}
              />
            </Space>
          ) : null
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Giá nhiên liệu (VNĐ / lít)
            </Text>
            <InputNumber
              aria-label="Giá nhiên liệu"
              min={1}
              max={10_000_000}
              addonAfter="VNĐ"
              style={{ width: '100%' }}
              formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(value) => Number((value || '').replace(/,/g, ''))}
              value={displayedCostPenalty.fuelPricePerLiter}
              disabled={!isCostEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, fuelPricePerLiter: value ?? 23_500 },
                }))
              }
            />
          </Col>

          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Số phút làm việc / tháng
            </Text>
            <InputNumber
              aria-label="Số phút làm việc mỗi tháng"
              min={60}
              max={44_640}
              precision={0}
              addonAfter="phút"
              style={{ width: '100%' }}
              value={displayedCostPenalty.monthlyWorkingMinutes}
              disabled={!isCostEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, monthlyWorkingMinutes: value ?? 10_560 },
                }))
              }
            />
          </Col>

          <Col xs={24} md={8}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Phí lưu hàng trên xe (VNĐ / tấn·giờ)
            </Text>
            <InputNumber
              aria-label="Phí lưu hàng trên xe"
              min={0}
              max={100_000_000}
              addonAfter="VNĐ"
              style={{ width: '100%' }}
              formatter={(value) => `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(value) => Number((value || '').replace(/,/g, ''))}
              value={displayedCostPenalty.cargoHoldingCostVndPerTonHour}
              disabled={!isCostEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: {
                    ...prev.costPenalty,
                    cargoHoldingCostVndPerTonHour: value ?? 0,
                  },
                }))
              }
            />
          </Col>

          <Col xs={24} md={6}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Giờ bắt đầu ca (HH:mm)
            </Text>
            <Input
              aria-label="Giờ bắt đầu ca"
              placeholder="08:00"
              maxLength={5}
              value={displayedCostPenalty.workStartTime}
              disabled={!isCostEditable}
              onChange={(event) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, workStartTime: event.target.value },
                }))
              }
            />
          </Col>

          <Col xs={24} md={6}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Giờ kết thúc ca (HH:mm)
            </Text>
            <Input
              aria-label="Giờ kết thúc ca"
              placeholder="17:00"
              maxLength={5}
              value={displayedCostPenalty.workEndTime}
              disabled={!isCostEditable}
              onChange={(event) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, workEndTime: event.target.value },
                }))
              }
            />
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Số ngày ân hạn giao hàng mặc định (0 - 365 ngày)
            </Text>
            <InputNumber
              aria-label="Số ngày ân hạn giao hàng"
              min={0}
              max={365}
              precision={0}
              addonAfter="ngày"
              style={{ width: '100%' }}
              value={displayedCostPenalty.deliveryGraceDays}
              disabled={!isCostEditable}
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, deliveryGraceDays: value ?? 0 },
                }))
              }
            />
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Hình thức phạt giao trễ
            </Text>
            <Select<LateDeliveryPenaltyMode>
              aria-label="Hình thức phạt giao trễ"
              value={displayedCostPenalty.lateDeliveryPenaltyMode}
              disabled={!isCostEditable}
              style={{ width: '100%' }}
              onChange={(mode) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: {
                    ...prev.costPenalty,
                    lateDeliveryPenaltyMode: mode,
                    lateDeliveryPenaltyValue:
                      mode === 'NONE' ? 0 : prev.costPenalty.lateDeliveryPenaltyValue,
                  },
                }))
              }
              options={[
                { value: 'NONE', label: LATE_PENALTY_MODE_LABELS.NONE },
                { value: 'FIXED_PER_DAY', label: LATE_PENALTY_MODE_LABELS.FIXED_PER_DAY },
                {
                  value: 'PERCENT_ORDER_VALUE_PER_DAY',
                  label: LATE_PENALTY_MODE_LABELS.PERCENT_ORDER_VALUE_PER_DAY,
                },
              ]}
            />
          </Col>

          <Col xs={24} md={12}>
            <Text strong style={{ display: 'block', marginBottom: 6 }}>
              Giá trị phạt giao trễ
            </Text>
            <InputNumber
              aria-label="Giá trị phạt giao trễ"
              min={0}
              max={
                displayedCostPenalty.lateDeliveryPenaltyMode === 'PERCENT_ORDER_VALUE_PER_DAY'
                  ? 100
                  : 1_000_000_000
              }
              addonAfter={
                displayedCostPenalty.lateDeliveryPenaltyMode === 'PERCENT_ORDER_VALUE_PER_DAY'
                  ? '% / ngày'
                  : 'VNĐ / ngày'
              }
              style={{ width: '100%' }}
              value={displayedCostPenalty.lateDeliveryPenaltyValue}
              disabled={
                !isCostEditable || displayedCostPenalty.lateDeliveryPenaltyMode === 'NONE'
              }
              onChange={(value) =>
                onChangeDraft((prev) => ({
                  ...prev,
                  costPenalty: { ...prev.costPenalty, lateDeliveryPenaltyValue: value ?? 0 },
                }))
              }
            />
          </Col>
        </Row>
        <Divider style={{ margin: '12px 0' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Thay đổi nhóm Chi phí & Phạt trễ sẽ tự động đồng bộ với thông tin cấu hình của các chi nhánh tương ứng.
        </Text>
      </Card>
    </Space>
  );
};
