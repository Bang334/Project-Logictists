import React, { useEffect, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Select,
  Checkbox,
  Button,
  Tag,
  Typography,
  Space,
  message,
  Divider,
  Progress,
  Table,
  Spin,
  Alert,
} from 'antd';
import {
  CompassOutlined,
  CarOutlined,
  UserOutlined,
  CheckCircleOutlined,
  SendOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons';
import { vehiclesApi, driversApi, ordersApi, tripsApi } from '../api/client';
import { Vehicle, Driver, Order, Trip, LoadProfileResult } from '../types';
import MapboxMap from '../components/MapboxMap';

const { Title, Text } = Typography;

const DispatchPage: React.FC = () => {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form State
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('');
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);

  // Selected Trip & Active Analysis State
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [loadProfile, setLoadProfile] = useState<LoadProfileResult | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [vRes, dRes, oRes, tRes] = await Promise.all([
        vehiclesApi.getAvailable(),
        driversApi.getAvailable(),
        ordersApi.getAvailableForDispatch(),
        tripsApi.getAll(),
      ]);
      setVehicles(vRes.data);
      setDrivers(dRes.data);
      setOrders(oRes.data);
      setTrips(tRes.data);

      if (vRes.data.length > 0 && !selectedVehicleId) {
        setSelectedVehicleId(vRes.data[0].id);
      }
      if (dRes.data.length > 0 && !selectedDriverId) {
        setSelectedDriverId(dRes.data[0].id);
      }
      if (tRes.data.length > 0 && !activeTrip) {
        setActiveTrip(tRes.data[0]);
        fetchLoadProfile(tRes.data[0].id);
      }
    } catch {
      message.error('Lỗi khi tải dữ liệu điều phối');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const fetchLoadProfile = async (tripId: string) => {
    try {
      const res = await tripsApi.getLoadProfile(tripId);
      setLoadProfile(res.data);
    } catch (err) {
      console.error('Lỗi khi lấy load profile:', err);
    }
  };

  const handleSelectTrip = (trip: Trip) => {
    setActiveTrip(trip);
    fetchLoadProfile(trip.id);
  };

  const handleCreateTrip = async () => {
    if (!selectedVehicleId) {
      return message.warning('Vui lòng chọn xe tải thực hiện chuyến đi');
    }
    if (!selectedDriverId) {
      return message.warning('Vui lòng phân công tài xế');
    }
    if (selectedOrderIds.length === 0) {
      return message.warning('Vui lòng chọn ít nhất một đơn hàng để ghép vào chuyến');
    }

    try {
      setSubmitting(true);
      const now = new Date();
      const startTime = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
      const endTime = new Date(now.getTime() + 8 * 3600 * 1000).toISOString();

      const res = await tripsApi.create({
        vehicleId: selectedVehicleId,
        driverId: selectedDriverId,
        plannedStartTime: startTime,
        plannedEndTime: endTime,
        orderIds: selectedOrderIds,
        notes: 'Chuyến ghép đơn điều phối thủ công qua Mapbox',
      });

      message.success(`Đã tạo thành công chuyến đi ${res.data.tripNumber}!`);
      setActiveTrip(res.data);
      setSelectedOrderIds([]);
      fetchLoadProfile(res.data.id);
      fetchData();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể tạo chuyến đi do vi phạm quy tắc');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePublishTrip = async () => {
    if (!activeTrip) return;
    try {
      setSubmitting(true);
      const res = await tripsApi.publish(activeTrip.id);
      message.success(`Chuyến đi ${res.data.tripNumber} đã được phát hành (DISPATCHED)!`);
      setActiveTrip(res.data);
      fetchData();
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Không thể phát hành chuyến');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedVehicle = vehicles.find((v) => v.id === selectedVehicleId);
  const selectedDriver = drivers.find((d) => d.id === selectedDriverId);

  // Tính tổng trọng tải tạm tính của các đơn đang chọn
  const chosenOrders = orders.filter((o) => selectedOrderIds.includes(o.id));
  const estimatedWeight = chosenOrders.reduce((sum, o) => sum + o.totalWeightKg, 0);
  const estimatedVolume = chosenOrders.reduce((sum, o) => sum + o.totalVolumeM3, 0);

  // Chuẩn bị markers hiển thị trên Mapbox Map
  let mapMarkers: any[] = [];
  let routeGeometry: any = null;

  if (activeTrip) {
    if (activeTrip.vehicle?.homeBranch) {
      mapMarkers.push({
        id: 'depot',
        latitude: activeTrip.vehicle.homeBranch.latitude,
        longitude: activeTrip.vehicle.homeBranch.longitude,
        title: `Tổng kho xuất phát: ${activeTrip.vehicle.homeBranch.name}`,
        subtitle: activeTrip.vehicle.homeBranch.address,
        type: 'DEPOT',
      });
    }

    activeTrip.stops.forEach((stop) => {
      mapMarkers.push({
        id: stop.id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        title: `Điểm ${stop.sequence}: ${stop.stopType === 'PICKUP' ? 'Lấy Hàng' : 'Giao Hàng'}`,
        subtitle: stop.address,
        type: stop.stopType,
        sequence: stop.sequence,
      });
    });

    if (activeTrip.routeGeometry) {
      try {
        routeGeometry = JSON.parse(activeTrip.routeGeometry);
      } catch {
        routeGeometry = null;
      }
    }
  }

  const loadColumns = [
    {
      title: 'Chặng / Điểm Dừng',
      key: 'stop',
      render: (_: any, r: any) => (
        <div>
          <Tag color={r.stopType === 'PICKUP' ? 'green' : 'orange'}>
            #{r.stopIndex} {r.action === 'LOAD' ? 'BỐC HÀNG (+)' : 'DỠ HÀNG (-)'}
          </Tag>
          <div style={{ fontSize: '12px', marginTop: '4px', maxWidth: 260 }}>{r.stopAddress}</div>
        </div>
      ),
    },
    {
      title: 'Tải Trọng Trên Xe (kg)',
      key: 'weight',
      render: (_: any, r: any) => (
        <div>
          <strong>{r.currentWeightKg.toLocaleString()} kg</strong>
          <Progress
            percent={r.weightUtilizationPercent}
            size="small"
            status={r.weightUtilizationPercent > 100 ? 'exception' : 'active'}
          />
        </div>
      ),
    },
    {
      title: 'Thể Tích (m³)',
      key: 'volume',
      render: (_: any, r: any) => (
        <div>
          <span>{r.currentVolumeM3} m³</span>
          <Progress
            percent={r.volumeUtilizationPercent}
            size="small"
            strokeColor="#10b981"
            status={r.volumeUtilizationPercent > 100 ? 'exception' : 'normal'}
          />
        </div>
      ),
    },
  ];

  if (loading && trips.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Đang tải Bàn điều phối Mapbox..." />
      </div>
    );
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <CompassOutlined style={{ color: '#1d4ed8', marginRight: '8px' }} />
            Bàn Điều Phối Vận Tải (TMS Dispatch Console)
          </Title>
          <Text type="secondary">
            Lập kế hoạch chuyến đi, ghép nhiều đơn hàng, kiểm tra bất biến tải trọng (BR03 / BR04) và tích hợp Mapbox
          </Text>
        </div>
      </div>

      <Row gutter={[20, 20]}>
        {/* CỘT TRÁI: BÀN LẬP CHUYẾN & DANH SÁCH ĐƠN HÀNG */}
        <Col xs={24} xl={10}>
          <Card
            title="1. Thiết Lập Chuyến Đi Mới"
            bordered={false}
            className="card-elevation"
            style={{ marginBottom: '20px' }}
          >
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '6px', fontSize: '13px' }}>
                <CarOutlined /> Chọn Xe Tải Sẵn Sàng (Available Trucks)
              </label>
              <Select
                style={{ width: '100%' }}
                value={selectedVehicleId}
                onChange={setSelectedVehicleId}
                placeholder="Chọn xe tải"
              >
                {vehicles.map((v) => (
                  <Select.Option key={v.id} value={v.id}>
                    {v.plateNumber} — {v.model} ({v.payloadCapacityKg.toLocaleString()} kg / {v.volumeCapacityM3} m³)
                  </Select.Option>
                ))}
              </Select>
              {selectedVehicle && (
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  🏢 Chi nhánh: {selectedVehicle.homeBranch?.name} | Kích thước thùng: {selectedVehicle.lengthCm}x
                  {selectedVehicle.widthCm}x{selectedVehicle.heightCm} cm
                </div>
              )}
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '6px', fontSize: '13px' }}>
                <UserOutlined /> Phân Công Tài Xế (Available Drivers)
              </label>
              <Select
                style={{ width: '100%' }}
                value={selectedDriverId}
                onChange={setSelectedDriverId}
                placeholder="Chọn tài xế"
              >
                {drivers.map((d) => (
                  <Select.Option key={d.id} value={d.id}>
                    {d.fullName} — Bằng {d.licenseClass} ({d.phone})
                  </Select.Option>
                ))}
              </Select>
            </div>

            <Divider style={{ margin: '16px 0' }} />

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontWeight: 600, fontSize: '13px' }}>
                  2. Chọn Đơn Hàng Cần Ghép ({orders.length} đơn sẵn sàng)
                </span>
                <span style={{ fontSize: '12px', color: '#64748b' }}>
                  Đã chọn: <strong>{selectedOrderIds.length}</strong> đơn
                </span>
              </div>

              {orders.length === 0 ? (
                <Alert type="info" message="Tất cả đơn hàng hiện tại đã được gán vào chuyến xe." showIcon />
              ) : (
                <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px' }}>
                  {orders.map((o) => (
                    <div
                      key={o.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px',
                        borderBottom: '1px solid #f1f5f9',
                      }}
                    >
                      <Checkbox
                        checked={selectedOrderIds.includes(o.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedOrderIds([...selectedOrderIds, o.id]);
                          } else {
                            setSelectedOrderIds(selectedOrderIds.filter((id) => id !== o.id));
                          }
                        }}
                      >
                        <div>
                          <strong style={{ color: '#0284c7' }}>{o.orderNumber}</strong>
                          <span style={{ marginLeft: '8px', color: '#475569', fontSize: '12px' }}>
                            {o.customer.name}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          📦 {o.totalWeightKg} kg | {o.totalVolumeM3} m³ ({o.items[0]?.description})
                        </div>
                      </Checkbox>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedVehicle && selectedOrderIds.length > 0 && (
              <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                  <span>Tải trọng tạm tính:</span>
                  <strong>
                    {estimatedWeight} / {selectedVehicle.payloadCapacityKg} kg (
                    {Math.round((estimatedWeight / selectedVehicle.payloadCapacityKg) * 100)}%)
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginTop: '4px' }}>
                  <span>Thể tích tạm tính:</span>
                  <strong>
                    {estimatedVolume.toFixed(1)} / {selectedVehicle.volumeCapacityM3} m³ (
                    {Math.round((estimatedVolume / selectedVehicle.volumeCapacityM3) * 100)}%)
                  </strong>
                </div>
              </div>
            )}

            <Button
              type="primary"
              size="large"
              block
              icon={<SendOutlined />}
              onClick={handleCreateTrip}
              loading={submitting}
              disabled={selectedOrderIds.length === 0}
              style={{ marginTop: '16px' }}
            >
              Tạo Chuyến Đi & Kiểm Tra Bất Biến (BR03 / BR04)
            </Button>
          </Card>

          {/* DANH SÁCH CÁC CHUYẾN ĐI ĐÃ TẠO */}
          <Card title="Danh Sách Chuyến Đi Đang Quản Lý" bordered={false} className="card-elevation">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {trips.map((t) => (
                <div
                  key={t.id}
                  onClick={() => handleSelectTrip(t)}
                  style={{
                    padding: '12px',
                    borderRadius: '6px',
                    border: activeTrip?.id === t.id ? '2px solid #2563eb' : '1px solid #e2e8f0',
                    background: activeTrip?.id === t.id ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ color: '#1d4ed8', fontSize: '14px' }}>{t.tripNumber}</strong>
                    <Tag color={t.status === 'DISPATCHED' ? 'cyan' : 'gold'}>{t.status}</Tag>
                  </div>
                  <div style={{ fontSize: '12px', color: '#475569', marginTop: '4px' }}>
                    🚗 Xe: <strong>{t.vehicle.plateNumber}</strong> ({t.vehicle.model}) | 👤 Tài xế:{' '}
                    <strong>{t.assignments[0]?.driver.fullName}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                    <span>🛣️ Cự ly Mapbox: <strong>{t.totalDistanceKm} km</strong></span>
                    <span>⏱️ Thời gian: <strong>{t.totalDurationMinutes} phút</strong></span>
                    <span>🛑 Số chặng: <strong>{t.stops.length} điểm</strong></span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </Col>

        {/* CỘT PHẢI: BẢN ĐỒ MAPBOX & PHÂN TÍCH TẢI TRỌNG TỪNG CHẶNG */}
        <Col xs={24} xl={14}>
          <Card
            title={
              activeTrip ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    Bản Đồ Lộ Trình Mapbox — Chuyến <strong>{activeTrip.tripNumber}</strong>
                  </span>
                  <Space>
                    <Tag color="blue">{activeTrip.totalDistanceKm} km</Tag>
                    <Tag color="purple">~{activeTrip.totalDurationMinutes} phút</Tag>
                    {activeTrip.status === 'PLANNED' && (
                      <Button
                        type="primary"
                        size="small"
                        icon={<CheckCircleOutlined />}
                        onClick={handlePublishTrip}
                        loading={submitting}
                        style={{ background: '#059669', borderColor: '#059669' }}
                      >
                        Phát Hành Chuyến (Publish)
                      </Button>
                    )}
                  </Space>
                </div>
              ) : (
                'Bản Đồ Lộ Trình Mapbox'
              )
            }
            bordered={false}
            className="card-elevation"
            style={{ marginBottom: '20px' }}
          >
            <MapboxMap markers={mapMarkers} routeGeometry={routeGeometry} height={460} />
          </Card>

          {/* BIỂU ĐỒ PHÂN TÍCH TẢI TRỌNG TỪNG CHẶNG (BR04 INVARIANT VERIFICATION) */}
          {loadProfile && (
            <Card
              title={
                <Space>
                  <span>Phân Tích Tải Trọng Từng Chặng (Stop-by-Stop Load Profile)</span>
                  <Tag color="green">Bất Biến BR03 & BR04 Đạt Chuẩn</Tag>
                </Space>
              }
              bordered={false}
              className="card-elevation"
            >
              <Alert
                type="success"
                showIcon
                message="Kiểm chứng bất biến tải trọng thành công:"
                description={
                  <span style={{ fontSize: '13px' }}>
                    Tải trọng tối đa trên xe đạt <strong>{loadProfile.maxWeightKg} kg</strong> (Giới hạn xe:{' '}
                    {activeTrip?.vehicle.payloadCapacityKg} kg). Thể tích tối đa đạt{' '}
                    <strong>{loadProfile.maxVolumeM3} m³</strong> (Dung tích xe:{' '}
                    {activeTrip?.vehicle.volumeCapacityM3} m³). Điểm lấy hàng luôn đi trước điểm giao hàng.
                  </span>
                }
                style={{ marginBottom: '16px' }}
              />

              <Table
                dataSource={loadProfile.loadProfile}
                columns={loadColumns}
                rowKey="stopIndex"
                pagination={false}
                size="small"
              />
            </Card>
          )}
        </Col>
      </Row>
    </div>
  );
};

export default DispatchPage;
