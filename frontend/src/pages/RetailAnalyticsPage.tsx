import React, { useCallback, useState, useEffect } from 'react';
import {
  Row,
  Col,
  Card,
  Statistic,
  Typography,
  Table,
  Tag,
  Progress,
  Button,
  Space,
  Input,
  Alert,
  Divider,
  App as AntdApp,
} from 'antd';
import {
  BarChartOutlined,
  DollarCircleOutlined,
  CheckCircleOutlined,
  ShoppingOutlined,
  InboxOutlined,
  WarningOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import {
  FinancialSummary,
  FulfillmentPerformance,
  FunnelSummary,
  OccupancySummary,
  parseFinancialSummary,
  parseFulfillmentPerformance,
  parseFunnelSummary,
  parseOccupancyRows,
} from '../utils/retailAnalytics';

const { Title, Text } = Typography;

const RetailAnalyticsPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [financial, setFinancial] = useState<FinancialSummary | null>(null);
  const [funnel, setFunnel] = useState<FunnelSummary | null>(null);
  const [performance, setPerformance] = useState<FulfillmentPerformance | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancySummary[]>([]);

  // Reconciliation
  const [reconcileOrderId, setReconcileOrderId] = useState('');
  const [reconcileResult, setReconcileResult] = useState<any>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [finRes, funRes, perfRes, occRes] = await Promise.all([
        apiClient.get('/retail-analytics/financial-summary'),
        apiClient.get('/retail-analytics/funnel'),
        apiClient.get('/retail-analytics/fulfillment-performance'),
        apiClient.get('/retail-analytics/occupancy'),
      ]);
      setFinancial(parseFinancialSummary(finRes.data));
      setFunnel(parseFunnelSummary(funRes.data));
      setPerformance(parseFulfillmentPerformance(perfRes.data));
      setOccupancy(parseOccupancyRows(occRes.data));
    } catch {
      setLoadError('Dữ liệu báo cáo không đúng định dạng hoặc không thể tải từ máy chủ.');
      message.error('Không thể tải dữ liệu báo cáo vận hành bán lẻ');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleReconcile = async () => {
    if (!reconcileOrderId) {
      message.warning('Vui lòng nhập ID đơn hàng cần đối soát');
      return;
    }
    try {
      const res = await apiClient.get(`/retail-analytics/reconcile/${reconcileOrderId.trim()}`);
      setReconcileResult(res.data);
      message.success('Đối soát hoàn tất!');
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Lỗi khi đối soát đơn hàng');
    }
  };

  const funnelData = funnel?.byStatus || {};

  return (
    <div className="tms-page">
      {/* Header */}
      <Row justify="space-between" align="middle" style={{ marginBottom: '20px' }}>
        <Col>
          <Title level={3} style={{ margin: 0, color: '#0f172a' }}>
            <BarChartOutlined style={{ marginRight: '10px', color: '#1d4ed8' }} />
            Báo Cáo Vận Hành & Tài Chính Bán Lẻ (Retail Analytics)
          </Title>
          <Text type="secondary">
            Phễu đơn hàng, tỷ lệ nhặt hàng (Fill Rate), sức chứa điểm nhận và đối soát dữ liệu toàn diện
          </Text>
        </Col>
        <Col>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
            Làm mới
          </Button>
        </Col>
      </Row>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message="Không thể hiển thị báo cáo"
          description={loadError}
          action={<Button onClick={fetchData} loading={loading}>Thử lại</Button>}
          style={{ marginBottom: 20 }}
        />
      )}

      {/* Thẻ Tài Chính & Doanh Thu */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: '8px' }}>
            <Statistic
              title="Tổng Giá Trị Đơn Hàng"
              value={financial?.grossSales || 0}
              precision={0}
              prefix={<DollarCircleOutlined style={{ color: '#10b981' }} />}
              suffix="đ"
            />
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
              Tổng cộng {financial?.orderCount || 0} đơn bán lẻ
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: '8px' }}>
            <Statistic
              title="Thanh Toán Đã Ghi Nhận"
              value={financial?.payments || 0}
              precision={0}
              prefix={<ShoppingOutlined style={{ color: '#3b82f6' }} />}
              suffix="đ"
            />
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
              Dữ liệu giao dịch đã hoàn tất
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: '8px' }}>
            <Statistic
              title="Tỷ Lệ Hoàn Tất Fulfillment"
              value={performance?.completionRate || 0}
              precision={1}
              prefix={<CheckCircleOutlined style={{ color: '#059669' }} />}
              suffix="%"
            />
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
              Short-pick: {performance?.shortPickTasks || 0}/{performance?.totalTasks || 0} tác vụ
            </div>
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={{ borderRadius: '8px' }}>
            <Statistic
              title="Doanh Thu Ròng"
              value={financial?.netRevenue || 0}
              prefix={<SafetyCertificateOutlined style={{ color: '#8b5cf6' }} />}
              suffix="đ"
            />
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#64748b' }}>
              Đã hoàn: {(financial?.refunds || 0).toLocaleString('vi-VN')}đ
            </div>
          </Card>
        </Col>
      </Row>

      {/* Phễu Đơn Hàng (Order Funnel) */}
      <Card
        title={
          <Space>
            <ShoppingOutlined style={{ color: '#1d4ed8' }} />
            <span>Phễu Đơn Hàng Bán Lẻ (Order Funnel)</span>
          </Space>
        }
        style={{ marginBottom: '24px', borderRadius: '8px' }}
      >
        <Row gutter={[16, 16]}>
          {[
            { key: 'DRAFT', label: '1. Bản Nháp', color: '#64748b' },
            { key: 'CONFIRMED', label: '2. Đã Xác Nhận', color: '#3b82f6' },
            { key: 'ASSIGNED', label: '3. Đã Phân Công', color: '#6366f1' },
            { key: 'IN_TRANSIT', label: '4. Đang Vận Chuyển', color: '#f59e0b' },
            { key: 'COMPLETED', label: '5. Hoàn Tất', color: '#059669' },
          ].map((step, idx) => {
            const count = funnelData[step.key] || 0;
            return (
              <Col xs={24} sm={12} lg={4} key={step.key} style={{ textAlign: 'center' }}>
                <Card
                  size="small"
                  style={{
                    borderTop: `4px solid ${step.color}`,
                    background: '#f8fafc',
                    borderRadius: '6px',
                  }}
                >
                  <Text type="secondary" style={{ fontSize: '11px' }}>{step.label}</Text>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: step.color, margin: '6px 0' }}>
                    {count}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>
                    {funnel?.total || 0} đơn trong kỳ
                  </div>
                </Card>
                {idx < 4 && (
                  <div style={{ marginTop: '8px', color: '#94a3b8' }}>
                    <ArrowRightOutlined />
                  </div>
                )}
              </Col>
            );
          })}
          <Col xs={24} sm={12} lg={4} style={{ textAlign: 'center' }}>
            <Card
              size="small"
              style={{
                borderTop: '4px solid #ef4444',
                background: '#fef2f2',
                borderRadius: '6px',
              }}
            >
              <Text type="secondary" style={{ fontSize: '11px' }}>Đã Hủy</Text>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#ef4444', margin: '6px 0' }}>
                {funnelData.CANCELLED || 0}
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                {funnel?.total || 0} đơn trong kỳ
              </div>
            </Card>
          </Col>
        </Row>
      </Card>

      {/* Sức Chứa & Tỷ Lệ Lấp Đầy Điểm Nhận */}
      <Card
        title={
          <Space>
            <InboxOutlined style={{ color: '#10b981' }} />
            <span>Sức Chứa & Tỷ Lệ Lấp Đầy Các Điểm Nhận Hàng (Pickup Points Occupancy)</span>
          </Space>
        }
        style={{ marginBottom: '24px', borderRadius: '8px' }}
      >
        <Table
          dataSource={occupancy}
          rowKey="locationId"
          pagination={false}
          columns={[
            {
              title: 'Điểm Nhận Hàng',
              key: 'location',
              render: (_: unknown, r: OccupancySummary) => (
                <div>
                  <Text strong>Điểm nhận hiện tại</Text>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>{r.locationId}</div>
                </div>
              ),
            },
            {
              title: 'Số Kiện Đang Giữ / Sức Chứa',
              key: 'slots',
              render: (_, r) => (
                <Text strong>
                  {r.occupiedSlots} / {r.totalSlots} kiện
                </Text>
              ),
            },
            {
              title: 'Vị Trí Còn Trống',
              dataIndex: 'availableSlots',
              key: 'availableSlots',
              render: (count: number) => <Tag color={count > 0 ? 'green' : 'red'}>{count} vị trí</Tag>,
            },
            {
              title: 'Tỷ Lệ Lấp Đầy',
              dataIndex: 'occupancyRate',
              key: 'occupancyRate',
              render: (rate: number) => (
                <div style={{ width: '180px' }}>
                  <Progress
                    percent={rate}
                    size="small"
                    status={rate > 85 ? 'exception' : 'active'}
                    strokeColor={rate > 85 ? '#ef4444' : '#10b981'}
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>

      {/* Đối Soát Dữ Liệu 3 Chiều (Reconciliation Tool) */}
      <Card
        title={
          <Space>
            <SafetyCertificateOutlined style={{ color: '#8b5cf6' }} />
            <span>Công Cụ Đối Soát Toàn Diện Đơn Hàng (Order Data Reconciliation)</span>
          </Space>
        }
        style={{ borderRadius: '8px' }}
      >
        <Alert
          type="info"
          showIcon
          message="Đối soát dữ liệu 3 chiều (RR14 & R8-08)"
          description="Kiểm tra tính nhất quán toán học giữa Sales Order — Giữ chỗ tồn kho (Reservations) — Xuất kho (Ledger) — Kiện hàng (Packages) — Điểm nhận (Holdings) — Mã bí mật OTP/QR."
          style={{ marginBottom: '16px' }}
        />

        <Row gutter={16} align="middle">
          <Col span={18}>
            <Input
              size="large"
              placeholder="Nhập ID đơn bán lẻ (UUID) để đối soát..."
              value={reconcileOrderId}
              onChange={(e) => setReconcileOrderId(e.target.value)}
            />
          </Col>
          <Col span={6}>
            <Button
              type="primary"
              size="large"
              block
              onClick={handleReconcile}
              style={{ background: '#4f46e5' }}
            >
              Thực Hiện Đối Soát
            </Button>
          </Col>
        </Row>

        {reconcileResult && (
          <Card style={{ marginTop: '16px', background: '#f8fafc' }}>
            <Row justify="space-between" align="middle">
              <Col>
                <Title level={5} style={{ margin: 0 }}>
                  Đơn Hàng: {reconcileResult.orderNumber}
                </Title>
                <Text type="secondary">Trạng thái: <Tag color="blue">{reconcileResult.status}</Tag></Text>
              </Col>
              <Col>
                {reconcileResult.isConsistent ? (
                  <Tag color="success" style={{ fontSize: '14px', padding: '4px 12px' }}>
                    <CheckCircleOutlined /> Dữ Liệu Đồng Bộ Tuyệt Đối
                  </Tag>
                ) : (
                  <Tag color="error" style={{ fontSize: '14px', padding: '4px 12px' }}>
                    <WarningOutlined /> Phát Hiện {reconcileResult.discrepancies.length} Sai Lệch
                  </Tag>
                )}
              </Col>
            </Row>

            {!reconcileResult.isConsistent && (
              <div style={{ marginTop: '12px' }}>
                <Divider style={{ margin: '8px 0' }} />
                <Text strong type="danger">Chi tiết các điểm sai lệch:</Text>
                <ul>
                  {reconcileResult.discrepancies.map((d: string, i: number) => (
                    <li key={i} style={{ color: '#ef4444' }}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}
      </Card>
    </div>
  );
};

export default RetailAnalyticsPage;
