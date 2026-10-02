import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  CloseCircleOutlined,
  CompassOutlined,
  EnvironmentOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  ShoppingOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { MapLocationPickerModal } from '../components/MapLocationPickerModal';
import { getProductImage } from '../utils/demoAssets';
import { ExpandableText } from '../components/ExpandableText';

const { Title, Text } = Typography;

interface OrderStop {
  id: string;
  type: 'PICKUP' | 'DELIVERY';
  address: string;
  latitude?: number;
  longitude?: number;
}

interface SalesOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod?: string;
  totalAmount: string | number;
  createdAt: string;
  customer: { name: string; phone?: string; address?: string };
  selectedPickupPoint?: { id: string; name: string; address: string };
  allocatedSource?: { id: string; name: string };
  stops?: OrderStop[];
  items: Array<{
    id: string;
    sku: string;
    description: string;
    quantity: number;
    unitPrice: string | number;
    lineTotal: string | number;
  }>;
  events?: Array<{ id: string; eventType: string; occurredAt: string }>;
}

interface CatalogSku {
  id: string;
  skuCode: string;
  name: string;
  uom: string;
  salePrice: number | string;
}

interface CatalogProduct {
  id: string;
  name: string;
  code: string;
  imageUrl?: string;
  skus: CatalogSku[];
}

interface LocationItem {
  id: string;
  name: string;
  address: string;
  type: string;
}

const statusLabel: Record<string, { color: string; text: string }> = {
  DRAFT: { color: 'default', text: 'Nháp' },
  CONFIRMED: { color: 'blue', text: 'Đã xác nhận' },
  ASSIGNED: { color: 'purple', text: 'Đã chọn nguồn' },
  IN_TRANSIT: { color: 'cyan', text: 'Đang vận chuyển' },
  COMPLETED: { color: 'green', text: 'Hoàn tất' },
  CANCELLED: { color: 'red', text: 'Đã hủy' },
};

const money = (value: string | number) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(Number(value));

export const RetailOrdersPage: React.FC = () => {
  const { message, modal } = AntdApp.useApp();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>();
  const [selected, setSelected] = useState<SalesOrder>();
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Modal bản đồ cho điểm giao
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [deliveryCoord, setDeliveryCoord] = useState<{ lat: number; lng: number } | null>(null);

  const key = useRef(crypto.randomUUID());
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orderRes, catalogRes, locationRes] = await Promise.all([
        apiClient.get('/sales-orders', { params: { status, limit: 100 } }),
        apiClient.get('/catalog/products', { params: { limit: 100 } }),
        apiClient.get('/locations'),
      ]);
      setOrders(orderRes.data?.data ?? []);
      setProducts(catalogRes.data?.data ?? []);
      setLocations(locationRes.data ?? []);
    } catch (error: any) {
      setOrders([]);
      message.error(error.response?.data?.message || 'Không thể tải đơn bán hàng');
    } finally {
      setLoading(false);
    }
  }, [message, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const skuToImageMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) {
      if (p.imageUrl) {
        map.set(p.code, p.imageUrl);
        for (const s of p.skus || []) {
          map.set(s.skuCode, p.imageUrl);
          map.set(s.id, p.imageUrl);
        }
      }
    }
    return map;
  }, [products]);

  const skuOptions = useMemo(() => {
    return products.flatMap((product) =>
      product.skus.map((sku) => ({
        value: sku.id,
        label: `${product.name} - ${sku.name} (${money(sku.salePrice)} / ${sku.uom})`,
        imageUrl: getProductImage(product.code, product.imageUrl),
      })),
    );
  }, [products]);

  const handleSelectMapLocation = (loc: { address: string; latitude: number; longitude: number }) => {
    setDeliveryCoord({ lat: loc.latitude, lng: loc.longitude });
    form.setFieldsValue({
      deliveryAddress: loc.address,
    });
    message.success('Đã cập nhật địa chỉ và tọa độ bản đồ Mapbox!');
  };

  const checkout = async (values: any) => {
    setSubmitting(true);
    try {
      await apiClient.post('/sales-orders/checkout', {
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        deliveryAddress: values.deliveryAddress,
        deliveryLatitude: deliveryCoord?.lat,
        deliveryLongitude: deliveryCoord?.lng,
        fulfillmentSourceId: values.sourceLocationId || undefined,
        paymentMethod: 'MANUAL_PENDING',
        idempotencyKey: key.current,
        items: [{ skuId: values.skuId, quantity: values.quantity }],
      });
      message.success('Đã tạo thành công đơn bán hàng giao tận nơi!');
      setCheckoutOpen(false);
      form.resetFields();
      setDeliveryCoord(null);
      key.current = crypto.randomUUID();
      await load();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể tạo đơn hàng');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = (order: SalesOrder) =>
    modal.confirm({
      title: `Hủy ${order.orderNumber}?`,
      content: 'Tồn kho đã giữ sẽ được trả lại trong cùng transaction.',
      okType: 'danger',
      okText: 'Hủy đơn',
      cancelText: 'Đóng',
      onOk: async () => {
        await apiClient.post(`/sales-orders/${order.id}/cancel`, {
          reason: 'Hủy trên giao diện quản trị',
          idempotencyKey: crypto.randomUUID(),
        });
        message.success('Đã hủy đơn và hoàn trả tồn kho');
        await load();
      },
    });

  return (
    <div className="tms-page">
      <Row justify="space-between" align="middle" style={{ marginBottom: 20 }}>
        <Col>
          <Title level={3} style={{ margin: 0 }}>
            <ShoppingOutlined style={{ marginRight: 8, color: '#16a34a' }} />
            Đơn Bán Hàng & Giao Chân Công Trình
          </Title>
          <Text type="secondary">
            Quản lý đơn hàng vật liệu xây dựng, địa chỉ giao tận nơi và điều phối vận tải.
          </Text>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              Làm mới
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setCheckoutOpen(true);
                setDeliveryCoord(null);
              }}
              style={{ background: '#16a34a' }}
            >
              Tạo đơn giao hàng
            </Button>
          </Space>
        </Col>
      </Row>

      <Card style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="Lọc trạng thái đơn"
          style={{ width: 240 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(statusLabel).map(([value, item]) => ({ value, label: item.text }))}
        />
      </Card>

      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={orders}
          scroll={{ x: 1020 }}
          columns={[
            {
              title: 'Mã đơn',
              dataIndex: 'orderNumber',
              width: 140,
              render: (value: string) => <Text strong>{value}</Text>,
            },
            {
              title: 'Khách hàng',
              width: 200,
              render: (_, order) => (
                <ExpandableText
                  text={order.customer?.name || 'Khách vãng lai'}
                  maxChars={24}
                  strong
                  maxWidth={190}
                  subText={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {order.customer?.phone || '—'}
                    </Text>
                  }
                />
              ),
            },
            {
              title: 'Điểm giao hàng / Chân công trình',
              width: 270,
              render: (_, order) => {
                const deliveryStop = order.stops?.find((s) => s.type === 'DELIVERY');
                const pickupStop = order.stops?.find((s) => s.type === 'PICKUP');
                const addr = deliveryStop?.address || order.customer?.address || order.selectedPickupPoint?.address;

                return (
                  <div>
                    {addr ? (
                      <ExpandableText
                        text={addr}
                        maxChars={32}
                        maxWidth={260}
                        prefix={<EnvironmentOutlined style={{ color: '#ef4444', marginRight: 4 }} />}
                        style={{ fontSize: 13, color: '#0f172a' }}
                        subText={
                          pickupStop ? (
                            <ExpandableText
                              text={`Kho xuất: ${pickupStop.address}`}
                              maxChars={28}
                              maxWidth={250}
                              style={{ fontSize: 11, color: '#64748b' }}
                            />
                          ) : null
                        }
                      />
                    ) : (
                      <Text type="secondary">Chưa xác định điểm giao</Text>
                    )}
                  </div>
                );
              },
            },
            {
              title: 'Tổng tiền',
              dataIndex: 'totalAmount',
              width: 130,
              align: 'right',
              render: money,
            },
            {
              title: 'Trạng thái',
              dataIndex: 'status',
              width: 140,
              render: (value: string) => (
                <Tag color={statusLabel[value]?.color}>{statusLabel[value]?.text || value}</Tag>
              ),
            },
            {
              title: 'Thao tác',
              width: 140,
              render: (_, order) => (
                <Space>
                  <Button icon={<EyeOutlined />} onClick={() => setSelected(order)}>
                    Chi tiết
                  </Button>
                  {!['IN_TRANSIT', 'COMPLETED', 'CANCELLED'].includes(order.status) && (
                    <Button danger icon={<CloseCircleOutlined />} onClick={() => cancel(order)}>
                      Hủy
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* Modal Chi tiết Đơn hàng */}
      <Modal
        title={`Chi tiết đơn: ${selected?.orderNumber}`}
        open={!!selected}
        onCancel={() => setSelected(undefined)}
        footer={null}
        width={780}
      >
        {selected && (
          <>
            <div style={{ background: '#f8fafc', padding: 12, borderRadius: 8, marginBottom: 16 }}>
              <Row gutter={[16, 8]}>
                <Col span={12}>
                  <Text type="secondary">Khách hàng:</Text>
                  <div>
                    <b>{selected.customer?.name}</b> — {selected.customer?.phone}
                  </div>
                </Col>
                <Col span={12}>
                  <Text type="secondary">Trạng thái:</Text>
                  <div>
                    <Tag color={statusLabel[selected.status]?.color}>
                      {statusLabel[selected.status]?.text || selected.status}
                    </Tag>
                  </div>
                </Col>
                {selected.stops && selected.stops.length > 0 && (
                  <Col span={24}>
                    <Text type="secondary">Lộ trình giao nhận:</Text>
                    <div style={{ marginTop: 4 }}>
                      {selected.stops.map((s, idx) => (
                        <div key={s.id || idx} style={{ marginBottom: 4 }}>
                          <Tag color={s.type === 'PICKUP' ? 'blue' : 'green'}>
                            {s.type === 'PICKUP' ? 'Lấy hàng' : 'Giao hàng'}
                          </Tag>
                          <Text>{s.address}</Text>
                        </div>
                      ))}
                    </div>
                  </Col>
                )}
              </Row>
            </div>

            <Table
              rowKey="id"
              pagination={false}
              dataSource={selected.items}
              columns={[
                {
                  title: 'Ảnh',
                  key: 'image',
                  width: 55,
                  render: (_, item) => (
                    <img
                      src={getProductImage(item.sku, skuToImageMap.get(item.sku))}
                      alt=""
                      width={36}
                      height={36}
                      style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #e2e8f0' }}
                    />
                  ),
                },
                { title: 'SKU', dataIndex: 'sku' },
                { title: 'Mặt hàng', dataIndex: 'description' },
                { title: 'Số lượng', dataIndex: 'quantity' },
                { title: 'Đơn giá', dataIndex: 'unitPrice', align: 'right', render: money },
                { title: 'Thành tiền', dataIndex: 'lineTotal', align: 'right', render: money },
              ]}
            />
            <Timeline
              style={{ marginTop: 24 }}
              items={(selected.events ?? []).map((event) => ({
                children: (
                  <>
                    <b>{event.eventType}</b> — {new Date(event.occurredAt).toLocaleString('vi-VN')}
                  </>
                ),
              }))}
            />
          </>
        )}
      </Modal>

      {/* Modal Tạo đơn bán hàng & giao chân công trình */}
      <Modal
        title="Tạo Đơn Bán Hàng & Giao Chân Công Trình"
        open={checkoutOpen}
        onCancel={() => setCheckoutOpen(false)}
        footer={null}
        width={680}
      >
        <Form form={form} layout="vertical" onFinish={checkout}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="customerName"
                label="Tên khách hàng / Đơn vị thi công"
                rules={[{ required: true, message: 'Nhập tên khách hàng' }]}
              >
                <Input placeholder="Ví dụ: Công ty XD Nam Thăng Long" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="customerPhone"
                label="Số điện thoại"
                rules={[{ required: true, message: 'Nhập số điện thoại' }]}
              >
                <Input placeholder="0912345678" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label="Địa chỉ giao hàng / Chân công trình"
            required
            extra="Nhập trực tiếp hoặc bấm nút 'Chọn trên bản đồ' để di chuyển ghim đỏ."
          >
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="deliveryAddress"
                noStyle
                rules={[{ required: true, message: 'Nhập địa chỉ giao hàng' }]}
              >
                <Input
                  placeholder="Nhập số nhà, tên đường, khu công nghiệp..."
                  style={{ width: 'calc(100% - 170px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                icon={<CompassOutlined />}
                onClick={() => setIsMapOpen(true)}
                style={{ width: '170px', background: '#0284c7' }}
              >
                📍 Chọn trên bản đồ
              </Button>
            </Space.Compact>

            {deliveryCoord && (
              <div style={{ marginTop: 6 }}>
                <Tag color="cyan" icon={<AimOutlined />}>
                  Tọa độ đã ghim: {deliveryCoord.lat.toFixed(5)}, {deliveryCoord.lng.toFixed(5)}
                </Tag>
              </div>
            )}
          </Form.Item>

          <Row gutter={12}>
            <Col span={16}>
              <Form.Item
                name="skuId"
                label="Mặt hàng vật liệu xây dựng"
                rules={[{ required: true, message: 'Chọn mặt hàng' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Chọn sản phẩm VLXD"
                  options={skuOptions}
                  optionRender={(option) => {
                    const item = skuOptions.find((s) => s.value === option.value);
                    return (
                      <Space align="center" style={{ padding: '2px 0' }}>
                        <img
                          src={item?.imageUrl}
                          alt=""
                          width={32}
                          height={32}
                          style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #e2e8f0' }}
                        />
                        <span>{option.label}</span>
                      </Space>
                    );
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="quantity"
                label="Số lượng"
                initialValue={10}
                rules={[{ required: true, message: 'Nhập số lượng' }]}
              >
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="sourceLocationId"
            label="Tổng kho / Showroom xuất hàng (Tùy chọn)"
            extra="Để trống để hệ thống TMS tự động phân bổ nguồn hàng tối ưu khoảng cách."
          >
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Hệ thống tự động chọn Tổng kho tối ưu"
              options={locations.map((loc) => ({
                value: loc.id,
                label: `${loc.name} — ${loc.address}`,
              }))}
            />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            style={{ background: '#16a34a', height: 44, fontWeight: 600 }}
          >
            Xác Nhận Tạo Đơn & Chuyển Điều Phối TMS
          </Button>
        </Form>
      </Modal>

      {/* Modal bản đồ tương tác Mapbox */}
      <MapLocationPickerModal
        open={isMapOpen}
        title="Chọn Vị Trí Giao Hàng Trên Bản Đồ"
        initialLocation={{
          address: form.getFieldValue('deliveryAddress'),
          latitude: deliveryCoord?.lat || 21.0285,
          longitude: deliveryCoord?.lng || 105.8542,
        }}
        onCancel={() => setIsMapOpen(false)}
        onSelectLocation={handleSelectMapLocation}
      />
    </div>
  );
};

export default RetailOrdersPage;
