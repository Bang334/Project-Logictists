import React, { useEffect, useState } from 'react';
import { Table, Tag, Tabs, Card, Typography, Space, Badge, App as AntdApp } from 'antd';
import { CarOutlined, TeamOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { vehiclesApi, driversApi } from '../api/client';
import { Vehicle, Driver } from '../types';

const { Title, Text } = Typography;

const FleetPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [vRes, dRes] = await Promise.all([
          vehiclesApi.getAll(),
          driversApi.getAll(),
        ]);
        setVehicles(vRes.data);
        setDrivers(dRes.data);
      } catch {
        message.error('Lỗi khi tải dữ liệu đội xe và tài xế');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  const vehicleColumns = [
    {
      title: 'Biển Số Xe',
      dataIndex: 'plateNumber',
      key: 'plateNumber',
      render: (text: string) => <strong style={{ color: '#1d4ed8', fontSize: '15px' }}>{text}</strong>,
    },
    {
      title: 'Loại Xe & Dòng Xe',
      key: 'model',
      render: (_: any, r: Vehicle) => (
        <div>
          <strong>{r.model}</strong>
          <div style={{ color: '#64748b', fontSize: '12px' }}>{r.vehicleType}</div>
        </div>
      ),
    },
    {
      title: 'Chi Nhánh Quản Lý (Home Branch)',
      key: 'branch',
      render: (_: any, r: Vehicle) => (
        <Space>
          <EnvironmentOutlined style={{ color: '#3b82f6' }} />
          <span>{r.homeBranch?.name}</span>
        </Space>
      ),
    },
    {
      title: 'Tải Trọng Đăng Kiểm',
      dataIndex: 'payloadCapacityKg',
      key: 'payloadCapacityKg',
      render: (kg: number) => <Tag color="blue" style={{ fontSize: '13px' }}>{kg.toLocaleString()} kg</Tag>,
    },
    {
      title: 'Thể Tích Thùng (m³)',
      dataIndex: 'volumeCapacityM3',
      key: 'volumeCapacityM3',
      render: (m3: number) => <span>{m3} m³</span>,
    },
    {
      title: 'Kích Thước Lọt Lòng (D x R x C)',
      key: 'dimensions',
      render: (_: any, r: Vehicle) => (
        <span style={{ fontSize: '12px', color: '#475569' }}>
          {r.lengthCm} x {r.widthCm} x {r.heightCm} cm
        </span>
      ),
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const color = status === 'AVAILABLE' ? 'success' : status === 'ON_TRIP' ? 'processing' : 'warning';
        return <Badge status={color as any} text={status} />;
      },
    },
  ];

  const driverColumns = [
    {
      title: 'Họ và Tên Tài Xế',
      dataIndex: 'fullName',
      key: 'fullName',
      render: (text: string) => <strong style={{ color: '#0f172a' }}>{text}</strong>,
    },
    {
      title: 'Số Điện Thoại',
      dataIndex: 'phone',
      key: 'phone',
    },
    {
      title: 'Hạng Bằng Lái',
      dataIndex: 'licenseClass',
      key: 'licenseClass',
      render: (cls: string) => <Tag color="purple" style={{ fontWeight: 600 }}>Hạng {cls}</Tag>,
    },
    {
      title: 'Thời Hạn Bằng Lái',
      dataIndex: 'licenseExpiry',
      key: 'licenseExpiry',
      render: (date: string) => (
        <span style={{ color: new Date(date) < new Date() ? '#ef4444' : '#10b981' }}>
          {new Date(date).toLocaleDateString('vi-VN')}
        </span>
      ),
    },
    {
      title: 'Chi Nhánh Trực Thuộc',
      key: 'branch',
      render: (_: any, r: Driver) => r.homeBranch?.name,
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const color = status === 'AVAILABLE' ? 'success' : 'default';
        return <Badge status={color as any} text={status} />;
      },
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: '24px' }}>
        <Title level={4} style={{ margin: 0 }}>Quản Lý Đội Xe & Tài Xế</Title>
        <Text type="secondary">Theo dõi hồ sơ đăng kiểm, quy cách thùng xe tải và thời hạn bằng lái của tài xế</Text>
      </div>

      <Card variant="borderless" className="card-elevation">
        <Tabs
          defaultActiveKey="vehicles"
          items={[
            {
              key: 'vehicles',
              label: (
                <span>
                  <CarOutlined /> Danh Sách Xe Tải ({vehicles.length})
                </span>
              ),
              children: (
                <Table
                  dataSource={vehicles}
                  columns={vehicleColumns}
                  rowKey="id"
                  loading={loading}
                  pagination={{ pageSize: 8 }}
                />
              ),
            },
            {
              key: 'drivers',
              label: (
                <span>
                  <TeamOutlined /> Đội Ngũ Tài Xế ({drivers.length})
                </span>
              ),
              children: (
                <Table
                  dataSource={drivers}
                  columns={driverColumns}
                  rowKey="id"
                  loading={loading}
                  pagination={{ pageSize: 8 }}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default FleetPage;
