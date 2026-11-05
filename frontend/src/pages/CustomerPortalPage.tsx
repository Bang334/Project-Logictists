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
  Modal,
  Checkbox,
  Tabs,
  Badge,
} from 'antd';
import {
  EnvironmentOutlined,
  CompassOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  CheckCircleOutlined,
  AimOutlined,
  DeleteOutlined,
  ShopOutlined,
  FileTextOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { apiClient } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { getProductImage } from '../utils/demoAssets';
import { MapLocationPickerModal } from '../components/MapLocationPickerModal';

const { Title, Text, Paragraph } = Typography;

interface ServiceProvince {
  provinceCode: string;
  provinceName: string;
  zoneId: string;
  zoneCode: string;
  zoneName: string;
  activeStoreCount: number;
}

interface SkuAvailability {
  skuId: string;
  skuCode: string;
  name: string;
  uom: string;
  salePrice: number;
  imageUrl?: string | null;
  productName: string;
  categoryName?: string;
  maxOrderableQuantity: number;
  fulfillmentLabel: 'SINGLE_STORE' | 'MULTI_STORE' | 'UNAVAILABLE';
  canAddToCart: boolean;
}

interface CartItem {
  skuId: string;
  skuCode: string;
  name: string;
  uom: string;
  unitPrice: number;
  quantity: number;
  imageUrl?: string | null;
}

interface CartCheckResult {
  isFeasible: boolean;
  sourceCount: number;
  sources: Array<{ id: string; name: string; address: string }>;
  warnings: string[];
  suggestedActions?: string[];
}

interface QuoteDetails {
  quoteId: string;
  quoteVersion: number;
  createdAt: string;
  expiresAt: string;
  provinceCode: string;
  deliveryAddress: string;
  deliveryLatitude: number;
  deliveryLongitude: number;
  items: Array<{
    skuId: string;
    skuCode: string;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    sourceAllocations: Array<{ locationId: string; locationName: string; quantity: number }>;
  }>;
  subtotal: number;
  shippingFee: number;
  shippingFeeStatus: 'ESTIMATED_PENDING_MEASUREMENT' | 'FIXED';
  totalAmount: number;
  sourceStores: Array<{
    id: string;
    name: string;
    address: string;
    distanceToDeliveryKm: number;
  }>;
  maxDistanceBetweenSourcesKm: number;
  conditionsToAccept: string[];
}

interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: string;
  subtotal?: number | string;
  totalAmount?: number | string;
  createdAt: string;
  stops?: Array<{
    id: string;
    type: 'PICKUP' | 'DELIVERY';
    address: string;
  }>;
  fulfillmentGroups?: Array<{
    id: string;
    groupNumber: string;
    status: string;
    sourceLocation?: { name: string; address: string };
    lines?: Array<{
      id: string;
      requestedQuantity: number;
      sku?: { name: string; uom: string };
    }>;
  }>;
  items?: Array<{
    id: string;
    sku: string;
    description: string;
    quantity: number;
    unitPrice: number | string;
    lineTotal: number | string;
  }>;
}

const money = (value: number | string | undefined) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(Number(value || 0));

export const CustomerPortalPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();
  const [form] = Form.useForm();

  // 1. Quản lý vùng / Tỉnh thành
  const [provinces, setProvinces] = useState<ServiceProvince[]>([]);
  const [selectedProvince, setSelectedProvince] = useState<string>(() => {
    return localStorage.getItem('tms_customer_province') || 'HN';
  });

  // 2. Danh mục sản phẩm theo vùng
  const [catalogItems, setCatalogItems] = useState<SkuAvailability[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);

  // 3. Giỏ hàng nhiều SKU
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem('tms_customer_cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // 4. Kiểm tra tính khả thi giỏ hàng (Check Cart)
  const [cartCheck, setCartCheck] = useState<CartCheckResult | null>(null);
  const [checkingCart, setCheckingCart] = useState(false);

  // 5. Báo giá & Thanh toán
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [deliveryCoord, setDeliveryCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [quoteModalOpen, setQuoteModalOpen] = useState(false);
  const [quote, setQuote] = useState<QuoteDetails | null>(null);
  const [creatingQuote, setCreatingQuote] = useState(false);
  const [acceptedConditions, setAcceptedConditions] = useState(false);
  const [submittingCheckout, setSubmittingCheckout] = useState(false);

  // 6. Đơn hàng đã đặt
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  // Lưu giỏ hàng vào localStorage khi thay đổi
  useEffect(() => {
    localStorage.setItem('tms_customer_cart', JSON.stringify(cart));
  }, [cart]);

  // Lưu tỉnh thành được chọn
  useEffect(() => {
    localStorage.setItem('tms_customer_province', selectedProvince);
  }, [selectedProvince]);

  // Tải danh sách tỉnh/thành được phục vụ
  useEffect(() => {
    const loadServiceAreas = async () => {
      try {
        const res = await apiClient.get('/shopping/service-areas');
        const provs: ServiceProvince[] = res.data?.provinces || [];
        setProvinces(provs);
        if (provs.length > 0 && !provs.some((p) => p.provinceCode === selectedProvince)) {
          setSelectedProvince(provs[0].provinceCode);
        }
      } catch (err: any) {
        message.error('Không thể tải danh sách vùng phục vụ');
      }
    };
    loadServiceAreas();
  }, [message, selectedProvince]);

  // Tải danh mục sản phẩm theo vị trí
  const loadCatalog = useCallback(async () => {
    if (!selectedProvince) return;
    setLoadingCatalog(true);
    try {
      const res = await apiClient.post('/shopping/availability/search', {
        provinceCode: selectedProvince,
        search: searchTerm.trim() || undefined,
        showUnavailable,
        limit: 100,
      });
      setCatalogItems(res.data?.data || []);
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể tải danh mục sản phẩm trong khu vực');
    } finally {
      setLoadingCatalog(false);
    }
  }, [selectedProvince, searchTerm, showUnavailable, message]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // Kiểm tra giỏ hàng nhanh (check-cart)
  const verifyCart = useCallback(async () => {
    if (cart.length === 0 || !selectedProvince) {
      setCartCheck(null);
      return;
    }
    setCheckingCart(true);
    try {
      const res = await apiClient.post<CartCheckResult>('/shopping/cart/check', {
        provinceCode: selectedProvince,
        latitude: deliveryCoord?.lat,
        longitude: deliveryCoord?.lng,
        items: cart.map((c) => ({ skuId: c.skuId, quantity: c.quantity })),
      });
      setCartCheck(res.data);
    } catch (err: any) {
      setCartCheck({
        isFeasible: false,
        sourceCount: 0,
        sources: [],
        warnings: [err.response?.data?.message || 'Không thể kiểm tra giỏ hàng'],
      });
    } finally {
      setCheckingCart(false);
    }
  }, [cart, selectedProvince, deliveryCoord]);

  useEffect(() => {
    verifyCart();
  }, [verifyCart]);

  // Tải danh sách đơn hàng đã đặt
  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await apiClient.get('/sales-orders', { params: { limit: 20 } });
      setOrders(res.data?.data || []);
    } catch (err: any) {
      // Có thể là guest chưa đăng nhập
    } finally {
      setLoadingOrders(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadOrders();
    }
  }, [user, loadOrders]);

  // Thêm vào giỏ
  const addToCart = (item: SkuAvailability) => {
    setCart((prev) => {
      const existing = prev.find((p) => p.skuId === item.skuId);
      if (existing) {
        return prev.map((p) =>
          p.skuId === item.skuId ? { ...p, quantity: p.quantity + 1 } : p,
        );
      }
      return [
        ...prev,
        {
          skuId: item.skuId,
          skuCode: item.skuCode,
          name: item.name,
          uom: item.uom,
          unitPrice: item.salePrice,
          quantity: 1,
          imageUrl: item.imageUrl,
        },
      ];
    });
    message.success(`Đã thêm ${item.name} vào giỏ hàng`);
  };

  // Cập nhật số lượng trong giỏ
  const updateCartQuantity = (skuId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(skuId);
      return;
    }
    setCart((prev) =>
      prev.map((p) => (p.skuId === skuId ? { ...p, quantity } : p)),
    );
  };

  // Xóa khỏi giỏ
  const removeFromCart = (skuId: string) => {
    setCart((prev) => prev.filter((p) => p.skuId !== skuId));
  };

  // Tổng tiền tạm tính của giỏ
  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }, [cart]);

  // Chọn vị trí trên bản đồ
  const handleSelectMapLocation = (loc: { address: string; latitude: number; longitude: number }) => {
    setDeliveryCoord({ lat: loc.latitude, lng: loc.longitude });
    form.setFieldsValue({
      deliveryAddress: loc.address,
      deliveryLatitude: loc.latitude,
      deliveryLongitude: loc.longitude,
    });
    setIsMapOpen(false);
    message.success('Đã cập nhật vị trí và tọa độ ghim trên bản đồ!');
  };

  // Lấy báo giá chính xác (Request Quote)
  const handleRequestQuote = async () => {
    try {
      const values = await form.validateFields();
      if (cart.length === 0) {
        message.warning('Giỏ hàng đang trống!');
        return;
      }
      if (!deliveryCoord) {
        message.warning('Vui lòng ghim vị trí giao hàng chính xác trên bản đồ để tính lộ trình');
        return;
      }

      setCreatingQuote(true);
      const res = await apiClient.post<QuoteDetails>('/shopping/quotes', {
        provinceCode: selectedProvince,
        deliveryAddress: values.deliveryAddress,
        deliveryLatitude: deliveryCoord.lat,
        deliveryLongitude: deliveryCoord.lng,
        items: cart.map((c) => ({ skuId: c.skuId, quantity: c.quantity })),
      });

      setQuote(res.data);
      setAcceptedConditions(false);
      setQuoteModalOpen(true);
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể tạo báo giá. Vui lòng kiểm tra lại thông tin.');
    } finally {
      setCreatingQuote(false);
    }
  };

  // Xác nhận đặt hàng từ báo giá
  const handleConfirmCheckout = async () => {
    if (!quote) return;
    if (!acceptedConditions) {
      message.warning('Bạn cần tích chọn chấp thuận điều kiện đóng gói và đo thực tế');
      return;
    }

    const values = form.getFieldsValue();
    setSubmittingCheckout(true);
    try {
      const res = await apiClient.post<CustomerOrder>('/sales-orders/checkout-multi-source', {
        quoteId: quote.quoteId,
        customerName: values.customerName,
        customerPhone: values.customerPhone,
        notes: values.notes,
        idempotencyKey: `checkout_${quote.quoteId}`,
        acceptedConditions: true,
      });

      message.success(`Đặt hàng thành công! Mã đơn: ${res.data.orderNumber}`);
      setCart([]);
      setQuoteModalOpen(false);
      form.resetFields();
      setDeliveryCoord(null);
      await loadOrders();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể hoàn tất đặt hàng');
    } finally {
      setSubmittingCheckout(false);
    }
  };

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      {/* 1. Header chọn khu vực phục vụ */}
      <Card style={{ marginBottom: 20, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={2}>
              <Title level={4} style={{ margin: 0 }}>
                <CompassOutlined style={{ color: '#1890ff', marginRight: 8 }} />
                Mua Hàng Vật Liệu Xây Dựng Theo Khu Vực
              </Title>
              <Text type="secondary">
                Hệ thống tự động điều phối từ các cửa hàng gần nhất trong cùng vùng phục vụ.
              </Text>
            </Space>
          </Col>
          <Col xs={24} md={12} style={{ textAlign: 'right' }}>
            <Space wrap>
              <Text strong>Khu vực giao hàng:</Text>
              <Select
                value={selectedProvince}
                onChange={(val) => {
                  setSelectedProvince(val);
                  setCart([]); // Reset giỏ khi đổi khu vực theo POL-M12
                  message.info('Đã đổi khu vực phục vụ. Giỏ hàng đã được làm mới theo khu vực mới.');
                }}
                style={{ width: 220 }}
                placeholder="Chọn tỉnh / thành phố"
              >
                {provinces.map((p) => (
                  <Select.Option key={p.provinceCode} value={p.provinceCode}>
                    {p.provinceName} ({p.activeStoreCount} cửa hàng)
                  </Select.Option>
                ))}
              </Select>
              <Button icon={<ReloadOutlined />} onClick={loadCatalog} loading={loadingCatalog}>
                Làm mới
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Tabs defaultActiveKey="shopping">
        <Tabs.TabPane
          tab={
            <span>
              <ShoppingCartOutlined /> Mua Sắm & Đặt Hàng ({cart.length})
            </span>
          }
          key="shopping"
        >
          <Row gutter={24}>
            {/* Cột trái: Danh mục sản phẩm trong khu vực */}
            <Col xs={24} lg={15}>
              <Card
                title={
                  <Row justify="space-between" align="middle">
                    <Col>
                      <Space>
                        <ShopOutlined />
                        <span>Danh mục hàng hóa sẵn có</span>
                      </Space>
                    </Col>
                    <Col>
                      <Space>
                        <Input.Search
                          placeholder="Tìm xi măng, cát, đá, sắt thép..."
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          onSearch={loadCatalog}
                          style={{ width: 240 }}
                          allowClear
                        />
                        <Checkbox
                          checked={showUnavailable}
                          onChange={(e) => setShowUnavailable(e.target.checked)}
                        >
                          Hiện hàng hết
                        </Checkbox>
                      </Space>
                    </Col>
                  </Row>
                }
                style={{ borderRadius: 8 }}
              >
                {loadingCatalog ? (
                  <Skeleton active paragraph={{ rows: 6 }} />
                ) : catalogItems.length === 0 ? (
                  <Empty
                    description={
                      <span>
                        Chưa có sản phẩm nào khả dụng tại khu vực đã chọn.
                        <br />
                        Vui lòng thử chọn tỉnh/thành phố khác hoặc bật "Hiện hàng hết".
                      </span>
                    }
                  />
                ) : (
                  <List
                    grid={{ gutter: 16, xs: 1, sm: 2, md: 2, lg: 2, xl: 3 }}
                    dataSource={catalogItems}
                    renderItem={(item) => (
                      <List.Item>
                        <Card
                          hoverable
                          cover={
                            <div style={{ height: 160, overflow: 'hidden', background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <img
                                alt={item.name}
                                src={getProductImage(item.skuCode, item.imageUrl)}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            </div>
                          }
                          actions={[
                            <Button
                              type="primary"
                              disabled={!item.canAddToCart}
                              icon={<ShoppingCartOutlined />}
                              onClick={() => addToCart(item)}
                              block
                            >
                              Thêm vào giỏ
                            </Button>,
                          ]}
                          style={{ borderRadius: 8, opacity: item.canAddToCart ? 1 : 0.6 }}
                        >
                          <Card.Meta
                            title={
                              <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {item.name}
                              </div>
                            }
                            description={
                              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {item.productName} · {item.categoryName || 'VLXD'}
                                </Text>
                                <div style={{ margin: '4px 0' }}>
                                  <Text strong style={{ color: '#f5222d', fontSize: 16 }}>
                                    {money(item.salePrice)}
                                  </Text>
                                  <Text type="secondary" style={{ fontSize: 12 }}> / {item.uom}</Text>
                                </div>
                                <div>
                                  {item.fulfillmentLabel === 'SINGLE_STORE' && (
                                    <Tag color="success">Giao từ 1 nơi</Tag>
                                  )}
                                  {item.fulfillmentLabel === 'MULTI_STORE' && (
                                    <Tag color="warning">Cần gom từ 2 nơi</Tag>
                                  )}
                                  {item.fulfillmentLabel === 'UNAVAILABLE' && (
                                    <Tag color="default">Không phục vụ tại khu vực</Tag>
                                  )}
                                </div>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  Tối đa: {item.maxOrderableQuantity} {item.uom}
                                </Text>
                              </Space>
                            }
                          />
                        </Card>
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </Col>

            {/* Cột phải: Giỏ hàng nhiều SKU & Đặt hàng */}
            <Col xs={24} lg={9}>
              <Card
                title={
                  <Space>
                    <ShoppingCartOutlined />
                    <span>Giỏ hàng của bạn ({cart.length})</span>
                  </Space>
                }
                style={{ borderRadius: 8, marginBottom: 20 }}
              >
                {cart.length === 0 ? (
                  <Empty description="Giỏ hàng đang trống. Hãy chọn sản phẩm ở danh mục." />
                ) : (
                  <div>
                    <List
                      size="small"
                      dataSource={cart}
                      renderItem={(cItem) => (
                        <List.Item
                          actions={[
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => removeFromCart(cItem.skuId)}
                            />,
                          ]}
                        >
                          <List.Item.Meta
                            title={<Text strong>{cItem.name}</Text>}
                            description={
                              <Space wrap>
                                <Text>{money(cItem.unitPrice)} / {cItem.uom}</Text>
                                <InputNumber
                                  min={1}
                                  max={999}
                                  size="small"
                                  value={cItem.quantity}
                                  onChange={(val) => updateCartQuantity(cItem.skuId, val || 1)}
                                />
                                <Text strong style={{ color: '#1890ff' }}>
                                  = {money(cItem.unitPrice * cItem.quantity)}
                                </Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )}
                    />

                    <Divider style={{ margin: '12px 0' }} />

                    {/* Đánh giá tính khả thi giỏ hàng */}
                    {checkingCart ? (
                      <Skeleton active paragraph={{ rows: 2 }} />
                    ) : cartCheck && (
                      <div style={{ marginBottom: 16 }}>
                        {cartCheck.isFeasible ? (
                          <Alert
                            type={cartCheck.sourceCount === 1 ? 'success' : 'warning'}
                            showIcon
                            icon={cartCheck.sourceCount === 1 ? <CheckCircleOutlined /> : <WarningOutlined />}
                            message={
                              cartCheck.sourceCount === 1
                                ? 'Đủ hàng tại 1 cửa hàng trong khu vực'
                                : `Cần gom hàng từ ${cartCheck.sourceCount} cửa hàng`
                            }
                            description={
                              <div>
                                {cartCheck.sources.map((s) => (
                                  <div key={s.id} style={{ fontSize: 12 }}>
                                    • {s.name} ({s.address})
                                  </div>
                                ))}
                                {cartCheck.warnings.map((w, idx) => (
                                  <div key={idx} style={{ color: '#fa8c16', fontSize: 12, marginTop: 4 }}>
                                    {w}
                                  </div>
                                ))}
                              </div>
                            }
                          />
                        ) : (
                          <Alert
                            type="error"
                            showIcon
                            message="Không thể giao trọn giỏ hàng này"
                            description={
                              <div>
                                {cartCheck.warnings.map((w, idx) => (
                                  <div key={idx}>• {w}</div>
                                ))}
                                {cartCheck.suggestedActions?.map((act, idx) => (
                                  <div key={idx} style={{ fontWeight: 500, marginTop: 2 }}>
                                    👉 {act}
                                  </div>
                                ))}
                              </div>
                            }
                          />
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <Text strong style={{ fontSize: 16 }}>Tổng tiền hàng:</Text>
                      <Text strong style={{ fontSize: 20, color: '#f5222d' }}>
                        {money(cartSubtotal)}
                      </Text>
                    </div>

                    <Divider style={{ margin: '12px 0' }} />

                    {/* Biểu mẫu nhận hàng */}
                    <Form form={form} layout="vertical">
                      <Form.Item
                        name="customerName"
                        label="Họ tên người nhận"
                        rules={[{ required: true, message: 'Vui lòng nhập tên người nhận' }]}
                      >
                        <Input placeholder="Ví dụ: Nguyễn Văn A" />
                      </Form.Item>
                      <Form.Item
                        name="customerPhone"
                        label="Số điện thoại"
                        rules={[{ required: true, message: 'Vui lòng nhập số điện thoại' }]}
                      >
                        <Input placeholder="Ví dụ: 0912345678" />
                      </Form.Item>
                      <Form.Item
                        name="deliveryAddress"
                        label="Địa chỉ giao hàng tận nơi"
                        rules={[{ required: true, message: 'Vui lòng nhập địa chỉ công trình/giao hàng' }]}
                      >
                        <Input.TextArea rows={2} placeholder="Nhập địa chỉ chi tiết hoặc ghim trên bản đồ" />
                      </Form.Item>

                      <Button
                        type="dashed"
                        icon={<AimOutlined />}
                        onClick={() => setIsMapOpen(true)}
                        block
                        style={{ marginBottom: 16 }}
                      >
                        {deliveryCoord ? 'Đã ghim vị trí trên bản đồ' : 'Ghim vị trí trên bản đồ Mapbox'}
                      </Button>

                      <Button
                        type="primary"
                        size="large"
                        icon={<FileTextOutlined />}
                        onClick={handleRequestQuote}
                        loading={creatingQuote}
                        disabled={!cartCheck?.isFeasible}
                        block
                      >
                        Lấy Báo Giá & Xác Nhận Đặt Hàng
                      </Button>
                    </Form>
                  </div>
                )}
              </Card>
            </Col>
          </Row>
        </Tabs.TabPane>

        {/* Tab 2: Lịch sử đơn hàng của tôi */}
        <Tabs.TabPane
          tab={
            <span>
              <FileTextOutlined /> Đơn Hàng Của Tôi ({orders.length})
            </span>
          }
          key="orders"
        >
          <Card title="Lịch sử đơn hàng đã đặt" style={{ borderRadius: 8 }}>
            {loadingOrders ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : orders.length === 0 ? (
              <Empty description="Bạn chưa có đơn hàng nào." />
            ) : (
              <List
                dataSource={orders}
                renderItem={(ord) => (
                  <List.Item>
                    <Card style={{ width: '100%', marginBottom: 8 }} size="small">
                      <Row justify="space-between" align="middle">
                        <Col>
                          <Space>
                            <Text strong style={{ fontSize: 16 }}>{ord.orderNumber}</Text>
                            <Tag color={ord.status === 'CONFIRMED' ? 'blue' : 'green'}>{ord.status}</Tag>
                          </Space>
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary">
                              Ngày đặt: {new Date(ord.createdAt).toLocaleString('vi-VN')}
                            </Text>
                          </div>
                        </Col>
                        <Col style={{ textAlign: 'right' }}>
                          <Text strong style={{ fontSize: 18, color: '#f5222d' }}>
                            {money(ord.totalAmount || ord.subtotal)}
                          </Text>
                        </Col>
                      </Row>

                      {/* Hiển thị các nhóm chuẩn bị hàng theo nguồn (Fulfillment Groups) */}
                      {ord.fulfillmentGroups && ord.fulfillmentGroups.length > 0 && (
                        <div style={{ marginTop: 12, background: '#fafafa', padding: 12, borderRadius: 6 }}>
                          <Text strong style={{ fontSize: 13 }}>
                            <ShopOutlined style={{ marginRight: 6 }} />
                            Phân bổ nguồn xuất hàng ({ord.fulfillmentGroups.length} cửa hàng):
                          </Text>
                          <div style={{ marginTop: 6 }}>
                            {ord.fulfillmentGroups.map((grp) => (
                              <div key={grp.id} style={{ marginBottom: 4, fontSize: 12 }}>
                                • <strong>{grp.sourceLocation?.name || 'Cửa hàng'}</strong>: Trạng thái{' '}
                                <Badge status={grp.status === 'PACKED' ? 'success' : 'processing'} text={grp.status} />
                                {grp.lines && (
                                  <span style={{ color: '#8c8c8c', marginLeft: 8 }}>
                                    ({grp.lines.map((l) => `${l.sku?.name || 'SKU'}: ${l.requestedQuantity}`).join(', ')})
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </Card>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Tabs.TabPane>
      </Tabs>

      {/* Modal chọn vị trí trên bản đồ Mapbox */}
      <MapLocationPickerModal
        open={isMapOpen}
        onCancel={() => setIsMapOpen(false)}
        onSelectLocation={handleSelectMapLocation}
        initialLocation={
          deliveryCoord
            ? { latitude: deliveryCoord.lat, longitude: deliveryCoord.lng }
            : undefined
        }
        title="Ghim Địa Chỉ Giao Hàng Trên Bản Đồ"
      />

      {/* Modal xác nhận báo giá (Quote Confirmation Modal) */}
      <Modal
        open={quoteModalOpen}
        title={
          <Space>
            <FileTextOutlined style={{ color: '#1890ff' }} />
            <span>Xác Nhận Báo Giá Đơn Hàng #{quote?.quoteId}</span>
          </Space>
        }
        onCancel={() => setQuoteModalOpen(false)}
        width={700}
        footer={[
          <Button key="back" onClick={() => setQuoteModalOpen(false)}>
            Xem lại giỏ hàng
          </Button>,
          <Button
            key="submit"
            type="primary"
            loading={submittingCheckout}
            disabled={!acceptedConditions}
            onClick={handleConfirmCheckout}
          >
            Chấp Thuận & Đặt Hàng
          </Button>,
        ]}
      >
        {quote && (
          <div>
            <Alert
              type="info"
              showIcon
              message="Báo giá có hiệu lực trong 15 phút"
              description="Hàng sẽ được giữ tạm thời trong quá trình nhân viên tại các cửa hàng đóng gói và đo kích thước thực tế."
              style={{ marginBottom: 16 }}
            />

            <DescriptionsCard quote={quote} />

            <Divider style={{ margin: '16px 0' }} />

            <div style={{ marginBottom: 16 }}>
              <Text strong>Điều kiện thương mại & vận tải cần khách hàng chấp thuận:</Text>
              <div style={{ marginTop: 8, background: '#fafafa', padding: 12, borderRadius: 6 }}>
                {quote.conditionsToAccept.map((cond, idx) => (
                  <div key={idx} style={{ fontSize: 13, marginBottom: 4 }}>
                    ✓ {cond}
                  </div>
                ))}
              </div>
            </div>

            <Checkbox
              checked={acceptedConditions}
              onChange={(e) => setAcceptedConditions(e.target.checked)}
            >
              <Text strong>
                Tôi đồng ý với các điều kiện báo giá, quy trình đóng gói đo đạc và điều phối gom hàng liên chi nhánh.
              </Text>
            </Checkbox>
          </div>
        )}
      </Modal>
    </div>
  );
};

// Component hiển thị chi tiết báo giá
const DescriptionsCard: React.FC<{ quote: QuoteDetails }> = ({ quote }) => {
  return (
    <div>
      <Row gutter={[16, 8]}>
        <Col span={12}>
          <Text type="secondary">Địa chỉ giao hàng:</Text>
          <div><Text strong>{quote.deliveryAddress}</Text></div>
        </Col>
        <Col span={12}>
          <Text type="secondary">Số lượng nguồn xuất hàng:</Text>
          <div><Text strong>{quote.sourceStores.length} cửa hàng</Text></div>
        </Col>
      </Row>

      <div style={{ marginTop: 12 }}>
        <Text type="secondary">Cửa hàng phục vụ & Khoảng cách đường bộ:</Text>
        {quote.sourceStores.map((src) => (
          <div key={src.id} style={{ fontSize: 12, marginTop: 2 }}>
            📍 <strong>{src.name}</strong> — {src.address} (~{src.distanceToDeliveryKm} km)
          </div>
        ))}
      </div>

      <Divider style={{ margin: '12px 0' }} />

      <Row justify="space-between" style={{ marginBottom: 6 }}>
        <Text>Tiền hàng tạm tính:</Text>
        <Text strong>{money(quote.subtotal)}</Text>
      </Row>
      <Row justify="space-between" style={{ marginBottom: 6 }}>
        <Text>Phí vận chuyển dự kiến:</Text>
        <Text type="secondary" italic>Chờ đo kích thước thực tế</Text>
      </Row>
      <Row justify="space-between" style={{ fontSize: 16, marginTop: 8 }}>
        <Text strong>Tổng thanh toán tạm tính:</Text>
        <Text strong style={{ color: '#f5222d', fontSize: 18 }}>
          {money(quote.totalAmount)}
        </Text>
      </Row>
    </div>
  );
};

export default CustomerPortalPage;
