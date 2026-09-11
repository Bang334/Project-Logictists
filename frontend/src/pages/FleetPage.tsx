import React, { useEffect, useMemo, useState } from 'react';
import {
  Table,
  Tag,
  Tabs,
  Card,
  Typography,
  Space,
  Badge,
  Button,
  Select,
  Input,
  Row,
  Col,
  Statistic,
  Tooltip,
  App as AntdApp,
} from 'antd';
import {
  CarOutlined,
  TeamOutlined,
  EnvironmentOutlined,
  ApartmentOutlined,
  EditOutlined,
  PhoneOutlined,
  SearchOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  ToolOutlined,
  StopOutlined,
  SmileOutlined,
  CoffeeOutlined,
} from '@ant-design/icons';
import { vehiclesApi, driversApi, branchesApi } from '../api/client';
import { Vehicle, Driver, Branch } from '../types';
import { EditBranchModal } from '../components/EditBranchModal';
import { EditVehicleModal } from '../components/EditVehicleModal';
import { EditDriverModal } from '../components/EditDriverModal';
import { useAuth } from '../context/AuthContext';

const { Title, Text } = Typography;

const FleetPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const { user } = useAuth();

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);

  // Bộ lọc
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [vehicleStatusFilter, setVehicleStatusFilter] = useState<string>('ALL');
  const [driverStatusFilter, setDriverStatusFilter] = useState<string>('ALL');
  const [searchText, setSearchText] = useState<string>('');

  // Modals
  const [selectedBranchForEdit, setSelectedBranchForEdit] = useState<Branch | null>(null);
  const [isEditBranchModalOpen, setIsEditBranchModalOpen] = useState(false);

  const [selectedVehicleForEdit, setSelectedVehicleForEdit] = useState<Vehicle | null>(null);
  const [isEditVehicleModalOpen, setIsEditVehicleModalOpen] = useState(false);

  const [selectedDriverForEdit, setSelectedDriverForEdit] = useState<Driver | null>(null);
  const [isEditDriverModalOpen, setIsEditDriverModalOpen] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const branchParam = selectedBranchId === 'ALL' ? undefined : selectedBranchId;
      const [vRes, dRes, bRes] = await Promise.all([
        vehiclesApi.getAll(branchParam),
        driversApi.getAll(branchParam),
        branchesApi.getAll(),
      ]);
      setVehicles(vRes.data);
      setDrivers(dRes.data);
      setBranches(bRes.data);
    } catch {
      message.error('Lỗi khi tải dữ liệu đội xe, tài xế và chi nhánh');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
  }, [selectedBranchId]);

  // Thao tác đổi nhanh trạng thái xe
  const handleQuickVehicleStatusChange = async (vehicle: Vehicle, newStatus: string) => {
    try {
      await vehiclesApi.update(vehicle.id, { status: newStatus as any });
      message.success(`Đã cập nhật trạng thái xe ${vehicle.plateNumber}`);
      setVehicles((prev) =>
        prev.map((v) => (v.id === vehicle.id ? { ...v, status: newStatus as any } : v)),
      );
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể đổi trạng thái xe');
    }
  };

  // Thao tác đổi nhanh trạng thái tài xế
  const handleQuickDriverStatusChange = async (driver: Driver, newStatus: string) => {
    try {
      await driversApi.update(driver.id, { status: newStatus as any });
      message.success(`Đã cập nhật trạng thái tài xế ${driver.fullName}`);
      setDrivers((prev) =>
        prev.map((d) => (d.id === driver.id ? { ...d, status: newStatus as any } : d)),
      );
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể đổi trạng thái tài xế');
    }
  };

  // Danh sách xe lọc theo search và status
  const filteredVehicles = useMemo(() => {
    return vehicles.filter((v) => {
      const matchStatus = vehicleStatusFilter === 'ALL' || v.status === vehicleStatusFilter;
      const query = searchText.trim().toLowerCase();
      const matchSearch =
        !query ||
        v.plateNumber.toLowerCase().includes(query) ||
        v.model.toLowerCase().includes(query) ||
        v.vehicleType.toLowerCase().includes(query) ||
        (v.homeBranch?.name && v.homeBranch.name.toLowerCase().includes(query));
      return matchStatus && matchSearch;
    });
  }, [vehicles, vehicleStatusFilter, searchText]);

  // Danh sách tài xế lọc theo search và status
  const filteredDrivers = useMemo(() => {
    return drivers.filter((d) => {
      const matchStatus = driverStatusFilter === 'ALL' || d.status === driverStatusFilter;
      const query = searchText.trim().toLowerCase();
      const matchSearch =
        !query ||
        d.fullName.toLowerCase().includes(query) ||
        d.phone.toLowerCase().includes(query) ||
        d.citizenId.toLowerCase().includes(query) ||
        d.licenseNumber.toLowerCase().includes(query) ||
        (d.homeBranch?.name && d.homeBranch.name.toLowerCase().includes(query));
      return matchStatus && matchSearch;
    });
  }, [drivers, driverStatusFilter, searchText]);

  // Cột bảng Xe Tải
  const vehicleColumns = [
    {
      title: 'Biển Số Xe',
      dataIndex: 'plateNumber',
      key: 'plateNumber',
      width: 140,
      render: (text: string) => (
        <strong style={{ color: '#1d4ed8', fontSize: '15px' }}>{text}</strong>
      ),
    },
    {
      title: 'Loại Xe & Dòng Xe',
      key: 'model',
      render: (_: any, r: Vehicle) => (
        <div>
          <strong style={{ color: '#0f172a' }}>{r.model}</strong>
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
          <span>{r.homeBranch?.name || 'Chưa gán'}</span>
        </Space>
      ),
    },
    {
      title: 'Tải Trọng Tối Đa',
      dataIndex: 'payloadCapacityKg',
      key: 'payloadCapacityKg',
      width: 150,
      render: (val: number) => <strong>{val?.toLocaleString()} kg</strong>,
    },
    {
      title: 'Kích Thước Thùng (D x R x C)',
      key: 'dimensions',
      render: (_: any, r: Vehicle) => (
        <span>
          {r.lengthCm} × {r.widthCm} × {r.heightCm} cm{' '}
          <Tag color="cyan">{r.volumeCapacityM3} m³</Tag>
        </span>
      ),
    },
    {
      title: 'Trạng Thái Hoạt Động',
      dataIndex: 'status',
      key: 'status',
      width: 170,
      render: (status: string, r: Vehicle) => (
        <Select
          size="small"
          value={status}
          style={{ width: 145 }}
          onChange={(newVal) => handleQuickVehicleStatusChange(r, newVal)}
          options={[
            { value: 'AVAILABLE', label: <Tag color="green">Sẵn sàng</Tag> },
            { value: 'ON_TRIP', label: <Tag color="blue">Chạy chuyến</Tag> },
            { value: 'MAINTENANCE', label: <Tag color="orange">Bảo dưỡng</Tag> },
            { value: 'DECOMMISSIONED', label: <Tag color="red">Ngừng chạy</Tag> },
          ]}
        />
      ),
    },
    {
      title: 'Thao Tác',
      key: 'actions',
      width: 110,
      render: (_: any, r: Vehicle) => (
        <Button
          type="primary"
          ghost
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setSelectedVehicleForEdit(r);
            setIsEditVehicleModalOpen(true);
          }}
        >
          Sửa
        </Button>
      ),
    },
  ];

  // Cột bảng Tài Xế
  const driverColumns = [
    {
      title: 'Họ và Tên',
      dataIndex: 'fullName',
      key: 'fullName',
      width: 180,
      render: (text: string) => <strong style={{ color: '#0f172a' }}>{text}</strong>,
    },
    {
      title: 'Số Điện Thoại',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
      render: (text: string) => <span>{text}</span>,
    },
    {
      title: 'Số CCCD / CMND',
      dataIndex: 'citizenId',
      key: 'citizenId',
      width: 150,
    },
    {
      title: 'Giấy Phép Lái Xe',
      key: 'license',
      width: 180,
      render: (_: any, r: Driver) => (
        <div>
          <Tag color="blue">Hạng {r.licenseClass}</Tag>
          <span style={{ fontSize: '12px', color: '#64748b', marginLeft: '4px' }}>
            {r.licenseNumber}
          </span>
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            Hết hạn: {r.licenseExpiry ? new Date(r.licenseExpiry).toLocaleDateString('vi-VN') : '—'}
          </div>
        </div>
      ),
    },
    {
      title: 'Chi Nhánh Trực Thuộc',
      key: 'branch',
      render: (_: any, r: Driver) => (
        <Space>
          <EnvironmentOutlined style={{ color: '#10b981' }} />
          <span>{r.homeBranch?.name || 'Chưa gán'}</span>
        </Space>
      ),
    },
    {
      title: 'Trạng Thái Làm Việc',
      dataIndex: 'status',
      key: 'status',
      width: 180,
      render: (status: string, r: Driver) => (
        <Select
          size="small"
          value={status}
          style={{ width: 160 }}
          onChange={(newVal) => handleQuickDriverStatusChange(r, newVal)}
          options={[
            { value: 'AVAILABLE', label: <Tag color="success">Sẵn sàng nhận lệnh</Tag> },
            { value: 'ON_DUTY', label: <Tag color="processing">Đang chạy ca</Tag> },
            { value: 'RESTING', label: <Tag color="warning">Nghỉ ngơi theo ca</Tag> },
            { value: 'ON_LEAVE', label: <Tag color="default">Nghỉ phép</Tag> },
          ]}
        />
      ),
    },
    {
      title: 'Thao Tác',
      key: 'actions',
      width: 110,
      render: (_: any, r: Driver) => (
        <Button
          type="primary"
          ghost
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setSelectedDriverForEdit(r);
            setIsEditDriverModalOpen(true);
          }}
        >
          Sửa
        </Button>
      ),
    },
  ];

  // Cột bảng Chi Nhánh
  const branchColumns = [
    {
      title: 'Mã Chi Nhánh',
      dataIndex: 'code',
      key: 'code',
      width: 140,
      render: (val: string) => <Tag color="geekblue">{val}</Tag>,
    },
    {
      title: 'Tên Chi Nhánh / Bãi Xe',
      dataIndex: 'name',
      key: 'name',
      render: (val: string) => <strong style={{ color: '#1e3a8a' }}>{val}</strong>,
    },
    {
      title: 'Địa Chỉ Bãi Xe / Kho Xuất Phát',
      key: 'address',
      render: (_: any, r: Branch) => (
        <div>
          <div style={{ color: '#0f172a', fontWeight: 500 }}>{r.address}</div>
          {r.latitude && r.longitude && (
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: 2 }}>
              📍 Tọa độ GPS: {r.latitude.toFixed(5)}, {r.longitude.toFixed(5)}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Điện Thoại Hotline',
      dataIndex: 'phone',
      key: 'phone',
      width: 150,
      render: (val: string) =>
        val ? (
          <Space>
            <PhoneOutlined style={{ color: '#1677ff' }} />
            <span>{val}</span>
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Nguồn Lực Trực Thuộc',
      key: 'resources',
      width: 180,
      render: (_: any, r: Branch) => (
        <Space direction="vertical" size={2}>
          <span style={{ fontSize: 12 }}>
            🚗 <strong>{r._count?.vehicles || 0}</strong> xe quản lý
          </span>
          <span style={{ fontSize: 12 }}>
            👤 <strong>{r._count?.drivers || 0}</strong> tài xế
          </span>
        </Space>
      ),
    },
    {
      title: 'Thao Tác',
      key: 'actions',
      width: 140,
      render: (_: any, r: Branch) => (
        <Button
          type="primary"
          ghost
          size="small"
          icon={<EditOutlined />}
          onClick={() => {
            setSelectedBranchForEdit(r);
            setIsEditBranchModalOpen(true);
          }}
        >
          Sửa địa chỉ
        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      {/* Header & Bộ Lọc Tổng Thể */}
      <div style={{ marginBottom: '20px' }}>
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Title level={4} style={{ margin: 0 }}>
              Quản Lý Đội Xe, Tài Xế & Chi Nhánh Kho Vận
            </Title>
            <Text type="secondary">
              Theo dõi danh mục chi nhánh, đăng kiểm xe tải, tình trạng ca kíp và thời hạn bằng lái
            </Text>
          </Col>
          <Col xs={24} md={12} style={{ textAlign: 'right' }}>
            <Space wrap>
              {/* Chọn Chi Nhánh */}
              <span style={{ fontWeight: 500, fontSize: 13 }}>
                <EnvironmentOutlined style={{ color: '#1677ff', marginRight: 4 }} />
                Chi nhánh:
              </span>
              <Select
                value={selectedBranchId}
                onChange={setSelectedBranchId}
                style={{ width: 260, textAlign: 'left' }}
                placeholder="Chọn chi nhánh"
              >
                <Select.Option value="ALL">
                  🌐 <strong>Tất cả chi nhánh (Toàn quốc)</strong>
                </Select.Option>
                {branches.map((b) => (
                  <Select.Option key={b.id} value={b.id}>
                    📍 {b.name} ({b.code})
                  </Select.Option>
                ))}
              </Select>

              <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>
                Làm mới
              </Button>
            </Space>
          </Col>
        </Row>
      </div>

      {/* Thẻ Thống Kê Nhanh */}
      <Row gutter={[16, 16]} style={{ marginBottom: '20px' }}>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" className="card-elevation">
            <Statistic
              title="Đội Xe Quản Lý"
              value={vehicles.length}
              prefix={<CarOutlined style={{ color: '#1d4ed8' }} />}
              suffix={
                <span style={{ fontSize: 13, color: '#10b981', fontWeight: 500 }}>
                  ({vehicles.filter((v) => v.status === 'AVAILABLE').length} sẵn sàng)
                </span>
              }
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" className="card-elevation">
            <Statistic
              title="Đội Ngũ Tài Xế"
              value={drivers.length}
              prefix={<TeamOutlined style={{ color: '#059669' }} />}
              suffix={
                <span style={{ fontSize: 13, color: '#10b981', fontWeight: 500 }}>
                  ({drivers.filter((d) => d.status === 'AVAILABLE').length} sẵn sàng)
                </span>
              }
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" className="card-elevation">
            <Statistic
              title="Chi Nhánh & Bãi Xe"
              value={branches.length}
              prefix={<ApartmentOutlined style={{ color: '#7c3aed' }} />}
              suffix="Hub vận tải"
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" className="card-elevation">
            <Statistic
              title="Tải Trọng Sẵn Sàng"
              value={
                vehicles
                  .filter((v) => v.status === 'AVAILABLE')
                  .reduce((sum, v) => sum + (v.payloadCapacityKg || 0), 0) / 1000
              }
              precision={1}
              prefix={<CheckCircleOutlined style={{ color: '#2563eb' }} />}
              suffix="tấn"
            />
          </Card>
        </Col>
      </Row>

      {/* Bảng Dữ Liệu và Các Tab */}
      <Card variant="borderless" className="card-elevation">
        <Tabs
          defaultActiveKey="vehicles"
          items={[
            {
              key: 'vehicles',
              label: (
                <span>
                  <CarOutlined /> Danh Sách Xe Tải ({filteredVehicles.length})
                </span>
              ),
              children: (
                <>
                  {/* Thanh lọc xe */}
                  <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
                    <Col>
                      <Space wrap>
                        <Input
                          placeholder="Tìm biển số xe, dòng xe, chi nhánh..."
                          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                          value={searchText}
                          onChange={(e) => setSearchText(e.target.value)}
                          allowClear
                          style={{ width: 280 }}
                        />
                        <span style={{ fontSize: 13, color: '#64748b' }}>Trạng thái:</span>
                        <Select
                          value={vehicleStatusFilter}
                          onChange={setVehicleStatusFilter}
                          style={{ width: 170 }}
                        >
                          <Select.Option value="ALL">Tất cả trạng thái</Select.Option>
                          <Select.Option value="AVAILABLE">Sẵn sàng</Select.Option>
                          <Select.Option value="ON_TRIP">Đang chạy chuyến</Select.Option>
                          <Select.Option value="MAINTENANCE">Đang bảo dưỡng</Select.Option>
                          <Select.Option value="DECOMMISSIONED">Ngừng hoạt động</Select.Option>
                        </Select>
                      </Space>
                    </Col>
                    <Col>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        Hiển thị <strong>{filteredVehicles.length}</strong> / {vehicles.length} xe tải
                      </Text>
                    </Col>
                  </Row>

                  <Table
                    dataSource={filteredVehicles}
                    columns={vehicleColumns}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 8 }}
                  />
                </>
              ),
            },
            {
              key: 'drivers',
              label: (
                <span>
                  <TeamOutlined /> Đội Ngũ Tài Xế ({filteredDrivers.length})
                </span>
              ),
              children: (
                <>
                  {/* Thanh lọc tài xế */}
                  <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
                    <Col>
                      <Space wrap>
                        <Input
                          placeholder="Tìm tên, số điện thoại, CCCD, bằng lái..."
                          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                          value={searchText}
                          onChange={(e) => setSearchText(e.target.value)}
                          allowClear
                          style={{ width: 280 }}
                        />
                        <span style={{ fontSize: 13, color: '#64748b' }}>Trạng thái:</span>
                        <Select
                          value={driverStatusFilter}
                          onChange={setDriverStatusFilter}
                          style={{ width: 180 }}
                        >
                          <Select.Option value="ALL">Tất cả trạng thái</Select.Option>
                          <Select.Option value="AVAILABLE">Sẵn sàng nhận lệnh</Select.Option>
                          <Select.Option value="ON_DUTY">Đang chạy ca</Select.Option>
                          <Select.Option value="RESTING">Nghỉ ngơi theo ca</Select.Option>
                          <Select.Option value="ON_LEAVE">Nghỉ phép</Select.Option>
                        </Select>
                      </Space>
                    </Col>
                    <Col>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        Hiển thị <strong>{filteredDrivers.length}</strong> / {drivers.length} tài xế
                      </Text>
                    </Col>
                  </Row>

                  <Table
                    dataSource={filteredDrivers}
                    columns={driverColumns}
                    rowKey="id"
                    loading={loading}
                    pagination={{ pageSize: 8 }}
                  />
                </>
              ),
            },
            {
              key: 'branches',
              label: (
                <span>
                  <ApartmentOutlined /> Chi Nhánh & Bãi Xe ({branches.length})
                </span>
              ),
              children: (
                <Table
                  dataSource={branches}
                  columns={branchColumns}
                  rowKey="id"
                  loading={loading}
                  pagination={{ pageSize: 8 }}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* Modal Chỉnh Sửa Địa Chỉ Chi Nhánh */}
      <EditBranchModal
        open={isEditBranchModalOpen}
        branch={selectedBranchForEdit}
        onCancel={() => {
          setIsEditBranchModalOpen(false);
          setSelectedBranchForEdit(null);
        }}
        onSuccess={() => void fetchData()}
      />

      {/* Modal Chỉnh Sửa Xe Tải */}
      <EditVehicleModal
        open={isEditVehicleModalOpen}
        vehicle={selectedVehicleForEdit}
        branches={branches}
        onCancel={() => {
          setIsEditVehicleModalOpen(false);
          setSelectedVehicleForEdit(null);
        }}
        onSuccess={() => void fetchData()}
      />

      {/* Modal Chỉnh Sửa Tài Xế */}
      <EditDriverModal
        open={isEditDriverModalOpen}
        driver={selectedDriverForEdit}
        branches={branches}
        onCancel={() => {
          setIsEditDriverModalOpen(false);
          setSelectedDriverForEdit(null);
        }}
        onSuccess={() => void fetchData()}
      />
    </div>
  );
};

export default FleetPage;
