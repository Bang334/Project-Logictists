import React, { useCallback, useState, useEffect } from 'react';
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Input,
  Select,
  Row,
  Col,
  Typography,
  Modal,
  Form,
  InputNumber,
  App as AntdApp,
  Statistic,
  Image,
} from 'antd';
import {
  DatabaseOutlined,
  SearchOutlined,
  ReloadOutlined,
  PlusCircleOutlined,
  SlidersOutlined,
  CheckCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { getProductImage } from '../utils/demoAssets';

const { Title, Text } = Typography;
const { Option } = Select;

interface StockItem {
  id: string;
  skuId: string;
  locationId: string;
  skuCode: string;
  skuName: string;
  uom: string;
  productImage?: string;
  locationName: string;
  locationCode: string;
  onHand: number;
  reserved: number;
  safetyBuffer: number;
  sellable: number;
  damaged: number;
}

const InventoryPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [stockList, setStockList] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchText, setSearchText] = useState<string>('');
  const [locationFilter, setLocationFilter] = useState<string | undefined>(undefined);
  const [isReceiptModal, setIsReceiptModal] = useState<boolean>(false);
  const [isAdjustModal, setIsAdjustModal] = useState<boolean>(false);
  const [receiptForm] = Form.useForm();
  const [adjustForm] = Form.useForm();

  const fetchStock = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/inventory/balances', {
        params: {
          locationId: locationFilter || undefined,
        },
      });
      if (res.data?.data && res.data.data.length > 0) {
        const formatted = res.data.data.map((item: any) => {
          const skuCode = item.sku?.skuCode || item.skuId;
          const productCode = item.sku?.product?.code || skuCode;
          const imageUrl = item.sku?.product?.imageUrl;
          return {
            id: item.id,
            skuId: item.skuId,
            locationId: item.locationId,
            skuCode,
            skuName: item.sku?.name || 'Sản phẩm',
            uom: item.sku?.uom || 'Đơn vị',
            productImage: getProductImage(productCode, imageUrl),
            locationName: item.location?.name || 'Địa điểm',
            locationCode: item.location?.code || '',
            onHand: item.onHand,
            reserved: item.reserved,
            safetyBuffer: item.safetyBuffer,
            sellable: item.sellable,
            damaged: item.damaged,
          };
        });
        setStockList(formatted);
      } else {
        setStockList([]);
      }
    } catch (e: any) {
      setStockList([]);
      message.error(e.response?.data?.message || 'Không thể tải tồn kho');
    } finally {
      setLoading(false);
    }
  }, [locationFilter, message]);

  useEffect(() => {
    fetchStock();
  }, [fetchStock]);

  const handleReceiptSubmit = async (values: any) => {
    try {
      const stock = stockList.find((item) => item.id === values.stockId);
      if (!stock) return message.error('Vui lòng chọn SKU và địa điểm nhập');
      await apiClient.post('/inventory/receipts', {
        locationId: stock.locationId,
        supplierName: values.supplierName,
        idempotencyKey: `receipt_${crypto.randomUUID()}`,
        lines: [{ skuId: stock.skuId, quantity: values.quantity }],
      });
      message.success(`Đã tạo phiếu nhập kho thành công! Số lượng +${values.quantity}`);
      setIsReceiptModal(false);
      receiptForm.resetFields();
      fetchStock();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể tạo phiếu nhập kho');
    }
  };

  const handleAdjustSubmit = async (values: any) => {
    try {
      const stock = stockList.find((item) => item.id === values.stockId);
      if (!stock) return message.error('Vui lòng chọn SKU và địa điểm điều chỉnh');
      await apiClient.post('/inventory/adjustments', {
        locationId: stock.locationId,
        reason: values.reason,
        note: values.note,
        idempotencyKey: `adjustment_${crypto.randomUUID()}`,
        lines: [{ skuId: stock.skuId, deltaQuantity: values.delta }],
      });
      message.success(`Đã ghi nhận điều chỉnh tồn kho (${values.reason}) thành công!`);
      setIsAdjustModal(false);
      adjustForm.resetFields();
      fetchStock();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể điều chỉnh tồn kho');
    }
  };

  const filteredStock = stockList.filter((item) => {
    const matchSearch =
      !searchText ||
      item.skuName.toLowerCase().includes(searchText.toLowerCase()) ||
      item.skuCode.toLowerCase().includes(searchText.toLowerCase()) ||
      item.locationName.toLowerCase().includes(searchText.toLowerCase());
    return matchSearch;
  });

  // Thống kê nhanh
  const totalOnHand = filteredStock.reduce((acc, curr) => acc + curr.onHand, 0);
  const totalReserved = filteredStock.reduce((acc, curr) => acc + curr.reserved, 0);
  const totalSellable = filteredStock.reduce((acc, curr) => acc + curr.sellable, 0);

  const availableLocations = Array.from(
    new Map(
      stockList.map((item) => [
        item.locationId,
        { id: item.locationId, name: item.locationName, code: item.locationCode },
      ]),
    ).values(),
  );

  const columns = [
    {
      title: 'Ảnh',
      key: 'image',
      width: 76,
      align: 'center' as const,
      render: (_: any, record: StockItem) => (
        <Image
          src={record.productImage}
          alt={record.skuName}
          width={50}
          height={50}
          fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='50' height='50'%3E%3Crect width='50' height='50' rx='8' fill='%23e2e8f0'/%3E%3C/svg%3E"
          style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }}
          preview={true}
        />
      ),
    },
    {
      title: 'Mã SKU / Mặt Hàng',
      key: 'sku',
      width: 220,
      render: (_: any, record: StockItem) => (
        <div style={{ maxWidth: 210 }}>
          <Text strong style={{ color: '#1e40af', fontSize: '13px' }}>{record.skuCode}</Text>
          <div style={{ fontSize: '13px', lineHeight: '1.35', color: '#1e293b', marginTop: 2, marginBottom: 4 }}>
            {record.skuName}
          </div>
          <Tag color="purple">{record.uom}</Tag>
        </div>
      ),
    },
    {
      title: 'Kho / Cửa Hàng (Location)',
      key: 'location',
      width: 190,
      render: (_: any, record: StockItem) => (
        <div style={{ maxWidth: 180 }}>
          <Text strong style={{ fontSize: '13px', lineHeight: '1.35' }}>{record.locationName}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: '12px' }}>{record.locationCode}</Text>
        </div>
      ),
    },
    {
      title: 'Tồn Vật Lý (On-Hand)',
      dataIndex: 'onHand',
      key: 'onHand',
      width: 120,
      align: 'right' as const,
      render: (val: number) => (
        <Text strong style={{ fontSize: '15px' }}>
          {val.toLocaleString('vi-VN')}
        </Text>
      ),
    },
    {
      title: 'Đang Giữ (Reserved)',
      dataIndex: 'reserved',
      key: 'reserved',
      width: 110,
      align: 'right' as const,
      render: (val: number) => (
        <Tag color="orange" style={{ fontSize: '13px', padding: '2px 8px' }}>
          {val.toLocaleString('vi-VN')}
        </Tag>
      ),
    },
    {
      title: 'Đệm An Toàn',
      dataIndex: 'safetyBuffer',
      key: 'safetyBuffer',
      width: 105,
      align: 'right' as const,
      render: (val: number) => (
        <Tag color="default">{val}</Tag>
      ),
    },
    {
      title: 'Khả Dụng Bán (Sellable)',
      dataIndex: 'sellable',
      key: 'sellable',
      width: 130,
      align: 'right' as const,
      render: (val: number) => (
        <Tag
          color={val > 0 ? 'green' : 'red'}
          style={{ fontSize: '14px', fontWeight: 'bold', padding: '2px 10px' }}
        >
          {val.toLocaleString('vi-VN')}
        </Tag>
      ),
    },
  ];

  return (
    <div className="tms-page">
      <Row justify="space-between" align="middle" className="tms-page-header" gutter={[16, 16]}>
        <Col>
          <Text className="tms-page-eyebrow">Inventory · Single source of truth</Text>
          <Title level={3} style={{ margin: 0 }}>
            <DatabaseOutlined style={{ marginRight: 8, color: '#2563eb' }} />
            Quản Lý Tồn Kho & Chuyển Kho Nhẹ (Inventory SOT)
          </Title>
          <Text type="secondary">
            Kiểm soát số dư tồn kho bất biến (Single Source of Truth), vùng đệm an toàn và giữ hàng chống oversell
          </Text>
        </Col>
        <Col>
          <Space wrap className="tms-page-actions">
            <Button icon={<ReloadOutlined />} onClick={fetchStock} loading={loading}>
              Làm mới
            </Button>
            <Button
              icon={<SlidersOutlined />}
              onClick={() => setIsAdjustModal(true)}
            >
              Kiểm Kê / Điều Chỉnh
            </Button>
            <Button
              type="primary"
              icon={<PlusCircleOutlined />}
              onClick={() => setIsReceiptModal(true)}
            >
              Nhập Hàng Đầu Kỳ
            </Button>
          </Space>
        </Col>
      </Row>

      {/* Thẻ thống kê nhanh */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={24} sm={8}>
          <Card style={{ borderRadius: 8 }}>
            <Statistic
              title="Tổng Tồn Vật Lý (On-Hand)"
              value={totalOnHand}
              valueStyle={{ color: '#1e293b' }}
              prefix={<DatabaseOutlined style={{ color: '#2563eb', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ borderRadius: 8 }}>
            <Statistic
              title="Đang Giữ Cho Đơn Hàng (Reserved)"
              value={totalReserved}
              valueStyle={{ color: '#ea580c' }}
              prefix={<WarningOutlined style={{ color: '#ea580c', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ borderRadius: 8 }}>
            <Statistic
              title="Khả Dụng Bán Ra Khách (Sellable)"
              value={totalSellable}
              valueStyle={{ color: '#16a34a' }}
              prefix={<CheckCircleOutlined style={{ color: '#16a34a', marginRight: 8 }} />}
            />
          </Card>
        </Col>
      </Row>

      <Card style={{ marginBottom: 20, borderRadius: 8 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={14}>
            <Input
              placeholder="Tìm kiếm theo mã SKU, tên mặt hàng hoặc tên địa điểm..."
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
          </Col>
          <Col xs={24} md={10}>
            <Select
              style={{ width: '100%' }}
              placeholder="Lọc theo điểm bán / kho bãi"
              allowClear
              value={locationFilter}
              onChange={(val) => setLocationFilter(val)}
            >
              {availableLocations.map((loc) => (
                <Option key={loc.id} value={loc.id}>
                  {loc.name} {loc.code ? `(${loc.code})` : ''}
                </Option>
              ))}
            </Select>
          </Col>
        </Row>
      </Card>

      <Card style={{ borderRadius: 8 }}>
        <Table
          columns={columns}
          dataSource={filteredStock}
          rowKey="id"
          loading={loading}
          scroll={{ x: 950 }}
          pagination={{ pageSize: 8, showTotal: (total) => `Tổng cộng ${total} mục tồn kho` }}
        />
      </Card>

      {/* Modal Nhập hàng */}
      <Modal
        title="Tạo Phiếu Nhập Kho (Stock Receipt)"
        open={isReceiptModal}
        onCancel={() => setIsReceiptModal(false)}
        footer={null}
      >
        <Form form={receiptForm} layout="vertical" onFinish={handleReceiptSubmit}>
          <Form.Item name="stockId" label="SKU / Địa Điểm" rules={[{ required: true, message: 'Chọn SKU và địa điểm' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stockList.map((item) => ({
                value: item.id,
                label: `${item.skuCode} — ${item.locationName}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="supplierName" label="Nhà Cung Cấp" initialValue="Tập đoàn Thép Hòa Phát / Vicem">
            <Input />
          </Form.Item>
          <Form.Item name="quantity" label="Số Lượng Nhập" rules={[{ required: true, message: 'Nhập số lượng' }]}>
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setIsReceiptModal(false)}>Hủy</Button>
              <Button type="primary" htmlType="submit" style={{ background: '#2563eb' }}>
                Xác Nhận Nhập
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal Điều chỉnh tồn kho */}
      <Modal
        title="Điều Chỉnh Tồn Kho / Kiểm Kê (Stock Adjustment)"
        open={isAdjustModal}
        onCancel={() => setIsAdjustModal(false)}
        footer={null}
      >
        <Form form={adjustForm} layout="vertical" onFinish={handleAdjustSubmit}>
          <Form.Item name="stockId" label="SKU / Địa Điểm" rules={[{ required: true, message: 'Chọn SKU và địa điểm' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stockList.map((item) => ({
                value: item.id,
                label: `${item.skuCode} — ${item.locationName}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="Lý Do Điều Chỉnh" initialValue="COUNT_DISCREPANCY">
            <Select>
              <Option value="COUNT_DISCREPANCY">Chênh lệch kiểm kê thực tế</Option>
              <Option value="DAMAGE">Hàng hư hỏng / bể vỡ</Option>
              <Option value="EXPIRY">Hàng hết hạn sử dụng</Option>
              <Option value="LOSS">Hao hụt thất thoát</Option>
            </Select>
          </Form.Item>
          <Form.Item name="delta" label="Số Lượng Chênh Lệch (+ hoặc -)" rules={[{ required: true, message: 'Nhập chênh lệch' }]}>
            <InputNumber style={{ width: '100%' }} placeholder="Ví dụ: -2 hoặc +5" />
          </Form.Item>
          <Form.Item name="note" label="Ghi Chú Chi Tiết">
            <Input.TextArea rows={2} placeholder="Biên bản kiểm kê số..." />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setIsAdjustModal(false)}>Hủy</Button>
              <Button type="primary" htmlType="submit" style={{ background: '#2563eb' }}>
                Lưu Điều Chỉnh
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default InventoryPage;
