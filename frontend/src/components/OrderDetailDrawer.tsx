import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  Space,
  Tag,
  Typography,
  Divider,
  Table,
  Button,
  Row,
  Col,
  Card,
} from 'antd';
import {
  EnvironmentOutlined,
  ShoppingOutlined,
  EditOutlined,
  UserOutlined,
  PhoneOutlined,
  InboxOutlined,
  AimOutlined,
} from '@ant-design/icons';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Order, OrderItem } from '../types';
import { mapboxApi } from '../api/client';

const { Text } = Typography;

interface OrderDetailDrawerProps {
  open: boolean;
  order: Order | null;
  onClose: () => void;
  onEdit?: (order: Order) => void;
}

export const OrderDetailDrawer: React.FC<OrderDetailDrawerProps> = ({
  open,
  order,
  onClose,
  onEdit,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distanceKm: string; durationMin: number } | null>(null);

  const pickupStop = order?.stops?.find((s) => s.type === 'PICKUP');
  const deliveryStop = order?.stops?.find((s) => s.type === 'DELIVERY');

  // Khởi tạo map hiển thị 2 điểm pickup & delivery và đường đi thực tế (Mapbox Directions API)
  useEffect(() => {
    if (!open || !order || !pickupStop || !deliveryStop) return;

    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token) return;
    mapboxgl.accessToken = token;

    let isMounted = true;

    const timer = setTimeout(async () => {
      if (!mapContainerRef.current) return;

      if (mapRef.current) {
        mapRef.current.remove();
      }

      const pLng = pickupStop.longitude;
      const pLat = pickupStop.latitude;
      const dLng = deliveryStop.longitude;
      const dLat = deliveryStop.latitude;

      const hasValidCoords = pLng && pLat && dLng && dLat;

      const center: [number, number] = hasValidCoords
        ? [(pLng + dLng) / 2, (pLat + dLat) / 2]
        : [105.8542, 21.0285];

      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center,
        zoom: 12,
      });

      if (hasValidCoords) {
        // Marker Pickup (Xanh lá)
        const pickupEl = document.createElement('div');
        pickupEl.innerHTML = `
          <div style="background: #10b981; color: white; padding: 5px 10px; border-radius: 12px; font-weight: 700; font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid white; display: flex; align-items: center; gap: 4px;">
            <span>LẤY HÀNG</span>
          </div>
        `;
        new mapboxgl.Marker({ element: pickupEl }).setLngLat([pLng, pLat]).addTo(map);

        // Marker Delivery (Cam)
        const deliveryEl = document.createElement('div');
        deliveryEl.innerHTML = `
          <div style="background: #f59e0b; color: white; padding: 5px 10px; border-radius: 12px; font-weight: 700; font-size: 11px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); border: 2px solid white; display: flex; align-items: center; gap: 4px;">
            <span>GIAO HÀNG</span>
          </div>
        `;
        new mapboxgl.Marker({ element: deliveryEl }).setLngLat([dLng, dLat]).addTo(map);

        // Lấy lộ trình đường bộ thực tế qua Mapbox Directions API (không dùng đường chim bay)
        const drivingResult = await mapboxApi.getDrivingRoute(pLng, pLat, dLng, dLat);
        if (!isMounted) return;

        let routeCoordinates: [number, number][] = [
          [pLng, pLat],
          [dLng, dLat],
        ];

        if (drivingResult && drivingResult.coordinates?.length > 0) {
          routeCoordinates = drivingResult.coordinates;
          setRouteInfo({
            distanceKm: (drivingResult.distanceMeters / 1000).toFixed(1),
            durationMin: Math.round(drivingResult.durationSeconds / 60),
          });
        } else {
          setRouteInfo(null);
        }

        const renderRouteOnMap = () => {
          if (!map.getSource('order-road-line')) {
            map.addSource('order-road-line', {
              type: 'geojson',
              data: {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: routeCoordinates,
                },
              },
            });

            map.addLayer({
              id: 'order-road-line-layer',
              type: 'line',
              source: 'order-road-line',
              layout: {
                'line-join': 'round',
                'line-cap': 'round',
              },
              paint: {
                'line-color': '#2563eb',
                'line-width': 5,
                'line-opacity': 0.85,
              },
            });
          }

          // Fit bounds theo toàn bộ lộ trình thực tế
          const bounds = new mapboxgl.LngLatBounds();
          routeCoordinates.forEach((c) => bounds.extend(c));
          map.fitBounds(bounds, { padding: 45, maxZoom: 14 });
        };

        if (map.isStyleLoaded()) {
          renderRouteOnMap();
        } else {
          map.on('load', renderRouteOnMap);
        }
      }

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      mapRef.current = map;
    }, 250);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [open, order, pickupStop, deliveryStop]);

  if (!order) return null;

  const statusColors: Record<string, string> = {
    DRAFT: 'default',
    CONFIRMED: 'blue',
    ASSIGNED: 'gold',
    IN_TRANSIT: 'purple',
    COMPLETED: 'green',
    CANCELLED: 'red',
  };

  const isEditable = order.status === 'CONFIRMED' || order.status === 'DRAFT';

  const itemColumns = [
    {
      title: '#',
      key: 'idx',
      width: 45,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: 'Mô tả hàng hóa',
      dataIndex: 'description',
      key: 'description',
      render: (val: string, r: OrderItem) => (
        <div>
          <strong style={{ color: '#1e293b' }}>{val}</strong>
          {r.sku && <div style={{ fontSize: 11, color: '#64748b' }}>SKU: {r.sku}</div>}
        </div>
      ),
    },
    {
      title: 'Kiểu đóng gói',
      dataIndex: 'packageType',
      key: 'packageType',
      width: 110,
      render: (val: string) => <Tag color="cyan">{val || 'CARTON'}</Tag>,
    },
    {
      title: 'Số kiện',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      align: 'right' as const,
      render: (val: number) => <strong>{val}</strong>,
    },
    {
      title: 'Khối lượng (kg)',
      dataIndex: 'weightKg',
      key: 'weightKg',
      width: 120,
      align: 'right' as const,
      render: (val: number) => `${val.toFixed(1)} kg`,
    },
    {
      title: 'Kích thước (cm)',
      key: 'dimensions',
      width: 140,
      align: 'center' as const,
      render: (_: any, r: OrderItem) => `${r.lengthCm} × ${r.widthCm} × ${r.heightCm}`,
    },
    {
      title: 'Thể tích (m³)',
      dataIndex: 'volumeM3',
      key: 'volumeM3',
      width: 110,
      align: 'right' as const,
      render: (val: number) => `${Number(val).toFixed(3)} m³`,
    },
  ];

  return (
    <Modal
      title={
        <Space align="center" style={{ fontSize: 16 }}>
          <ShoppingOutlined style={{ color: '#2563eb', fontSize: 20 }} />
          <span style={{ fontWeight: 700 }}>Chi Tiết Đơn Hàng Vận Tải:</span>
          <strong style={{ color: '#0284c7', fontSize: 17 }}>{order.orderNumber}</strong>
          <Tag color={statusColors[order.status] || 'default'}>{order.status}</Tag>
        </Space>
      }
      open={open}
      onCancel={onClose}
      centered
      width={1050}
      style={{ top: 20 }}
      styles={{
        body: {
          maxHeight: 'calc(90vh - 120px)',
          overflowY: 'auto',
          padding: '16px 20px',
        },
      }}
      footer={[
        isEditable && onEdit ? (
          <Button
            key="edit"
            type="primary"
            icon={<EditOutlined />}
            onClick={() => {
              onClose();
              onEdit(order);
            }}
          >
            Chỉnh Sửa Đơn
          </Button>
        ) : null,
        <Button key="close" onClick={onClose}>
          Đóng
        </Button>,
      ]}
    >
      {/* Thông tin khách hàng & tổng quan */}
      <Card
        size="small"
        style={{
          marginBottom: 16,
          background: '#f8fafc',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
        }}
      >
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} sm={14}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 2 }}>
              Khách hàng doanh nghiệp:
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text strong style={{ fontSize: 15, color: '#0f172a' }}>
                {order.customer?.name || 'N/A'}
              </Text>
              {order.customer?.code && <Tag color="blue">{order.customer.code}</Tag>}
            </div>
            <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
              {order.customer?.phone && (
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  <PhoneOutlined style={{ marginRight: 4 }} />
                  SĐT: <strong>{order.customer.phone}</strong>
                </div>
              )}
              {order.branch && (
                <div style={{ fontSize: 12, color: '#475569' }}>
                  Chi nhánh: <Tag color="geekblue">{order.branch.name}</Tag>
                </div>
              )}
            </div>
          </Col>
          <Col xs={24} sm={10}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '8px',
                background: '#ffffff',
                padding: '10px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
              }}
            >
              <div>
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  Tổng tải trọng
                </Text>
                <strong style={{ color: '#059669', fontSize: 15 }}>
                  {order.totalWeightKg} kg
                </strong>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  Tổng thể tích
                </Text>
                <strong style={{ color: '#2563eb', fontSize: 15 }}>
                  {order.totalVolumeM3} m³
                </strong>
                <div style={{ fontSize: 11, color: '#64748b' }}>
                  ({order.totalPackages} kiện)
                </div>
              </div>
            </div>
          </Col>
          {order.notes && (
            <Col xs={24}>
              <Divider style={{ margin: '4px 0 8px 0' }} />
              <div style={{ fontSize: 12, color: '#475569' }}>
                <Text type="secondary" style={{ marginRight: 6 }}>
                  Ghi chú:
                </Text>
                <Text italic>{order.notes}</Text>
              </div>
            </Col>
          )}
        </Row>
      </Card>

      {/* Thông tin 2 Điểm Lấy & Giao hàng */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>
          <EnvironmentOutlined style={{ color: '#ef4444', marginRight: 6 }} />
          Lộ Trình Lấy & Giao Hàng
        </div>
        {routeInfo && (
          <div style={{ fontSize: 12, color: '#0369a1', background: '#e0f2fe', padding: '3px 10px', borderRadius: 6, fontWeight: 600 }}>
            🚗 Khoảng cách đường bộ thực tế: {routeInfo.distanceKm} km (dự kiến ~{routeInfo.durationMin} phút)
          </div>
        )}
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
        {/* Điểm Lấy Hàng */}
        <Col xs={24} md={12}>
          <Card
            size="small"
            style={{
              height: '100%',
              borderRadius: 8,
              border: '1px solid #a7f3d0',
              background: '#f0fdf4',
            }}
            title={
              <Space>
                <Tag color="green">1. ĐIỂM LẤY HÀNG (PICKUP)</Tag>
              </Space>
            }
          >
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 13, color: '#065f46' }}>
                {pickupStop?.address || 'Chưa cấu hình địa chỉ lấy hàng'}
              </Text>
            </div>
            <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>
              <UserOutlined style={{ marginRight: 6, color: '#64748b' }} />
              Người liên hệ: <strong>{pickupStop?.contactName || 'Thủ kho'}</strong>
            </div>
            <div style={{ fontSize: 12, color: '#334155', marginBottom: 6 }}>
              <PhoneOutlined style={{ marginRight: 6, color: '#64748b' }} />
              Số điện thoại: <strong>{pickupStop?.contactPhone || 'N/A'}</strong>
            </div>
            {pickupStop?.latitude && pickupStop?.longitude && (
              <div style={{ fontSize: 11, color: '#64748b' }}>
                <AimOutlined style={{ marginRight: 4 }} />
                Tọa độ: {pickupStop.latitude.toFixed(5)}, {pickupStop.longitude.toFixed(5)}
              </div>
            )}
          </Card>
        </Col>

        {/* Điểm Giao Hàng */}
        <Col xs={24} md={12}>
          <Card
            size="small"
            style={{
              height: '100%',
              borderRadius: 8,
              border: '1px solid #fed7aa',
              background: '#fff7ed',
            }}
            title={
              <Space>
                <Tag color="orange">2. ĐIỂM GIAO HÀNG (DELIVERY)</Tag>
              </Space>
            }
          >
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 13, color: '#9a3412' }}>
                {deliveryStop?.address || 'Chưa cấu hình địa chỉ giao hàng'}
              </Text>
            </div>
            <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>
              <UserOutlined style={{ marginRight: 6, color: '#64748b' }} />
              Người nhận: <strong>{deliveryStop?.contactName || 'Đại diện nhận'}</strong>
            </div>
            <div style={{ fontSize: 12, color: '#334155', marginBottom: 6 }}>
              <PhoneOutlined style={{ marginRight: 6, color: '#64748b' }} />
              Số điện thoại: <strong>{deliveryStop?.contactPhone || 'N/A'}</strong>
            </div>
            {deliveryStop?.latitude && deliveryStop?.longitude && (
              <div style={{ fontSize: 11, color: '#64748b' }}>
                <AimOutlined style={{ marginRight: 4 }} />
                Tọa độ: {deliveryStop.latitude.toFixed(5)}, {deliveryStop.longitude.toFixed(5)}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Mini Map trực quan đường bộ thực tế */}
      <div style={{ marginBottom: 18 }}>
        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: '280px',
            borderRadius: '8px',
            overflow: 'hidden',
            border: '1px solid #cbd5e1',
          }}
        />
      </div>

      {/* Bảng danh sách kiện hàng */}
      <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b', marginBottom: 10 }}>
        <InboxOutlined style={{ color: '#2563eb', marginRight: 6 }} />
        Danh Sách Các Loại Hàng & Kiện Vật Lý ({order.items?.length || 0} loại)
      </div>

      <Table
        dataSource={order.items || []}
        columns={itemColumns}
        rowKey="id"
        pagination={false}
        size="small"
        bordered
        summary={(data) => {
          const totalQty = data.reduce((sum, item) => sum + (item.quantity || 0), 0);
          const totalWeight = data.reduce((sum, item) => sum + (Number(item.weightKg) || 0), 0);
          const totalVol = data.reduce((sum, item) => sum + (Number(item.volumeM3) || 0), 0);
          return (
            <Table.Summary.Row style={{ background: '#f8fafc', fontWeight: 600 }}>
              <Table.Summary.Cell index={0} colSpan={3}>
                TỔNG CỘNG
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                <span style={{ color: '#2563eb' }}>{totalQty} kiện</span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                <span style={{ color: '#059669' }}>{totalWeight.toFixed(1)} kg</span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="center">
                —
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">
                <span style={{ color: '#2563eb' }}>{totalVol.toFixed(3)} m³</span>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          );
        }}
      />
    </Modal>
  );
};
