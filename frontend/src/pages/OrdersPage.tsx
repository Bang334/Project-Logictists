import React, { useEffect, useState } from 'react';
import {
  Table,
  Button,
  Tag,
  Space,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Typography,
  Card,
  AutoComplete,
  Divider,
  Alert,
  Col,
  Row,
  App as AntdApp,
} from 'antd';
import { EnvironmentOutlined, MinusCircleOutlined, PlusOutlined, ShoppingOutlined } from '@ant-design/icons';
import { customersApi, mapboxApi, ordersApi } from '../api/client';
import { Order } from '../types';

const { Title, Text } = Typography;

const OrdersPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [customers, setCustomers] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [form] = Form.useForm();

  // Autocomplete options for Mapbox geocoding
  const [pickupOptions, setPickupOptions] = useState<any[]>([]);
  const [deliveryOptions, setDeliveryOptions] = useState<any[]>([]);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const res = await ordersApi.getAll();
      setOrders(res.data);
    } catch (error) {
      message.error('Không thể tải danh sách đơn hàng');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchOrders();
    void customersApi.getAll().then((response) => setCustomers(response.data));
  }, []);

  const handleSearchAddress = async (query: string, type: 'pickup' | 'delivery') => {
    if (!query || query.length < 3) return;
    const results = await mapboxApi.geocode(query);
    const options = results.map((r: any) => ({
      value: r.address,
      label: r.address,
      lat: r.latitude,
      lng: r.longitude,
    }));

    if (type === 'pickup') {
      setPickupOptions(options);
    } else {
      setDeliveryOptions(options);
    }
  };

  const handleCreateOrder = async (values: any) => {
    try {
      setLoading(true);

      const pickupCoord = pickupOptions.find((o) => o.value === values.pickupAddress);
      const deliveryCoord = deliveryOptions.find((o) => o.value === values.deliveryAddress);

      const payload = {
        customerId: values.customerId,
        notes: values.notes,
        items: values.items.map((item: any) => ({
          ...item,
          volumeM3:
            (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
        })),
        stops: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: values.pickupAddress,
            latitude: pickupCoord?.lat || 0,
            longitude: pickupCoord?.lng || 0,
            contactName: values.pickupContactName,
            contactPhone: values.pickupContactPhone,
            serviceDurationMinutes: 20,
          },
          {
            type: 'DELIVERY',
            sequence: 2,
            address: values.deliveryAddress,
            latitude: deliveryCoord?.lat || 0,
            longitude: deliveryCoord?.lng || 0,
            contactName: values.deliveryContactName,
            contactPhone: values.deliveryContactPhone,
            serviceDurationMinutes: 20,
          },
        ],
      };

      await ordersApi.create(payload);
      message.success('Đã tạo đơn hàng mới vào cơ sở dữ liệu PostgreSQL!');
      setIsModalOpen(false);
      form.resetFields();
      fetchOrders();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Lỗi khi tạo đơn hàng');
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: 'Mã Vận Đơn',
      dataIndex: 'orderNumber',
      key: 'orderNumber',
      render: (text: string) => <strong style={{ color: '#0284c7' }}>{text}</strong>,
    },
    {
      title: 'Khách Hàng',
      key: 'customer',
      render: (_: any, r: Order) => (
        <div>
          <strong>{r.customer.name}</strong>
          <div style={{ color: '#64748b', fontSize: '12px' }}>{r.customer.code}</div>
        </div>
      ),
    },
    {
      title: 'Điểm Lấy Hàng (PICKUP)',
      key: 'pickup',
      render: (_: any, r: Order) => {
        const pickup = r.stops.find((s) => s.type === 'PICKUP');
        return (
          <div style={{ maxWidth: 220 }}>
            <Tag color="green" icon={<EnvironmentOutlined />}>Lấy hàng</Tag>
            <div style={{ fontSize: '12px', marginTop: '2px' }}>{pickup?.address}</div>
          </div>
        );
      },
    },
    {
      title: 'Điểm Giao Hàng (DELIVERY)',
      key: 'delivery',
      render: (_: any, r: Order) => {
        const delivery = r.stops.find((s) => s.type === 'DELIVERY');
        return (
          <div style={{ maxWidth: 220 }}>
            <Tag color="orange" icon={<EnvironmentOutlined />}>Giao hàng</Tag>
            <div style={{ fontSize: '12px', marginTop: '2px' }}>{delivery?.address}</div>
          </div>
        );
      },
    },
    {
      title: 'Khối Lượng / Thể Tích',
      key: 'load',
      render: (_: any, r: Order) => (
        <div>
          <strong>{r.totalWeightKg} kg</strong>
          <div style={{ color: '#64748b', fontSize: '12px' }}>{r.totalVolumeM3} m³ ({r.totalPackages} kiện)</div>
        </div>
      ),
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colors: Record<string, string> = {
          CONFIRMED: 'blue',
          ASSIGNED: 'gold',
          IN_TRANSIT: 'purple',
          COMPLETED: 'green',
        };
        return <Tag color={colors[status] || 'default'}>{status}</Tag>;
      },
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Quản Lý Đơn Hàng Vận Tải</Title>
          <Text type="secondary">Tiếp nhận đơn hàng, chuẩn hóa địa chỉ qua Mapbox Geocoding và chuẩn bị điều phối</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsModalOpen(true)}>
          Tạo Đơn Hàng Mới
        </Button>
      </div>

      <Card variant="borderless" className="card-elevation">
        <Table
          dataSource={orders}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 8 }}
        />
      </Card>

      {/* Modal Tạo Đơn Hàng */}
      <Modal
        title={
          <Space>
            <ShoppingOutlined style={{ color: '#1677ff' }} />
            <span>Tiếp Nhận Đơn Hàng Mới (Mapbox Verified)</span>
          </Space>
        }
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        footer={null}
        width={720}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateOrder} style={{ marginTop: '16px' }}>
          <Form.Item
            label="Khách Hàng Doanh Nghiệp"
            name="customerId"
            rules={[{ required: true, message: 'Chọn khách hàng' }]}
          >
            <Select placeholder="Chọn khách hàng">
              {customers.map((customer) => (
                <Select.Option key={customer.id} value={customer.id}>
                  {customer.code} — {customer.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: '13px' }}>1. Điểm Lấy Hàng (PICKUP)</Divider>
          <Form.Item
            label="Địa chỉ lấy hàng (Gợi ý tự động qua Mapbox)"
            name="pickupAddress"
            rules={[{ required: true, message: 'Nhập địa chỉ lấy hàng' }]}
          >
            <AutoComplete
              options={pickupOptions}
              onSearch={(val) => handleSearchAddress(val, 'pickup')}
              placeholder="Nhập tên đường, KCN, quận huyện (ví dụ: KCN Tiên Sơn Bắc Ninh)"
            />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item label="Người phụ trách lấy hàng" name="pickupContactName" initialValue="Thủ kho xuất">
              <Input placeholder="Tên người liên hệ" />
            </Form.Item>
            <Form.Item label="SĐT lấy hàng" name="pickupContactPhone" initialValue="0912345678">
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>2. Điểm Giao Hàng (DELIVERY)</Divider>
          <Form.Item
            label="Địa chỉ giao hàng (Gợi ý tự động qua Mapbox)"
            name="deliveryAddress"
            rules={[{ required: true, message: 'Nhập địa chỉ giao hàng' }]}
          >
            <AutoComplete
              options={deliveryOptions}
              onSearch={(val) => handleSearchAddress(val, 'delivery')}
              placeholder="Nhập địa chỉ nhận hàng (ví dụ: Cầu Giấy Hà Nội)"
            />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item label="Người nhận hàng" name="deliveryContactName" initialValue="Đại diện nhận hàng">
              <Input placeholder="Tên người nhận" />
            </Form.Item>
            <Form.Item label="SĐT nhận hàng" name="deliveryContactPhone" initialValue="0987654321">
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>3. Các loại hàng và kiện vật lý</Divider>
          <Alert
            type="info"
            showIcon
            message="Mỗi dòng là một loại hàng; số lượng là số kiện cùng kích thước. Khối lượng nhập là tổng của cả dòng."
            style={{ marginBottom: 12 }}
          />
          <Form.List name="items" initialValue={[{ quantity: 1, packageType: 'CARTON' }]}>
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    title={`Loại hàng ${index + 1}`}
                    extra={fields.length > 1 ? (
                      <Button danger type="text" icon={<MinusCircleOutlined />} onClick={() => remove(field.name)}>
                        Xóa
                      </Button>
                    ) : null}
                  >
                    <Row gutter={12}>
                      <Col xs={24} md={12}>
                        <Form.Item {...field} label="Mô tả" name={[field.name, 'description']} rules={[{ required: true, message: 'Nhập mô tả' }]}>
                          <Input placeholder="Ví dụ: Thùng sữa 48 hộp" />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item {...field} label="Loại kiện" name={[field.name, 'packageType']} rules={[{ required: true }]}>
                          <Select options={['CARTON', 'PALLET', 'CRATE', 'BAG'].map((value) => ({ value, label: value }))} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item {...field} label="Số kiện" name={[field.name, 'quantity']} rules={[{ required: true }]}>
                          <InputNumber min={1} max={500} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item {...field} label="Tổng kg của dòng" name={[field.name, 'weightKg']} rules={[{ required: true }]}>
                          <InputNumber min={0.1} precision={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item {...field} label="Dài/kiện (cm)" name={[field.name, 'lengthCm']} rules={[{ required: true }]}>
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item {...field} label="Rộng/kiện (cm)" name={[field.name, 'widthCm']} rules={[{ required: true }]}>
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item {...field} label="Cao/kiện (cm)" name={[field.name, 'heightCm']} rules={[{ required: true }]}>
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ quantity: 1, packageType: 'CARTON' })} block>
                  Thêm loại hàng khác
                </Button>
              </Space>
            )}
          </Form.List>

          <Form.Item label="Ghi chú đơn hàng" name="notes">
            <Input.TextArea rows={2} placeholder="Yêu cầu bảo quản, lưu ý khi dỡ hàng..." />
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Lưu Đơn Hàng Vào Hệ Thống
          </Button>
        </Form>
      </Modal>
    </div>
  );
};

export default OrdersPage;
