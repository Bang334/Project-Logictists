import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  RollbackOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { apiErrorMessage, branchesApi, settingsApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Branch } from '../types';
import {
  ScopedSettingsResponse,
  SettingAuditLogItem,
  SettingsGroupKey,
} from '../types/settings';
import { SettingsAuditLogCard } from '../components/settings/SettingsAuditLogCard';
import { LoadRestrictionZonesCard } from '../components/settings/LoadRestrictionZonesCard';
import {
  SettingsDraftState,
  SettingsGroupsForm,
} from '../components/settings/SettingsGroupsForm';

const { Title, Text } = Typography;

const TIME_HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function buildDraftFromResponse(data: ScopedSettingsResponse): SettingsDraftState {
  const isBranch = Boolean(data.branch);
  return {
    overrides: isBranch
      ? { ...data.effective.overrides }
      : { stacking: false, optimization: false, costPenalty: false },
    stacking: { ...data.effective.stacking },
    optimization: { ...data.effective.optimization },
    costPenalty: { ...data.effective.costPenalty },
  };
}

function validateDraft(
  scopeType: 'COMPANY' | 'BRANCH',
  draft: SettingsDraftState,
): string | null {
  const checkOptimization = scopeType === 'COMPANY' || draft.overrides.optimization;
  if (
    checkOptimization &&
    draft.optimization.defaultSearchBudgetSeconds > draft.optimization.maxTimeSeconds
  ) {
    return 'Ngân sách tìm kiếm mặc định không được lớn hơn trần thời gian tối ưu tối đa.';
  }

  const checkCost = scopeType === 'COMPANY' || draft.overrides.costPenalty;
  if (checkCost) {
    if (
      !TIME_HH_MM_REGEX.test(draft.costPenalty.workStartTime) ||
      !TIME_HH_MM_REGEX.test(draft.costPenalty.workEndTime)
    ) {
      return 'Giờ bắt đầu và kết thúc ca phải đúng định dạng HH:mm (ví dụ 08:00 - 17:00).';
    }
    const [sh, sm] = draft.costPenalty.workStartTime.split(':').map(Number);
    const [eh, em] = draft.costPenalty.workEndTime.split(':').map(Number);
    if (sh * 60 + sm >= eh * 60 + em) {
      return 'Giờ bắt đầu ca phải trước giờ kết thúc ca.';
    }
    if (
      draft.costPenalty.lateDeliveryPenaltyMode === 'PERCENT_ORDER_VALUE_PER_DAY' &&
      draft.costPenalty.lateDeliveryPenaltyValue > 100
    ) {
      return 'Mức phạt phần trăm mỗi ngày trễ không được vượt quá 100%.';
    }
  }
  return null;
}

const SettingsPage: React.FC = () => {
  const { message } = App.useApp();
  const { user, can } = useAuth();
  const canManage = can('settings.manage');

  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedScope, setSelectedScope] = useState<string>('COMPANY');
  const [scopedData, setScopedData] = useState<ScopedSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsDraftState | null>(null);
  const [baselineJson, setBaselineJson] = useState<string>('');

  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [auditItems, setAuditItems] = useState<SettingAuditLogItem[]>([]);
  const [auditTotal, setAuditTotal] = useState<number>(0);
  const [auditPage, setAuditPage] = useState<number>(1);
  const [auditPageSize] = useState<number>(10);
  const [loadingAudit, setLoadingAudit] = useState<boolean>(false);

  const scopeType: 'COMPANY' | 'BRANCH' =
    selectedScope === 'COMPANY' ? 'COMPANY' : 'BRANCH';
  const selectedBranchId = scopeType === 'BRANCH' ? selectedScope : undefined;

  const isDirty = useMemo(() => {
    if (!draft || !baselineJson) return false;
    return JSON.stringify(draft) !== baselineJson;
  }, [draft, baselineJson]);

  const loadSettings = useCallback(
    async (scope: string) => {
      setLoading(true);
      setLoadError(null);
      setConflictError(null);
      setValidationError(null);
      try {
        const res =
          scope === 'COMPANY'
            ? await settingsApi.getCompany()
            : await settingsApi.getBranch(scope);
        const nextDraft = buildDraftFromResponse(res.data);
        setScopedData(res.data);
        setDraft(nextDraft);
        setBaselineJson(JSON.stringify(nextDraft));
      } catch (err) {
        setLoadError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadAuditLogs = useCallback(
    async (branchId: string | undefined, page: number) => {
      setLoadingAudit(true);
      try {
        const res = await settingsApi.getAuditLogs({
          branchId,
          page,
          pageSize: auditPageSize,
        });
        setAuditItems(res.data.items);
        setAuditTotal(res.data.total);
      } catch {
        // Non-blocking audit fetch failure
      } finally {
        setLoadingAudit(false);
      }
    },
    [auditPageSize],
  );

  useEffect(() => {
    let active = true;
    branchesApi
      .getAll()
      .then((res) => {
        if (!active) return;
        const allowed = user?.companyScope
          ? res.data
          : res.data.filter((b) => user?.branches.some((ub) => ub.id === b.id));
        setBranches(allowed);
      })
      .catch(() => {
        if (active && user?.branches) {
          setBranches(
            user.branches.map((b) => ({
              id: b.id,
              code: b.code,
              name: b.name,
              address: '',
              latitude: 0,
              longitude: 0,
              phone: '',
              timezone: 'Asia/Ho_Chi_Minh',
              active: true,
              deliveryGraceDays: 2,
              lateDeliveryPenaltyMode: 'NONE',
              lateDeliveryPenaltyValue: '0',
            })),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    void loadSettings(selectedScope);
    setAuditPage(1);
    void loadAuditLogs(selectedBranchId, 1);
  }, [selectedScope, selectedBranchId, loadSettings, loadAuditLogs]);

  const handleToggleOverride = (group: SettingsGroupKey, checked: boolean) => {
    if (!scopedData) return;
    setValidationError(null);
    setDraft((prev) => {
      if (!prev) return prev;
      if (checked) {
        return {
          ...prev,
          overrides: { ...prev.overrides, [group]: true },
          stacking:
            group === 'stacking' ? { ...scopedData.company.stacking } : prev.stacking,
          optimization:
            group === 'optimization'
              ? { ...scopedData.company.optimization }
              : prev.optimization,
          costPenalty:
            group === 'costPenalty'
              ? { ...scopedData.company.costPenalty }
              : prev.costPenalty,
        };
      }
      return {
        ...prev,
        overrides: { ...prev.overrides, [group]: false },
        stacking:
          group === 'stacking' ? { ...scopedData.company.stacking } : prev.stacking,
        optimization:
          group === 'optimization'
            ? { ...scopedData.company.optimization }
            : prev.optimization,
        costPenalty:
          group === 'costPenalty'
            ? { ...scopedData.company.costPenalty }
            : prev.costPenalty,
      };
    });
  };

  const applySavedResponse = (data: ScopedSettingsResponse, successText: string) => {
    const nextDraft = buildDraftFromResponse(data);
    setScopedData(data);
    setDraft(nextDraft);
    setBaselineJson(JSON.stringify(nextDraft));
    setConflictError(null);
    setValidationError(null);
    message.success(successText);
    void loadAuditLogs(selectedBranchId, 1);
    setAuditPage(1);
  };

  const handleSave = async () => {
    if (!scopedData || !draft || !canManage) return;
    const errMsg = validateDraft(scopeType, draft);
    if (errMsg) {
      setValidationError(errMsg);
      return;
    }

    setSaving(true);
    setConflictError(null);
    setValidationError(null);
    try {
      if (scopeType === 'COMPANY') {
        const res = await settingsApi.updateCompany({
          expectedVersion: scopedData.company.version,
          stacking: draft.stacking,
          optimization: draft.optimization,
          costPenalty: draft.costPenalty,
        });
        applySavedResponse(res.data, 'Đã lưu cấu hình mặc định toàn công ty.');
      } else if (selectedBranchId && scopedData.branch) {
        const res = await settingsApi.updateBranch(selectedBranchId, {
          expectedVersion: scopedData.branch.version,
          overrideStacking: draft.overrides.stacking,
          ...(draft.overrides.stacking ? { stacking: draft.stacking } : {}),
          overrideOptimization: draft.overrides.optimization,
          ...(draft.overrides.optimization ? { optimization: draft.optimization } : {}),
          overrideCostPenalty: draft.overrides.costPenalty,
          ...(draft.overrides.costPenalty ? { costPenalty: draft.costPenalty } : {}),
        });
        applySavedResponse(
          res.data,
          `Đã lưu cấu hình riêng cho chi nhánh ${scopedData.branch.branchName}.`,
        );
      }
    } catch (err: unknown) {
      const status =
        typeof err === 'object' &&
        err !== null &&
        'response' in err &&
        (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setConflictError(
          'Phiên bản cấu hình đã thay đổi bởi người dùng khác. Hãy tải lại dữ liệu mới nhất trước khi lưu.',
        );
      } else {
        message.error(apiErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetBranch = async () => {
    if (!selectedBranchId || !scopedData?.branch || !canManage) return;
    setSaving(true);
    setConflictError(null);
    try {
      const res = await settingsApi.resetBranchOverrides(selectedBranchId, {
        expectedVersion: scopedData.branch.version,
      });
      applySavedResponse(
        res.data,
        `Đã khôi phục toàn bộ cấu hình chi nhánh ${scopedData.branch.branchName} về mặc định công ty.`,
      );
    } catch (err: unknown) {
      const status =
        typeof err === 'object' &&
        err !== null &&
        'response' in err &&
        (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setConflictError(
          'Phiên bản cấu hình đã thay đổi bởi người dùng khác. Hãy tải lại trước khi khôi phục.',
        );
      } else {
        message.error(apiErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const hasBranchOverrides = Boolean(
    scopedData?.branch &&
      (draft?.overrides.stacking ||
        draft?.overrides.optimization ||
        draft?.overrides.costPenalty),
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', paddingBottom: 32 }}>
      <Card>
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Space align="start" size={12}>
              <SettingOutlined style={{ fontSize: 24, marginTop: 4, color: '#1677ff' }} />
              <div>
                <Space wrap align="center">
                  <Title level={3} style={{ margin: 0 }}>
                    Cấu hình chung hệ thống
                  </Title>
                  {canManage ? (
                    <Tag color="green">Quyền chỉnh sửa (Admin)</Tag>
                  ) : (
                    <Tag color="default">Chỉ xem (Điều phối viên)</Tag>
                  )}
                  {isDirty && <Tag color="orange">Có thay đổi chưa lưu</Tag>}
                </Space>
                <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
                  Thiết lập chính sách xếp chồng, giới hạn tối ưu và chi phí vận hành áp dụng thống nhất từ PostgreSQL.
                </Text>
              </div>
            </Space>
          </Col>

          <Col xs={24} lg={10} style={{ textAlign: 'right' }}>
            <Space wrap>
              <Select
                aria-label="Chọn phạm vi cấu hình"
                value={selectedScope}
                style={{ minWidth: 260, textAlign: 'left' }}
                disabled={saving}
                onChange={(val) => setSelectedScope(val)}
                options={[
                  { value: 'COMPANY', label: '🌐 Mặc định toàn công ty' },
                  ...branches.map((branch) => ({
                    value: branch.id,
                    label: `🏢 Chi nhánh: ${branch.code} — ${branch.name}`,
                  })),
                ]}
              />

              <Button
                icon={<ReloadOutlined />}
                loading={loading}
                disabled={saving}
                onClick={() => {
                  void loadSettings(selectedScope);
                  void loadAuditLogs(selectedBranchId, auditPage);
                }}
              >
                Tải lại
              </Button>

              {canManage && scopeType === 'BRANCH' && hasBranchOverrides && (
                <Popconfirm
                  title="Khôi phục toàn bộ nhóm về mặc định công ty?"
                  description="Tất cả ghi đè riêng của chi nhánh sẽ bị xóa và kế thừa lại từ công ty."
                  okText="Khôi phục"
                  cancelText="Hủy"
                  onConfirm={handleResetBranch}
                >
                  <Button icon={<RollbackOutlined />} disabled={saving || loading}>
                    Khôi phục mặc định công ty
                  </Button>
                </Popconfirm>
              )}

              {canManage && (
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  disabled={loading || !draft || !isDirty}
                  onClick={handleSave}
                >
                  Lưu thay đổi
                </Button>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {!canManage && (
        <Alert
          type="info"
          showIcon
          message="Bạn đang ở chế độ chỉ xem"
          description="Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa cấu hình toàn công ty hoặc chi nhánh. Điều phối viên có thể xem cấu hình hiệu lực đang áp dụng cho chi nhánh của mình."
        />
      )}

      {loadError && (
        <Alert
          type="error"
          showIcon
          message="Không tải được cấu hình chung"
          description={loadError}
          action={
            <Button size="small" onClick={() => void loadSettings(selectedScope)}>
              Thử lại
            </Button>
          }
        />
      )}

      {conflictError && (
        <Alert
          type="warning"
          showIcon
          message="Xung đột phiên bản cập nhật (409 Conflict)"
          description={conflictError}
          action={
            <Button size="small" type="primary" onClick={() => void loadSettings(selectedScope)}>
              Tải lại bản mới
            </Button>
          }
        />
      )}

      {validationError && (
        <Alert type="error" showIcon message="Dữ liệu chưa hợp lệ" description={validationError} />
      )}

      {loading && !draft ? (
        <Card>
          <div style={{ padding: 48, textAlign: 'center' }}>
            <Spin size="large" />
            <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
              Đang tải cấu hình hệ thống...
            </Text>
          </div>
        </Card>
      ) : null}

      {scopedData && draft && (
        <>
          <Card size="small">
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label="Phiên bản hiệu lực">
                <Tag color="blue">{scopedData.effective.policyVersion}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Nguồn xếp chồng">
                <Tag color={scopedData.effective.sources.stacking === 'BRANCH' ? 'gold' : 'geekblue'}>
                  {scopedData.effective.sources.stacking === 'BRANCH' ? 'Chi nhánh' : 'Công ty'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Nguồn tối ưu">
                <Tag color={scopedData.effective.sources.optimization === 'BRANCH' ? 'gold' : 'geekblue'}>
                  {scopedData.effective.sources.optimization === 'BRANCH' ? 'Chi nhánh' : 'Công ty'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Nguồn chi phí & phạt">
                <Tag color={scopedData.effective.sources.costPenalty === 'BRANCH' ? 'gold' : 'geekblue'}>
                  {scopedData.effective.sources.costPenalty === 'BRANCH' ? 'Chi nhánh' : 'Công ty'}
                </Tag>
              </Descriptions.Item>
            </Descriptions>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Các chuyến đã phát hành giữ nguyên snapshot chính sách lúc lập kế hoạch; mọi lượt tối ưu và chuyến lập mới sau khi lưu sẽ áp dụng ngay cấu hình hiện hành.
            </Text>
          </Card>

          <SettingsGroupsForm
            scopeType={scopeType}
            canManage={canManage}
            loading={loading || saving}
            companyDefaults={scopedData.company}
            draft={draft}
            onChangeDraft={(updater) => {
              setValidationError(null);
              setDraft((prev) => (prev ? updater(prev) : prev));
            }}
            onToggleOverride={handleToggleOverride}
          />

          {selectedBranchId && selectedBranchId !== 'COMPANY' && (
            <LoadRestrictionZonesCard
              branchId={selectedBranchId}
              branchName={branches.find((b) => b.id === selectedBranchId)?.name}
              canManage={canManage}
            />
          )}

          <SettingsAuditLogCard
            items={auditItems}
            total={auditTotal}
            page={auditPage}
            pageSize={auditPageSize}
            loading={loadingAudit}
            onPageChange={(nextPage) => {
              setAuditPage(nextPage);
              void loadAuditLogs(selectedBranchId, nextPage);
            }}
          />
        </>
      )}
    </Space>
  );
};

export default SettingsPage;
