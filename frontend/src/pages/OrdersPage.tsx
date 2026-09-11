import React, { useEffect, useMemo, useState } from 'react';
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
  Tooltip,
  App as AntdApp,
} from 'antd';
import {
  EnvironmentOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  ShoppingOutlined,
  EyeOutlined,
  EditOutlined,
  CompassOutlined,
  AimOutlined,
  SearchOutlined,
  ApartmentOutlined,
  ReloadOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import { branchesApi, customersApi, mapboxApi, ordersApi } from '../api/client';
import { Branch, Order } from '../types';
import { MapLocationPickerModal } from '../components/MapLocationPickerModal';
import { OrderDetailDrawer } from '../components/OrderDetailDrawer';

const { Title, Text } = Typography;

type MapPickerTarget = 'create-pickup' | 'create-delivery' | 'edit-pickup' | 'edit-delivery' | null;

interface Coordinate {
  lat: number;
  lng: number;
}

const OrdersPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  // State bộ lọc
  const [searchText, setSearchText] = useState('');
  const [filterBranchId, setFilterBranchId] = useState<string | undefined>(undefined);
  const [filterCustomerId, setFilterCustomerId] = useState<string | undefined>(undefined);
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);

  // Form tạo mới đơn hàng
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [createPickupOptions, setCreatePickupOptions] = useState<any[]>([]);
  const [createDeliveryOptions, setCreateDeliveryOptions] = useState<any[]>([]);
  const [createPickupCoord, setCreatePickupCoord] = useState<Coordinate | null>(null);
  const [createDeliveryCoord, setCreateDeliveryCoord] = useState<Coordinate | null>(null);

  // Drawer xem chi tiết đơn hàng
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [selectedOrderForDetail, setSelectedOrderForDetail] = useState<Order | null>(null);

  // Modal chỉnh sửa đơn hàng
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedOrderForEdit, setSelectedOrderForEdit] = useState<Order | null>(null);
  const [editForm] = Form.useForm();
  const [editPickupOptions, setEditPickupOptions] = useState<any[]>([]);
  const [editDeliveryOptions, setEditDeliveryOptions] = useState<any[]>([]);
  const [editPickupCoord, setEditPickupCoord] = useState<Coordinate | null>(null);
  const [editDeliveryCoord, setEditDeliveryCoord] = useState<Coordinate | null>(null);

  // Modal chọn vị trí trên bản đồ
  const [isMapPickerOpen, setIsMapPickerOpen] = useState(false);
  const [mapPickerTarget, setMapPickerTarget] = useState<MapPickerTarget>(null);
  const [mapPickerInitialLocation, setMapPickerInitialLocation] = useState<{
    address?: string;
    latitude?: number;
    longitude?: number;
  } | undefined>(undefined);
  const [mapPickerTitle, setMapPickerTitle] = useState('Chọn Vị Trí Trên Bản Đồ');

  const fetchOrders = async (status?: string, customerId?: string, branchId?: string) => {
    try {
      setLoading(true);
      const res = await ordersApi.getAll({
        status: status || undefined,
        customerId: customerId || undefined,
        branchId: branchId || undefined,
      });
      setOrders(res.data);
    } catch (error) {
      message.error('Không thể tải danh sách đơn hàng');
    } finally {
      setLoading(false);
    }
  };

  // Tải danh sách đơn hàng theo filter server
  useEffect(() => {
    void fetchOrders(filterStatus, filterCustomerId, filterBranchId);
  }, [filterStatus, filterCustomerId, filterBranchId]);

  // Tải dữ liệu master data (Khách hàng, Chi nhánh)
  useEffect(() => {
    void customersApi.getAll().then((response) => setCustomers(response.data));
    void branchesApi.getAll().then((response) => setBranches(response.data));
  }, []);

  // Lọc tức thời phía client theo từ khóa tìm kiếm
  const filteredOrders = useMemo(() => {
    if (!searchText.trim()) return orders;
    const q = searchText.toLowerCase().trim();
    return orders.filter((o) => {
      const matchOrderNum = o.orderNumber?.toLowerCase().includes(q);
      const matchCustomer =
        o.customer?.name?.toLowerCase().includes(q) ||
        o.customer?.code?.toLowerCase().includes(q) ||
        o.customer?.phone?.includes(q);
      const matchBranch =
        o.branch?.name?.toLowerCase().includes(q) ||
        o.branch?.code?.toLowerCase().includes(q);
      const matchStops = o.stops?.some(
        (s) =>
          s.address?.toLowerCase().includes(q) ||
          s.contactName?.toLowerCase().includes(q) ||
          s.contactPhone?.includes(q),
      );
      const matchItems = o.items?.some((i) => i.description?.toLowerCase().includes(q));
      return matchOrderNum || matchCustomer || matchBranch || matchStops || matchItems;
    });
  }, [orders, searchText]);

  // Đặt lại toàn bộ bộ lọc
  const handleResetFilters = () => {
    setSearchText('');
    setFilterBranchId(undefined);
    setFilterCustomerId(undefined);
    setFilterStatus(undefined);
  };

  // Gợi ý địa chỉ từ Mapbox cho form tạo hoặc sửa
  const handleSearchAddress = async (
    query: string,
    mode: 'create' | 'edit',
    type: 'pickup' | 'delivery',
  ) => {
    if (!query || query.length < 3) return;
    const results = await mapboxApi.geocode(query);
    const options = results.map((r: any) => ({
      value: r.address,
      label: r.address,
      lat: r.latitude,
      lng: r.longitude,
    }));

    if (mode === 'create') {
      if (type === 'pickup') setCreatePickupOptions(options);
      else setCreateDeliveryOptions(options);
    } else {
      if (type === 'pickup') setEditPickupOptions(options);
      else setEditDeliveryOptions(options);
    }
  };

  // Mở Map Location Picker Modal
  const handleOpenMapPicker = (target: MapPickerTarget) => {
    setMapPickerTarget(target);

    if (target === 'create-pickup') {
      setMapPickerTitle('Chọn Điểm Lấy Hàng (PICKUP) — Tạo Đơn Mới');
      setMapPickerInitialLocation({
        address: createForm.getFieldValue('pickupAddress'),
        latitude: createPickupCoord?.lat,
        longitude: createPickupCoord?.lng,
      });
    } else if (target === 'create-delivery') {
      setMapPickerTitle('Chọn Điểm Giao Hàng (DELIVERY) — Tạo Đơn Mới');
      setMapPickerInitialLocation({
        address: createForm.getFieldValue('deliveryAddress'),
        latitude: createDeliveryCoord?.lat,
        longitude: createDeliveryCoord?.lng,
      });
    } else if (target === 'edit-pickup') {
      setMapPickerTitle('Chỉnh Sửa Điểm Lấy Hàng (PICKUP)');
      setMapPickerInitialLocation({
        address: editForm.getFieldValue('pickupAddress'),
        latitude: editPickupCoord?.lat,
        longitude: editPickupCoord?.lng,
      });
    } else if (target === 'edit-delivery') {
      setMapPickerTitle('Chỉnh Sửa Điểm Giao Hàng (DELIVERY)');
      setMapPickerInitialLocation({
        address: editForm.getFieldValue('deliveryAddress'),
        latitude: editDeliveryCoord?.lat,
        longitude: editDeliveryCoord?.lng,
      });
    }

    setIsMapPickerOpen(true);
  };

  // Nhận kết quả từ Map Location Picker Modal
  const handleSelectLocation = (result: { address: string; latitude: number; longitude: number }) => {
    const { address, latitude, longitude } = result;

    if (mapPickerTarget === 'create-pickup') {
      createForm.setFieldsValue({ pickupAddress: address });
      setCreatePickupCoord({ lat: latitude, lng: longitude });
    } else if (mapPickerTarget === 'create-delivery') {
      createForm.setFieldsValue({ deliveryAddress: address });
      setCreateDeliveryCoord({ lat: latitude, lng: longitude });
    } else if (mapPickerTarget === 'edit-pickup') {
      editForm.setFieldsValue({ pickupAddress: address });
      setEditPickupCoord({ lat: latitude, lng: longitude });
    } else if (mapPickerTarget === 'edit-delivery') {
      editForm.setFieldsValue({ deliveryAddress: address });
      setEditDeliveryCoord({ lat: latitude, lng: longitude });
    }

    setIsMapPickerOpen(false);
    setMapPickerTarget(null);
  };

  // Mở modal sửa đơn hàng và nạp sẵn dữ liệu cũ
  const handleOpenEditModal = (order: Order) => {
    setSelectedOrderForEdit(order);

    const pickup = order.stops.find((s) => s.type === 'PICKUP');
    const delivery = order.stops.find((s) => s.type === 'DELIVERY');

    setEditPickupCoord(pickup ? { lat: pickup.latitude, lng: pickup.longitude } : null);
    setEditDeliveryCoord(delivery ? { lat: delivery.latitude, lng: delivery.longitude } : null);

    editForm.setFieldsValue({
      customerId: order.customer.id,
      branchId: order.branchId || order.branch?.id,
      notes: order.notes,
      pickupAddress: pickup?.address || '',
      pickupContactName: pickup?.contactName || '',
      pickupContactPhone: pickup?.contactPhone || '',
      deliveryAddress: delivery?.address || '',
      deliveryContactName: delivery?.contactName || '',
      deliveryContactPhone: delivery?.contactPhone || '',
      items: order.items.map((item) => ({
        description: item.description,
        packageType: item.packageType || 'CARTON',
        quantity: item.quantity,
        weightKg: item.weightKg,
        lengthCm: item.lengthCm,
        widthCm: item.widthCm,
        heightCm: item.heightCm,
      })),
    });

    setIsEditModalOpen(true);
  };

  // Submit tạo mới đơn hàng
  const handleCreateOrder = async (values: any) => {
    try {
      setLoading(true);

      const pickupOption = createPickupOptions.find((o) => o.value === values.pickupAddress);
      const deliveryOption = createDeliveryOptions.find((o) => o.value === values.deliveryAddress);

      const pLat = createPickupCoord?.lat || pickupOption?.lat || 0;
      const pLng = createPickupCoord?.lng || pickupOption?.lng || 0;
      const dLat = createDeliveryCoord?.lat || deliveryOption?.lat || 0;
      const dLng = createDeliveryCoord?.lng || deliveryOption?.lng || 0;

      const payload = {
        customerId: values.customerId,
        branchId: values.branchId,
        notes: values.notes,
        items: values.items.map((item: any) => ({
          ...item,
          volumeM3: (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
        })),
        stops: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: values.pickupAddress,
            latitude: pLat,
            longitude: pLng,
            contactName: values.pickupContactName,
            contactPhone: values.pickupContactPhone,
            serviceDurationMinutes: 20,
          },
          {
            type: 'DELIVERY',
            sequence: 2,
            address: values.deliveryAddress,
            latitude: dLat,
            longitude: dLng,
            contactName: values.deliveryContactName,
            contactPhone: values.deliveryContactPhone,
            serviceDurationMinutes: 20,
          },
        ],
      };

      await ordersApi.create(payload);
      message.success('Đã tạo đơn hàng mới vào cơ sở dữ liệu PostgreSQL!');
      setIsCreateModalOpen(false);
      createForm.resetFields();
      setCreatePickupCoord(null);
      setCreateDeliveryCoord(null);
      fetchOrders(filterStatus, filterCustomerId, filterBranchId);
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Lỗi khi tạo đơn hàng');
    } finally {
      setLoading(false);
    }
  };

  // Submit cập nhật đơn hàng
  const handleUpdateOrder = async (values: any) => {
    if (!selectedOrderForEdit) return;

    try {
      setLoading(true);

      const pickupOption = editPickupOptions.find((o) => o.value === values.pickupAddress);
      const deliveryOption = editDeliveryOptions.find((o) => o.value === values.deliveryAddress);

      const pLat = editPickupCoord?.lat || pickupOption?.lat || 0;
      const pLng = editPickupCoord?.lng || pickupOption?.lng || 0;
      const dLat = editDeliveryCoord?.lat || deliveryOption?.lat || 0;
      const dLng = editDeliveryCoord?.lng || deliveryOption?.lng || 0;

      const payload = {
        customerId: values.customerId,
        notes: values.notes,
        items: values.items.map((item: any) => ({
          ...item,
          volumeM3: (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
        })),
        stops: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: values.pickupAddress,
            latitude: pLat,
            longitude: pLng,
            contactName: values.pickupContactName,
            contactPhone: values.pickupContactPhone,
            serviceDurationMinutes: 20,
          },
          {
            type: 'DELIVERY',
            sequence: 2,
            address: values.deliveryAddress,
            latitude: dLat,
            longitude: dLng,
            contactName: values.deliveryContactName,
            contactPhone: values.deliveryContactPhone,
            serviceDurationMinutes: 20,
          },
        ],
      };

      await ordersApi.update(selectedOrderForEdit.id, payload);
      message.success(`Đã cập nhật đơn hàng ${selectedOrderForEdit.orderNumber} thành công!`);
      setIsEditModalOpen(false);
      setSelectedOrderForEdit(null);
      fetchOrders(filterStatus, filterCustomerId, filterBranchId);
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Lỗi khi cập nhật đơn hàng');
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: 'Mã Vận Đơn',
      dataIndex: 'orderNumber',
      key: 'orderNumber',
      width: 150,
      render: (text: string, r: Order) => (
        <div style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
          <Button
            type="link"
            style={{
              padding: 0,
              fontWeight: 700,
              color: '#0284c7',
              height: 'auto',
              whiteSpace: 'normal',
              textAlign: 'left',
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
              lineHeight: 1.35,
            }}
            onClick={() => {
              setSelectedOrderForDetail(r);
              setDetailDrawerOpen(true);
            }}
          >
            {text}
          </Button>
        </div>
      ),
    },
    {
      title: 'Khách Hàng',
      key: 'customer',
      width: 200,
      render: (_: any, r: Order) => (
        <div>
          <strong style={{ color: '#0f172a' }}>{r.customer.name}</strong>
          <div style={{ color: '#64748b', fontSize: '12px' }}>{r.customer.code}</div>
        </div>
      ),
    },
    {
      title: 'Chi Nhánh',
      key: 'branch',
      width: 160,
      render: (_: any, r: Order) =>
        r.branch ? (
          <div>
            <Tag color="geekblue" icon={<ApartmentOutlined />}>
              {r.branch.code}
            </Tag>
            <div style={{ fontSize: '11px', color: '#64748b', marginTop: 2 }}>
              {r.branch.name}
            </div>
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Chưa gán
          </Text>
        ),
    },
    {
      title: 'Điểm Lấy Hàng (PICKUP)',
      key: 'pickup',
      width: 220,
      render: (_: any, r: Order) => {
        const pickup = r.stops.find((s) => s.type === 'PICKUP');
        return (
          <div style={{ maxWidth: 210 }}>
            <Tag color="green" icon={<EnvironmentOutlined />}>
              Lấy hàng
            </Tag>
            <Tooltip title={pickup?.address}>
              <div
                style={{
                  fontSize: '12px',
                  marginTop: '4px',
                  color: '#334155',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  lineHeight: 1.4,
                  cursor: 'pointer',
                }}
              >
                {pickup?.address || 'Chưa có địa chỉ'}
              </div>
            </Tooltip>
          </div>
        );
      },
    },
    {
      title: 'Điểm Giao Hàng (DELIVERY)',
      key: 'delivery',
      width: 220,
      render: (_: any, r: Order) => {
        const delivery = r.stops.find((s) => s.type === 'DELIVERY');
        return (
          <div style={{ maxWidth: 210 }}>
            <Tag color="orange" icon={<EnvironmentOutlined />}>
              Giao hàng
            </Tag>
            <Tooltip title={delivery?.address}>
              <div
                style={{
                  fontSize: '12px',
                  marginTop: '4px',
                  color: '#334155',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  lineHeight: 1.4,
                  cursor: 'pointer',
                }}
              >
                {delivery?.address || 'Chưa có địa chỉ'}
              </div>
            </Tooltip>
          </div>
        );
      },
    },
    {
      title: 'Khối Lượng / Thể Tích',
      key: 'load',
      width: 140,
      render: (_: any, r: Order) => (
        <div>
          <strong>{r.totalWeightKg} kg</strong>
          <div style={{ color: '#64748b', fontSize: '12px' }}>
            {r.totalVolumeM3} m³ ({r.totalPackages} kiện)
          </div>
        </div>
      ),
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => {
        const colors: Record<string, string> = {
          DRAFT: 'default',
          CONFIRMED: 'blue',
          ASSIGNED: 'gold',
          IN_TRANSIT: 'purple',
          COMPLETED: 'green',
          CANCELLED: 'red',
        };
        return <Tag color={colors[status] || 'default'}>{status}</Tag>;
      },
    },
    {
      title: 'Thao Tác',
      key: 'actions',
      width: 160,
      fixed: 'right' as const,
      render: (_: any, record: Order) => {
        const isEditable = record.status === 'CONFIRMED' || record.status === 'DRAFT';
        return (
          <Space size={6}>
            <Tooltip title="Xem chi tiết đơn hàng & kiện vật lý">
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={() => {
                  setSelectedOrderForDetail(record);
                  setDetailDrawerOpen(true);
                }}
              >
                Chi tiết
              </Button>
            </Tooltip>
            <Tooltip
              title={
                isEditable
                  ? 'Chỉnh sửa thông tin đơn hàng & vị trí bản đồ'
                  : 'Không thể sửa đơn đã xếp chuyến hoặc đang vận chuyển'
              }
            >
              <Button
                size="small"
                type="primary"
                ghost
                icon={<EditOutlined />}
                disabled={!isEditable}
                onClick={() => handleOpenEditModal(record)}
              >
                Sửa
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      {/* Header trang */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Quản Lý Đơn Hàng Vận Tải
          </Title>
          <Text type="secondary">
            Tiếp nhận, tra cứu lọc đơn, xem chi tiết, chỉnh sửa địa chỉ trực quan qua Mapbox và chuẩn bị điều phối
          </Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setCreatePickupCoord(null);
            setCreateDeliveryCoord(null);
            if (branches.length > 0) {
              createForm.setFieldsValue({ branchId: branches[0].id });
            }
            setIsCreateModalOpen(true);
          }}
        >
          Tạo Đơn Hàng Mới
        </Button>
      </div>

      {/* Thanh Bộ Lọc & Tìm Kiếm Đơn Hàng */}
      <Card
        size="small"
        style={{
          marginBottom: 16,
          background: '#ffffff',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
        }}
      >
        <Row gutter={[12, 12]} align="middle">
          {/* Ô Tìm kiếm từ khóa */}
          <Col xs={24} md={7}>
            <Input
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="Tìm theo mã đơn, khách hàng, địa chỉ, hàng hóa..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
          </Col>

          {/* Lọc theo Chi nhánh */}
          <Col xs={12} sm={8} md={5}>
            <Select
              placeholder="Tất cả chi nhánh"
              value={filterBranchId}
              onChange={(val) => setFilterBranchId(val)}
              allowClear
              style={{ width: '100%' }}
              options={branches.map((b) => ({
                value: b.id,
                label: `${b.name} (${b.code})`,
              }))}
            />
          </Col>

          {/* Lọc theo Khách hàng */}
          <Col xs={12} sm={8} md={5}>
            <Select
              placeholder="Tất cả khách hàng"
              value={filterCustomerId}
              onChange={(val) => setFilterCustomerId(val)}
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              options={customers.map((c) => ({
                value: c.id,
                label: `${c.name} (${c.code})`,
              }))}
            />
          </Col>

          {/* Lọc theo Trạng thái */}
          <Col xs={12} sm={8} md={4}>
            <Select
              placeholder="Tất cả trạng thái"
              value={filterStatus}
              onChange={(val) => setFilterStatus(val)}
              allowClear
              style={{ width: '100%' }}
              options={[
                { value: 'CONFIRMED', label: 'CONFIRMED (Chờ điều phối)' },
                { value: 'ASSIGNED', label: 'ASSIGNED (Đã xếp xe)' },
                { value: 'IN_TRANSIT', label: 'IN_TRANSIT (Đang chạy)' },
                { value: 'COMPLETED', label: 'COMPLETED (Hoàn tất)' },
                { value: 'DRAFT', label: 'DRAFT (Bản nháp)' },
                { value: 'CANCELLED', label: 'CANCELLED (Đã hủy)' },
              ]}
            />
          </Col>

          {/* Nút Đặt lại */}
          <Col xs={12} md={3} style={{ textAlign: 'right' }}>
            <Button
              icon={<ReloadOutlined />}
              onClick={handleResetFilters}
              disabled={!searchText && !filterBranchId && !filterCustomerId && !filterStatus}
            >
              Đặt lại
            </Button>
          </Col>
        </Row>

        {/* Thông tin số lượng & các Tag đang lọc */}
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: '1px solid #f1f5f9',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          <Space size={6} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <FilterOutlined style={{ marginRight: 4 }} />
              Hiển thị:{' '}
              <strong style={{ color: '#0284c7' }}>{filteredOrders.length}</strong> / {orders.length} đơn hàng
            </Text>
            {filterBranchId && (
              <Tag closable onClose={() => setFilterBranchId(undefined)} color="geekblue">
                Chi nhánh: {branches.find((b) => b.id === filterBranchId)?.name}
              </Tag>
            )}
            {filterCustomerId && (
              <Tag closable onClose={() => setFilterCustomerId(undefined)} color="blue">
                Khách hàng: {customers.find((c) => c.id === filterCustomerId)?.name}
              </Tag>
            )}
            {filterStatus && (
              <Tag closable onClose={() => setFilterStatus(undefined)} color="orange">
                Trạng thái: {filterStatus}
              </Tag>
            )}
            {searchText && (
              <Tag closable onClose={() => setSearchText('')} color="cyan">
                Từ khóa: "{searchText}"
              </Tag>
            )}
          </Space>
        </div>
      </Card>

      {/* Bảng Dữ Liệu Đơn Hàng */}
      <Card variant="borderless" className="card-elevation">
        <Table
          dataSource={filteredOrders}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 8, showTotal: (total) => `Tổng cộng: ${total} đơn hàng` }}
          scroll={{ x: 1100 }}
        />
      </Card>

      {/* Drawer Xem Chi Tiết Đơn Hàng */}
      <OrderDetailDrawer
        open={detailDrawerOpen}
        order={selectedOrderForDetail}
        onClose={() => {
          setDetailDrawerOpen(false);
          setSelectedOrderForDetail(null);
        }}
        onEdit={(order) => handleOpenEditModal(order)}
      />

      {/* Modal Chọn Vị Trí Trên Bản Đồ (Mapbox) */}
      <MapLocationPickerModal
        open={isMapPickerOpen}
        title={mapPickerTitle}
        initialLocation={mapPickerInitialLocation}
        onCancel={() => {
          setIsMapPickerOpen(false);
          setMapPickerTarget(null);
        }}
        onSelectLocation={handleSelectLocation}
      />

      {/* Modal Tạo Đơn Hàng Mới */}
      <Modal
        title={
          <Space>
            <ShoppingOutlined style={{ color: '#1677ff' }} />
            <span>Tiếp Nhận Đơn Hàng Mới (Mapbox Geocoding)</span>
          </Space>
        }
        open={isCreateModalOpen}
        onCancel={() => setIsCreateModalOpen(false)}
        footer={null}
        width={760}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={handleCreateOrder}
          style={{ marginTop: '16px' }}
        >
          <Row gutter={12}>
            <Col xs={24} md={14}>
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
            </Col>
            <Col xs={24} md={10}>
              <Form.Item
                label="Chi Nhánh Tiếp Nhận"
                name="branchId"
                rules={[{ required: true, message: 'Chọn chi nhánh' }]}
              >
                <Select placeholder="Chọn chi nhánh">
                  {branches.map((b) => (
                    <Select.Option key={b.id} value={b.id}>
                      {b.code} — {b.name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            1. Điểm Lấy Hàng (PICKUP)
          </Divider>
          <Form.Item label="Địa chỉ lấy hàng" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="pickupAddress"
                noStyle
                rules={[{ required: true, message: 'Nhập hoặc chọn địa chỉ lấy hàng' }]}
              >
                <AutoComplete
                  options={createPickupOptions}
                  onSearch={(val) => handleSearchAddress(val, 'create', 'pickup')}
                  onSelect={(_val, opt: any) => {
                    if (opt.lat && opt.lng) {
                      setCreatePickupCoord({ lat: opt.lat, lng: opt.lng });
                    }
                  }}
                  placeholder="Nhập tên đường, KCN, quận huyện (ví dụ: KCN Tiên Sơn Bắc Ninh)"
                  style={{ width: 'calc(100% - 160px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<CompassOutlined />}
                onClick={() => handleOpenMapPicker('create-pickup')}
                style={{ width: '160px' }}
              >
                Chọn trên bản đồ
              </Button>
            </Space.Compact>
            {createPickupCoord && (
              <div style={{ marginTop: 4 }}>
                <Tag color="cyan" icon={<AimOutlined />}>
                  Tọa độ đã chọn: {createPickupCoord.lat.toFixed(5)}, {createPickupCoord.lng.toFixed(5)}
                </Tag>
              </div>
            )}
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item
              label="Người phụ trách lấy hàng"
              name="pickupContactName"
              initialValue="Thủ kho xuất"
            >
              <Input placeholder="Tên người liên hệ" />
            </Form.Item>
            <Form.Item
              label="SĐT lấy hàng"
              name="pickupContactPhone"
              initialValue="0912345678"
            >
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            2. Điểm Giao Hàng (DELIVERY)
          </Divider>
          <Form.Item label="Địa chỉ giao hàng" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="deliveryAddress"
                noStyle
                rules={[{ required: true, message: 'Nhập hoặc chọn địa chỉ giao hàng' }]}
              >
                <AutoComplete
                  options={createDeliveryOptions}
                  onSearch={(val) => handleSearchAddress(val, 'create', 'delivery')}
                  onSelect={(_val, opt: any) => {
                    if (opt.lat && opt.lng) {
                      setCreateDeliveryCoord({ lat: opt.lat, lng: opt.lng });
                    }
                  }}
                  placeholder="Nhập địa chỉ nhận hàng (ví dụ: Cầu Giấy Hà Nội)"
                  style={{ width: 'calc(100% - 160px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<CompassOutlined />}
                onClick={() => handleOpenMapPicker('create-delivery')}
                style={{ width: '160px' }}
              >
                Chọn trên bản đồ
              </Button>
            </Space.Compact>
            {createDeliveryCoord && (
              <div style={{ marginTop: 4 }}>
                <Tag color="cyan" icon={<AimOutlined />}>
                  Tọa độ đã chọn: {createDeliveryCoord.lat.toFixed(5)}, {createDeliveryCoord.lng.toFixed(5)}
                </Tag>
              </div>
            )}
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item
              label="Người nhận hàng"
              name="deliveryContactName"
              initialValue="Đại diện nhận hàng"
            >
              <Input placeholder="Tên người nhận" />
            </Form.Item>
            <Form.Item
              label="SĐT nhận hàng"
              name="deliveryContactPhone"
              initialValue="0987654321"
            >
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            3. Các loại hàng và kiện vật lý
          </Divider>
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
                    extra={
                      fields.length > 1 ? (
                        <Button
                          danger
                          type="text"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                        >
                          Xóa
                        </Button>
                      ) : null
                    }
                  >
                    <Row gutter={12}>
                      <Col xs={24} md={12}>
                        <Form.Item
                          {...field}
                          label="Mô tả"
                          name={[field.name, 'description']}
                          rules={[{ required: true, message: 'Nhập mô tả' }]}
                        >
                          <Input placeholder="Ví dụ: Thùng sữa 48 hộp" />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Loại kiện"
                          name={[field.name, 'packageType']}
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={['CARTON', 'PALLET', 'CRATE', 'BAG'].map((value) => ({
                              value,
                              label: value,
                            }))}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Số kiện"
                          name={[field.name, 'quantity']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} max={500} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Tổng kg của dòng"
                          name={[field.name, 'weightKg']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={0.1} precision={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Dài/kiện (cm)"
                          name={[field.name, 'lengthCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Rộng/kiện (cm)"
                          name={[field.name, 'widthCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Cao/kiện (cm)"
                          name={[field.name, 'heightCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => add({ quantity: 1, packageType: 'CARTON' })}
                  block
                >
                  Thêm loại hàng khác
                </Button>
              </Space>
            )}
          </Form.List>

          <Form.Item label="Ghi chú đơn hàng" name="notes" style={{ marginTop: 16 }}>
            <Input.TextArea rows={2} placeholder="Yêu cầu bảo quản, lưu ý khi dỡ hàng..." />
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Lưu Đơn Hàng Vào Hệ Thống
          </Button>
        </Form>
      </Modal>

      {/* Modal Chỉnh Sửa Đơn Hàng */}
      <Modal
        title={
          <Space>
            <EditOutlined style={{ color: '#1677ff' }} />
            <span>
              Chỉnh Sửa Đơn Hàng:{' '}
              <strong style={{ color: '#0284c7' }}>{selectedOrderForEdit?.orderNumber}</strong>
            </span>
          </Space>
        }
        open={isEditModalOpen}
        onCancel={() => {
          setIsEditModalOpen(false);
          setSelectedOrderForEdit(null);
        }}
        footer={null}
        width={760}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={handleUpdateOrder}
          style={{ marginTop: '16px' }}
        >
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

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            1. Điểm Lấy Hàng (PICKUP)
          </Divider>
          <Form.Item label="Địa chỉ lấy hàng" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="pickupAddress"
                noStyle
                rules={[{ required: true, message: 'Nhập hoặc chọn địa chỉ lấy hàng' }]}
              >
                <AutoComplete
                  options={editPickupOptions}
                  onSearch={(val) => handleSearchAddress(val, 'edit', 'pickup')}
                  onSelect={(_val, opt: any) => {
                    if (opt.lat && opt.lng) {
                      setEditPickupCoord({ lat: opt.lat, lng: opt.lng });
                    }
                  }}
                  placeholder="Nhập tên đường, KCN, quận huyện..."
                  style={{ width: 'calc(100% - 160px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<CompassOutlined />}
                onClick={() => handleOpenMapPicker('edit-pickup')}
                style={{ width: '160px' }}
              >
                Chọn trên bản đồ
              </Button>
            </Space.Compact>
            {editPickupCoord && (
              <div style={{ marginTop: 4 }}>
                <Tag color="cyan" icon={<AimOutlined />}>
                  Tọa độ đã chọn: {editPickupCoord.lat.toFixed(5)}, {editPickupCoord.lng.toFixed(5)}
                </Tag>
              </div>
            )}
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item label="Người phụ trách lấy hàng" name="pickupContactName">
              <Input placeholder="Tên người liên hệ" />
            </Form.Item>
            <Form.Item label="SĐT lấy hàng" name="pickupContactPhone">
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            2. Điểm Giao Hàng (DELIVERY)
          </Divider>
          <Form.Item label="Địa chỉ giao hàng" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="deliveryAddress"
                noStyle
                rules={[{ required: true, message: 'Nhập hoặc chọn địa chỉ giao hàng' }]}
              >
                <AutoComplete
                  options={editDeliveryOptions}
                  onSearch={(val) => handleSearchAddress(val, 'edit', 'delivery')}
                  onSelect={(_val, opt: any) => {
                    if (opt.lat && opt.lng) {
                      setEditDeliveryCoord({ lat: opt.lat, lng: opt.lng });
                    }
                  }}
                  placeholder="Nhập địa chỉ nhận hàng..."
                  style={{ width: 'calc(100% - 160px)' }}
                />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<CompassOutlined />}
                onClick={() => handleOpenMapPicker('edit-delivery')}
                style={{ width: '160px' }}
              >
                Chọn trên bản đồ
              </Button>
            </Space.Compact>
            {editDeliveryCoord && (
              <div style={{ marginTop: 4 }}>
                <Tag color="cyan" icon={<AimOutlined />}>
                  Tọa độ đã chọn: {editDeliveryCoord.lat.toFixed(5)}, {editDeliveryCoord.lng.toFixed(5)}
                </Tag>
              </div>
            )}
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Form.Item label="Người nhận hàng" name="deliveryContactName">
              <Input placeholder="Tên người nhận" />
            </Form.Item>
            <Form.Item label="SĐT nhận hàng" name="deliveryContactPhone">
              <Input placeholder="Số điện thoại" />
            </Form.Item>
          </div>

          <Divider orientation="left" style={{ fontSize: '13px' }}>
            3. Các loại hàng và kiện vật lý
          </Divider>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((field, index) => (
                  <Card
                    key={field.key}
                    size="small"
                    title={`Loại hàng ${index + 1}`}
                    extra={
                      fields.length > 1 ? (
                        <Button
                          danger
                          type="text"
                          icon={<MinusCircleOutlined />}
                          onClick={() => remove(field.name)}
                        >
                          Xóa
                        </Button>
                      ) : null
                    }
                  >
                    <Row gutter={12}>
                      <Col xs={24} md={12}>
                        <Form.Item
                          {...field}
                          label="Mô tả"
                          name={[field.name, 'description']}
                          rules={[{ required: true, message: 'Nhập mô tả' }]}
                        >
                          <Input placeholder="Mô tả hàng hóa" />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Loại kiện"
                          name={[field.name, 'packageType']}
                          rules={[{ required: true }]}
                        >
                          <Select
                            options={['CARTON', 'PALLET', 'CRATE', 'BAG'].map((value) => ({
                              value,
                              label: value,
                            }))}
                          />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Số kiện"
                          name={[field.name, 'quantity']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} max={500} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={12} md={6}>
                        <Form.Item
                          {...field}
                          label="Tổng kg của dòng"
                          name={[field.name, 'weightKg']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={0.1} precision={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Dài/kiện (cm)"
                          name={[field.name, 'lengthCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Rộng/kiện (cm)"
                          name={[field.name, 'widthCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                      <Col xs={8} md={6}>
                        <Form.Item
                          {...field}
                          label="Cao/kiện (cm)"
                          name={[field.name, 'heightCm']}
                          rules={[{ required: true }]}
                        >
                          <InputNumber min={1} style={{ width: '100%' }} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={() => add({ quantity: 1, packageType: 'CARTON' })}
                  block
                >
                  Thêm loại hàng khác
                </Button>
              </Space>
            )}
          </Form.List>

          <Form.Item label="Ghi chú đơn hàng" name="notes" style={{ marginTop: 16 }}>
            <Input.TextArea rows={2} placeholder="Yêu cầu bảo quản, lưu ý khi dỡ hàng..." />
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            Lưu Thay Đổi Đơn Hàng
          </Button>
        </Form>
      </Modal>
    </div>
  );
};

export default OrdersPage;
