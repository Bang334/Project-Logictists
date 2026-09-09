import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Table, Tag, Typography, Button, Spin, Space } from 'antd';
import {
  CarOutlined,
  TeamOutlined,
  ShoppingOutlined,
  SendOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { branchesApi, vehiclesApi, driversApi, ordersApi, tripsApi } from '../api/client';
import { Branch, Vehicle, Driver, Order, Trip } from '../types';
import MapboxMap from '../components/MapboxMap';

const { Title, Text } = Typography;

interface DashboardPageProps {
  onNavigate: (tab: string) => void;
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [bRes, vRes, dRes, oRes, tRes] = await Promise.all([
          branchesApi.getAll(),
          vehiclesApi.getAll(),
          driversApi.getAll(),
          ordersApi.getAll(),
          tripsApi.getAll(),
        ]);
        setBranches(bRes.data);
        setVehicles(vRes.data);
        setDrivers(dRes.data);
        setOrders(oRes.data);
        setTrips(tRes.data);
      } catch (error) {
        console.error('Lỗi khi tải dữ liệu dashboard:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Đang tải dữ liệu vận hành TMS..." />
      </div>
    );
  }

  const availableVehicles = vehicles.filter((v) => v.status === 'AVAILABLE').length;
  const availableDrivers = drivers.filter((d) => d.status === 'AVAILABLE').length;
  const pendingOrders = orders.filter((o) => o.status === 'CONFIRMED').length;
  const activeTrips = trips.filter((t) => t.status === 'DISPATCHED' || t.status === 'IN_PROGRESS').length;

  // Chuẩn bị markers cho bản đồ tổng quan
  const branchMarkers = branches.map((b) => ({
    id: b.id,
    latitude: b.latitude,
    longitude: b.longitude,
    title: b.name,
    subtitle: b.address,
    type: 'DEPOT' as const,
  }));

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
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>Trung Tâm Chỉ Huy Vận Tải (TMS Dispatch)</Title>
          <Text type="secondary">Theo dõi đội xe, đơn hàng và các chuyến vận chuyển liên tỉnh trong thời gian thực</Text>
        </div>
        <Button type="primary" icon={<SendOutlined />} onClick={() => onNavigate('dispatch')}>
          Mở Bàn Điều Phối Chuyến Đi
        </Button>
      </div>

      {/* Thống kê KPIs */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} className="card-elevation">
            <Statistic
              title="Xe Tải Sẵn Sàng"
              value={availableVehicles}
              suffix={`/ ${vehicles.length}`}
              prefix={<CarOutlined style={{ color: '#3b82f6' }} />}
              valueStyle={{ color: '#1e40af' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} className="card-elevation">
            <Statistic
              title="Tài Xế Khả Dụng"
              value={availableDrivers}
              suffix={`/ ${drivers.length}`}
              prefix={<TeamOutlined style={{ color: '#10b981' }} />}
              valueStyle={{ color: '#047857' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} className="card-elevation">
            <Statistic
              title="Đơn Chờ Điều Phối"
              value={pendingOrders}
              suffix="đơn"
              prefix={<ShoppingOutlined style={{ color: '#f59e0b' }} />}
              valueStyle={{ color: '#b45309' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} className="card-elevation">
            <Statistic
              title="Chuyến Đang Thực Hiện"
              value={activeTrips}
              suffix="chuyến"
              prefix={<SendOutlined style={{ color: '#8b5cf6' }} />}
              valueStyle={{ color: '#6d28d9' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Bản đồ mạng lưới chi nhánh kho vận Mapbox */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} lg={16}>
          <Card
            title={
              <Space>
                <span>Mạng Lưới Chi Nhánh Vận Tải (Mapbox Live View)</span>
                <Tag color="blue">{branches.length} Chi nhánh lớn</Tag>
              </Space>
            }
            bordered={false}
            className="card-elevation"
          >
            <MapboxMap markers={branchMarkers} height={420} />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            title="Chi Nhánh & Tổng Kho"
            bordered={false}
            className="card-elevation"
            style={{ height: '100%' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {branches.map((b) => (
                <div
                  key={b.id}
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ color: '#1e3a8a' }}>{b.name}</strong>
                    <Tag color="geekblue">{b.code}</Tag>
                  </div>
                  <div style={{ color: '#64748b', fontSize: '13px', marginTop: '4px' }}>{b.address}</div>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '12px' }}>
                    <span>🚗 {b._count?.vehicles || 0} xe quản lý</span>
                    <span>👤 {b._count?.drivers || 0} tài xế</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Bảng chuyến đi gần đây */}
      <Card
        title="Danh Sách Chuyến Đi Gần Đây"
        extra={
          <Button type="link" onClick={() => onNavigate('dispatch')}>
            Xem tất cả trên Bàn điều phối <RightOutlined />
          </Button>
        }
        bordered={false}
        className="card-elevation"
      >
        <Table
          dataSource={trips}
          columns={tripColumns}
          rowKey="id"
          pagination={{ pageSize: 5 }}
        />
      </Card>
    </div>
  );
};

export default DashboardPage;
