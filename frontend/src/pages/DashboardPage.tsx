import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Table,
  Tag,
  Typography,
  Button,
  Spin,
  Alert,
  Input,
  Empty,
} from 'antd';
import {
  CarOutlined,
  TeamOutlined,
  ShoppingOutlined,
  SendOutlined,
  RightOutlined,
  ThunderboltOutlined,
  CompassOutlined,
  EditOutlined,
  EnvironmentOutlined,
  ApartmentOutlined,
  ReloadOutlined,
  SearchOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import {
  apiErrorMessage,
  branchesApi,
  vehiclesApi,
  driversApi,
  locationsApi,
  ordersApi,
  tripsApi,
} from '../api/client';
import { Branch, Vehicle, Driver, Location, Trip } from '../types';
import { useAuth } from '../context/AuthContext';
import { canOpenTab } from '../utils/navigationAccess';
import { formatDecimal } from '../utils/format';
import MapboxMap, { MapMarker } from '../components/MapboxMap';
import { EditBranchModal } from '../components/EditBranchModal';
import {
  TripStatusFilter,
  buildNetworkMarkers,
  buildNetworkPointItems,
  computeDashboardKpis,
  filterDashboardTrips,
  filterNetworkPointItems,
  formatTripWindow,
  getTripStatusPresentation,
  scopeDashboardEntities,
} from '../utils/dashboardMap';

const { Title, Text } = Typography;

interface DashboardPageProps {
  onNavigate: (tab: string) => void;
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { user, can, branchId } = useAuth();
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('');
  const hasLoadedOnceRef = useRef(false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [pendingOrders, setPendingOrders] = useState(0);
  const [trips, setTrips] = useState<Trip[]>([]);

  const [pointSearchQuery, setPointSearchQuery] = useState('');
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [tripStatusFilter, setTripStatusFilter] = useState<TripStatusFilter>('ALL');

  // Modal sửa chi nhánh
  const [selectedBranchForEdit, setSelectedBranchForEdit] = useState<Branch | null>(null);
  const [isEditBranchModalOpen, setIsEditBranchModalOpen] = useState(false);

  const canOpenFleet = canOpenTab(user, 'fleet', can);
  const canOpenOrders = canOpenTab(user, 'orders', can);
  const canOpenDispatchManual = canOpenTab(user, 'dispatch-manual', can);
  const canOpenDispatchAuto = canOpenTab(user, 'dispatch-auto', can);
  const canManageBranches = can('branches.manage');

  const fetchData = useCallback(async () => {
    try {
      if (!hasLoadedOnceRef.current) {
        setIsInitialLoading(true);
      } else {
        setIsRefreshing(true);
      }
      setLoadError(null);

      const [bRes, vRes, dRes, lRes, oRes, tRes] = await Promise.all([
        branchesApi.getAll(),
        vehiclesApi.getAll(branchId),
        driversApi.getAll(branchId),
        locationsApi.getAll(),
        ordersApi.list({ status: 'CONFIRMED', branchId, pageSize: 1 }),
        tripsApi.getAll(),
      ]);

      setBranches(bRes.data);
      setVehicles(vRes.data);
      setDrivers(dRes.data);
      setLocations(lRes.data);
      setPendingOrders(oRes.total);
      setTrips(tRes.data);
      hasLoadedOnceRef.current = true;
      setLastSyncedAt(
        new Intl.DateTimeFormat('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date()),
      );
    } catch (error) {
      setLoadError(apiErrorMessage(error));
    } finally {
      setIsInitialLoading(false);
      setIsRefreshing(false);
    }
  }, [branchId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const { scopedBranches, scopedLocations, scopedTrips } = useMemo(
    () =>
      scopeDashboardEntities({
        branches,
        locations,
        trips,
        branchId,
      }),
    [branches, locations, trips, branchId],
  );

  const activeBranchLabel = useMemo(() => {
    if (!branchId) {
      return user?.companyScope ? 'Toàn công ty' : 'Các chi nhánh được cấp';
    }
    const found =
      branches.find((b) => b.id === branchId) ||
      user?.branches.find((b) => b.id === branchId);
    return found ? `${found.name} (${found.code})` : 'Chi nhánh đang chọn';
  }, [branchId, branches, user]);

  const kpis = useMemo(
    () => computeDashboardKpis(vehicles, drivers, pendingOrders, scopedTrips),
    [vehicles, drivers, pendingOrders, scopedTrips],
  );

  const allPointItems = useMemo(
    () => buildNetworkPointItems(scopedBranches),
    [scopedBranches],
  );

  const filteredPointItems = useMemo(
    () => filterNetworkPointItems(allPointItems, 'ALL', pointSearchQuery),
    [allPointItems, pointSearchQuery],
  );

  const networkMarkers = useMemo(
    () => buildNetworkMarkers(scopedBranches),
    [scopedBranches],
  );

  const selectedPoint = useMemo(
    () => filteredPointItems.find((item) => item.id === selectedPointId) || null,
    [filteredPointItems, selectedPointId],
  );

  const filteredTrips = useMemo(
    () => filterDashboardTrips(scopedTrips, tripStatusFilter),
    [scopedTrips, tripStatusFilter],
  );

  const handleMarkerClick = useCallback((marker: MapMarker) => {
    setSelectedPointId(marker.id);
  }, []);

  if (isInitialLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '60vh',
          gap: 12,
        }}
      >
        <Spin size="large" />
        <span style={{ color: '#64748b' }}>Đang tải dữ liệu vận hành TMS...</span>
      </div>
    );
  }

  const tripColumns = [
    {
      title: 'Mã Chuyến',
      dataIndex: 'tripNumber',
      key: 'tripNumber',
      render: (text: string) => <strong style={{ color: '#0f5593' }}>{text}</strong>,
    },
    {
      title: 'Phương Tiện Phân Công',
      key: 'vehicle',
      render: (_: unknown, r: Trip) => (
        <span>
          <Tag color="blue">{r.vehicle?.plateNumber || '—'}</Tag>
          <Text type="secondary" style={{ fontSize: '12px' }}>
            {r.vehicle?.model || ''}
          </Text>
        </span>
      ),
    },
    {
      title: 'Tài Xế',
      key: 'driver',
      render: (_: unknown, r: Trip) => r.assignments?.[0]?.driver?.fullName || 'Chưa gán',
    },
    {
      title: 'Khung Giờ Dự Kiến',
      key: 'schedule',
      render: (_: unknown, r: Trip) => {
        const schedule = formatTripWindow(
          r.plannedStartTime,
          r.plannedEndTime,
          r.totalDurationMinutes,
        );
        return (
          <div>
            <div style={{ fontWeight: 600, fontSize: '12px' }}>{schedule.timeRange}</div>
            {schedule.durationLabel !== '—' && (
              <Text type="secondary" style={{ fontSize: '11px' }}>
                Thời lượng: {schedule.durationLabel}
              </Text>
            )}
          </div>
        );
      },
    },
    {
      title: 'Số Điểm Dừng',
      key: 'stops',
      render: (_: unknown, r: Trip) => `${r.stops?.length || 0} điểm dừng`,
    },
    {
      title: 'Cự Ly (Mapbox)',
      dataIndex: 'totalDistanceKm',
      key: 'totalDistanceKm',
      render: (km: number) => <strong>{formatDecimal(km, 1)} km</strong>,
    },
    {
      title: 'Trạng Thái',
      dataIndex: 'status',
      key: 'status',
      render: (status: Trip['status']) => {
        const presentation = getTripStatusPresentation(status);
        return <Tag color={presentation.color}>{presentation.label}</Tag>;
      },
    },
  ];

  const tripFilterButtons: Array<{ key: TripStatusFilter; label: string; count: number }> = [
    { key: 'ALL', label: 'Tất cả', count: kpis.trips.total },
    { key: 'ACTIVE', label: 'Đang chạy', count: kpis.trips.active },
    { key: 'PLANNED', label: 'Đã lên lịch', count: kpis.trips.planned },
    { key: 'COMPLETED', label: 'Hoàn thành', count: kpis.trips.completed },
  ];

  return (
    <div className="tms-page">
      {/* 1. Command Header */}
      <div className="dashboard-page-header">
        <div>
          <div className="dashboard-header-badges">
            <span className="dashboard-live-pill">
              <span className="tms-status-dot" />
              Trung tâm điều hành vận tải
            </span>
            <span className="dashboard-scope-pill">
              <EnvironmentOutlined /> Phạm vi: {activeBranchLabel}
            </span>
            {lastSyncedAt && (
              <span className="dashboard-sync-meta">Cập nhật lúc {lastSyncedAt}</span>
            )}
          </div>
          <Title level={3} style={{ margin: 0 }}>
            Tổng Quan Vận Hành & Mạng Lưới
          </Title>
          <Text type="secondary">
            Giám sát năng lực đội xe, đơn hàng chờ điều phối, sức chứa điểm nhận và tiến độ chuyến đi theo thời gian thực
          </Text>
        </div>

        <div className="dashboard-header-actions">
          <Button
            icon={<ReloadOutlined />}
            loading={isRefreshing}
            onClick={() => void fetchData()}
          >
            Làm mới
          </Button>
          {canOpenDispatchManual && (
            <Button
              className="dashboard-secondary-action"
              icon={<CompassOutlined />}
              onClick={() => onNavigate('dispatch-manual')}
            >
              Bàn Điều Phối Thủ Công
            </Button>
          )}
          {canOpenDispatchAuto && (
            <Button
              className="dashboard-primary-action"
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => onNavigate('dispatch-auto')}
            >
              Điều Phối Tự Động & Mô Phỏng
            </Button>
          )}
        </div>
      </div>

      {/* Banner cảnh báo lỗi nếu API gặp sự cố */}
      {loadError && (
        <Alert
          className="dashboard-error-banner"
          type="error"
          showIcon
          message="Không thể đồng bộ đầy đủ dữ liệu vận hành"
          description={loadError}
          action={
            <Button size="small" danger onClick={() => void fetchData()}>
              Thử lại
            </Button>
          }
        />
      )}

      {/* 2. Dải 4 Thẻ KPI Đa Tầng Có Tương Tác */}
      <Row gutter={[16, 16]} className="dashboard-kpi-grid">
        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`dashboard-kpi-card dashboard-kpi-blue ${canOpenFleet ? 'dashboard-kpi-clickable' : ''}`}
            onClick={canOpenFleet ? () => onNavigate('fleet') : undefined}
          >
            <div className="dashboard-kpi-top">
              <div>
                <span className="dashboard-kpi-label">Xe Tải Sẵn Sàng</span>
                <div className="dashboard-kpi-value-row">
                  <span className="dashboard-kpi-main-value">{kpis.vehicles.available}</span>
                  <span className="dashboard-kpi-suffix">/ {kpis.vehicles.total} xe</span>
                </div>
              </div>
              <span className="dashboard-kpi-icon">
                <CarOutlined />
              </span>
            </div>
            <div className="dashboard-kpi-progress" aria-hidden="true">
              <div
                className="dashboard-kpi-progress-bar"
                style={{ width: `${kpis.vehicles.availablePercent}%` }}
              />
            </div>
            <div className="dashboard-kpi-footer">
              <div className="dashboard-kpi-breakdown">
                <span className="dashboard-kpi-metric-pill">
                  <i className="dashboard-kpi-dot dashboard-kpi-dot-blue" />
                  {kpis.vehicles.onTrip} đang chạy
                </span>
                <span className="dashboard-kpi-metric-pill">
                  <i className="dashboard-kpi-dot dashboard-kpi-dot-amber" />
                  {kpis.vehicles.maintenance} bảo trì
                </span>
              </div>
              {canOpenFleet && (
                <span className="dashboard-kpi-link">
                  Đội xe <RightOutlined />
                </span>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`dashboard-kpi-card dashboard-kpi-green ${canOpenFleet ? 'dashboard-kpi-clickable' : ''}`}
            onClick={canOpenFleet ? () => onNavigate('fleet') : undefined}
          >
            <div className="dashboard-kpi-top">
              <div>
                <span className="dashboard-kpi-label">Tài Xế Khả Dụng</span>
                <div className="dashboard-kpi-value-row">
                  <span className="dashboard-kpi-main-value">{kpis.drivers.available}</span>
                  <span className="dashboard-kpi-suffix">/ {kpis.drivers.total} tài xế</span>
                </div>
              </div>
              <span className="dashboard-kpi-icon">
                <TeamOutlined />
              </span>
            </div>
            <div className="dashboard-kpi-progress" aria-hidden="true">
              <div
                className="dashboard-kpi-progress-bar"
                style={{ width: `${kpis.drivers.availablePercent}%` }}
              />
            </div>
            <div className="dashboard-kpi-footer">
              <div className="dashboard-kpi-breakdown">
                <span className="dashboard-kpi-metric-pill">
                  <i className="dashboard-kpi-dot dashboard-kpi-dot-green" />
                  {kpis.drivers.onDuty} đang chạy ca
                </span>
                <span className="dashboard-kpi-metric-pill">
                  <i className="dashboard-kpi-dot dashboard-kpi-dot-slate" />
                  {kpis.drivers.restingOrLeave} nghỉ
                </span>
              </div>
              {canOpenFleet && (
                <span className="dashboard-kpi-link">
                  Nhân sự <RightOutlined />
                </span>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`dashboard-kpi-card dashboard-kpi-amber ${canOpenOrders ? 'dashboard-kpi-clickable' : ''}`}
            onClick={canOpenOrders ? () => onNavigate('orders') : undefined}
          >
            <div className="dashboard-kpi-top">
              <div>
                <span className="dashboard-kpi-label">Đơn Chờ Điều Phối</span>
                <div className="dashboard-kpi-value-row">
                  <span className="dashboard-kpi-main-value">{kpis.orders.pendingCount}</span>
                  <span className="dashboard-kpi-suffix">đơn đã xác nhận</span>
                </div>
              </div>
              <span className="dashboard-kpi-icon">
                <ShoppingOutlined />
              </span>
            </div>
            <div className="dashboard-kpi-progress" aria-hidden="true">
              <div
                className="dashboard-kpi-progress-bar"
                style={{ width: kpis.orders.pendingCount > 0 ? '100%' : '0%' }}
              />
            </div>
            <div className="dashboard-kpi-footer">
              <div className="dashboard-kpi-breakdown">
                <span>Sẵn sàng gom chuyến</span>
              </div>
              {canOpenOrders && (
                <span className="dashboard-kpi-link">
                  Đơn hàng <RightOutlined />
                </span>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`dashboard-kpi-card dashboard-kpi-violet ${canOpenDispatchManual ? 'dashboard-kpi-clickable' : ''}`}
            onClick={canOpenDispatchManual ? () => onNavigate('dispatch-manual') : undefined}
          >
            <div className="dashboard-kpi-top">
              <div>
                <span className="dashboard-kpi-label">Chuyến Đang Thực Hiện</span>
                <div className="dashboard-kpi-value-row">
                  <span className="dashboard-kpi-main-value">{kpis.trips.active}</span>
                  <span className="dashboard-kpi-suffix">/ {kpis.trips.total} chuyến</span>
                </div>
              </div>
              <span className="dashboard-kpi-icon">
                <SendOutlined />
              </span>
            </div>
            <div className="dashboard-kpi-progress" aria-hidden="true">
              <div
                className="dashboard-kpi-progress-bar"
                style={{ width: `${kpis.trips.activePercent}%` }}
              />
            </div>
            <div className="dashboard-kpi-footer">
              <div className="dashboard-kpi-breakdown">
                <span>{kpis.trips.planned} đã lên lịch</span>
                <span>· {kpis.trips.completed} hoàn thành</span>
              </div>
              {canOpenDispatchManual && (
                <span className="dashboard-kpi-link">
                  Điều phối <RightOutlined />
                </span>
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 3. Không Gian Bản Đồ Mạng Lưới Mapbox & Inspector Chi Nhánh */}
      <Row gutter={[16, 16]} className="dashboard-workspace-row">
        <Col xs={24} lg={15}>
          <Card className="dashboard-network-card" styles={{ body: { padding: 0 } }}>
            <div className="dashboard-map-toolbar">
              <div className="dashboard-map-heading">
                <div>
                  <Text className="dashboard-section-kicker">Bản đồ mạng lưới trực tiếp</Text>
                  <Title level={4}>Mạng Lưới Chi Nhánh Vận Tải</Title>
                </div>
                <div className="dashboard-map-legend" aria-label="Chú giải bản đồ">
                  <Tag color="geekblue">
                    <ApartmentOutlined /> {scopedBranches.length} chi nhánh
                  </Tag>
                  <Tag color="blue">
                    <CarOutlined /> {kpis.vehicles.total} xe trực thuộc
                  </Tag>
                  <Tag color="cyan">
                    <TeamOutlined /> {kpis.drivers.total} tài xế
                  </Tag>
                </div>
              </div>
            </div>

            <div className="dashboard-map-frame">
              <MapboxMap
                markers={networkMarkers}
                height={470}
                onMarkerClick={handleMarkerClick}
              />

              {selectedPoint && (
                <div className="dashboard-selected-point-banner">
                  <div className="dashboard-selected-point-main">
                    <div className="dashboard-selected-point-title">
                      <Tag color="geekblue">Chi nhánh</Tag>
                      <strong>{selectedPoint.name}</strong>
                      <Text type="secondary">({selectedPoint.code})</Text>
                    </div>
                    <div className="dashboard-selected-point-address">
                      <EnvironmentOutlined /> {selectedPoint.address}
                    </div>
                    <div className="dashboard-selected-point-meta">
                      <span>
                        <CarOutlined /> {selectedPoint.vehicleCount || 0} xe trực thuộc
                      </span>
                      <span>
                        <TeamOutlined /> {selectedPoint.driverCount || 0} tài xế
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {selectedPoint.branch && canManageBranches && (
                      <Button
                        size="small"
                        type="primary"
                        ghost
                        icon={<EditOutlined />}
                        onClick={() => {
                          setSelectedBranchForEdit(selectedPoint.branch || null);
                          setIsEditBranchModalOpen(true);
                        }}
                      >
                        Sửa địa chỉ
                      </Button>
                    )}
                    <Button
                      size="small"
                      type="text"
                      icon={<CloseOutlined />}
                      aria-label="Đóng thông tin điểm đang chọn"
                      onClick={() => setSelectedPointId(null)}
                    />
                  </div>
                </div>
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card
            title={`Mạng Lưới Chi Nhánh (${filteredPointItems.length}/${allPointItems.length})`}
            className="dashboard-points-card"
          >
            <div className="dashboard-points-toolbar">
              <Input
                allowClear
                prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                placeholder="Tìm theo tên, mã chi nhánh hoặc địa chỉ..."
                value={pointSearchQuery}
                onChange={(e) => setPointSearchQuery(e.target.value)}
                aria-label="Tìm kiếm chi nhánh trong mạng lưới"
              />
            </div>

            <div className="dashboard-point-list">
              {filteredPointItems.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Không tìm thấy chi nhánh phù hợp với tìm kiếm"
                />
              ) : (
                filteredPointItems.map((item) => {
                  const isSelected = item.id === selectedPointId;

                  return (
                    <div
                      key={item.id}
                      className={`dashboard-point-item ${
                        isSelected ? 'dashboard-point-item-selected' : ''
                      }`}
                      onClick={() => setSelectedPointId(item.id)}
                    >
                      <div className="dashboard-point-topline">
                        <span className="dashboard-point-type dashboard-point-type-branch">
                          <ApartmentOutlined />
                        </span>
                        <div className="dashboard-point-copy">
                          <strong>{item.name}</strong>
                          <span>
                            <Tag color="geekblue">Chi nhánh</Tag>
                            {item.code}
                          </span>
                        </div>
                        {item.branch && canManageBranches && (
                          <Button
                            size="small"
                            type="link"
                            icon={<EditOutlined />}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedBranchForEdit(item.branch || null);
                              setIsEditBranchModalOpen(true);
                            }}
                            aria-label={`Sửa địa chỉ ${item.name}`}
                          >
                            Sửa
                          </Button>
                        )}
                      </div>

                      <div className="dashboard-point-address">
                        <EnvironmentOutlined /> {item.address}
                      </div>

                      <div className="dashboard-point-meta">
                        <span>
                          <CarOutlined /> {item.vehicleCount || 0} xe trực thuộc
                        </span>
                        <span>
                          <TeamOutlined /> {item.driverCount || 0} tài xế
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 4. Bảng Giám Sát Chuyến Đi Gần Đây */}
      <Card
        title="Danh Sách Chuyến Đi Gần Đây"
        extra={
          <div className="dashboard-trips-toolbar">
            <div className="dashboard-filter-pills" role="tablist" aria-label="Lọc trạng thái chuyến đi">
              {tripFilterButtons.map((btn) => {
                const isActive = tripStatusFilter === btn.key;
                return (
                  <button
                    key={btn.key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`dashboard-filter-pill ${
                      isActive ? 'dashboard-filter-pill-active' : ''
                    }`}
                    onClick={() => setTripStatusFilter(btn.key)}
                  >
                    {btn.label} ({btn.count})
                  </button>
                );
              })}
            </div>
            {canOpenDispatchManual && (
              <Button type="link" onClick={() => onNavigate('dispatch-manual')}>
                Xem tất cả trên Bàn điều phối <RightOutlined />
              </Button>
            )}
          </div>
        }
        variant="borderless"
        className="dashboard-trips-card"
      >
        <Table
          dataSource={filteredTrips}
          columns={tripColumns}
          rowKey="id"
          pagination={{ pageSize: 5 }}
          locale={{
            emptyText: 'Chưa có chuyến vận chuyển nào thuộc bộ lọc hiện tại',
          }}
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
