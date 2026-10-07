import React, { useCallback, useState, useEffect } from 'react';
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Row,
  Col,
  Typography,
  App as AntdApp,
  Input,
  Select,
  Tabs,
  Alert,
  Statistic,
} from 'antd';
import {
  ShopOutlined,
  ScanOutlined,
  KeyOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  InboxOutlined,
  ClockCircleOutlined,
  QrcodeOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { useAuth } from '../context/AuthContext';

const { Title, Text } = Typography;

interface Holding {
  id: string;
  holdingSlot: string;
  storageCondition: string;
  status: string;
  receivedAt: string;
  expiryDate: string;
  package?: {
    packageCode: string;
    weightKg?: number;
  };
  salesOrder?: {
    id: string;
    orderNumber: string;
    customerName: string;
    customerPhone: string;
    status: string;
    collectionToken?: {
      status: string;
      expiresAt: string;
      verifiedAt?: string;
    };
  };
}

const PickupPointOpsPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('holdings');
  const [loading, setLoading] = useState(false);
  const [holdings, setHoldings] = useState<Holding[]>([]);

  // Inbound Scan
  const [scanPackageCode, setScanPackageCode] = useState('');
  const [holdingSlotInput, setHoldingSlotInput] = useState('KỆ-A1-01');
  const [scanStorageCond, setScanStorageCond] = useState('AMBIENT');
  const [inboundResult, setInboundResult] = useState<any>(null);

  // Customer Collection Verification
  const [verifyOtpInput, setVerifyOtpInput] = useState('');
  const [verifyQrInput, setVerifyQrInput] = useState('');
  const [verifySalesOrderId, setVerifySalesOrderId] = useState('');
  const [verifyResult, setVerifyResult] = useState<any>(null);

  const fetchHoldings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/pickup/holdings');
      setHoldings(res.data);
    } catch {
      message.error('Không thể tải danh sách kiện đang giữ tại điểm');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void fetchHoldings();
  }, [fetchHoldings]);

  // Quét nhập kiện tại điểm
  const handleInboundScan = async () => {
    if (!scanPackageCode) {
      message.warning('Vui lòng nhập hoặc quét mã kiện PKG-xxx');
      return;
    }
    try {
      const res = await apiClient.post(
        '/pickup/inbound-scan',
        {
          packageCode: scanPackageCode,
          holdingSlot: holdingSlotInput,
          storageCondition: scanStorageCond,
        },
      );
      setInboundResult(res.data);
      message.success(`Đã lưu kiện vào vị trí ${holdingSlotInput}!`);
      setScanPackageCode('');
      fetchHoldings();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Lỗi khi nhập kiện vào điểm');
    }
  };

  // Xác thực giao khách nhận hàng
  const handleVerifyCollection = async () => {
    if (!verifySalesOrderId.trim() || (!verifyOtpInput && !verifyQrInput)) {
      message.warning('Vui lòng nhập mã OTP 6 số hoặc quét mã QR');
      return;
    }
    if (!user?.locationId) {
      message.error('Tài khoản nhân viên chưa được gán điểm nhận hàng');
      return;
    }
    try {
      const res = await apiClient.post(
        '/pickup/verify-collection',
        {
          salesOrderId: verifySalesOrderId.trim(),
          pickupPointId: user.locationId,
          otpCode: verifyOtpInput || undefined,
          qrToken: verifyQrInput || undefined,
        },
      );
      setVerifyResult(res.data);
      message.success('Xác thực mã OTP thành công! Đã bàn giao hàng cho khách.');
      setVerifyOtpInput('');
      setVerifyQrInput('');
      setVerifySalesOrderId('');
      fetchHoldings();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Xác thực thất bại');
    }
  };

  const activeHoldings = holdings.filter((h) => h.status === 'HOLDING');
  const releasedHoldings = holdings.filter((h) => h.status === 'RELEASED_TO_CUSTOMER');

  return (
    <div className="tms-page">
      {/* Header */}
      <Row justify="space-between" align="middle" style={{ marginBottom: '20px' }}>
        <Col>
          <Title level={3} style={{ margin: 0, color: '#0f172a' }}>
            <ShopOutlined style={{ marginRight: '10px', color: '#1d4ed8' }} />
            Vận Hành Điểm Nhận Hàng & Giao Khách (Pickup Point Ops)
          </Title>
          <Text type="secondary">
            Nhập kiện vào kệ lưu giữ (Inbound Scan), quản lý sức chứa 72h và xác thực OTP/QR giao khách nhận hàng
          </Text>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchHoldings}>
              Làm mới
            </Button>
          </Space>
        </Col>
      </Row>

      {/* Thống kê nhanh */}
      <Row gutter={16} style={{ marginBottom: '20px' }}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Kiện đang lưu giữ tại điểm"
              value={activeHoldings.length}
              prefix={<InboxOutlined style={{ color: '#1d4ed8' }} />}
              suffix="kiện"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Đã giao cho khách thành công"
              value={releasedHoldings.length}
              prefix={<CheckCircleOutlined style={{ color: '#10b981' }} />}
              suffix="kiện"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Thời hạn lưu trữ chuẩn"
              value={72}
              prefix={<ClockCircleOutlined style={{ color: '#f59e0b' }} />}
              suffix="giờ (3 ngày)"
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Cơ chế bảo mật"
              value="OTP + QR"
              prefix={<KeyOutlined style={{ color: '#8b5cf6' }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Tabs */}
      <Card style={{ borderRadius: '8px', border: '1px solid #e2e8f0' }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'holdings',
              label: (
                <span>
                  <InboxOutlined /> Danh Sách Kiện Đang Giữ ({activeHoldings.length})
                </span>
              ),
              children: (
                <Table
                  dataSource={holdings}
                  rowKey="id"
                  loading={loading}
                  pagination={{ pageSize: 8 }}
                  columns={[
                    {
                      title: 'Vị Trí Kệ',
                      dataIndex: 'holdingSlot',
                      key: 'holdingSlot',
                      render: (val) => <Tag color="geekblue" style={{ fontWeight: 'bold' }}>{val}</Tag>,
                    },
                    {
                      title: 'Mã Kiện Hàng',
                      dataIndex: ['package', 'packageCode'],
                      key: 'packageCode',
                      render: (val) => <Text strong copyable>{val}</Text>,
                    },
                    {
                      title: 'Đơn Bán Lẻ',
                      dataIndex: ['salesOrder', 'orderNumber'],
                      key: 'orderNumber',
                      render: (val, r) => (
                        <div>
                          <Text strong>{val}</Text>
                          <div style={{ fontSize: '11px', color: '#64748b' }}>
                            Khách: {r.salesOrder?.customerName} ({r.salesOrder?.customerPhone})
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: 'Mã OTP Nhận Hàng',
                      key: 'collectionTokenStatus',
                      render: (_, r) => {
                        const token = r.salesOrder?.collectionToken;
                        return token ? (
                          <Tag color={token.status === 'ACTIVE' ? 'purple' : 'default'}>
                            {token.status}
                          </Tag>
                        ) : (
                          <Tag color="default">Chưa sinh</Tag>
                        );
                      },
                    },
                    {
                      title: 'Bảo Quản',
                      dataIndex: 'storageCondition',
                      key: 'storageCondition',
                      render: (c) => <Tag color={c === 'COOL' ? 'cyan' : 'default'}>{c}</Tag>,
                    },
                    {
                      title: 'Trạng Thái',
                      dataIndex: 'status',
                      key: 'status',
                      render: (st) =>
                        st === 'HOLDING' ? (
                          <Tag color="processing">Đang lưu giữ</Tag>
                        ) : (
                          <Tag color="green">Đã giao khách</Tag>
                        ),
                    },
                    {
                      title: 'Thời Gian Nhận / Hết Hạn',
                      key: 'time',
                      render: (_, r) => (
                        <div style={{ fontSize: '12px' }}>
                          <div>Nhập: {new Date(r.receivedAt).toLocaleDateString('vi-VN')}</div>
                          <div style={{ color: '#ef4444' }}>
                            Hạn: {new Date(r.expiryDate).toLocaleDateString('vi-VN')}
                          </div>
                        </div>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'inbound',
              label: (
                <span>
                  <ScanOutlined /> Quét Nhập Kiện Vào Kệ (Inbound Scan)
                </span>
              ),
              children: (
                <div style={{ maxWidth: '600px', margin: '0 auto', padding: '16px 0' }}>
                  <Alert
                    type="info"
                    showIcon
                    message="Quy trình nhập kiện tại Điểm Nhận (R7-07)"
                    description="Quét mã vạch kiện PKG-xxx do tài xế bàn giao, chỉ định ô kệ lưu giữ. Khi toàn bộ kiện của đơn hàng đã nhập, hệ thống sẽ tự động kích hoạt mã nhận OTP/QR gửi cho khách hàng."
                    style={{ marginBottom: '20px' }}
                  />

                  <div style={{ marginBottom: '16px' }}>
                    <Text strong>Mã Vạch Kiện Hàng (Package Code):</Text>
                    <Input
                      size="large"
                      prefix={<ScanOutlined />}
                      value={scanPackageCode}
                      onChange={(e) => setScanPackageCode(e.target.value)}
                      placeholder="Quét mã PKG-20260923-xxxx..."
                      style={{ marginTop: '6px' }}
                    />
                  </div>

                  <Row gutter={16} style={{ marginBottom: '16px' }}>
                    <Col span={14}>
                      <Text strong>Chỉ Định Ô Kệ / Vị Trí Lưu Giữ:</Text>
                      <Select
                        size="large"
                        style={{ width: '100%', marginTop: '6px' }}
                        value={holdingSlotInput}
                        onChange={setHoldingSlotInput}
                        options={[
                          { label: 'KỆ-A1-01 (Tầng 1 - Hàng khô)', value: 'KỆ-A1-01' },
                          { label: 'KỆ-A1-02 (Tầng 1 - Hàng khô)', value: 'KỆ-A1-02' },
                          { label: 'KỆ-A2-01 (Tầng 2 - Hàng khô)', value: 'KỆ-A2-01' },
                          { label: 'TỦ-MÁT-C1 (Ngăn mát 10-15°C)', value: 'TỦ-MÁT-C1' },
                          { label: 'TỦ-MÁT-C2 (Ngăn mát 10-15°C)', value: 'TỦ-MÁT-C2' },
                        ]}
                      />
                    </Col>
                    <Col span={10}>
                      <Text strong>Yêu Cầu Bảo Quản:</Text>
                      <Select
                        size="large"
                        style={{ width: '100%', marginTop: '6px' }}
                        value={scanStorageCond}
                        onChange={setScanStorageCond}
                        options={[
                          { label: 'Nhiệt độ thường (AMBIENT)', value: 'AMBIENT' },
                          { label: 'Ngăn mát (COOL/CHILLED)', value: 'COOL' },
                        ]}
                      />
                    </Col>
                  </Row>

                  <Button
                    type="primary"
                    size="large"
                    block
                    icon={<CheckCircleOutlined />}
                    onClick={handleInboundScan}
                    style={{ background: '#1d4ed8' }}
                  >
                    Xác Nhận Nhập Kiện Vào Kệ
                  </Button>

                  {inboundResult && (
                    <Card style={{ marginTop: '20px', background: '#ecfdf5', borderColor: '#a7f3d0' }}>
                      <Alert
                        type="success"
                        message="Nhập kiện thành công!"
                        description={
                          <div>
                            <div>Trạng thái đơn hàng: <Tag color="green">{inboundResult.orderStatus}</Tag></div>
                            {inboundResult.credentialIssued && (
                              <div style={{ marginTop: '6px' }}>
                                <strong>Mã OTP nhận hàng phát sinh: </strong>
                                <Tag color="purple" style={{ fontSize: '14px', fontWeight: 'bold' }}>
                                  Credential issued
                                </Tag>
                              </div>
                            )}
                          </div>
                        }
                      />
                    </Card>
                  )}
                </div>
              ),
            },
            {
              key: 'verify',
              label: (
                <span>
                  <KeyOutlined /> Khách Nhận Hàng (Customer Collection)
                </span>
              ),
              children: (
                <div style={{ maxWidth: '600px', margin: '0 auto', padding: '16px 0' }}>
                  <Alert
                    type="success"
                    showIcon
                    message="Xác thực OTP/QR giao hàng an toàn (R7-09)"
                    description="Yêu cầu khách hàng xuất trình mã OTP 6 số hoặc quét mã QR nhận hàng. Hệ thống kiểm tra tính hợp lệ và giải phóng kiện hàng giao cho khách."
                    style={{ marginBottom: '20px' }}
                  />

                  <div style={{ marginBottom: '16px' }}>
                    <Text strong>ID Đơn Hàng:</Text>
                    <Input
                      size="large"
                      value={verifySalesOrderId}
                      onChange={(e) => setVerifySalesOrderId(e.target.value)}
                      placeholder="Nhập ID đơn hàng (UUID)..."
                      style={{ marginTop: '6px' }}
                    />
                  </div>

                  <div style={{ marginBottom: '16px' }}>
                    <Text strong>Mã OTP 6 Số (Khách Đọc):</Text>
                    <Input
                      size="large"
                      prefix={<KeyOutlined />}
                      value={verifyOtpInput}
                      onChange={(e) => setVerifyOtpInput(e.target.value)}
                      placeholder="Nhập 6 chữ số OTP (Ví dụ: 839201)..."
                      style={{ marginTop: '6px', fontSize: '18px', letterSpacing: '4px' }}
                      maxLength={6}
                    />
                  </div>

                  <div style={{ textAlign: 'center', margin: '12px 0', color: '#94a3b8' }}>- HOẶC -</div>

                  <div style={{ marginBottom: '20px' }}>
                    <Text strong>Quét Mã QR Khách Xuất Trình:</Text>
                    <Input
                      size="large"
                      prefix={<QrcodeOutlined />}
                      value={verifyQrInput}
                      onChange={(e) => setVerifyQrInput(e.target.value)}
                      placeholder="Quét chuỗi mã QR nhận hàng..."
                      style={{ marginTop: '6px' }}
                    />
                  </div>

                  <Button
                    type="primary"
                    size="large"
                    block
                    icon={<CheckCircleOutlined />}
                    onClick={handleVerifyCollection}
                    style={{ background: '#059669', borderColor: '#059669' }}
                  >
                    Xác Thực & Hoàn Tất Bàn Giao Cho Khách
                  </Button>

                  {verifyResult && (
                    <Card style={{ marginTop: '20px', background: '#f0fdf4', borderColor: '#86efac' }}>
                      <Alert
                        type="success"
                        message="Bàn giao khách hàng thành công!"
                        description={
                          <div>
                            <div>Mã biên bản: <strong>{verifyResult.collectionRecord?.collectionCode}</strong></div>
                            <div>Đơn hàng: <strong>{verifyResult.salesOrder?.orderNumber}</strong></div>
                            <div>Trạng thái đơn: <Tag color="green">{verifyResult.salesOrder?.status}</Tag></div>
                          </div>
                        }
                      />
                    </Card>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default PickupPointOpsPage;
