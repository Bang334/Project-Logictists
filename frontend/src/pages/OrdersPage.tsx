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
  message,
  Typography,
  Card,
  AutoComplete,
  Divider,
} from 'antd';
import { PlusOutlined, ShoppingOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { ordersApi, mapboxApi } from '../api/client';
import { Order } from '../types';

const { Title, Text } = Typography;

const OrdersPage: React.FC = () => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
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
    fetchOrders();
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
        items: [
          {
            description: values.itemDescription,
            quantity: values.itemQuantity,
            weightKg: values.itemWeightKg,
            lengthCm: values.lengthCm || 50,
            widthCm: values.widthCm || 40,
            heightCm: values.heightCm || 30,
            volumeM3: values.volumeM3 || 0.5,
          },
        ],
        stops: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: values.pickupAddress,
            latitude: pickupCoord?.lat || 21.0285,
            longitude: pickupCoord?.lng || 105.8542,
            contactName: values.pickupContactName,
            contactPhone: values.pickupContactPhone,
            serviceDurationMinutes: 20,
          },
          {
            type: 'DELIVERY',
            sequence: 2,
            address: values.deliveryAddress,
            latitude: deliveryCoord?.lat || 21.0312,
            longitude: deliveryCoord?.lng || 105.7871,
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

      <Card bordered={false} className="card-elevation">
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
              <Select.Option value="7cb8f31a-0ad8-4c9d-a03c-c9acb1599299">
                Vinamilk - Công ty CP Sữa Việt Nam
              </Select.Option>
              <Select.Option value="9caa8ada-eeec-471c-93ff-aeb630ebfcdd">
                Sunhouse - Tập đoàn Sunhouse
              </Select.Option>
              <Select.Option value="d0952c52-e5ac-4121-a830-d4fe93fe8e6d">
                Panasonic - Công ty TNHH Panasonic Việt Nam
              </Select.Option>
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

          <Divider orientation="left" style={{ fontSize: '13px' }}>3. Chi Tiết Kiện Hàng & Trọng Tải</Divider>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' }}>
            <Form.Item label="Tên/Mô tả hàng hóa" name="itemDescription" rules={[{ required: true }]}>
              <Input placeholder="Ví dụ: Thùng sữa chua 48 hộp" />
            </Form.Item>
            <Form.Item label="Số lượng kiện" name="itemQuantity" initialValue={50} rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="Khối lượng (kg)" name="itemWeightKg" initialValue={650} rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          </div>

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
