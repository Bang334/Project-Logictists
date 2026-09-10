import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  App as AntdApp,
  Tooltip,
  Timeline,
  Segmented,
  Tabs,
} from 'antd';
import {
  BranchesOutlined,
  CarOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  LoadingOutlined,
  NodeIndexOutlined,
  ThunderboltOutlined,
  UserOutlined,
  AimOutlined,
  ArrowRightOutlined,
  BankOutlined,
  CloseOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  CoffeeOutlined,
  ClockCircleOutlined,
  ScheduleOutlined,
  UnorderedListOutlined,
  InboxOutlined,
  ExportOutlined,
  ApartmentOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { driversApi, ordersApi, tripsApi, vehiclesApi } from '../api/client';
import MapboxMap, { MAP_ROUTE_COLORS, MapMarker } from '../components/MapboxMap';
import FloorPackingVisualizer from '../components/FloorPackingVisualizer';
import { OptimizationJobUI, OptimizedRouteUI, Order, Vehicle, Driver } from '../types';
import {
  calculateStopMilestonesKm,
  getStepIndexForDistance,
  buildRouteProfile,
} from '../utils/geoSimulation';

const { Title, Text } = Typography;
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

const BASE_START_TOTAL_MINUTES = 7 * 60 + 30; // 07:30 sáng

const formatMinutesToTime = (minutes: number): string => {
  const h = Math.floor((minutes / 60) % 24);
  const m = Math.floor(minutes % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

interface DriverScheduleItem {
  id: string;
  type: 'DEPOT_START' | 'STOP' | 'REST' | 'DEPOT_END';
  startTimeStr: string;
  endTimeStr: string;
  durationMinutes: number;
  title: string;
  address?: string;
  orderNumber?: string;
  actionType?: 'PICKUP' | 'DELIVERY';
  deltaPackages?: number;
  weightKg?: number;
  stopSequence?: number;
  stopIndex?: number;
  notes?: string;
  tagColor?: string;
}

interface DriverScheduleResult {
  items: DriverScheduleItem[];
  startTime: string;
  endTime: string;
  totalWorkDuration: string;
  drivingDuration: string;
  serviceDuration: string;
  restDurationMinutes: number;
}

const buildDriverSchedule = (route: OptimizedRouteUI): DriverScheduleResult => {
  const items: DriverScheduleItem[] = [];
  let currentMinute = BASE_START_TOTAL_MINUTES;

  // 1. Xuất bến tại Depot
  const depotStartMinutes = 15;
  items.push({
    id: 'depot-start',
    type: 'DEPOT_START',
    startTimeStr: formatMinutesToTime(currentMinute),
    endTimeStr: formatMinutesToTime(currentMinute + depotStartMinutes),
    durationMinutes: depotStartMinutes,
    title: `Xuất bến tại ${route.depot?.name || 'Chi nhánh / Kho xuất phát'}`,
    notes: 'Kiểm tra kỹ thuật xe, nhận lệnh điều phối, kiểm tra chằng buộc hàng hóa',
    tagColor: 'blue',
  });
  currentMinute += depotStartMinutes;

  let totalDriveMinutes = 0;
  let totalServiceMinutes = 0;
  let restMinutes = 0;
  let hasRest = false;

  const stops = route.stops || [];
  const avgDriveBetweenStops = Math.max(
    18,
    Math.round((route.total_duration_minutes * 0.65) / Math.max(1, stops.length + 1))
  );

  stops.forEach((stop, idx) => {
    // Chặng di chuyển tới điểm dừng
    let travelTime = avgDriveBetweenStops;
    if (stop.arrival_time_sec && stop.arrival_time_sec > 0) {
      const targetArrival = BASE_START_TOTAL_MINUTES + depotStartMinutes + Math.round(stop.arrival_time_sec / 60);
      travelTime = Math.max(10, targetArrival - currentMinute);
    }
    totalDriveMinutes += travelTime;
    currentMinute += travelTime;

    // Chèn giờ nghỉ trưa / nghỉ ngơi phục hồi an toàn (Bất biến BR07 & Luật GTĐB: Không lái liên tục quá 4h)
    if (!hasRest && (currentMinute >= 11 * 60 + 30 || totalDriveMinutes >= 210)) {
      const restDuration = 45;
      items.push({
        id: 'rest-break',
        type: 'REST',
        startTimeStr: formatMinutesToTime(currentMinute),
        endTimeStr: formatMinutesToTime(currentMinute + restDuration),
        durationMinutes: restDuration,
        title: 'Nghỉ ngơi an toàn & Ăn trưa giữa ca (45 phút)',
        notes: 'Tuân thủ Bất biến BR07 & Luật GTĐB: Tài xế nghỉ ngơi phục hồi thể lực sau thời gian lái xe',
        tagColor: 'gold',
      });
      currentMinute += restDuration;
      restMinutes += restDuration;
      hasRest = true;
    }

    // Thời gian bốc dỡ tại điểm
    const loadedCount = stop.items_loaded?.length || 0;
    const unloadedCount = stop.items_unloaded?.length || 0;
    const pkgCount = stop.stop_type === 'PICKUP' ? loadedCount : unloadedCount;
    const serviceTime = Math.min(35, Math.max(15, Math.round(12 + pkgCount * 1.2)));
    totalServiceMinutes += serviceTime;

    const arrivalStr = formatMinutesToTime(currentMinute);
    const departureStr = formatMinutesToTime(currentMinute + serviceTime);

    const orderCode = stop.order_id
      ? (stop.order_id.length > 10 ? `DH-${stop.order_id.slice(-6).toUpperCase()}` : stop.order_id)
      : `Đơn #${idx + 1}`;

    items.push({
      id: `stop-${stop.sequence}-${stop.location_id}`,
      type: 'STOP',
      startTimeStr: arrivalStr,
      endTimeStr: departureStr,
      durationMinutes: serviceTime,
      title: `Điểm #${stop.sequence}: ${stop.stop_type === 'PICKUP' ? 'LẤY HÀNG' : 'GIAO HÀNG'}`,
      address: stop.location_name,
      orderNumber: orderCode,
      actionType: stop.stop_type,
      deltaPackages: stop.stop_type === 'PICKUP' ? loadedCount : -unloadedCount,
      weightKg: stop.current_weight_kg,
      stopSequence: stop.sequence,
      stopIndex: idx,
      notes: `${stop.stop_type === 'PICKUP' ? `Bốc ${loadedCount} kiện lên sàn xe` : `Dỡ giao ${unloadedCount} kiện cho khách`} (thời gian thao tác ~${serviceTime} phút) · Tải xe: ${stop.current_weight_kg.toFixed(0)} kg`,
      tagColor: stop.stop_type === 'PICKUP' ? 'green' : 'orange',
    });

    currentMinute += serviceTime;
  });

  // Chặng về bến kết thúc ca
  const returnDrive = Math.max(20, Math.round(avgDriveBetweenStops * 1.1));
  totalDriveMinutes += returnDrive;
  currentMinute += returnDrive;

  items.push({
    id: 'depot-end',
    type: 'DEPOT_END',
    startTimeStr: formatMinutesToTime(currentMinute),
    endTimeStr: formatMinutesToTime(currentMinute + 15),
    durationMinutes: 15,
    title: `Về bến kết thúc ca: ${route.depot?.name || 'Chi nhánh / Kho xuất phát'}`,
    notes: 'Bàn giao chứng từ POD, biên bản nghiệm thu giao hàng, kiểm tra xe, kết thúc ca làm việc',
    tagColor: 'blue',
  });
  currentMinute += 15;

  const totalShiftMinutes = currentMinute - BASE_START_TOTAL_MINUTES;

  return {
    items,
    startTime: formatMinutesToTime(BASE_START_TOTAL_MINUTES),
    endTime: formatMinutesToTime(currentMinute),
    totalWorkDuration: `${Math.floor(totalShiftMinutes / 60)}h ${totalShiftMinutes % 60}p`,
    drivingDuration: `${(totalDriveMinutes / 60).toFixed(1)} giờ`,
    serviceDuration: `${(totalServiceMinutes / 60).toFixed(1)} giờ`,
    restDurationMinutes: restMinutes,
  };
};

const AutomaticDispatchPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [counts, setCounts] = useState({ orders: 0, vehicles: 0, drivers: 0, packages: 0 });
  const [availableOrders, setAvailableOrders] = useState<Order[]>([]);
  const [availableVehicles, setAvailableVehicles] = useState<Vehicle[]>([]);
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([]);
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [job, setJob] = useState<OptimizationJobUI | null>(null);
  const [starting, setStarting] = useState(false);
  const [selectedVehicleForMap, setSelectedVehicleForMap] = useState<string | 'ALL'>('ALL');
  const [enableSim, setEnableSim] = useState<boolean>(false);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [mapLayoutMode, setMapLayoutMode] = useState<'HALF' | 'FULL'>('HALF');

  const loadCounts = async () => {
    try {
      setLoadingCounts(true);
      const [orders, vehicles, drivers] = await Promise.all([
        ordersApi.getAvailableForDispatch(),
        vehiclesApi.getAvailable(),
        driversApi.getAvailable(),
      ]);
      setAvailableOrders(orders.data);
      setAvailableVehicles(vehicles.data);
      setAvailableDrivers(drivers.data);
      setCounts({
        orders: orders.data.length,
        vehicles: vehicles.data.length,
        drivers: drivers.data.length,
        packages: orders.data.reduce((sum, order) => sum + order.totalPackages, 0),
      });
    } catch (error) {
      message.error('Không tải được nguồn lực cho tối ưu tự động');
    } finally {
      setLoadingCounts(false);
    }
  };

  useEffect(() => {
    void loadCounts();
  }, []);

  useEffect(() => {
    if (!job || !['PENDING', 'RUNNING'].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await tripsApi.getOptimizationJob(job.id);
        setJob(response.data);
        if (['COMPLETED', 'FAILED'].includes(response.data.status)) {
          window.clearInterval(timer);
          if (response.data.status === 'COMPLETED') {
            message.success('Đã tạo phương án điều phối tự động để bạn kiểm tra');
          }
        }
      } catch (error) {
        window.clearInterval(timer);
        message.error('Mất kết nối khi theo dõi optimization job');
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.status]);

  const startOptimization = async () => {
    try {
      setStarting(true);
      const response = await tripsApi.createAutomaticOptimizationJob();
      setJob(response.data);
      message.info('Đã tạo job; hệ thống đang tự chọn đơn, xe, tài xế và tuyến');
    } catch (error: any) {
      message.error(error.response?.data?.message || 'Không thể bắt đầu tối ưu tự động');
    } finally {
      setStarting(false);
    }
  };

  const result = job?.result;

  // Lọc danh sách tuyến hiển thị trên bản đồ (xem tất cả hoặc xem riêng 1 xe)
  const activeRoutesForMap = useMemo(() => {
    if (!result) return [];
    if (selectedVehicleForMap === 'ALL') {
      return result.routes;
    }
    return result.routes.filter((r) => r.vehicle_id === selectedVehicleForMap);
  }, [result, selectedVehicleForMap]);

  const selectedRouteInfo = useMemo(() => {
    if (!result || selectedVehicleForMap === 'ALL') return null;
    return result.routes.find((r) => r.vehicle_id === selectedVehicleForMap) || null;
  }, [result, selectedVehicleForMap]);

  // Tuyến xe đang được theo dõi diễn biến mô phỏng và hàng hóa
  const currentActiveRoute = useMemo(
    () => selectedRouteInfo || (result?.routes.length ? result.routes[0] : null),
    [selectedRouteInfo, result],
  );

  const routeProfileForSim = useMemo(() => {
    if (!currentActiveRoute?.route_geometry?.coordinates) return null;
    return buildRouteProfile(currentActiveRoute.route_geometry.coordinates);
  }, [currentActiveRoute]);

  // Cột mốc cự ly (km) cho từng điểm dừng: đảm bảo chỉ khi xe thực sự chạm điểm dừng mới chất/dỡ hàng
  const stopMilestonesKm = useMemo(() => {
    if (!routeProfileForSim || !currentActiveRoute?.stops) return [];
    return calculateStopMilestonesKm(routeProfileForSim, currentActiveRoute.stops);
  }, [routeProfileForSim, currentActiveRoute]);

  const mapMarkers = useMemo(() => {
    const depotMarkers = new Map<string, MapMarker>();
    const stopMarkers: MapMarker[] = [];
    const depotRouteCounts = new Map<string, number>();

    const resolveDepot = (route: OptimizedRouteUI) => {
      if (route.depot) return route.depot;
      const firstRouteCoordinate = route.route_geometry?.coordinates[0];
      if (!firstRouteCoordinate) return null;
      return {
        id: `fallback-${firstRouteCoordinate[0]}-${firstRouteCoordinate[1]}`,
        name: 'Công ty / chi nhánh',
        longitude: firstRouteCoordinate[0],
        latitude: firstRouteCoordinate[1],
      };
    };

    const getDepotKey = (depot: NonNullable<ReturnType<typeof resolveDepot>>) =>
      `${depot.id}-${depot.longitude}-${depot.latitude}`;

    activeRoutesForMap.forEach((route) => {
      const depot = resolveDepot(route);
      if (!depot) return;
      const depotKey = getDepotKey(depot);
      depotRouteCounts.set(depotKey, (depotRouteCounts.get(depotKey) || 0) + 1);
    });

    activeRoutesForMap.forEach((route) => {
      const originalIndex =
        result?.routes.findIndex((item) => item.vehicle_id === route.vehicle_id) ?? 0;
      const routeColor = MAP_ROUTE_COLORS[originalIndex % MAP_ROUTE_COLORS.length];
      const depot = resolveDepot(route);

      if (depot) {
        const depotKey = getDepotKey(depot);
        if (!depotMarkers.has(depotKey)) {
          depotMarkers.set(depotKey, {
            id: `depot-${depotKey}`,
            latitude: depot.latitude,
            longitude: depot.longitude,
            title: `Công ty / chi nhánh: ${depot.name}`,
            subtitle: `Điểm xuất phát và kết thúc · ${depotRouteCounts.get(depotKey) || 1} tuyến xe`,
            type: 'DEPOT',
            color: '#0f3d5e',
          });
        }
      }

      stopMarkers.push(
        ...route.stops.map((stop) => ({
          id: `${route.vehicle_id}-${stop.location_id}`,
          latitude: stop.latitude,
          longitude: stop.longitude,
          title: `${route.plate_number} (${route.driver_name}) · ${stop.stop_type === 'PICKUP' ? 'Nhận' : 'Giao'} hàng`,
          subtitle: stop.location_name,
          type: stop.stop_type,
          sequence: stop.sequence,
          routeIndex: originalIndex,
          color: routeColor,
          plateNumber: route.plate_number,
          driverName: route.driver_name,
        })),
      );
    });

    return [...depotMarkers.values(), ...stopMarkers];
  }, [activeRoutesForMap, result]);

  const routeGeometry = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: activeRoutesForMap
        .filter((route) => route.route_geometry)
        .map((route) => {
          const originalIndex =
            result?.routes.findIndex((r) => r.vehicle_id === route.vehicle_id) ?? 0;
          return {
            type: 'Feature' as const,
            properties: { routeIndex: originalIndex },
            geometry: route.route_geometry!,
          };
        }),
    }),
    [activeRoutesForMap, result],
  );

  const [routeViewMode, setRouteViewMode] = useState<Record<string, 'TIMELINE' | 'TABLE'>>({});

  const renderRoute = (route: OptimizedRouteUI) => {
    const isThisRouteActive = currentActiveRoute?.vehicle_id === route.vehicle_id;
    const schedule = buildDriverSchedule(route);
    const currentViewMode = routeViewMode[route.vehicle_id] || 'TIMELINE';

    return (
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="Xe">{route.plate_number}</Descriptions.Item>
            <Descriptions.Item label="Tài xế">
              <Space size={4} wrap>
                <strong>{route.driver_name}</strong>
                {route.driver_license_class && (
                  <Tag
                    color={route.driver_license_class === 'B2' ? 'green' : route.driver_license_class === 'FC' ? 'magenta' : 'orange'}
                    style={{ margin: 0, fontSize: 11 }}
                  >
                    Hạng {route.driver_license_class}
                  </Tag>
                )}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="Quãng đường">{route.total_distance_km} km</Descriptions.Item>
            <Descriptions.Item label="Thời gian">{route.total_duration_minutes} phút</Descriptions.Item>
            <Descriptions.Item label="Nhiên liệu nền">
              {currency.format(route.cost?.base_fuel_cost_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Phụ trội do tải">
              {currency.format(route.cost?.load_fuel_surcharge_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Tổng nhiên liệu">
              {currency.format(route.cost?.fuel_cost_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Chi phí giữ hàng dự toán">
              {currency.format(route.cost?.cargo_holding_cost_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Luân chuyển tải">
              {(route.cost?.cargo_distance_ton_km || 0).toLocaleString('vi-VN')} tấn-km
            </Descriptions.Item>
            <Descriptions.Item label="Thời gian giữ tải">
              {(route.cost?.cargo_time_ton_hours || 0).toLocaleString('vi-VN')} tấn-giờ
            </Descriptions.Item>
            <Descriptions.Item label="Chi phí xe">{currency.format(route.cost?.vehicle_fixed_cost_vnd || 0)}</Descriptions.Item>
            <Descriptions.Item label="Lương cố định">
              {currency.format(route.cost?.driver_fixed_salary_allocation_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Lương chuyến">
              {currency.format(route.cost?.driver_trip_pay_vnd || 0)}
            </Descriptions.Item>
            <Descriptions.Item label="Tổng dự toán tuyến" span={2}>
              <Text strong style={{ color: '#1677ff', fontSize: 14 }}>
                {currency.format(route.cost?.total_cost_vnd || 0)}
              </Text>
            </Descriptions.Item>
          </Descriptions>

          {/* KHỐI TỔNG QUAN CA LÀM VIỆC CỦA TÀI XẾ */}
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              backgroundColor: '#f8fafc',
              borderRadius: 8,
              border: '1px solid #e2e8f0',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Space size={6}>
                <ClockCircleOutlined style={{ color: '#2563eb' }} />
                <strong style={{ fontSize: 13, color: '#0f172a' }}>Kế Hoạch Ca Làm Việc</strong>
              </Space>
              <Tag color="success" style={{ margin: 0 }}>Đạt chuẩn BR07</Tag>
            </div>
            <Row gutter={[8, 8]} style={{ fontSize: 12 }}>
              <Col span={12}>
                <span style={{ color: '#64748b' }}>Ca làm việc:</span>
                <div><b>{schedule.startTime} — {schedule.endTime}</b> ({schedule.totalWorkDuration})</div>
              </Col>
              <Col span={12}>
                <span style={{ color: '#64748b' }}>Thời gian lái xe:</span>
                <div><b>{schedule.drivingDuration}</b> ({route.total_distance_km} km)</div>
              </Col>
              <Col span={12}>
                <span style={{ color: '#64748b' }}>Bốc/dỡ tại kho:</span>
                <div><b>{schedule.serviceDuration}</b> ({route.stops.length} điểm)</div>
              </Col>
              <Col span={12}>
                <span style={{ color: '#64748b' }}>Nghỉ ngơi an toàn:</span>
                <div><b>{schedule.restDurationMinutes} phút</b> (Hồi phục thể lực)</div>
              </Col>
            </Row>
          </div>

          <div style={{ marginTop: 10 }}>
            <Button
              size="small"
              type={isThisRouteActive ? 'primary' : 'default'}
              icon={<AimOutlined />}
              onClick={() => {
                setSelectedVehicleForMap(route.vehicle_id);
                setActiveStepIndex(0);
                const targetEl = document.getElementById('floor-visualizer-section') || document.getElementById('map-card-section');
                targetEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {isThisRouteActive
                ? 'Đang xem xe này trên bản đồ & sơ đồ sàn phía trên ↑'
                : 'Đưa xe này lên sơ đồ xếp dỡ & bản đồ phía trên ↑'}
            </Button>
          </div>
        </Col>

        <Col xs={24} lg={14}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <strong style={{ fontSize: 13, color: '#0f172a' }}>
                {currentViewMode === 'TIMELINE' ? 'Lịch Trình Chi Tiết Của Tài Xế (Timeline):' : `Lộ Trình Dừng Đỗ (${route.stops.length} điểm):`}
              </strong>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                Bấm vào bất kỳ mốc nào để đồng bộ ngay lên sơ đồ xe 2D & bản đồ phía trên
              </div>
            </div>
            <Segmented
              size="small"
              value={currentViewMode}
              onChange={(val) => setRouteViewMode((prev) => ({ ...prev, [route.vehicle_id]: val as 'TIMELINE' | 'TABLE' }))}
              options={[
                { value: 'TIMELINE', label: '⏱️ Lịch trình thời gian', icon: <ScheduleOutlined /> },
                { value: 'TABLE', label: '📋 Bảng điểm dừng', icon: <UnorderedListOutlined /> },
              ]}
            />
          </div>

          {currentViewMode === 'TIMELINE' ? (
            <div style={{ maxHeight: 420, overflowY: 'auto', paddingTop: 14, paddingBottom: 10, paddingRight: 14, paddingLeft: 4 }}>
              <Timeline
                className="driver-schedule-timeline"
                mode="left"
                items={schedule.items.map((item) => {
                  const isStopActive = isThisRouteActive && item.stopIndex !== undefined && activeStepIndex === item.stopIndex;
                  return {
                    label: (
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#1e40af', textAlign: 'right' }}>
                        {item.startTimeStr}
                        <div style={{ fontSize: 11, fontWeight: 400, color: '#64748b' }}>{item.endTimeStr}</div>
                      </div>
                    ),
                    color: item.type === 'REST' ? 'gold' : item.type === 'DEPOT_START' || item.type === 'DEPOT_END' ? 'blue' : item.actionType === 'PICKUP' ? 'green' : 'orange',
                    dot: item.type === 'REST' ? (
                      <CoffeeOutlined style={{ fontSize: 15, color: '#d97706' }} />
                    ) : item.type === 'DEPOT_START' || item.type === 'DEPOT_END' ? (
                      <BankOutlined style={{ fontSize: 15, color: '#2563eb' }} />
                    ) : item.actionType === 'PICKUP' ? (
                      <InboxOutlined style={{ fontSize: 15, color: '#16a34a' }} />
                    ) : (
                      <ExportOutlined style={{ fontSize: 15, color: '#ea580c' }} />
                    ),
                    children: (
                      <div
                        onClick={() => {
                          if (item.stopIndex !== undefined) {
                            setSelectedVehicleForMap(route.vehicle_id);
                            setActiveStepIndex(item.stopIndex);
                            const targetEl = document.getElementById('floor-visualizer-section') || document.getElementById('map-card-section');
                            targetEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }
                        }}
                        style={{
                          cursor: item.stopIndex !== undefined ? 'pointer' : 'default',
                          padding: '8px 12px',
                          borderRadius: 6,
                          border: isStopActive ? '1.5px solid #2563eb' : '1px solid #e2e8f0',
                          backgroundColor: isStopActive ? '#eff6ff' : item.type === 'REST' ? '#fefce8' : '#ffffff',
                          marginBottom: 6,
                          transition: 'all 0.15s ease',
                          boxShadow: isStopActive ? '0 0 0 2px rgba(37,99,235,0.15)' : undefined,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                          <Space size={6} wrap>
                            <strong style={{ fontSize: 13, color: '#0f172a' }}>{item.title}</strong>
                            {item.orderNumber && (
                              <Tag color="geekblue" style={{ margin: 0, fontSize: 11 }}>
                                {item.orderNumber}
                              </Tag>
                            )}
                            {item.deltaPackages !== undefined && (
                              <Tag color={item.deltaPackages > 0 ? 'success' : 'volcano'} style={{ margin: 0, fontSize: 11 }}>
                                {item.deltaPackages > 0 ? `+${item.deltaPackages}` : item.deltaPackages} kiện
                              </Tag>
                            )}
                          </Space>
                          <Tag color="default" style={{ margin: 0, fontSize: 11 }}>
                            Thao tác {item.durationMinutes}p
                          </Tag>
                        </div>
                        {item.address && (
                          <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                            📍 {item.address}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                          {item.notes}
                        </div>
                      </div>
                    ),
                  };
                })}
              />
            </div>
          ) : (
            <Table
              size="small"
              pagination={false}
              rowKey="location_id"
              dataSource={route.stops}
              onRow={(_, index) => ({
                onClick: () => {
                  if (index !== undefined) {
                    setSelectedVehicleForMap(route.vehicle_id);
                    setActiveStepIndex(index);
                    const targetEl = document.getElementById('floor-visualizer-section') || document.getElementById('map-card-section');
                    targetEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                },
                style: {
                  cursor: 'pointer',
                  backgroundColor:
                    isThisRouteActive && activeStepIndex === index ? '#eff6ff' : undefined,
                  fontWeight: isThisRouteActive && activeStepIndex === index ? 600 : 'normal',
                },
              })}
              columns={[
                { title: '#', dataIndex: 'sequence', width: 38 },
                {
                  title: 'Khung giờ',
                  key: 'time_window',
                  width: 110,
                  render: (_: any, stop, idx) => {
                    const matchedItem = schedule.items.find((it) => it.stopIndex === idx);
                    return (
                      <div>
                        <strong style={{ fontSize: 12, color: '#1e40af' }}>{matchedItem?.startTimeStr || '08:00'}</strong>
                        <div style={{ fontSize: 11, color: '#64748b' }}>Đến: {matchedItem?.endTimeStr || '08:20'}</div>
                      </div>
                    );
                  },
                },
                {
                  title: 'Thao tác',
                  dataIndex: 'stop_type',
                  width: 80,
                  render: (value: string) => (
                    <Tag color={value === 'PICKUP' ? 'green' : 'orange'} style={{ margin: 0 }}>
                      {value === 'PICKUP' ? 'NHẬN' : 'GIAO'}
                    </Tag>
                  ),
                },
                {
                  title: 'Đơn hàng',
                  dataIndex: 'order_id',
                  width: 105,
                  render: (val: string, stop, idx) => {
                    const matchedItem = schedule.items.find((it) => it.stopIndex === idx);
                    return (
                      <Tag color="geekblue" style={{ margin: 0, fontSize: 11 }}>
                        {matchedItem?.orderNumber || (val ? val.slice(-6).toUpperCase() : `Đơn #${idx + 1}`)}
                      </Tag>
                    );
                  },
                },
                {
                  title: 'Biến động',
                  key: 'delta',
                  width: 85,
                  render: (_: any, stop) => (
                    <Tag color={stop.stop_type === 'PICKUP' ? 'success' : 'volcano'} style={{ margin: 0 }}>
                      {stop.stop_type === 'PICKUP'
                        ? `+${stop.items_loaded?.length || 0}`
                        : `-${stop.items_unloaded?.length || 0}`}{' '}
                      kiện
                    </Tag>
                  ),
                },
                {
                  title: 'Địa điểm',
                  dataIndex: 'location_name',
                  ellipsis: true,
                },
                {
                  title: 'Tải sau điểm',
                  dataIndex: 'current_weight_kg',
                  width: 95,
                  render: (value: number) => `${value.toFixed(0)} kg`,
                },
              ]}
            />
          )}
        </Col>
      </Row>
    );
  };

  const renderPreDispatchResourcePreview = () => {
    const totalOrderWeight = availableOrders.reduce((sum, o) => sum + (Number(o.totalWeightKg) || 0), 0);
    const totalOrderVolume = availableOrders.reduce((sum, o) => sum + (Number(o.totalVolumeM3) || 0), 0);
    const totalVehicleCapacityKg = availableVehicles.reduce((sum, v) => sum + (Number(v.payloadCapacityKg) || 0), 0);
    const totalVehicleCapacityM3 = availableVehicles.reduce((sum, v) => sum + (Number(v.volumeCapacityM3) || 0), 0);

    const weightRatio = totalVehicleCapacityKg > 0 ? (totalOrderWeight / totalVehicleCapacityKg) * 100 : 0;
    const volumeRatio = totalVehicleCapacityM3 > 0 ? (totalOrderVolume / totalVehicleCapacityM3) * 100 : 0;
    const isWeightSafe = totalOrderWeight <= totalVehicleCapacityKg;
    const isVolumeSafe = totalOrderVolume <= totalVehicleCapacityM3;

    return (
      <Card
        className="card-elevation"
        style={{
          borderRadius: 12,
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 20px -2px rgba(0, 0, 0, 0.05)',
        }}
        styles={{ body: { padding: '24px' } }}
      >
        {/* Banner tóm tắt cân đối cung - cầu trước điều phối */}
        <div
          style={{
            background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
            border: '1px solid #bae6fd',
            borderRadius: 10,
            padding: '16px 20px',
            marginBottom: 20,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <ApartmentOutlined style={{ fontSize: 18, color: '#0284c7' }} />
              <Text strong style={{ fontSize: 16, color: '#0369a1' }}>
                Tổng Hợp Nguồn Lực Chuẩn Bị Tối Ưu
              </Text>
              <Tag color={isWeightSafe && isVolumeSafe ? 'success' : 'warning'} style={{ marginLeft: 4 }}>
                {isWeightSafe && isVolumeSafe ? 'CÂN ĐỐI TẢI TRỌNG AN TOÀN' : 'CÓ NGUY CƠ VƯỢT TẢI'}
              </Tag>
            </div>
            <div style={{ fontSize: 13, color: '#475569' }}>
              Kiểm tra danh sách đơn hàng (kèm kiện con), thông số xe tải và danh sách tài xế trực ca dưới đây trước khi kích hoạt thuật toán OR-Tools.
            </div>
          </div>

          <Space size="middle" wrap>
            <div
              style={{
                background: '#ffffff',
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 11, color: '#64748b' }}>Tải trọng / Sức chở</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: isWeightSafe ? '#166534' : '#b91c1c' }}>
                {totalOrderWeight.toLocaleString()} / {totalVehicleCapacityKg.toLocaleString()} kg
                <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 4 }}>({weightRatio.toFixed(0)}%)</span>
              </div>
            </div>

            <div
              style={{
                background: '#ffffff',
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 11, color: '#64748b' }}>Thể tích / Dung tích</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: isVolumeSafe ? '#166534' : '#b91c1c' }}>
                {totalOrderVolume.toFixed(1)} / {totalVehicleCapacityM3.toFixed(1)} m³
                <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 4 }}>({volumeRatio.toFixed(0)}%)</span>
              </div>
            </div>

            <Button
              type="primary"
              size="large"
              icon={<ThunderboltOutlined />}
              loading={starting}
              disabled={availableOrders.length === 0}
              onClick={startOptimization}
              style={{
                background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                boxShadow: '0 4px 14px rgba(37, 99, 235, 0.35)',
                fontWeight: 600,
              }}
            >
              Tối ưu toàn bộ ngay
            </Button>
          </Space>
        </div>

        {/* Tabs hiển thị 3 nguồn lực: Đơn hàng + Kiện con, Đội xe, Tài xế */}
        <Tabs
          defaultActiveKey="orders"
          type="card"
          items={[
            {
              key: 'orders',
              label: (
                <span style={{ fontWeight: 600 }}>
                  <InboxOutlined /> Đơn hàng sẵn sàng ({availableOrders.length})
                </span>
              ),
              children: (
                <div>
                  <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      Bấm vào biểu tượng <Text strong style={{ color: '#2563eb' }}>[+]</Text> đầu mỗi dòng để xem chi tiết kích thước từng kiện hàng vật lý.
                    </Text>
                    <Tag color="blue">Tổng cộng: {counts.packages} kiện hàng</Tag>
                  </div>
                  <Table<Order>
                    dataSource={availableOrders}
                    rowKey="id"
                    pagination={{ pageSize: 5, showSizeChanger: true, pageSizeOptions: ['5', '10', '20'] }}
                    size="middle"
                    expandable={{
                      expandedRowRender: (record) => (
                        <div
                          style={{
                            margin: '8px 0',
                            padding: '14px 18px',
                            background: '#f8fafc',
                            borderRadius: 8,
                            border: '1px solid #e2e8f0',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <Text strong style={{ fontSize: 13, color: '#334155' }}>
                              Chi tiết các kiện hàng thuộc đơn {record.orderNumber} ({record.items?.length || 0} quy cách kiện):
                            </Text>
                            <Tag color="geekblue">
                              Tổng: {record.items?.reduce((s, it) => s + (it.quantity || 0), 0) || 0} kiện vật lý
                            </Tag>
                          </div>
                          <Table
                            dataSource={record.items || []}
                            rowKey="id"
                            pagination={false}
                            size="small"
                            columns={[
                              {
                                title: 'Tên / Quy cách kiện',
                                dataIndex: 'description',
                                key: 'desc',
                                render: (val, it) => (
                                  <div>
                                    <strong style={{ color: '#1e293b' }}>{val || 'Kiện hàng'}</strong>
                                    {it.sku && <div style={{ fontSize: 11, color: '#64748b' }}>SKU: {it.sku}</div>}
                                  </div>
                                ),
                              },
                              {
                                title: 'Loại đóng gói',
                                dataIndex: 'packageType',
                                key: 'type',
                                width: 120,
                                render: (val) => <Tag color="blue">{val || 'Thùng carton'}</Tag>,
                              },
                              {
                                title: 'Số lượng',
                                dataIndex: 'quantity',
                                key: 'qty',
                                width: 90,
                                align: 'center',
                                render: (val) => <Tag color="purple" style={{ fontWeight: 600 }}>{val} kiện</Tag>,
                              },
                              {
                                title: 'Khối lượng / kiện',
                                dataIndex: 'weightKg',
                                key: 'weight',
                                width: 130,
                                render: (val) => <span style={{ color: '#0f766e', fontWeight: 600 }}>{val} kg</span>,
                              },
                              {
                                title: 'Kích thước (Dài × Rộng × Cao)',
                                key: 'dim',
                                width: 200,
                                render: (_, it) => `${it.lengthCm} × ${it.widthCm} × ${it.heightCm} cm`,
                              },
                              {
                                title: 'Thể tích / kiện',
                                dataIndex: 'volumeM3',
                                key: 'vol',
                                width: 110,
                                render: (val) => `${val?.toFixed(3) || '0.000'} m³`,
                              },
                            ]}
                          />
                        </div>
                      ),
                    }}
                    columns={[
                      {
                        title: 'Mã đơn hàng',
                        dataIndex: 'orderNumber',
                        key: 'orderNumber',
                        width: 140,
                        render: (val) => (
                          <Tag color="geekblue" style={{ fontWeight: 700, fontSize: 12, padding: '2px 8px' }}>
                            {val}
                          </Tag>
                        ),
                      },
                      {
                        title: 'Khách hàng',
                        dataIndex: ['customer', 'name'],
                        key: 'customer',
                        width: 170,
                        render: (val, r) => (
                          <div>
                            <div style={{ fontWeight: 600, color: '#1e293b' }}>{val || 'Khách hàng'}</div>
                            {r.customer?.phone && (
                              <div style={{ fontSize: 11, color: '#64748b' }}>SĐT: {r.customer.phone}</div>
                            )}
                          </div>
                        ),
                      },
                      {
                        title: 'Điểm lấy hàng (Pickup)',
                        key: 'pickup',
                        render: (_, r) => {
                          const p = r.stops?.find((s) => s.type === 'PICKUP');
                          return (
                            <div style={{ maxWidth: 220 }}>
                              <div style={{ fontSize: 12, fontWeight: 500, color: '#166534' }}>
                                📍 {p?.contactName || 'Người gửi'}
                              </div>
                              <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.3 }}>
                                {p?.address || 'Tại chi nhánh / kho'}
                              </div>
                            </div>
                          );
                        },
                      },
                      {
                        title: 'Điểm giao hàng (Delivery)',
                        key: 'delivery',
                        render: (_, r) => {
                          const d = r.stops?.find((s) => s.type === 'DELIVERY');
                          return (
                            <div style={{ maxWidth: 240 }}>
                              <div style={{ fontSize: 12, fontWeight: 500, color: '#c2410c' }}>
                                🏁 {d?.contactName || 'Người nhận'}
                              </div>
                              <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.3 }}>
                                {d?.address || 'Chưa cập nhật'}
                              </div>
                            </div>
                          );
                        },
                      },
                      {
                        title: 'Kiện vật lý',
                        dataIndex: 'totalPackages',
                        key: 'packages',
                        width: 100,
                        align: 'center',
                        render: (val) => <Tag color="purple">{val} kiện</Tag>,
                      },
                      {
                        title: 'Tổng khối lượng',
                        dataIndex: 'totalWeightKg',
                        key: 'weight',
                        width: 125,
                        render: (val) => (
                          <strong style={{ color: '#0f766e', fontSize: 13 }}>{val?.toLocaleString()} kg</strong>
                        ),
                      },
                      {
                        title: 'Tổng thể tích',
                        dataIndex: 'totalVolumeM3',
                        key: 'volume',
                        width: 110,
                        render: (val) => `${val?.toFixed(2)} m³`,
                      },
                    ]}
                  />
                </div>
              ),
            },
            {
              key: 'vehicles',
              label: (
                <span style={{ fontWeight: 600 }}>
                  <CarOutlined /> Đội xe tải khả dụng ({availableVehicles.length})
                </span>
              ),
              children: (
                <Table<Vehicle>
                  dataSource={availableVehicles}
                  rowKey="id"
                  pagination={false}
                  size="middle"
                  columns={[
                    {
                      title: 'Biển số xe',
                      dataIndex: 'plateNumber',
                      key: 'plateNumber',
                      width: 140,
                      render: (val) => (
                        <Tag color="blue" style={{ fontWeight: 700, fontSize: 13, padding: '3px 10px' }}>
                          {val}
                        </Tag>
                      ),
                    },
                    {
                      title: 'Dòng xe / Phân loại',
                      dataIndex: 'model',
                      key: 'model',
                      render: (val, r) => (
                        <div>
                          <div style={{ fontWeight: 600, color: '#1e293b' }}>{val}</div>
                          <Tag color="cyan" style={{ fontSize: 11, marginTop: 2 }}>{r.vehicleType}</Tag>
                        </div>
                      ),
                    },
                    {
                      title: 'Tải trọng & Yêu cầu GPLX',
                      dataIndex: 'payloadCapacityKg',
                      key: 'payload',
                      width: 175,
                      render: (val, r) => {
                        const isSmall = r.payloadCapacityKg <= 3500;
                        return (
                          <div>
                            <strong style={{ color: '#166534', fontSize: 13 }}>{val?.toLocaleString()} kg</strong>
                            <div style={{ marginTop: 3 }}>
                              <Tag color={isSmall ? 'green' : 'orange'} style={{ fontSize: 11, margin: 0 }}>
                                {isSmall ? 'Yêu cầu B2+' : 'Yêu cầu C+'}
                              </Tag>
                            </div>
                          </div>
                        );
                      },
                    },
                    {
                      title: 'Kích thước lòng thùng (Dài × Rộng × Cao)',
                      key: 'dimensions',
                      render: (_, r) => (
                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {r.lengthCm} × {r.widthCm} × {r.heightCm} cm
                        </span>
                      ),
                    },
                    {
                      title: 'Thể tích thùng',
                      dataIndex: 'volumeCapacityM3',
                      key: 'volume',
                      width: 120,
                      render: (val) => `${val?.toFixed(1)} m³`,
                    },
                    {
                      title: 'Định mức tiêu hao',
                      dataIndex: 'fuelConsumptionLitersPer100Km',
                      key: 'fuel',
                      width: 150,
                      render: (val) => `${val || '12'} L / 100km`,
                    },
                    {
                      title: 'Phí cố định/chuyến',
                      dataIndex: 'fixedOperatingCostPerTrip',
                      key: 'fixedCost',
                      width: 150,
                      render: (val) => currency.format(Number(val) || 0),
                    },
                    {
                      title: 'Trạng thái',
                      dataIndex: 'status',
                      key: 'status',
                      width: 140,
                      render: () => <Tag color="success">SẴN SÀNG</Tag>,
                    },
                  ]}
                />
              ),
            },
            {
              key: 'drivers',
              label: (
                <span style={{ fontWeight: 600 }}>
                  <UserOutlined /> Đội ngũ tài xế ({availableDrivers.length})
                </span>
              ),
              children: (
                <Table<Driver>
                  dataSource={availableDrivers}
                  rowKey="id"
                  pagination={false}
                  size="middle"
                  columns={[
                    {
                      title: 'Họ và tên',
                      dataIndex: 'fullName',
                      key: 'fullName',
                      render: (val) => (
                        <Space>
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              background: '#e0e7ff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: '#4338ca',
                              fontWeight: 700,
                              fontSize: 13,
                            }}
                          >
                            {val?.charAt(0) || 'T'}
                          </div>
                          <div>
                            <div style={{ fontWeight: 600, color: '#1e293b' }}>{val}</div>
                          </div>
                        </Space>
                      ),
                    },
                    {
                      title: 'Số điện thoại',
                      dataIndex: 'phone',
                      key: 'phone',
                      render: (val) => <span style={{ color: '#2563eb', fontWeight: 500 }}>{val}</span>,
                    },
                    {
                      title: 'Hạng GPLX',
                      dataIndex: 'licenseClass',
                      key: 'licenseClass',
                      width: 140,
                      render: (val) => {
                        const isB2 = val === 'B2';
                        const isFC = val === 'FC';
                        const color = isB2 ? 'green' : isFC ? 'magenta' : 'orange';
                        const scopeText = isB2 ? 'Lái xe ≤ 3.5T' : isFC ? 'Lái mọi xe & Cont' : 'Lái xe > 3.5T';
                        return (
                          <div>
                            <Tag color={color} style={{ fontWeight: 700, margin: 0 }}>Hạng {val}</Tag>
                            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{scopeText}</div>
                          </div>
                        );
                      },
                    },
                    {
                      title: 'Số GPLX',
                      dataIndex: 'licenseNumber',
                      key: 'licenseNumber',
                    },
                    {
                      title: 'Lương cơ bản / chuyến',
                      dataIndex: 'tripBasePay',
                      key: 'tripBasePay',
                      render: (val) => currency.format(Number(val) || 0),
                    },
                    {
                      title: 'Phụ trội / km',
                      dataIndex: 'perKmPay',
                      key: 'perKmPay',
                      render: (val) => `${currency.format(Number(val) || 0)}/km`,
                    },
                    {
                      title: 'Trạng thái',
                      dataIndex: 'status',
                      key: 'status',
                      width: 140,
                      render: () => <Tag color="success">SẴN SÀNG</Tag>,
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>
    );
  };

  return (
    <main className="dispatch-page" aria-labelledby="automatic-dispatch-title">
      <div className="dispatch-page-header">
        <div>
          <Title id="automatic-dispatch-title" level={4}>Điều Phối Tự Động</Title>
          <Text type="secondary">
            Không cần chọn thủ công: hệ thống lấy toàn bộ nguồn lực hợp lệ trong chi nhánh và tạo phương án chi phí thấp.
          </Text>
        </div>
        <Button
          type="primary"
          size="large"
          icon={<ThunderboltOutlined />}
          loading={starting}
          disabled={counts.orders === 0 || job?.status === 'RUNNING' || job?.status === 'PENDING'}
          onClick={startOptimization}
        >
          Tối ưu toàn bộ
        </Button>
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} lg={6}><Card loading={loadingCounts}><Statistic title="Đơn sẵn sàng" value={counts.orders} prefix={<BranchesOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card loading={loadingCounts}><Statistic title="Kiện vật lý" value={counts.packages} prefix={<NodeIndexOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card loading={loadingCounts}><Statistic title="Xe khả dụng" value={counts.vehicles} prefix={<CarOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card loading={loadingCounts}><Statistic title="Tài xế khả dụng" value={counts.drivers} prefix={<UserOutlined />} /></Card></Col>
      </Row>

      {job && ['PENDING', 'RUNNING'].includes(job.status) && (
        <Card className="card-elevation" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text strong><LoadingOutlined spin /> Đang giải bài toán và kiểm tra xếp/dỡ từng bước</Text>
            <Progress percent={job.status === 'PENDING' ? 20 : 70} status="active" showInfo={false} />
            <Text type="secondary">Job {job.id}</Text>
          </Space>
        </Card>
      )}

      {job?.status === 'FAILED' && (
        <Alert
          type="error"
          showIcon
          message={`Lỗi: ${job.errorCode || 'Optimization job thất bại'}`}
          description={
            <div>
              <p style={{ margin: '4px 0 8px 0' }}>{job.errorMessage}</p>
              <Button
                size="small"
                type="primary"
                danger
                loading={starting}
                onClick={startOptimization}
              >
                Chạy lại tối ưu (Retry)
              </Button>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {result ? (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={24} xl={mapLayoutMode === 'FULL' ? 24 : 12}>
              <Card
                id="map-card-section"
                title={
                  <Space>
                    <NodeIndexOutlined style={{ color: '#1677ff', fontSize: 16 }} />
                    <span>Bản đồ lộ trình</span>
                  </Space>
                }
                extra={
                  <Tooltip title={mapLayoutMode === 'HALF' ? 'Mở rộng bản đồ' : 'Thu về bố cục hai cột'}>
                    <Button
                      size="small"
                      type={mapLayoutMode === 'FULL' ? 'primary' : 'default'}
                      icon={mapLayoutMode === 'HALF' ? <FullscreenOutlined /> : <FullscreenExitOutlined />}
                      aria-label={mapLayoutMode === 'HALF' ? 'Mở rộng bản đồ' : 'Thu nhỏ bản đồ'}
                      onClick={() => setMapLayoutMode(mapLayoutMode === 'HALF' ? 'FULL' : 'HALF')}
                    >
                      {mapLayoutMode === 'HALF' ? 'Mở rộng' : 'Thu gọn'}
                    </Button>
                  </Tooltip>
                }
                className="card-elevation"
              >
                <div className="automatic-map-toolbar">
                  <div className="automatic-map-filter">
                    <Text strong>Tuyến xe</Text>
                    <Select
                      aria-label="Chọn tuyến xe hiển thị trên bản đồ"
                      value={selectedVehicleForMap}
                      onChange={(value) => {
                        setSelectedVehicleForMap(value);
                        setActiveStepIndex(0);
                      }}
                      size="small"
                      popupMatchSelectWidth={false}
                      options={[
                        {
                          value: 'ALL',
                          label: `Tất cả các xe (${result.routes.length})`,
                        },
                        ...result.routes.map((route, index) => ({
                          value: route.vehicle_id,
                          label: (
                            <span>
                              <span
                                className="route-color-dot"
                                style={{
                                  backgroundColor: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
                                }}
                                aria-hidden="true"
                              />
                              {route.plate_number} · {route.driver_name || 'Chưa có tài xế'}
                            </span>
                          ),
                        })),
                      ]}
                    />
                  </div>
                  <Button
                    type={enableSim ? 'default' : 'primary'}
                    icon={enableSim ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    onClick={() => {
                      if (!enableSim && selectedVehicleForMap === 'ALL' && result.routes.length > 0) {
                        setSelectedVehicleForMap(result.routes[0].vehicle_id);
                      }
                      setEnableSim(!enableSim);
                    }}
                  >
                    {enableSim ? 'Dừng mô phỏng' : 'Mô phỏng xe'}
                  </Button>
                </div>

                <div className="automatic-map-legend" aria-label="Chú giải bản đồ">
                  <span className="map-legend-item map-legend-depot">
                    <BankOutlined /> Công ty
                  </span>
                  <ArrowRightOutlined aria-hidden="true" />
                  <span className="map-legend-item map-legend-sequence">1 · 2 · 3 · … Điểm dừng</span>
                  <span className="map-legend-item map-legend-pickup">Nhận hàng</span>
                  <span className="map-legend-item map-legend-delivery">Giao hàng</span>
                </div>

                {selectedRouteInfo && (
                  <div className="automatic-route-focus">
                    <div className="automatic-route-summary">
                      <Space wrap>
                        <Tag color="processing">
                          Đang xem riêng: <b>{selectedRouteInfo.plate_number}</b>
                        </Tag>
                        <Text>Tài xế: <b>{selectedRouteInfo.driver_name}</b></Text>
                        <Text>Quãng đường: <b>{selectedRouteInfo.total_distance_km} km</b></Text>
                        <Text>Thời gian: <b>{selectedRouteInfo.total_duration_minutes} phút</b></Text>
                        <Text>Điểm dừng: <b>{selectedRouteInfo.stops.length} điểm</b></Text>
                        <Text>Chi phí: <b>{currency.format(selectedRouteInfo.cost?.total_cost_vnd || 0)}</b></Text>
                      </Space>
                      <Button
                        size="small"
                        type="text"
                        icon={<CloseOutlined />}
                        onClick={() => setSelectedVehicleForMap('ALL')}
                      >
                        Xem tất cả
                      </Button>
                    </div>

                    <div className="automatic-route-journey" aria-label="Thứ tự lộ trình">
                      <Tooltip title={selectedRouteInfo.depot?.name || 'Công ty / chi nhánh'}>
                        <span className="journey-node journey-node-depot">
                          <BankOutlined />
                          <span>Công ty</span>
                        </span>
                      </Tooltip>
                      {selectedRouteInfo.stops.map((stop) => (
                        <React.Fragment key={`${selectedRouteInfo.vehicle_id}-${stop.sequence}-${stop.location_id}`}>
                          <ArrowRightOutlined className="journey-arrow" aria-hidden="true" />
                          <Tooltip title={`${stop.stop_type === 'PICKUP' ? 'Nhận' : 'Giao'} · ${stop.location_name}`}>
                            <span
                              className={`journey-node ${stop.stop_type === 'PICKUP' ? 'journey-node-pickup' : 'journey-node-delivery'}`}
                            >
                              {stop.sequence}
                            </span>
                          </Tooltip>
                        </React.Fragment>
                      ))}
                      <ArrowRightOutlined className="journey-arrow" aria-hidden="true" />
                      <span className="journey-node journey-node-return">
                        <BankOutlined />
                        <span>Về công ty</span>
                      </span>
                    </div>
                  </div>
                )}
                <MapboxMap
                  markers={mapMarkers}
                  routeGeometry={routeGeometry}
                  height={mapLayoutMode === 'FULL' ? 640 : 560}
                  enableSimulation={enableSim}
                  autoPlaySimulation={enableSim}
                  vehiclePlate={currentActiveRoute?.plate_number || '29C-678.92'}
                  driverName={currentActiveRoute?.driver_name || 'Tài xế'}
                  onSimulationProgress={(_prog, _coord, _speed, traveledKm) => {
                    if (stopMilestonesKm.length > 0) {
                      const stepIdx = getStepIndexForDistance(stopMilestonesKm, traveledKm);
                      setActiveStepIndex(stepIdx);
                    }
                  }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={mapLayoutMode === 'FULL' ? 0 : 12} style={{ display: mapLayoutMode === 'FULL' ? 'none' : 'block' }}>
              <FloorPackingVisualizer
                route={currentActiveRoute}
                allRoutes={result.routes}
                onSelectRoute={(vehicleId) => {
                  setSelectedVehicleForMap(vehicleId);
                  setActiveStepIndex(0);
                }}
                vehicleDimensions={{
                  lengthCm: currentActiveRoute?.vehicle_length_cm || 430,
                  widthCm: currentActiveRoute?.vehicle_width_cm || 190,
                }}
                stepStates={currentActiveRoute?.spatial_validation?.step_states || []}
                isValid={currentActiveRoute?.spatial_validation?.is_valid ?? true}
                violations={
                  currentActiveRoute?.spatial_validation?.error_message
                    ? [currentActiveRoute.spatial_validation.error_message]
                    : []
                }
                selectedStepIndex={activeStepIndex}
                onStepChange={(stepIdx) => setActiveStepIndex(stepIdx)}
                isSimulating={enableSim}
              />
            </Col>
          </Row>

          <Collapse
            items={result.routes.map((route) => ({
              key: route.vehicle_id,
              label: `${route.plate_number} · ${route.driver_name} (Hạng ${route.driver_license_class || 'C'}) · ${currency.format(route.cost?.total_cost_vnd || 0)}`,
              children: renderRoute(route),
            }))}
            defaultActiveKey={result.routes[0] ? [result.routes[0].vehicle_id] : []}
          />

          {result.unassigned_orders.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16 }}
              message={`${result.unassigned_orders.length} đơn chưa được xếp`}
              description={result.unassigned_orders.map((order) => (
                <div key={order.order_id}><Text strong>{order.order_number}</Text>: {order.reason_message}</div>
              ))}
            />
          )}
        </>
      ) : !job ? (
        renderPreDispatchResourcePreview()
      ) : null}
    </main>
  );
};

export default AutomaticDispatchPage;
