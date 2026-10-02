import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Table, Tag, Typography, Button, Spin } from 'antd';
import {
  CarOutlined,
  TeamOutlined,
  ShoppingOutlined,
  SendOutlined,
  RightOutlined,
  PlayCircleOutlined,
  EditOutlined,
  EnvironmentOutlined,
  BankOutlined,
  ShopOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { branchesApi, vehiclesApi, driversApi, locationsApi, ordersApi, tripsApi } from '../api/client';
import { Branch, Vehicle, Driver, Location, Order, Trip } from '../types';
import MapboxMap from '../components/MapboxMap';
import { EditBranchModal } from '../components/EditBranchModal';
import { buildNetworkMarkers } from '../utils/dashboardMap';

const { Title, Text } = Typography;

interface DashboardPageProps {
  onNavigate: (tab: string) => void;
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedBranchForEdit, setSelectedBranchForEdit] = useState<Branch | null>(null);
  const [isEditBranchModalOpen, setIsEditBranchModalOpen] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [bRes, vRes, dRes, lRes, oRes, tRes] = await Promise.all([
        branchesApi.getAll(),
        vehiclesApi.getAll(),
        driversApi.getAll(),
        locationsApi.getAll(),
        ordersApi.getAll(),
        tripsApi.getAll(),
      ]);
      setBranches(bRes.data);
      setVehicles(vRes.data);
      setDrivers(dRes.data);
      setLocations(lRes.data);
      setOrders(oRes.data);
      setTrips(tRes.data);
    } catch (error) {
      console.error('Lỗi khi tải dữ liệu dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '60vh', gap: 12 }}>
        <Spin size="large" />
        <span style={{ color: '#64748b' }}>Đang tải dữ liệu vận hành TMS...</span>
      </div>
    );
  }

  const availableVehicles = vehicles.filter((v) => v.status === 'AVAILABLE').length;
  const availableDrivers = drivers.filter((d) => d.status === 'AVAILABLE').length;
  const pendingOrders = orders.filter((o) => o.status === 'CONFIRMED').length;
  const activeTrips = trips.filter((t) => t.status === 'DISPATCHED' || t.status === 'IN_PROGRESS').length;

  const networkMarkers = buildNetworkMarkers(branches, locations);
  const warehouseCount = locations.filter((location) => location.type === 'CENTRAL_WAREHOUSE').length;
  const pickupPointCount = locations.filter((location) => location.type === 'PICKUP_POINT').length;
  const storeCount = locations.filter((location) => location.type === 'STORE').length;

  const tripColumns = [
    {
      title: 'Mã Chuyến',
      dataIndex: 'tripNumber',
      key: 'tripNumber',
      render: (text: string) => <strong style={{ color: '#1d4ed8' }}>{text}</strong>,
    },
    {
      title: 'Xe Phân Công',
      key: 'vehicle',
      render: (_: any, r: Trip) => (
        <span>
          <Tag color="blue">{r.vehicle.plateNumber}</Tag>
          <Text type="secondary" style={{ fontSize: '12px' }}>{r.vehicle.model}</Text>
        </span>
      ),
    },
    {
      title: 'Tài Xế',
      key: 'driver',
      render: (_: any, r: Trip) => r.assignments[0]?.driver.fullName || 'Chưa gán',
    },
    {
      title: 'Số Điểm Dừng',
      key: 'stops',
      render: (_: any, r: Trip) => `${r.stops.length} điểm dừng`,
    },
    {
      title: 'Cự Ly (Mapbox)',
      dataIndex: 'totalDistanceKm',
      key: 'totalDistanceKm',
      render: (km: number) => <strong>{km} km</strong>,
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          PLANNED: 'gold',
          DISPATCHED: 'cyan',
          IN_PROGRESS: 'blue',
          COMPLETED: 'green',
        };
        return <Tag color={colorMap[status] || 'default'}>{status}</Tag>;
      },
    },
  ];

  return (
    <div className="tms-page">
      <div className="dashboard-page-header">
        <div>
          <Text className="tms-page-eyebrow">Operations control center</Text>
          <Title level={3} style={{ margin: 0 }}>Trung Tâm Chỉ Huy Vận Tải</Title>
          <Text type="secondary">Theo dõi đội xe, đơn hàng và các chuyến vận chuyển liên tỉnh trong thời gian thực</Text>
        </div>
        <Button className="dashboard-primary-action" type="primary" icon={<SendOutlined />} onClick={() => onNavigate('dispatch-manual')}>
          Mở Bàn Điều Phối Chuyến Đi
        </Button>
      </div>

      {/* Thống kê KPIs */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-kpi-card dashboard-kpi-blue">
            <Statistic
              title="Xe Tải Sẵn Sàng"
              value={availableVehicles}
              suffix={`/ ${vehicles.length}`}
              prefix={<span className="dashboard-kpi-icon"><CarOutlined /></span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-kpi-card dashboard-kpi-green">
            <Statistic
              title="Tài Xế Khả Dụng"
              value={availableDrivers}
              suffix={`/ ${drivers.length}`}
              prefix={<span className="dashboard-kpi-icon"><TeamOutlined /></span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-kpi-card dashboard-kpi-amber">
            <Statistic
              title="Đơn Chờ Điều Phối"
              value={pendingOrders}
              suffix="đơn"
              prefix={<span className="dashboard-kpi-icon"><ShoppingOutlined /></span>}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="dashboard-kpi-card dashboard-kpi-violet">
            <Statistic
              title="Chuyến Đang Thực Hiện"
              value={activeTrips}
              suffix="chuyến"
              prefix={<span className="dashboard-kpi-icon"><SendOutlined /></span>}
            />
          </Card>
        </Col>
      </Row>

      {/* Bản đồ mạng lưới chi nhánh kho vận Mapbox */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} lg={16}>
          <Card className="dashboard-network-card" styles={{ body: { padding: 0 } }}>
            <div className="dashboard-map-toolbar">
              <div className="dashboard-map-heading">
                <div>
                  <Text className="dashboard-section-kicker">Mapbox live view</Text>
                  <Title level={4}>Mạng Lưới Kho & Điểm Nhận</Title>
                </div>
                <div className="dashboard-map-legend" aria-label="Chú giải bản đồ">
                  <Tag color="blue"><BankOutlined /> {branches.length + warehouseCount} kho vận</Tag>
                  <Tag color="cyan"><InboxOutlined /> {pickupPointCount} điểm nhận</Tag>
                  <Tag color="orange"><ShopOutlined /> {storeCount} cửa hàng</Tag>
                </div>
              </div>
              <Button
                className="dashboard-map-action"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => onNavigate('dispatch-auto')}
              >
                Điều Phối & Mô Phỏng
              </Button>
            </div>
            <div className="dashboard-map-frame">
              <MapboxMap markers={networkMarkers} height={480} />
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            title="Điểm Trong Mạng Lưới"
            className="dashboard-points-card"
            style={{ height: '100%' }}
          >
            <div className="dashboard-point-list">
              {branches.map((b) => (
                <div key={b.id} className="dashboard-point-item">
                  <div className="dashboard-point-topline">
                    <span className="dashboard-point-type dashboard-point-type-branch"><BankOutlined /></span>
                    <div className="dashboard-point-copy">
                      <strong>{b.name}</strong>
                      <span><Tag color="blue">Kho vận</Tag>{b.code}</span>
                    </div>
                    <Button
                      size="small"
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setSelectedBranchForEdit(b);
                        setIsEditBranchModalOpen(true);
                      }}
                      aria-label={`Sửa địa chỉ ${b.name}`}
                    >
                      Sửa
                    </Button>
                  </div>
                  <div className="dashboard-point-address">
                    <EnvironmentOutlined /> {b.address}
                  </div>
                  <div className="dashboard-point-meta">
                    <span><CarOutlined /> {b._count?.vehicles || 0} xe</span>
                    <span><TeamOutlined /> {b._count?.drivers || 0} tài xế</span>
                  </div>
                </div>
              ))}
              {locations.map((location) => {
                const config = location.type === 'PICKUP_POINT'
                  ? { label: 'Điểm nhận', icon: <InboxOutlined />, color: 'cyan', className: 'pickup' }
                  : location.type === 'CENTRAL_WAREHOUSE'
                    ? { label: 'Kho trung tâm', icon: <BankOutlined />, color: 'blue', className: 'warehouse' }
                    : { label: 'Cửa hàng', icon: <ShopOutlined />, color: 'orange', className: 'store' };
                return (
                  <div key={location.id} className="dashboard-point-item">
                    <div className="dashboard-point-topline">
                      <span className={`dashboard-point-type dashboard-point-type-${config.className}`}>{config.icon}</span>
                      <div className="dashboard-point-copy">
                        <strong>{location.name}</strong>
                        <span><Tag color={config.color}>{config.label}</Tag>{location.code}</span>
                      </div>
                    </div>
                    <div className="dashboard-point-address"><EnvironmentOutlined /> {location.address}</div>
                    {location.type === 'PICKUP_POINT' && (
                      <div className="dashboard-point-meta">
                        <span><InboxOutlined /> {location.availableHoldingSlots}/{location.totalHoldingSlots} chỗ trống</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Bảng chuyến đi gần đây */}
      <Card
        title="Danh Sách Chuyến Đi Gần Đây"
        extra={
          <Button type="link" onClick={() => onNavigate('dispatch-manual')}>
            Xem tất cả trên Bàn điều phối <RightOutlined />
          </Button>
        }
        variant="borderless"
        className="card-elevation"
      >
        <Table
          dataSource={trips}
          columns={tripColumns}
          rowKey="id"
          pagination={{ pageSize: 5 }}
        />
      </Card>

      {/* Modal Chỉnh Sửa Địa Chỉ & Thông Tin Chi Nhánh */}
      <EditBranchModal
        open={isEditBranchModalOpen}
        branch={selectedBranchForEdit}
        onCancel={() => {
          setIsEditBranchModalOpen(false);
          setSelectedBranchForEdit(null);
        }}
        onSuccess={() => void fetchData()}
      />
    </div>
  );
};

export default DashboardPage;
