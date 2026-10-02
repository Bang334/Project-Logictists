import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Row,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
  App as AntdApp,
  Divider,
} from 'antd';
import {
  EnvironmentOutlined,
  CompassOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  CarOutlined,
  CheckCircleOutlined,
  AimOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { getProductImage } from '../utils/demoAssets';
import { MapLocationPickerModal } from '../components/MapLocationPickerModal';

const { Title, Text } = Typography;

interface CatalogSku {
  id: string;
  skuCode: string;
  name: string;
  uom: string;
  storageCondition: string;
  salePrice: number | string;
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  isSellable: boolean;
}

interface CatalogProduct {
  id: string;
  code: string;
  name: string;
  brand?: string;
  imageUrl?: string;
  category?: {
    id: string;
    code: string;
    name: string;
  };
  skus: CatalogSku[];
}

interface FulfillmentLocation {
  id: string;
  code: string;
  name: string;
  type: string;
  address: string;
}

interface OrderStop {
  id: string;
  type: 'PICKUP' | 'DELIVERY';
  address: string;
  latitude?: number;
  longitude?: number;
}

interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount?: number | string;
  grandTotal?: number | string;
  createdAt: string;
  stops?: OrderStop[];
  items?: Array<{
    id: string;
    sku: string;
    description: string;
    quantity: number;
    unitPrice: number | string;
    lineTotal: number | string;
  }>;
}

interface CheckoutFormValues {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  fulfillmentSourceId?: string;
  skuId: string;
  quantity: number;
}

const money = (value: number | string | undefined) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(Number(value || 0));

export const CustomerPortalPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const [form] = Form.useForm<CheckoutFormValues>();

  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [locations, setLocations] = useState<FulfillmentLocation[]>([]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  // Bản đồ & tọa độ giao hàng
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [deliveryCoord, setDeliveryCoord] = useState<{ lat: number; lng: number } | null>(null);

  // Tính toán tải trọng theo thời gian thực
  const selectedSkuId = Form.useWatch('skuId', form);
  const selectedQuantity = Form.useWatch('quantity', form) || 1;

  const idempotencyKey = useRef(`checkout_${crypto.randomUUID()}`);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [catalogRes, locationsRes, ordersRes] = await Promise.all([
        apiClient.get('/catalog/products', { params: { limit: 100 } }),
        apiClient.get('/locations'),
        apiClient.get('/sales-orders', { params: { limit: 20 } }),
      ]);

      setProducts(catalogRes.data?.data ?? []);
      setLocations(locationsRes.data ?? []);
      setOrders(ordersRes.data?.data ?? []);
    } catch (error: any) {
      setLoadError(error.response?.data?.message || 'Không thể tải dữ liệu mua hàng và kho bãi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

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

  // Gom danh sách SKU VLXD (không hiển thị kích thước, tải trọng kỹ thuật cho khách hàng)
  const skuOptions = useMemo(() => {
    return products.flatMap((product) =>
      product.skus
        .filter((sku) => sku.isSellable)
        .map((sku) => ({
          value: sku.id,
          label: `[${product.category?.name || 'VLXD'}] ${sku.name} — ${money(sku.salePrice)} / ${sku.uom}`,
          productName: product.name,
          categoryName: product.category?.name || 'Vật liệu xây dựng',
          skuCode: sku.skuCode,
          skuName: sku.name,
          price: sku.salePrice,
          uom: sku.uom,
          imageUrl: getProductImage(product.code, product.imageUrl),
        })),
    );
  }, [products]);

  // Tìm SKU đang được người dùng chọn
  const currentSku = useMemo(() => {
    return skuOptions.find((item) => item.value === selectedSkuId);
  }, [skuOptions, selectedSkuId]);

  const orderSummary = useMemo(() => {
    if (!currentSku) return null;
    const qty = Number(selectedQuantity) || 1;
    return {
      totalPrice: Number(currentSku.price) * qty,
    };
  }, [currentSku, selectedQuantity]);

  // Khi người dùng chọn và xác nhận tọa độ từ MapLocationPickerModal
  const handleSelectMapLocation = (loc: { address: string; latitude: number; longitude: number }) => {
    setDeliveryCoord({ lat: loc.latitude, lng: loc.longitude });
    form.setFieldsValue({
      deliveryAddress: loc.address,
      deliveryLatitude: loc.latitude,
      deliveryLongitude: loc.longitude,
    });
    message.success('Đã cập nhật địa chỉ và tọa độ ghim trên bản đồ!');
  };

  const submitOrder = async (values: CheckoutFormValues) => {
    setSubmitting(true);
    try {
      const response = await apiClient.post<CustomerOrder>('/sales-orders/checkout', {
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        deliveryAddress: values.deliveryAddress,
        deliveryLatitude: deliveryCoord?.lat || values.deliveryLatitude,
        deliveryLongitude: deliveryCoord?.lng || values.deliveryLongitude,
        fulfillmentSourceId: values.fulfillmentSourceId || undefined,
        paymentMethod: 'MANUAL_PENDING',
        idempotencyKey: idempotencyKey.current,
        items: [{ skuId: values.skuId, quantity: values.quantity }],
      });

      message.success(`Đã tạo thành công đơn hàng ${response.data.orderNumber} giao tận chân công trình!`);
      idempotencyKey.current = `checkout_${crypto.randomUUID()}`;
      form.resetFields(['skuId', 'quantity']);
      await loadPage();
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể đặt hàng. Dữ liệu trong biểu mẫu vẫn được giữ nguyên.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 24 }} role="status" aria-live="polite">
        <Skeleton active paragraph={{ rows: 10 }} />
      </div>
    );
  }

  return (
    <main className="tms-page" style={{ maxWidth: 1240 }}>
      {/* Header trang */}
      <Space direction="vertical" size={4} style={{ marginBottom: 20 }}>
        <Title level={2} style={{ margin: 0 }}>
          <ShoppingCartOutlined style={{ color: '#16a34a', marginRight: 8 }} />
          Đặt Mua Vật Liệu Xây Dựng & Giao Tận Chân Công Trình
        </Title>
        <Text type="secondary" style={{ fontSize: 14 }}>
          Cung cấp sắt thép, gạch ốp lát, cửa cuốn, sơn, xi măng. Nhập địa chỉ hoặc di chuyển ghim trên bản đồ để nhận hàng trực tiếp tại địa chỉ công trình.
        </Text>
      </Space>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message="Không tải được dữ liệu hệ thống"
          description={loadError}
          action={<Button icon={<ReloadOutlined />} onClick={loadPage}>Thử lại</Button>}
          style={{ marginBottom: 20 }}
        />
      )}

      <Row gutter={[24, 24]}>
        {/* Cột trái: Form Đặt hàng & Bản đồ */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <CarOutlined style={{ color: '#0284c7' }} />
                <span>Thông Tin Đặt Hàng & Giao Hàng Tận Nơi</span>
              </Space>
            }
            bordered
            style={{ borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
          >
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                customerName: user?.fullName || 'Công ty CP Đầu tư Xây dựng Hà Nội',
                customerPhone: user?.phone || '0988776655',
                quantity: 10,
                deliveryAddress: 'Số 18 đường Cổ Linh, Phường Long Biên, Hà Nội (Dự án Nhà ở Phố Đông)',
              }}
              onValuesChange={() => {
                idempotencyKey.current = `checkout_${crypto.randomUUID()}`;
              }}
              onFinish={submitOrder}
              requiredMark="optional"
            >
              {/* Thông tin người nhận */}
              <Row gutter={12}>
                <Col xs={24} sm={12}>
                  <Form.Item
                    name="customerName"
                    label="Tên khách hàng / Đơn vị thi công"
                    rules={[{ required: true, message: 'Vui lòng nhập tên người nhận hoặc đơn vị' }]}
                  >
                    <Input placeholder="Ví dụ: Công ty XD Minh Anh" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item
                    name="customerPhone"
                    label="Số điện thoại liên hệ"
                    rules={[{ required: true, message: 'Vui lòng nhập số điện thoại' }]}
                  >
                    <Input placeholder="0912345678" />
                  </Form.Item>
                </Col>
              </Row>

              <Divider orientation="left" style={{ margin: '8px 0 16px', fontSize: 13, color: '#64748b' }}>
                <EnvironmentOutlined /> Địa Chỉ Nhận Hàng & Bản Đồ Tọa Độ
              </Divider>

              {/* Nhập địa chỉ và nút di chuyển trên bản đồ */}
              <Form.Item
                label="Địa chỉ giao hàng / Chân công trình"
                required
                extra="Nhập trực tiếp hoặc bấm nút bên phải để tìm kiếm và di chuyển ghim đỏ trên bản đồ Mapbox."
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item
                    name="deliveryAddress"
                    noStyle
                    rules={[{ required: true, message: 'Vui lòng nhập hoặc chọn địa chỉ nhận hàng' }]}
                  >
                    <Input
                      placeholder="Nhập số nhà, tên đường, khu đô thị, công trình..."
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

                {/* Hiển thị tọa độ đã ghim */}
                {deliveryCoord && (
                  <div style={{ marginTop: 8 }}>
                    <Tag color="cyan" icon={<AimOutlined />} style={{ padding: '3px 8px', fontSize: 12 }}>
                      Tọa độ GPS đã ghim: {deliveryCoord.lat.toFixed(5)}, {deliveryCoord.lng.toFixed(5)}
                    </Tag>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setIsMapOpen(true)}
                      style={{ padding: 0, marginLeft: 8 }}
                    >
                      Di chuyển lại ghim
                    </Button>
                  </div>
                )}
              </Form.Item>

              <Divider orientation="left" style={{ margin: '8px 0 16px', fontSize: 13, color: '#64748b' }}>
                <ShopOutlined /> Mặt Hàng Vật Liệu Xây Dựng
              </Divider>

              {/* Chọn SKU sản phẩm VLXD */}
              <Form.Item
                name="skuId"
                label="Sản phẩm vật liệu xây dựng"
                rules={[{ required: true, message: 'Vui lòng chọn mặt hàng cần mua' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={skuOptions}
                  placeholder="Chọn sắt thép, gạch, cửa, sơn, xi măng..."
                  optionRender={(option) => {
                    const item = skuOptions.find((s) => s.value === option.value);
                    return (
                      <Space align="center" style={{ padding: '4px 0' }}>
                        <img
                          src={item?.imageUrl}
                          alt=""
                          width={36}
                          height={36}
                          style={{
                            objectFit: 'contain',
                            borderRadius: 6,
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            padding: 2,
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 13 }}>
                            {item?.skuName}
                          </div>
                          <div style={{ fontSize: 11, color: '#64748b' }}>
                            {item?.categoryName} — <Tag color="blue">{money(item?.price)} / {item?.uom}</Tag>
                          </div>
                        </div>
                      </Space>
                    );
                  }}
                />
              </Form.Item>

              {/* Số lượng */}
              <Form.Item
                name="quantity"
                label={`Số lượng đặt (${currentSku?.uom || 'Đơn vị'})`}
                rules={[{ required: true, message: 'Nhập số lượng' }]}
              >
                <InputNumber
                  min={1}
                  max={10000}
                  style={{ width: '100%' }}
                  addonAfter={currentSku?.uom || 'Đơn vị'}
                />
              </Form.Item>

              {/* Card tóm tắt đơn hàng & thành tiền */}
              {orderSummary && currentSku && (
                <Card
                  size="small"
                  style={{
                    marginBottom: 16,
                    background: '#f8fafc',
                    borderColor: '#cbd5e1',
                    borderRadius: 8,
                  }}
                >
                  <Row gutter={[16, 8]} align="middle">
                    <Col xs={24} sm={6} style={{ textAlign: 'center' }}>
                      <img
                        src={currentSku.imageUrl}
                        alt={currentSku.skuName}
                        style={{
                          width: '100%',
                          maxHeight: 88,
                          objectFit: 'cover',
                          borderRadius: 6,
                          border: '1px solid #cbd5e1',
                        }}
                      />
                    </Col>
                    <Col xs={24} sm={18}>
                      <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>
                        {currentSku.skuName}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {currentSku.categoryName} • Đơn giá: <b>{money(currentSku.price)}</b> / {currentSku.uom}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>Tổng tiền tạm tính:</Text>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#16a34a' }}>
                          {money(orderSummary.totalPrice)}
                        </div>
                      </div>
                    </Col>
                    <Col xs={24}>
                      <Divider style={{ margin: '8px 0 6px' }} />
                      <Text type="secondary" style={{ fontSize: 11, fontStyle: 'italic', color: '#64748b' }}>
                        * Lưu ý vận chuyển: Quy cách đóng gói, tải trọng và phân bổ phương tiện chuyên dụng sẽ do bộ phận điều phối kho bãi và nhân viên xếp dỡ kiểm tra, sắp xếp khi xuất kho.
                      </Text>
                    </Col>
                  </Row>
                </Card>
              )}

              {/* Lựa chọn Tổng kho / Showroom xuất hàng (Tùy chọn) */}
              <Form.Item
                name="fulfillmentSourceId"
                label="Kho / Showroom xuất hàng"
                extra="Mặc định: Hệ thống TMS tự động điều phối từ Tổng kho gần công trình nhất để tối ưu chi phí."
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Để trống để hệ thống tự động tìm Tổng kho tối ưu"
                  options={locations.map((loc) => ({
                    value: loc.id,
                    label: `${loc.name} (${loc.type === 'WAREHOUSE' ? 'Tổng kho' : loc.type === 'SHOWROOM' ? 'Showroom' : 'Kho vật liệu'}) — ${loc.address}`,
                  }))}
                />
              </Form.Item>

              <Alert
                type="info"
                showIcon
                message="Chính sách giao nhận tại chân công trình"
                description="Đơn hàng được phân bổ xe tải chuyên dụng có bạt che và hạ hàng tại chân công trình. Kiểm tra số lượng và ký biên bản giao nhận POD khi nhận hàng."
                style={{ marginBottom: 16 }}
              />

              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={submitting}
                disabled={!skuOptions.length}
                icon={<CheckCircleOutlined />}
                style={{ height: 46, fontSize: 16, fontWeight: 600, background: '#16a34a' }}
              >
                Xác Nhận Đặt Hàng & Giao Chân Công Trình
              </Button>
            </Form>
          </Card>
        </Col>

        {/* Cột phải: Lịch sử đơn hàng của tôi */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <ShoppingCartOutlined style={{ color: '#16a34a' }} />
                <span>Đơn Hàng VLXD Của Tôi</span>
              </Space>
            }
            extra={
              <Button icon={<ReloadOutlined />} onClick={loadPage} size="small">
                Làm mới
              </Button>
            }
            bordered
            style={{ borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
          >
            <List
              dataSource={orders}
              locale={{ emptyText: <Empty description="Bạn chưa có đơn đặt hàng nào" /> }}
              renderItem={(order) => {
                const deliveryStop = order.stops?.find((s) => s.type === 'DELIVERY');
                const pickupStop = order.stops?.find((s) => s.type === 'PICKUP');
                const destination = deliveryStop?.address || 'Giao tận chân công trình';

                return (
                  <List.Item
                    style={{
                      padding: '16px 0',
                      borderBottom: '1px solid #f1f5f9',
                    }}
                  >
                    <List.Item.Meta
                      title={
                        <Space wrap style={{ marginBottom: 4 }}>
                          <Text strong style={{ fontSize: 15, color: '#0f172a' }}>
                            {order.orderNumber}
                          </Text>
                          <Tag color="blue">{order.status}</Tag>
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Thời gian tạo: {new Date(order.createdAt).toLocaleString('vi-VN')}
                          </Text>

                          {/* Điểm xuất hàng */}
                          {pickupStop && (
                            <Text style={{ fontSize: 13, color: '#475569' }}>
                              <ShopOutlined style={{ color: '#0284c7', marginRight: 6 }} />
                              <b>Kho xuất:</b> {pickupStop.address}
                            </Text>
                          )}

                          {/* Điểm giao hàng tận nơi */}
                          <div style={{ background: '#f8fafc', padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                            <Text style={{ fontSize: 13, color: '#0f172a' }}>
                              <EnvironmentOutlined style={{ color: '#ef4444', marginRight: 6 }} />
                              <b>Giao tại:</b> {destination}
                            </Text>
                          </div>

                          {/* Danh sách mặt hàng */}
                          {order.items && order.items.length > 0 && (
                            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {order.items.map((it) => (
                                <Space key={it.id} size={4} style={{ background: '#f1f5f9', padding: '2px 8px 2px 4px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                                  <img
                                    src={getProductImage(it.sku, skuToImageMap.get(it.sku))}
                                    alt=""
                                    width={22}
                                    height={22}
                                    style={{ objectFit: 'cover', borderRadius: 4, verticalAlign: 'middle' }}
                                  />
                                  <span style={{ fontSize: 12, fontWeight: 500, color: '#334155' }}>
                                    {it.description} x{it.quantity}
                                  </span>
                                </Space>
                              ))}
                            </div>
                          )}
                        </Space>
                      }
                    />
                    <div style={{ textAlign: 'right', minWidth: 120 }}>
                      <Text strong style={{ color: '#16a34a', fontSize: 16, display: 'block' }}>
                        {money(order.grandTotal || order.totalAmount)}
                      </Text>
                      <Tag color="success" style={{ marginTop: 4 }}>
                        Giao tận nơi
                      </Tag>
                    </div>
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
      </Row>

      {/* Modal Chọn Vị Trí Trên Bản Đồ Mapbox */}
      <MapLocationPickerModal
        open={isMapOpen}
        title="Chọn Vị Trí Công Trình Trên Bản Đồ"
        initialLocation={{
          address: form.getFieldValue('deliveryAddress'),
          latitude: deliveryCoord?.lat || 21.0285,
          longitude: deliveryCoord?.lng || 105.8542,
        }}
        onCancel={() => setIsMapOpen(false)}
        onSelectLocation={handleSelectMapLocation}
      />
    </main>
  );
};

export default CustomerPortalPage;
