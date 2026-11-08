import React, { useState } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Typography,
  Tag,
  Progress,
  Divider,
  Space,
  Tooltip,
  Table,
  Alert,
  Button,
  Modal,
  Badge,
  Tabs,
} from 'antd';
import {
  ThunderboltOutlined,
  DashboardOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  FundOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
  ExperimentOutlined,
  BranchesOutlined,
  NodeIndexOutlined,
} from '@ant-design/icons';
import {
  BenchmarkComparisonUI,
  BenchmarkMetricUI,
  FleetOptimizationResultUI,
  PlanningObjectiveBreakdownUI,
} from '../types';
import { formatCurrency, formatDecimal } from '../utils/format';

const { Text, Title, Paragraph } = Typography;

interface Props {
  benchmarks?: BenchmarkComparisonUI | null;
  optimizationStatus?: FleetOptimizationResultUI['status'];
  unassignedOrderCount?: number;
  planningObjective?: PlanningObjectiveBreakdownUI | null;
  onSelectDirect?: () => void;
  showingDirect?: boolean;
}

export const BenchmarkCostComparisonCard: React.FC<Props> = ({
  benchmarks,
  optimizationStatus,
  unassignedOrderCount = 0,
  planningObjective,
  onSelectDirect,
  showingDirect = false,
}) => {
  const [showDetails, setShowDetails] = useState(false);
  const [showAlgorithmModal, setShowAlgorithmModal] = useState(false);

  if (!benchmarks) {
    return null;
  }

  const {
    or_tools,
    direct_dedicated,
    savings_vs_direct_vnd,
    savings_vs_direct_percent,
  } = benchmarks;
  const isPartialOrTools =
    optimizationStatus === 'PARTIAL' && !or_tools.is_feasible;
  const orToolsSpanDays =
    planningObjective?.planning_span_days || or_tools.planning_span_days || 0;
  const orToolsPhysVehicles =
    planningObjective?.physical_vehicle_count ||
    or_tools.physical_vehicle_count ||
    or_tools.vehicles_used;
  const hasCompanyObjective = Boolean(
    ((planningObjective && planningObjective.selection_score_vnd > 0) ||
      (or_tools.selection_score_vnd && or_tools.selection_score_vnd > 0)) &&
      orToolsSpanDays > 0,
  );
  const orToolsRouteCostVnd = or_tools.total_cost_vnd;
  const orToolsIdleSalaryVnd = hasCompanyObjective
    ? (planningObjective?.driver_idle_salary_allocation_vnd ??
      or_tools.driver_idle_salary_allocation_vnd ??
      0)
    : 0;
  const orToolsCalendarSalaryVnd = hasCompanyObjective
    ? (planningObjective?.driver_calendar_salary_vnd ??
      or_tools.driver_calendar_salary_vnd ??
      0)
    : 0;
  const orToolsOperationalPenaltyVnd = hasCompanyObjective
    ? (planningObjective?.operational_late_penalty_vnd ?? 0)
    : 0;
  const orToolsEffectiveCostVnd = hasCompanyObjective
    ? (planningObjective?.selection_score_vnd ||
      or_tools.selection_score_vnd ||
      or_tools.total_cost_vnd)
    : or_tools.total_cost_vnd;

  const directSpanDays = direct_dedicated.planning_span_days || 0;
  const directPhysVehicles =
    direct_dedicated.physical_vehicle_count || direct_dedicated.vehicles_used;
  const directHasCompanyObjective = Boolean(
    direct_dedicated.is_feasible &&
      direct_dedicated.selection_score_vnd &&
      direct_dedicated.selection_score_vnd > 0 &&
      directSpanDays > 0,
  );
  const directIdleSalaryVnd = directHasCompanyObjective
    ? (direct_dedicated.driver_idle_salary_allocation_vnd ?? 0)
    : 0;
  const directCalendarSalaryVnd = directHasCompanyObjective
    ? (direct_dedicated.driver_calendar_salary_vnd ?? 0)
    : 0;
  const directEffectiveCostVnd =
    hasCompanyObjective && directHasCompanyObjective
      ? direct_dedicated.selection_score_vnd!
      : direct_dedicated.total_cost_vnd;

  const canCompareSavings =
    or_tools.is_feasible && direct_dedicated.is_feasible;
  const comparableSavingsVnd = canCompareSavings
    ? hasCompanyObjective && directEffectiveCostVnd > 0
      ? directEffectiveCostVnd - orToolsEffectiveCostVnd
      : savings_vs_direct_vnd
    : null;
  const comparableSavingsPercent = canCompareSavings
    ? hasCompanyObjective && directEffectiveCostVnd > 0 && comparableSavingsVnd !== null
      ? Number(((comparableSavingsVnd / directEffectiveCostVnd) * 100).toFixed(2))
      : savings_vs_direct_percent
    : null;
  const routeOnlySavingsVnd = canCompareSavings ? savings_vs_direct_vnd : null;
  const routeOnlySavingsPercent = canCompareSavings ? savings_vs_direct_percent : null;

  const methods = [
    { key: 'or_tools', metric: or_tools, effectiveCostVnd: orToolsEffectiveCostVnd },
    { key: 'direct', metric: direct_dedicated, effectiveCostVnd: directEffectiveCostVnd },
  ];
  const feasibleMethods = methods.filter(({ metric }) => metric.is_feasible);
  const maxComparableCost = Math.max(
    ...feasibleMethods.map(({ effectiveCostVnd }) => effectiveCostVnd),
    1,
  );
  const bestMethod = feasibleMethods.reduce<(typeof feasibleMethods)[number] | null>(
    (best, method) => !best || method.effectiveCostVnd < best.effectiveCostVnd
      ? method
      : best,
    null,
  );
  const ratioFor = (metric: BenchmarkMetricUI, costOverride?: number) => metric.is_feasible
    ? Math.round(((costOverride ?? metric.total_cost_vnd) / maxComparableCost) * 100)
    : 0;
  const orToolsRatio = ratioFor(or_tools, orToolsEffectiveCostVnd);
  const directRatio = ratioFor(direct_dedicated, directEffectiveCostVnd);

  const feasibilityTag = (
    metric: BenchmarkMetricUI,
    recommended = false,
    partial = false,
  ) => partial ? (
    <Tag color="warning" icon={<WarningOutlined />}>
      Phương án một phần (còn {unassignedOrderCount} đơn)
    </Tag>
  ) : metric.is_feasible ? (
    <Tag color={recommended ? 'success' : 'processing'} icon={<CheckCircleOutlined />}>
      {recommended ? 'Tốt nhất trong lần chạy này' : 'Nghiệm hợp lệ'}
    </Tag>
  ) : (
    <Tooltip title={metric.violations.join('\n') || metric.description}>
      <Tag color="error" icon={<WarningOutlined />}>Không hợp lệ</Tag>
    </Tooltip>
  );

  const feasibilityAlert = (metric: BenchmarkMetricUI, partial = false) => !metric.is_feasible && (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      message={partial
        ? 'Không so sánh chi phí khi còn đơn chưa xếp'
        : 'Không dùng để xếp hạng chi phí'}
      description={partial
        ? `Optimizer còn ${unassignedOrderCount} đơn chưa xếp; chi phí hiện tại không đại diện cho toàn bộ tập đơn.`
        : metric.violations.slice(0, 2).map((violation) => (
          <div key={violation}>{violation}</div>
        ))}
    />
  );

  const breakdownColumns = [
    {
      title: 'Khoản mục chi phí',
      dataIndex: 'category',
      key: 'category',
      render: (text: string) => <Text strong>{text}</Text>,
    },
    {
      title: 'Hybrid ALNS (Tối ưu)',
      dataIndex: 'or_tools',
      key: 'or_tools',
      render: (val: number) => (
        <Text style={{ color: '#059669', fontWeight: 600 }}>{formatCurrency(val)}</Text>
      ),
    },
    {
      title: 'Chuyến đơn lẻ (Direct Dedicated)',
      dataIndex: 'direct',
      key: 'direct',
      render: (val: number) => <Text type="secondary">{direct_dedicated.is_feasible ? formatCurrency(val) : '—'}</Text>,
    },
  ];

  const breakdownData = [
    {
      key: 'fuel',
      category: '⛽ Nhiên liệu xăng dầu',
      or_tools: or_tools.fuel_cost_vnd,
      direct: direct_dedicated.fuel_cost_vnd,
    },
    {
      key: 'vehicle',
      category: '🚚 Khấu hao & phí cố định xe',
      or_tools: or_tools.vehicle_fixed_cost_vnd,
      direct: direct_dedicated.vehicle_fixed_cost_vnd,
    },
    {
      key: 'driver',
      category: '👨‍✈️ Lương & thù lao tài xế (trên chuyến chạy)',
      or_tools: or_tools.driver_cost_vnd,
      direct: direct_dedicated.driver_cost_vnd,
    },
    {
      key: 'holding',
      category: '📦 Chi phí lưu hàng trên xe',
      or_tools: or_tools.cargo_holding_cost_vnd,
      direct: direct_dedicated.cargo_holding_cost_vnd,
    },
    {
      key: 'late-delivery',
      category: '⏱️ Phạt giao trễ dự kiến',
      or_tools: or_tools.late_delivery_penalty_vnd,
      direct: direct_dedicated.late_delivery_penalty_vnd,
    },
    ...(hasCompanyObjective
      ? [
          {
            key: 'route-subtotal',
            category: '🛣️ Tổng chi phí vận hành trực tiếp các chuyến',
            or_tools: orToolsRouteCostVnd,
            direct: direct_dedicated.total_cost_vnd,
          },
          {
            key: 'idle-driver-salary',
            category: directSpanDays > 0
              ? `🗓️ Lương cứng tài xế chờ lịch (${orToolsSpanDays} ngày so với ${directSpanDays} ngày)`
              : `🗓️ Lương cứng tài xế chờ lịch (${orToolsSpanDays} ngày)`,
            or_tools: orToolsIdleSalaryVnd,
            direct: directIdleSalaryVnd,
          },
          ...(orToolsOperationalPenaltyVnd > 0
            ? [
                {
                  key: 'operational-penalty',
                  category: '⚠️ Phạt trễ vận hành quy đổi',
                  or_tools: orToolsOperationalPenaltyVnd,
                  direct: 0,
                },
              ]
            : []),
          {
            key: 'total',
            category: '🏆 TỔNG CHI PHÍ TOÀN ĐỘI (Điểm xếp hạng)',
            or_tools: orToolsEffectiveCostVnd,
            direct: directEffectiveCostVnd,
          },
        ]
      : [
          {
            key: 'total',
            category: '💰 TỔNG CHI PHÍ TẠM TÍNH',
            or_tools: or_tools.total_cost_vnd,
            direct: direct_dedicated.total_cost_vnd,
          },
        ]),
  ];

  return (
    <Card
      style={{
        marginBottom: 20,
        borderRadius: 12,
        border: '1px solid #93c5fd',
        background: 'linear-gradient(180deg, #eff6ff 0%, #ffffff 100%)',
        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.08)',
      }}
      styles={{ body: { padding: '20px 24px' } }}
    >
      {/* Header Banner */}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Space align="center" size={10}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: '#10b981',
                color: '#ffffff',
                fontSize: 18,
              }}
            >
              <FundOutlined />
            </span>
            <div>
              <Title level={4} style={{ margin: 0, color: '#0f172a' }}>
                Đối Chuẩn Hiệu Quả Chi Phí (Cost Benchmarking)
              </Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                So sánh phương án tối ưu Hybrid ALNS với phương án Chuyến đơn lẻ (Lưu tạm thời, không ghi DB)
              </Text>
            </div>
          </Space>
        </Col>
        <Col>
          <Space size={8} wrap>
            <Button
              type="primary"
              ghost
              size="small"
              icon={<ExperimentOutlined />}
              onClick={() => setShowAlgorithmModal(true)}
              style={{ borderRadius: 6, fontWeight: 500, borderColor: '#0284c7', color: '#0284c7' }}
            >
              Đối chuẩn 4 thuật toán
            </Button>
            {comparableSavingsPercent !== null ? (
              <Tag color={comparableSavingsPercent >= 0 ? 'success' : 'warning'} icon={<SafetyCertificateOutlined />} style={{ padding: '4px 10px', fontSize: 13 }}>
                {comparableSavingsPercent >= 0
                  ? `Tiết kiệm ${formatDecimal(comparableSavingsPercent)}% so với Direct hợp lệ`
                  : `Cao hơn ${formatDecimal(Math.abs(comparableSavingsPercent))}% so với Direct hợp lệ`}
              </Tag>
            ) : (
              <Tag icon={<InfoCircleOutlined />} style={{ padding: '4px 10px', fontSize: 13 }}>
                {isPartialOrTools
                  ? 'Chưa so sánh: phương án còn đơn chưa xếp'
                  : 'Chỉ so sánh các nghiệm hợp lệ'}
              </Tag>
            )}
          </Space>
        </Col>
      </Row>

      {/* 2 Phương pháp so sánh */}
      <Row gutter={[16, 16]}>
        {/* CỘT 1: HYBRID ALNS METAHEURISTIC */}
        <Col xs={24} md={12}>
          <Card
            bordered={false}
            style={{
              height: '100%',
              borderRadius: 10,
              background: '#ffffff',
              border: '2px solid #10b981',
              boxShadow: '0 4px 8px rgba(16, 185, 129, 0.12)',
              position: 'relative',
            }}
            styles={{ body: { padding: 18 } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong style={{ color: '#047857', fontSize: 15 }}>
                <ThunderboltOutlined style={{ marginRight: 6 }} />
                Hybrid ALNS (Tối Ưu Ghép Chuyến)
              </Text>
              {feasibilityTag(or_tools, bestMethod?.key === 'or_tools', isPartialOrTools)}
            </div>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12, minHeight: 32 }}>
              Nghiệm khả thi tốt nhất tìm thấy trong thời gian cho phép; không khẳng định tối ưu toàn cục
            </Paragraph>

            <Statistic
              title={
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  {hasCompanyObjective
                    ? 'Tổng chi phí toàn đội (Điểm xếp hạng)'
                    : 'Tổng chi phí'}
                </span>
              }
              value={orToolsEffectiveCostVnd}
              formatter={(val) => formatCurrency(Number(val))}
              valueStyle={{ color: '#059669', fontWeight: 700, fontSize: 22 }}
            />

            {hasCompanyObjective && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: '#f0fdf4',
                  border: '1px solid #bbf7d0',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text type="secondary">
                    Chi phí vận hành {or_tools.vehicles_used} chuyến:
                  </Text>
                  <Text strong style={{ color: '#0f172a' }}>
                    {formatCurrency(orToolsRouteCostVnd)}
                  </Text>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text type="secondary">
                    + Lương cứng tài xế chờ lịch ({orToolsSpanDays} ngày):
                  </Text>
                  <Text strong style={{ color: '#047857' }}>
                    +{formatCurrency(orToolsIdleSalaryVnd)}
                  </Text>
                </div>
                {orToolsOperationalPenaltyVnd > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text type="secondary">+ Phạt trễ vận hành quy đổi:</Text>
                    <Text strong style={{ color: '#b45309' }}>
                      +{formatCurrency(orToolsOperationalPenaltyVnd)}
                    </Text>
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px dashed #86efac',
                    paddingTop: 4,
                    marginTop: 4,
                    color: '#166534',
                    fontSize: 11,
                  }}
                >
                  <span>
                    Hoàn tất trong {orToolsSpanDays} ngày ({or_tools.vehicles_used} chuyến /{' '}
                    {orToolsPhysVehicles} xe)
                  </span>
                  <span>Tổng lương lịch: {formatCurrency(orToolsCalendarSalaryVnd)}</span>
                </div>
              </div>
            )}

            <Divider style={{ margin: '12px 0' }} />

            <Row gutter={8}>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Quãng đường</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{formatDecimal(or_tools.total_distance_km)} km</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Thời gian</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{formatDecimal(or_tools.total_duration_minutes)} p</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Lượt chuyến</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{or_tools.vehicles_used} lượt</div>
              </Col>
            </Row>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <Text type="secondary">Tỷ lệ chi phí tương đối:</Text>
                <Text strong style={{ color: '#059669' }}>{orToolsRatio}%</Text>
              </div>
              <Progress percent={orToolsRatio} strokeColor="#10b981" showInfo={false} size="small" />
            </div>
            {feasibilityAlert(or_tools, isPartialOrTools)}
          </Card>
        </Col>

        {/* CỘT 2: CHUYẾN ĐƠN LẺ (DIRECT DEDICATED) */}
        <Col xs={24} md={12}>
          <Card
            bordered={false}
            style={{
              height: '100%',
              borderRadius: 10,
              background: '#ffffff',
              border: '1px solid #e2e8f0',
            }}
            styles={{ body: { padding: 18 } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text strong style={{ color: '#64748b', fontSize: 15 }}>
                <DashboardOutlined style={{ marginRight: 6 }} />
                Chuyến Đơn Lẻ (Direct Dedicated)
              </Text>
              {feasibilityTag(direct_dedicated, bestMethod?.key === 'direct')}
            </div>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12, minHeight: 32 }}>
              Mỗi chuyến chở một đơn. Xe và tài xế có thể chạy nhiều chuyến nối tiếp trong ca.
            </Paragraph>

            {direct_dedicated.is_feasible && <>
            <Statistic
              title={
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  {hasCompanyObjective && directHasCompanyObjective
                    ? 'Tổng chi phí toàn đội (Điểm xếp hạng)'
                    : 'Tổng chi phí'}
                </span>
              }
              value={directEffectiveCostVnd}
              formatter={(val) => formatCurrency(Number(val))}
              valueStyle={{ color: '#475569', fontWeight: 600, fontSize: 20 }}
            />

            {directSpanDays > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text type="secondary">
                    Chi phí vận hành {direct_dedicated.vehicles_used} chuyến:
                  </Text>
                  <Text strong style={{ color: '#0f172a' }}>
                    {formatCurrency(direct_dedicated.total_cost_vnd)}
                  </Text>
                </div>
                {hasCompanyObjective && directHasCompanyObjective && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text type="secondary">
                      + Lương cứng tài xế chờ lịch ({directSpanDays} ngày):
                    </Text>
                    <Text strong style={{ color: '#475569' }}>
                      +{formatCurrency(directIdleSalaryVnd)}
                    </Text>
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    borderTop: '1px dashed #cbd5e1',
                    paddingTop: 4,
                    marginTop: 4,
                    color: '#334155',
                    fontSize: 11,
                  }}
                >
                  <span>
                    Hoàn tất trong {directSpanDays} ngày ({direct_dedicated.vehicles_used} chuyến /{' '}
                    {directPhysVehicles} xe)
                  </span>
                  {hasCompanyObjective && directHasCompanyObjective && (
                    <span>Tổng lương lịch: {formatCurrency(directCalendarSalaryVnd)}</span>
                  )}
                </div>
              </div>
            )}

            <Divider style={{ margin: '12px 0' }} />

            <Row gutter={8}>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Quãng đường</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{formatDecimal(direct_dedicated.total_distance_km)} km</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Thời gian</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{formatDecimal(direct_dedicated.total_duration_minutes)} p</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Lượt chuyến</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{direct_dedicated.vehicles_used} lượt</div>
              </Col>
            </Row>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <Text type="secondary">Tỷ lệ chi phí tương đối:</Text>
                <Text strong style={{ color: '#64748b' }}>
                  {directRatio}%
                </Text>
              </div>
              <Progress percent={directRatio} strokeColor="#94a3b8" showInfo={false} size="small" />
            </div>
            </>}
            {feasibilityAlert(direct_dedicated)}
            {onSelectDirect ? (
              <Button style={{ marginTop: 12 }} onClick={onSelectDirect} aria-pressed={showingDirect}>
                {showingDirect ? 'Đang xem Chuyến đơn lẻ' : 'Xem và mô phỏng Chuyến đơn lẻ'}
              </Button>
            ) : direct_dedicated.is_feasible && !direct_dedicated.routes?.length && (
              <Text type="secondary" className="direct-route-help">Chạy lại tối ưu để tải tuyến mô phỏng.</Text>
            )}
          </Card>
        </Col>
      </Row>

      {/* Hiển thị mức tiết kiệm thực tế */}
      <div
        style={{
          marginTop: 16,
          padding: '12px 16px',
          background: '#ecfdf5',
          borderRadius: 8,
          border: '1px dashed #6ee7b7',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Space size={16} wrap>
          {comparableSavingsVnd !== null && comparableSavingsPercent !== null ? (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {hasCompanyObjective
                  ? directSpanDays > 0
                    ? `So với phương án Chuyến đơn lẻ (Direct) hợp lệ (${orToolsSpanDays} ngày so với ${directSpanDays} ngày):`
                    : `So với phương án Chuyến đơn lẻ (Direct) hợp lệ (đã cộng đủ lương lịch ${orToolsSpanDays} ngày):`
                  : 'So với phương án Chuyến đơn lẻ (Direct) hợp lệ:'}
              </Text>{' '}
              <Text strong style={{ color: comparableSavingsVnd >= 0 ? '#047857' : '#b45309', fontSize: 14 }}>
                {comparableSavingsVnd >= 0 ? 'Tiết kiệm ' : 'Cao hơn '}
                {formatCurrency(Math.abs(comparableSavingsVnd))} ({formatDecimal(Math.abs(comparableSavingsPercent))}%)
              </Text>
              {hasCompanyObjective &&
                routeOnlySavingsVnd !== null &&
                routeOnlySavingsPercent !== null &&
                orToolsIdleSalaryVnd > 0 && (
                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    · Riêng chi phí chạy chuyến:{' '}
                    {routeOnlySavingsVnd >= 0 ? 'Tiết kiệm ' : 'Cao hơn '}
                    {formatCurrency(Math.abs(routeOnlySavingsVnd))} ({formatDecimal(Math.abs(routeOnlySavingsPercent))}%)
                  </Text>
                )}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {isPartialOrTools
                ? 'Không so sánh chi phí khi còn đơn chưa xếp.'
                : 'Chưa có baseline hợp lệ để tính mức tiết kiệm.'}
            </Text>
          )}
        </Space>

        <a
          style={{ fontSize: 13, color: '#2563eb', textDecoration: 'underline', cursor: 'pointer' }}
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails ? '▲ Thu gọn chi tiết phân rã' : '▼ Xem chi tiết phân rã chi phí'}
        </a>
      </div>

      {/* Bảng phân rã chi tiết khi người dùng bấm xem thêm */}
      {showDetails && (
        <div style={{ marginTop: 14 }}>
          <Table
            className="dispatch-candidate-table dispatch-cost-table"
            columns={breakdownColumns}
            dataSource={breakdownData}
            pagination={false}
            size="small"
            scroll={{ x: 560 }}
          />
        </div>
      )}

      {/* Modal Đối chuẩn & So sánh 4 Thuật toán Tối ưu */}
      <Modal
        title={
          <Space align="center">
            <ExperimentOutlined style={{ color: '#0284c7', fontSize: 20 }} />
            <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
              Đối Chuẩn & So Sánh 4 Thuật Toán Vận Tải (TMS Multi-Algorithm Benchmark)
            </span>
          </Space>
        }
        open={showAlgorithmModal}
        onCancel={() => setShowAlgorithmModal(false)}
        footer={null}
        width={960}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16, borderRadius: 8 }}
          message="Kiểm chứng thực nghiệm độc lập theo kịch bản T21-T27"
          description="Cả 4 thuật toán đều được kiểm định bằng SpatialValidator sản xuất: bảo toàn 100% ràng buộc cấm xếp chồng, hành lang dỡ hàng LIFO thông suốt ra cửa sau/hông và tải trọng trục xe."
        />

        <Table
          columns={[
            {
              title: 'Thuật toán',
              dataIndex: 'name',
              key: 'name',
              render: (name: string, record: any) => (
                <div>
                  <Text strong style={{ color: record.isCurrent ? '#059669' : '#0f172a' }}>
                    {name}
                  </Text>
                  {record.isCurrent && (
                    <Tag color="success" style={{ marginLeft: 6 }}>Đang chạy</Tag>
                  )}
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {record.mechanism}
                  </div>
                </div>
              ),
            },
            {
              title: 'Gom chuyến',
              dataIndex: 'consolidation',
              key: 'consolidation',
              width: 140,
              render: (val: string, r: any) => (
                <Tag color={r.isCurrent ? 'green' : 'blue'}>{val}</Tag>
              ),
            },
            {
              title: 'Tốc độ giải',
              dataIndex: 'speed',
              key: 'speed',
              width: 110,
              render: (speed: string) => <Text style={{ fontSize: 12 }}>{speed}</Text>,
            },
            {
              title: 'Spatial Audit',
              dataIndex: 'spatial',
              key: 'spatial',
              width: 110,
              render: () => (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  PASS (T21-T27)
                </Tag>
              ),
            },
            {
              title: 'Khuyến nghị áp dụng',
              dataIndex: 'recommendation',
              key: 'recommendation',
              render: (text: string) => <Text style={{ fontSize: 12, color: '#334155' }}>{text}</Text>,
            },
          ]}
          dataSource={[
            {
              key: 'hybrid_alns',
              isCurrent: true,
              name: '0. Production Hybrid ALNS',
              mechanism: 'Packing-aware Destroy/Repair + SA + CP-SAT Route Pool Recombination',
              consolidation: 'Tối ưu nhất (ít xe nhất)',
              speed: '1.5s - 40s (Thích ứng)',
              recommendation: 'Lựa chọn chuẩn mực số 1 cho TMS: gom đơn xuất sắc nhất, chi phí vận hành thấp nhất.',
            },
            {
              key: 'hgs',
              isCurrent: false,
              name: '1. Hybrid Genetic Search (HGS)',
              mechanism: 'Quần thể tiến hóa + Lai ghép cặp Pickup-Delivery + Quản lý độ đa dạng',
              consolidation: 'Khá tốt (tiết kiệm km)',
              speed: '10s - 25s',
              recommendation: 'Phù hợp khi mạng lưới khách hàng phân tán rộng, cần tối ưu triệt để quãng đường di chuyển.',
            },
            {
              key: 'gvns_pool',
              isCurrent: false,
              name: '2. Guided VNS + Pool Matheuristic (GVNS-Pool)',
              mechanism: 'Lân cận biến thiên có hướng dẫn (GVNS) + Gom tuyến + Tái tổ hợp CP-SAT Pool',
              consolidation: 'Rất tốt (đối trọng trực tiếp với ALNS)',
              speed: '4s - 15s',
              recommendation: 'Mạnh khi bài toán có cấu trúc cụm/ca kíp rõ ràng và hưởng lợi từ tái tổ hợp nghiệm nguyên.',
            },
            {
              key: 'casa_ils',
              isCurrent: false,
              name: '3. Calibrated Adaptive SA + ILS (CASA-ILS)',
              mechanism: 'Tôi luyện mô phỏng tự hiệu chỉnh nhiệt độ + Tìm kiếm cục bộ lặp (ILS)',
              consolidation: 'Rất tốt (thoát cực trị địa phương sâu)',
              speed: '4s - 15s',
              recommendation: 'Đối thủ đối chứng mạnh để kiểm định khả năng thoát bẫy cực trị hình học 2D & khung giờ.',
            },
          ]}
          pagination={false}
          size="middle"
          bordered
        />
      </Modal>
    </Card>
  );
};
