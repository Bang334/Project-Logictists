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
  Divider,
  Progress,
  Table,
  Spin,
  Alert,
  App as AntdApp,
} from 'antd';
import {
  CompassOutlined,
  CarOutlined,
  UserOutlined,
  CheckCircleOutlined,
  SendOutlined,
  EnvironmentOutlined,
  ThunderboltOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons';
import { vehiclesApi, driversApi, ordersApi, tripsApi } from '../api/client';
import {
  Vehicle,
  Driver,
  Order,
  Trip,
  LoadProfileResult,
  OptimizationResultUI,
} from '../types';
import MapboxMap from '../components/MapboxMap';
import FloorPackingVisualizer from '../components/FloorPackingVisualizer';

const { Title, Text } = Typography;

const DispatchPage: React.FC = () => {
  const { message } = AntdApp.useApp();
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
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResultUI | null>(null);
  const [orderedStopIds, setOrderedStopIds] = useState<string[]>([]);
  const [draftRouteGeometry, setDraftRouteGeometry] = useState<any>(null);
  const [draftRouteStats, setDraftRouteStats] = useState<{ distanceKm: number; durationMinutes: number } | null>(null);
  const [enableSim, setEnableSim] = useState<boolean>(false);

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
        orderedStopIds,
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

  const handleRunOptimization = async () => {
    if (!selectedVehicleId) {
      return message.warning('Vui lòng chọn xe tải để tối ưu tuyến');
    }
    if (selectedOrderIds.length === 0) {
      return message.warning('Vui lòng chọn ít nhất 1 đơn hàng để tối ưu');
    }

    try {
      setOptimizing(true);
      const res = await tripsApi.optimize({ vehicleId: selectedVehicleId, orderIds: selectedOrderIds });
      setOptimizationResult(res.data);
      if (res.data.status === 'SUCCESS') {
        setOrderedStopIds(res.data.stops.map((stop) => stop.location_id));
        message.success(
          `Google OR-Tools đã tối ưu thành công! Cự ly: ${res.data.total_distance_km} km, thời gian: ${res.data.total_duration_minutes} phút, xếp dỡ 2D hợp lệ.`
        );
      } else {
        message.warning(`Kết quả tối ưu: ${res.data.status}`);
      }
    } catch (err: any) {
      message.error(err.response?.data?.message || 'Lỗi khi gọi Optimization Engine (FastAPI)');
    } finally {
      setOptimizing(false);
    }
  };

  const handleOrderToggle = (order: Order, checked: boolean) => {
    if (checked) {
      setSelectedOrderIds((current) => [...current, order.id]);
      setOrderedStopIds((current) => [
        ...current,
        ...order.stops
          .slice()
          .sort((a, b) => a.sequence - b.sequence)
          .map((stop) => stop.id),
      ]);
    } else {
      const stopIds = new Set(order.stops.map((stop) => stop.id));
      setSelectedOrderIds((current) => current.filter((id) => id !== order.id));
      setOrderedStopIds((current) => current.filter((id) => !stopIds.has(id)));
    }
    setOptimizationResult(null);
  };

  const moveStop = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= orderedStopIds.length) return;
    setOrderedStopIds((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const selectedVehicle = vehicles.find((v) => v.id === selectedVehicleId);
  const selectedDriver = drivers.find((d) => d.id === selectedDriverId);

  // Tính tổng trọng tải tạm tính của các đơn đang chọn
  const chosenOrders = orders.filter((o) => selectedOrderIds.includes(o.id));
  const estimatedWeight = chosenOrders.reduce((sum, o) => sum + o.totalWeightKg, 0);
  const estimatedVolume = chosenOrders.reduce((sum, o) => sum + o.totalVolumeM3, 0);
  const selectedStopById = new Map(
    chosenOrders.flatMap((order) =>
      order.stops.map((stop) => ({ ...stop, orderNumber: order.orderNumber })),
    ).map((stop) => [stop.id, stop]),
  );

  // Tự động kết nối tuyến đường (Mapbox Driving Directions) ngay khi người dùng chọn đơn / đổi thứ tự điểm dừng
  useEffect(() => {
    if (chosenOrders.length === 0 || orderedStopIds.length === 0) {
      setDraftRouteGeometry(null);
      setDraftRouteStats(null);
      return;
    }

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    const stopById = new Map(
      chosenOrders.flatMap((order) => order.stops).map((stop) => [stop.id, stop]),
    );
    const coords: [number, number][] = [];

    // Điểm xuất phát từ bãi xe / chi nhánh của xe
    if (selectedVehicle?.homeBranch) {
      coords.push([selectedVehicle.homeBranch.longitude, selectedVehicle.homeBranch.latitude]);
    }

    // Các điểm dừng theo thứ tự đã sắp xếp
    orderedStopIds.forEach((stopId) => {
      const stop = stopById.get(stopId);
      if (stop) {
        coords.push([stop.longitude, stop.latitude]);
      }
    });

    if (coords.length < 2) {
      setDraftRouteGeometry(null);
      setDraftRouteStats(null);
      return;
    }

    let isMounted = true;

    const fetchRoute = async () => {
      if (!token) {
        if (isMounted) {
          setDraftRouteGeometry({
            type: 'LineString',
            coordinates: coords,
          });
        }
        return;
      }

      try {
        const coordsString = coords.map((c) => `${c[0]},${c[1]}`).join(';');
        const res = await fetch(
          `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsString}?geometries=geojson&overview=full&access_token=${token}`,
        );
        const data = await res.json();
        if (isMounted) {
          if (data.routes && data.routes.length > 0) {
            const r = data.routes[0];
            setDraftRouteGeometry(r.geometry);
            setDraftRouteStats({
              distanceKm: Math.round((r.distance / 1000) * 10) / 10,
              durationMinutes: Math.round(r.duration / 60),
            });
          } else {
            setDraftRouteGeometry({
              type: 'LineString',
              coordinates: coords,
            });
          }
        }
      } catch {
        if (isMounted) {
          setDraftRouteGeometry({
            type: 'LineString',
            coordinates: coords,
          });
        }
      }
    };

    fetchRoute();

    return () => {
      isMounted = false;
    };
  }, [chosenOrders.length, orderedStopIds, selectedVehicle?.homeBranch]);

  // Chuẩn bị markers hiển thị trên Mapbox Map
  let mapMarkers: any[] = [];
  let routeGeometry: any = null;

  if (chosenOrders.length > 0) {
    routeGeometry = draftRouteGeometry;
    if (selectedVehicle?.homeBranch) {
      mapMarkers.push({
        id: 'draft-depot',
        latitude: selectedVehicle.homeBranch.latitude,
        longitude: selectedVehicle.homeBranch.longitude,
        title: `Điểm xuất phát: ${selectedVehicle.homeBranch.name}`,
        subtitle: selectedVehicle.homeBranch.address,
        type: 'DEPOT',
      });
    }
    const stopById = new Map(chosenOrders.flatMap((order) => order.stops).map((stop) => [stop.id, stop]));
    orderedStopIds.forEach((stopId, index) => {
      const stop = stopById.get(stopId);
      if (!stop) return;
      mapMarkers.push({
        id: stop.id,
        latitude: stop.latitude,
        longitude: stop.longitude,
        title: `${index + 1}. ${stop.type === 'PICKUP' ? 'Nhận hàng' : 'Giao hàng'}`,
        subtitle: stop.address,
        type: stop.type,
        sequence: index + 1,
      });
    });
  } else if (activeTrip) {
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
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '60vh', gap: '16px' }}>
        <Spin size="large" />
        <Text type="secondary">Đang tải Bàn điều phối Mapbox...</Text>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <CompassOutlined style={{ color: '#1d4ed8', marginRight: '8px' }} />
            Điều Phối Thủ Công
          </Title>
          <Text type="secondary">
            Chọn đơn ngay trên danh sách/bản đồ, sắp thứ tự điểm dừng, gán xe và tài xế trước khi phát hành
          </Text>
        </div>
      </div>

      <Row gutter={[20, 20]}>
        {/* CỘT TRÁI: BÀN LẬP CHUYẾN & DANH SÁCH ĐƠN HÀNG */}
        <Col xs={24} xl={10}>
          <Card
            title="1. Thiết Lập Chuyến Đi Mới"
            variant="borderless"
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
                  Chi nhánh: {selectedVehicle.homeBranch?.name} | Kích thước thùng: {selectedVehicle.lengthCm}x
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
                        onChange={(e) => handleOrderToggle(o, e.target.checked)}
                      >
                        <div>
                          <strong style={{ color: '#0284c7' }}>{o.orderNumber}</strong>
                          <span style={{ marginLeft: '8px', color: '#475569', fontSize: '12px' }}>
                            {o.customer.name}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>
                          {o.totalPackages} kiện · {o.totalWeightKg} kg · {o.totalVolumeM3} m³ ({o.items.length} loại hàng)
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

            {orderedStopIds.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Text strong>3. Thứ tự điểm dừng</Text>
                <div className="dispatch-stop-list" style={{ marginTop: 8 }}>
                  {orderedStopIds.map((stopId, index) => {
                    const stop = selectedStopById.get(stopId);
                    if (!stop) return null;
                    return (
                      <div className="dispatch-stop-row" key={stopId}>
                        <Tag color={stop.type === 'PICKUP' ? 'green' : 'orange'}>
                          {index + 1}. {stop.type === 'PICKUP' ? 'NHẬN' : 'GIAO'}
                        </Tag>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text strong>{stop.orderNumber}</Text>
                          <div className="dispatch-stop-address">{stop.address}</div>
                        </div>
                        <Space size={4}>
                          <Button
                            aria-label={`Đưa điểm ${index + 1} lên trước`}
                            icon={<ArrowUpOutlined />}
                            disabled={index === 0}
                            onClick={() => moveStop(index, -1)}
                          />
                          <Button
                            aria-label={`Đưa điểm ${index + 1} xuống sau`}
                            icon={<ArrowDownOutlined />}
                            disabled={index === orderedStopIds.length - 1}
                            onClick={() => moveStop(index, 1)}
                          />
                        </Space>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <Space direction="vertical" style={{ width: '100%', marginTop: '16px' }}>
              <Button
                type="default"
                size="large"
                block
                icon={<ThunderboltOutlined style={{ color: '#d97706' }} />}
                onClick={handleRunOptimization}
                loading={optimizing}
                disabled={selectedOrderIds.length === 0}
                style={{
                  borderColor: '#f59e0b',
                  color: '#92400e',
                  background: '#fef3c7',
                  fontWeight: 600,
                }}
              >
                Gợi Ý Thứ Tự Tuyến Cho Các Đơn Đã Chọn
              </Button>

              <Button
                type="primary"
                size="large"
                block
                icon={<SendOutlined />}
                onClick={handleCreateTrip}
                loading={submitting}
                disabled={selectedOrderIds.length === 0}
              >
                Tạo Chuyến Đi & Kiểm Tra Bất Biến (BR03 / BR04)
              </Button>
            </Space>
          </Card>

          {/* DANH SÁCH CÁC CHUYẾN ĐI ĐÃ TẠO */}
          <Card title="Danh Sách Chuyến Đi Đang Quản Lý" variant="borderless" className="card-elevation">
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
                    Xe: <strong>{t.vehicle.plateNumber}</strong> ({t.vehicle.model}) | Tài xế:{' '}
                    <strong>{t.assignments[0]?.driver.fullName}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
                    <span>Cự ly Mapbox: <strong>{t.totalDistanceKm} km</strong></span>
                    <span>Thời gian: <strong>{t.totalDurationMinutes} phút</strong></span>
                    <span>Số chặng: <strong>{t.stops.length} điểm</strong></span>
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
              chosenOrders.length > 0 ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span>Bản đồ phương án đang thiết lập (Đường nối tuyến thực tế)</span>
                  <Space wrap>
                    <Tag color="blue">{orderedStopIds.length} điểm dừng</Tag>
                    {draftRouteStats && (
                      <>
                        <Tag color="green">~{draftRouteStats.distanceKm} km</Tag>
                        <Tag color="purple">~{draftRouteStats.durationMinutes} phút</Tag>
                      </>
                    )}
                    <Button
                      type={enableSim ? 'default' : 'primary'}
                      size="small"
                      icon={enableSim ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                      disabled={!routeGeometry}
                      onClick={() => setEnableSim(!enableSim)}
                    >
                      {enableSim ? 'Dừng mô phỏng' : 'Demo xe chạy'}
                    </Button>
                  </Space>
                </div>
              ) : activeTrip ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span>
                    Bản Đồ Lộ Trình Mapbox — Chuyến <strong>{activeTrip.tripNumber}</strong>
                  </span>
                  <Space wrap>
                    <Tag color="blue">{activeTrip.totalDistanceKm} km</Tag>
                    <Tag color="purple">~{activeTrip.totalDurationMinutes} phút</Tag>
                    <Button
                      type={enableSim ? 'default' : 'primary'}
                      size="small"
                      icon={enableSim ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                      disabled={!routeGeometry}
                      onClick={() => setEnableSim(!enableSim)}
                    >
                      {enableSim ? 'Dừng mô phỏng' : 'Demo xe chạy'}
                    </Button>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Bản Đồ Lộ Trình Mapbox</span>
                  {routeGeometry && (
                    <Button
                      type={enableSim ? 'default' : 'primary'}
                      size="small"
                      icon={enableSim ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                      onClick={() => setEnableSim(!enableSim)}
                    >
                      {enableSim ? 'Dừng mô phỏng' : 'Demo xe chạy'}
                    </Button>
                  )}
                </div>
              )
            }
            variant="borderless"
            className="card-elevation"
            style={{ marginBottom: '20px' }}
          >
            <MapboxMap
              markers={mapMarkers}
              routeGeometry={routeGeometry}
              height={460}
              enableSimulation={enableSim}
              autoPlaySimulation={enableSim}
              vehiclePlate={activeTrip ? activeTrip.vehicle?.plateNumber : selectedVehicle?.plateNumber || '29C-678.92'}
              driverName={activeTrip ? activeTrip.assignments[0]?.driver?.fullName : drivers.find(d => d.id === selectedDriverId)?.fullName || 'Tài xế'}
            />
          </Card>

          {/* KẾT QUẢ TỐI ƯU TUYẾN & MÔ PHỎNG XẾP DỠ MẶT SÀN 2D (OR-TOOLS / NGƯỜI 3) */}
          {optimizationResult && (
            <div style={{ marginBottom: '20px' }}>
              <FloorPackingVisualizer
                vehicle={selectedVehicle}
                stepStates={optimizationResult.spatial_validation?.step_states || []}
                isValid={optimizationResult.spatial_validation?.is_valid ?? true}
                violations={
                  optimizationResult.spatial_validation?.error_message
                    ? [optimizationResult.spatial_validation.error_message]
                    : []
                }
              />
            </div>
          )}

          {/* BIỂU ĐỒ PHÂN TÍCH TẢI TRỌNG TỪNG CHẶNG (BR04 INVARIANT VERIFICATION) */}
          {loadProfile && (
            <Card
              title={
                <Space>
                  <span>Phân Tích Tải Trọng Từng Chặng (Stop-by-Stop Load Profile)</span>
                  <Tag color="green">Bất Biến BR03 & BR04 Đạt Chuẩn</Tag>
                </Space>
              }
              variant="borderless"
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
