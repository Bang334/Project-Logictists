import React, { useState, useMemo } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Tag,
  Space,
  Button,
  Timeline,
  Statistic,
  Progress,
  Badge,
  Alert,
} from 'antd';
import {
  CarOutlined,
  CompassOutlined,
  EnvironmentOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import MapboxMap from '../components/MapboxMap';
import {
  HANOI_SAMPLE_DEMO_ROUTE,
  HANOI_DEMO_STOPS,
  buildRouteProfile,
} from '../utils/geoSimulation';

const { Title, Text } = Typography;

const TrackingDemoPage: React.FC = () => {
  const [currentProgress, setCurrentProgress] = useState<number>(0);
  const [currentCoord, setCurrentCoord] = useState<[number, number]>([105.9082, 21.0345]);
  const [speedKmh, setSpeedKmh] = useState<number>(45);
  const [traveledKm, setTraveledKm] = useState<number>(0);

  const routeProfile = useMemo(() => buildRouteProfile(HANOI_SAMPLE_DEMO_ROUTE), []);

  // Tính toán điểm dừng hiện tại theo tiến độ xe
  const stopsWithStatus = useMemo(() => {
    const total = HANOI_DEMO_STOPS.length;
    return HANOI_DEMO_STOPS.map((stop, idx) => {
      // Ước lượng mốc tiến độ tương ứng với stop
      const stopMilestoneProgress = idx / (total - 1);
      let status: 'completed' | 'current' | 'pending' = 'pending';

      if (currentProgress >= stopMilestoneProgress + 0.08) {
        status = 'completed';
      } else if (
        currentProgress >= Math.max(0, stopMilestoneProgress - 0.08) &&
        currentProgress <= stopMilestoneProgress + 0.08
      ) {
        status = 'current';
      }

      return {
        ...stop,
        status,
        milestoneProgress: stopMilestoneProgress,
      };
    });
  }, [currentProgress]);

  // Tính tải trọng xe theo các điểm đã qua (Bất biến TMS: bốc hàng thì tăng, dỡ hàng thì giảm)
  const currentVehiclePayloadKg = useMemo(() => {
    let payload = 0;
    stopsWithStatus.forEach((s) => {
      if (s.status === 'completed' || s.status === 'current') {
        if (s.type === 'PICKUP') {
          payload += s.weightKg;
        } else if (s.type === 'DELIVERY') {
          payload = Math.max(0, payload - s.weightKg);
        }
      }
    });
    return payload;
  }, [stopsWithStatus]);

  const maxVehicleCapacityKg = 5200; // Hino 500 Series tải trọng 5.2 tấn
  const capacityPercent = Math.round((currentVehiclePayloadKg / maxVehicleCapacityKg) * 100);

  // Chuẩn bị markers hiển thị trên bản đồ
  const mapMarkers = useMemo(() => {
    return HANOI_DEMO_STOPS.map((stop, idx) => ({
      id: stop.id,
      latitude: stop.latitude,
      longitude: stop.longitude,
      title: stop.name,
      subtitle: `${stop.actionText} · ${stop.address}`,
      type: stop.type,
      sequence: idx + 1,
      routeIndex: 0,
      plateNumber: '29H-842.15',
      driverName: 'Nguyễn Văn Hùng',
    }));
  }, []);

  const routeGeoJson = useMemo(() => {
    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: HANOI_SAMPLE_DEMO_ROUTE,
      },
    };
  }, []);

  return (
    <div style={{ padding: '24px' }}>
      {/* Header Banner */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <Space align="center" size={10}>
            <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 24 }}>🚚</span> Giám Sát & Mô Phỏng Xe Chạy Realtime
            </Title>
            <Badge status="processing" text="Tín hiệu GPS trực tiếp (Live 60 FPS)" />
          </Space>
          <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
            Mô phỏng chuyển động thực tế của xe tải Hino 500 Series dọc theo lộ trình giao nhận qua các quận Hà Nội
          </Text>
        </div>

        <Space>
          <Tag color="blue" icon={<SafetyCertificateOutlined />}>
            Bảo toàn tải trọng TMS
          </Tag>
          <Tag color="cyan" icon={<DashboardOutlined />}>
            Độ trễ GPS &lt; 200ms
          </Tag>
        </Space>
      </div>

      <Alert
        message="Trình diễn tính năng xe chạy (Live Vehicle Tracking)"
        description="Bản đồ hiển thị xe tải di chuyển mượt mà bám theo góc cua của tuyến đường, đèn pha phát sáng, vệt xanh đánh dấu đường đã đi qua, và bảng điều khiển cho phép tạm dừng, tua nhanh 5x, 10x hoặc đổi góc nhìn bám theo xe."
        type="info"
        showIcon
        closable
        style={{ marginBottom: 16 }}
      />

      <Row gutter={[16, 16]}>
        {/* Bản đồ lớn hiển thị xe tải chạy */}
        <Col xs={24} xl={16}>
          <Card
            variant="borderless"
            className="card-elevation"
            style={{ overflow: 'hidden' }}
            title={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Space>
                  <EnvironmentOutlined style={{ color: '#2563eb' }} />
                  <span style={{ fontWeight: 600 }}>Bản Đồ GPS Vận Tải (Mapbox GL)</span>
                  <Tag color="gold">Chuyến: HN-EXP-2026</Tag>
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Tọa độ xe: [{currentCoord[0].toFixed(4)}, {currentCoord[1].toFixed(4)}]
                </Text>
              </div>
            }
          >
            <MapboxMap
              markers={mapMarkers}
              routeGeometry={routeGeoJson}
              height={560}
              enableSimulation={true}
              autoPlaySimulation={true}
              showControls={true}
              vehiclePlate="29H-842.15"
              driverName="Nguyễn Văn Hùng"
              onSimulationProgress={(prog, coord, spd, dist) => {
                setCurrentProgress(prog);
                setCurrentCoord(coord);
                setSpeedKmh(spd);
                setTraveledKm(dist);
              }}
            />
          </Card>
        </Col>

        {/* Panel thông tin Telemetry & Stops Timeline */}
        <Col xs={24} xl={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Thông số vận hành realtime của xe */}
            <Card
              title={
                <Space>
                  <CarOutlined style={{ color: '#2563eb' }} />
                  <span>Trạng Thái Xe & Tải Trọng</span>
                </Space>
              }
              variant="borderless"
              className="card-elevation"
            >
              <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                <Col span={12}>
                  <Statistic
                    title="Biển Số Xe"
                    value="29H-842.15"
                    valueStyle={{ color: '#1d4ed8', fontSize: 16, fontWeight: 'bold' }}
                    prefix={<CarOutlined />}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Tài Xế Phụ Trách"
                    value="Nguyễn Văn Hùng"
                    valueStyle={{ color: '#0f172a', fontSize: 14 }}
                    prefix={<UserOutlined />}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Tốc Độ Hiện Tại"
                    value={speedKmh}
                    suffix="km/h"
                    valueStyle={{ color: '#059669', fontSize: 20, fontWeight: 'bold' }}
                    prefix={<ThunderboltOutlined />}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="Cự Ly Đã Đi"
                    value={traveledKm.toFixed(1)}
                    suffix={`/ ${routeProfile.totalDistanceKm.toFixed(1)} km`}
                    valueStyle={{ color: '#475569', fontSize: 16 }}
                    prefix={<CompassOutlined />}
                  />
                </Col>
              </Row>

              {/* Tải trọng động trên sàn xe */}
              <div style={{ background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>
                    Tải trọng thực tế trên xe (Dynamic Payload):
                  </Text>
                  <strong style={{ color: capacityPercent > 80 ? '#dc2626' : '#2563eb' }}>
                    {currentVehiclePayloadKg} / {maxVehicleCapacityKg} kg ({capacityPercent}%)
                  </strong>
                </div>
                <Progress
                  percent={capacityPercent}
                  status={capacityPercent > 85 ? 'exception' : 'active'}
                  strokeColor={{
                    '0%': '#3b82f6',
                    '100%': capacityPercent > 80 ? '#ef4444' : '#10b981',
                  }}
                />
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                  * Tải trọng tự động cập nhật sau mỗi điểm bốc/dỡ theo quy tắc bất biến TMS.
                </Text>
              </div>
            </Card>

            {/* Danh sách lộ trình điểm dừng Timeline */}
            <Card
              title={
                <Space>
                  <EnvironmentOutlined style={{ color: '#059669' }} />
                  <span>Tiến Độ Điểm Dừng (Stops Progress)</span>
                </Space>
              }
              variant="borderless"
              className="card-elevation"
              style={{ maxHeight: 380, overflowY: 'auto' }}
            >
              <Timeline
                items={stopsWithStatus.map((stop) => {
                  let color = 'gray';
                  let dotIcon = <ClockCircleOutlined />;
                  if (stop.status === 'completed') {
                    color = 'green';
                    dotIcon = <CheckCircleOutlined style={{ color: '#10b981' }} />;
                  } else if (stop.status === 'current') {
                    color = 'blue';
                    dotIcon = <CarOutlined style={{ color: '#2563eb', fontSize: 14 }} />;
                  }

                  return {
                    color,
                    dot: dotIcon,
                    children: (
                      <div style={{ paddingBottom: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ fontSize: 13, color: stop.status === 'current' ? '#1d4ed8' : '#1e293b' }}>
                            {stop.name}
                          </strong>
                          <Tag
                            color={
                              stop.type === 'DEPOT'
                                ? 'blue'
                                : stop.type === 'PICKUP'
                                  ? 'green'
                                  : 'orange'
                            }
                            style={{ margin: 0, fontSize: 10 }}
                          >
                            {stop.type === 'DEPOT'
                              ? 'Tổng kho'
                              : stop.type === 'PICKUP'
                                ? 'Nhận hàng'
                                : 'Giao hàng'}
                          </Tag>
                        </div>
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{stop.address}</div>
                        <div style={{ fontSize: 11, color: '#2563eb', fontWeight: 500, marginTop: 2 }}>
                          {stop.actionText}
                        </div>
                      </div>
                    ),
                  };
                })}
              />
            </Card>
          </div>
        </Col>
      </Row>
    </div>
  );
};

export default TrackingDemoPage;
