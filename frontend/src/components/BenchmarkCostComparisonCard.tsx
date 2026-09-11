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
  Collapse,
  Table,
  Alert,
} from 'antd';
import {
  ThunderboltOutlined,
  DollarCircleOutlined,
  DashboardOutlined,
  CarOutlined,
  ArrowDownOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  FundOutlined,
  ClockCircleOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { BenchmarkComparisonUI, BenchmarkMetricUI } from '../types';

const { Text, Title, Paragraph } = Typography;

const formatCurrency = (val: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(val);

interface Props {
  benchmarks?: BenchmarkComparisonUI | null;
}

export const BenchmarkCostComparisonCard: React.FC<Props> = ({ benchmarks }) => {
  const [showDetails, setShowDetails] = useState(false);

  if (!benchmarks) {
    return null;
  }

  const {
    or_tools,
    direct_dedicated,
    savings_vs_direct_vnd,
    savings_vs_direct_percent,
  } = benchmarks;

  const methods = [
    { key: 'or_tools', metric: or_tools },
    { key: 'direct', metric: direct_dedicated },
  ];
  const feasibleMethods = methods.filter(({ metric }) => metric.is_feasible);
  const maxComparableCost = Math.max(
    ...feasibleMethods.map(({ metric }) => metric.total_cost_vnd),
    1,
  );
  const bestMethod = feasibleMethods.reduce<(typeof feasibleMethods)[number] | null>(
    (best, method) => !best || method.metric.total_cost_vnd < best.metric.total_cost_vnd
      ? method
      : best,
    null,
  );
  const ratioFor = (metric: BenchmarkMetricUI) => metric.is_feasible
    ? Math.round((metric.total_cost_vnd / maxComparableCost) * 100)
    : 0;
  const orToolsRatio = ratioFor(or_tools);

  const feasibilityTag = (metric: BenchmarkMetricUI, recommended = false) => metric.is_feasible ? (
    <Tag color={recommended ? 'success' : 'processing'} icon={<CheckCircleOutlined />}>
      {recommended ? 'Chi phí thấp nhất hợp lệ' : 'Nghiệm hợp lệ'}
    </Tag>
  ) : (
    <Tooltip title={metric.violations.join('\n')}>
      <Tag color="error" icon={<WarningOutlined />}>Không hợp lệ</Tag>
    </Tooltip>
  );

  const feasibilityAlert = (metric: BenchmarkMetricUI) => !metric.is_feasible && (
    <Alert
      type="warning"
      showIcon
      style={{ marginTop: 12 }}
      message="Không dùng để xếp hạng chi phí"
      description={metric.violations.slice(0, 2).map((violation) => (
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
      title: 'OR-Tools (Tối ưu)',
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
      render: (val: number) => <Text type="secondary">{formatCurrency(val)}</Text>,
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
      category: '👨‍✈️ Lương & thù lao tài xế',
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
      key: 'total',
      category: '💰 TỔNG CHI PHÍ TẠM TÍNH',
      or_tools: or_tools.total_cost_vnd,
      direct: direct_dedicated.total_cost_vnd,
    },
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
                So sánh phương án tối ưu OR-Tools với phương án Chuyến đơn lẻ (Lưu tạm thời, không ghi DB)
              </Text>
            </div>
          </Space>
        </Col>
        <Col>
          {savings_vs_direct_percent !== null ? (
            <Tag color={savings_vs_direct_percent >= 0 ? 'success' : 'warning'} icon={<SafetyCertificateOutlined />} style={{ padding: '4px 10px', fontSize: 13 }}>
              {savings_vs_direct_percent >= 0
                ? `Tiết kiệm ${savings_vs_direct_percent}% so với Direct hợp lệ`
                : `Cao hơn ${Math.abs(savings_vs_direct_percent)}% so với Direct hợp lệ`}
            </Tag>
          ) : (
            <Tag icon={<InfoCircleOutlined />} style={{ padding: '4px 10px', fontSize: 13 }}>
              Chỉ so sánh các nghiệm hợp lệ
            </Tag>
          )}
        </Col>
      </Row>

      {/* 2 Phương pháp so sánh */}
      <Row gutter={[16, 16]}>
        {/* CỘT 1: OR-TOOLS METAHEURISTIC */}
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
                Google OR-Tools (Tối Ưu Ghép Chuyến)
              </Text>
              {feasibilityTag(or_tools, bestMethod?.key === 'or_tools')}
            </div>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12, minHeight: 32 }}>
              Tối ưu đa điểm, khung giờ và kiểm định hình học xếp sàn xe 2D
            </Paragraph>

            <Statistic
              title={<span style={{ fontSize: 13, color: '#64748b' }}>Tổng chi phí</span>}
              value={or_tools.total_cost_vnd}
              formatter={(val) => formatCurrency(Number(val))}
              valueStyle={{ color: '#059669', fontWeight: 700, fontSize: 22 }}
            />

            <Divider style={{ margin: '12px 0' }} />

            <Row gutter={8}>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Quãng đường</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{or_tools.total_distance_km} km</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Thời gian</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{or_tools.total_duration_minutes} p</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Số xe dùng</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{or_tools.vehicles_used} xe</div>
              </Col>
            </Row>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <Text type="secondary">Tỷ lệ chi phí tương đối:</Text>
                <Text strong style={{ color: '#059669' }}>{orToolsRatio}%</Text>
              </div>
              <Progress percent={orToolsRatio} strokeColor="#10b981" showInfo={false} size="small" />
            </div>
            {feasibilityAlert(or_tools)}
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
              Mỗi đơn cử 1 xe đi lấy và giao riêng biệt, không ghép chuyến
            </Paragraph>

            <Statistic
              title={<span style={{ fontSize: 13, color: '#64748b' }}>
                {direct_dedicated.is_feasible ? 'Tổng chi phí' : 'Chi phí ước tính chưa hợp lệ'}
              </span>}
              value={direct_dedicated.total_cost_vnd}
              formatter={(val) => formatCurrency(Number(val))}
              valueStyle={{ color: '#475569', fontWeight: 600, fontSize: 20 }}
            />

            <Divider style={{ margin: '12px 0' }} />

            <Row gutter={8}>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Quãng đường</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{direct_dedicated.total_distance_km} km</div>
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 11 }}>Thời gian</Text>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{direct_dedicated.total_duration_minutes} p</div>
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
                  {direct_dedicated.is_feasible ? `${ratioFor(direct_dedicated)}%` : 'Không so sánh'}
                </Text>
              </div>
              <Progress percent={ratioFor(direct_dedicated)} strokeColor="#94a3b8" showInfo={false} size="small" />
            </div>
            {feasibilityAlert(direct_dedicated)}
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
          {savings_vs_direct_vnd !== null && savings_vs_direct_percent !== null ? (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                So với phương án Chuyến đơn lẻ (Direct) hợp lệ:
              </Text>{' '}
              <Text strong style={{ color: savings_vs_direct_vnd >= 0 ? '#047857' : '#b45309', fontSize: 14 }}>
                {savings_vs_direct_vnd >= 0 ? 'Tiết kiệm ' : 'Cao hơn '}
                {formatCurrency(Math.abs(savings_vs_direct_vnd))} ({Math.abs(savings_vs_direct_percent)}%)
              </Text>
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Chưa có baseline hợp lệ để tính mức tiết kiệm.
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
            columns={breakdownColumns}
            dataSource={breakdownData}
            pagination={false}
            size="small"
            bordered
          />
        </div>
      )}
    </Card>
  );
};
