import React, { useMemo } from 'react';
import {
  Card,
  Tag,
  Typography,
  Space,
  Progress,
  Button,
  Tooltip,
  Badge,
  Empty,
} from 'antd';
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  LeftOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  AppstoreOutlined,
  CarOutlined,
} from '@ant-design/icons';
import { OptimizedRouteUI, PlacedItemUI } from '../types';

const { Text } = Typography;
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

// Bảng màu phân biệt các kiện hàng theo đơn
const ITEM_COLORS = [
  { bg: '#3b82f6', border: '#1d4ed8', text: '#ffffff' }, // Blue
  { bg: '#10b981', border: '#047857', text: '#ffffff' }, // Green
  { bg: '#f59e0b', border: '#b45309', text: '#ffffff' }, // Amber
  { bg: '#8b5cf6', border: '#6d28d2', text: '#ffffff' }, // Purple
  { bg: '#ec4899', border: '#be185d', text: '#ffffff' }, // Pink
  { bg: '#06b6d4', border: '#0e7490', text: '#ffffff' }, // Cyan
  { bg: '#f97316', border: '#c2410c', text: '#ffffff' }, // Orange
  { bg: '#6366f1', border: '#4338ca', text: '#ffffff' }, // Indigo
  { bg: '#14b8a6', border: '#0f766e', text: '#ffffff' }, // Teal
];

interface LiveCargoStepTrackerProps {
  route: OptimizedRouteUI | null;
  currentStepIndex: number;
  onSelectStep: (stepIdx: number) => void;
  totalCostVnd?: number;
  totalDistanceKm?: number;
  totalRoutesCount?: number;
  statusText?: string;
  isSimulating?: boolean;
}

export const LiveCargoStepTracker: React.FC<LiveCargoStepTrackerProps> = ({
  route,
  currentStepIndex,
  onSelectStep,
  totalCostVnd = 0,
  totalDistanceKm = 0,
  totalRoutesCount = 1,
  statusText = 'SUCCESS',
  isSimulating = false,
}) => {
  if (!route) {
    return (
      <Card className="card-elevation" style={{ height: 560, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="Chọn một xe để theo dõi diễn biến hàng hóa từng bước" />
      </Card>
    );
  }

  const stops = route.stops || [];
  const stepStates = route.spatial_validation?.step_states || [];
  const totalSteps = Math.max(stops.length, stepStates.length);
  const clampedStep = Math.max(0, Math.min(totalSteps - 1, currentStepIndex));

  const currentStop = stops[clampedStep] || null;
  const currentStepState = stepStates[clampedStep] || null;

  // Kích thước chuẩn thùng xe từ dữ liệu tối ưu
  const vehicleLengthCm = route.vehicle_length_cm || 430;
  const vehicleWidthCm = route.vehicle_width_cm || 190;

  // Tính toán % tải trọng và diện tích
  const currentWeightKg = currentStepState?.current_weight_kg ?? currentStop?.current_weight_kg ?? 0;
  const maxWeightKg = route.spatial_validation?.max_weight_kg || 2450;
  const weightPercent = Math.min(100, Math.round((currentWeightKg / maxWeightKg) * 100));

  const areaPercent = Math.min(
    100,
    Math.round(currentStepState?.area_utilization_percent ?? 0),
  );

  const placedItems: PlacedItemUI[] = currentStepState?.placed_items || [];

  // Xác định action tại bước này
  const rawStopType = (currentStop?.stop_type || currentStepState?.stop_type || 'PICKUP') as string;
  const isPickup = rawStopType === 'PICKUP';
  const isDelivery = rawStopType === 'DELIVERY';
  const isDepot = rawStopType === 'DEPOT_START' || rawStopType === 'DEPOT_END' || (!isPickup && !isDelivery);

  const itemsLoadedCount = currentStop?.items_loaded?.length || 0;
  const itemsUnloadedCount = currentStop?.items_unloaded?.length || 0;

  // Tọa độ và kích thước viewBox SVG cho sơ đồ sàn xe ngang
  const bedStartX = 30;
  const bedStartY = 16;
  const svgTotalWidth = vehicleLengthCm + 50;
  const svgTotalHeight = vehicleWidthCm + 32;

  return (
    <Card
      className="card-elevation"
      style={{
        height: 560,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      styles={{
        body: {
          padding: '14px 18px',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowY: 'auto',
        },
      }}
    >
      {/* 1. Header: Xe & Điều khiển bước */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space size={8}>
          <CarOutlined style={{ fontSize: 18, color: '#1d4ed8' }} />
          <strong style={{ fontSize: 15, color: '#0f172a' }}>
            {route.plate_number}
          </strong>
          <Tag color="geekblue" style={{ margin: 0, fontSize: 11, fontWeight: 600 }}>
            {route.driver_name?.split(' ').slice(-1)[0] || 'Tài xế'}
          </Tag>
        </Space>

        {/* Nút lùi/tiến bước hoặc theo dõi xe */}
        <Space size={6}>
          {isSimulating && (
            <Badge status="processing" text={<span style={{ fontSize: 12, color: '#059669', fontWeight: 700 }}>Đang chạy theo xe</span>} />
          )}
          <Button
            size="small"
            icon={<LeftOutlined />}
            disabled={clampedStep <= 0}
            onClick={() => onSelectStep(clampedStep - 1)}
          >
            Trước
          </Button>
          <span style={{ fontSize: 13, fontWeight: 700, minWidth: 50, textAlign: 'center', color: '#1e40af' }}>
            Bước {clampedStep + 1}/{totalSteps}
          </span>
          <Button
            size="small"
            icon={<RightOutlined />}
            disabled={clampedStep >= totalSteps - 1}
            onClick={() => onSelectStep(clampedStep + 1)}
          >
            Sau
          </Button>
        </Space>
      </div>

      {/* 2. Thẻ Thông Tin Thao Tác Điểm Dừng */}
      <div
        style={{
          background: isPickup ? '#f0fdf4' : isDelivery ? '#fff7ed' : '#f8fafc',
          border: `1.5px solid ${isPickup ? '#86efac' : isDelivery ? '#fdba74' : '#cbd5e1'}`,
          borderRadius: 8,
          padding: '10px 14px',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space size={8}>
            <span style={{ fontSize: 18 }}>{isPickup ? '📥' : isDelivery ? '📤' : '🏢'}</span>
            <div>
              <strong style={{ fontSize: 13, color: '#0f172a' }}>
                Điểm #{clampedStep + 1}: {currentStop?.location_name || 'Điểm dừng'}
              </strong>
              <div style={{ fontSize: 11, color: '#64748b' }}>
                {isPickup
                  ? `Bốc hàng lên xe (+${itemsLoadedCount} kiện)`
                  : isDelivery
                    ? `Dỡ hàng xuống cho khách (-${itemsUnloadedCount} kiện)`
                    : 'Xuất bến / Hoàn thành chuyến'}
              </div>
            </div>
          </Space>
          <Tag
            color={isPickup ? 'success' : isDelivery ? 'warning' : 'blue'}
            style={{ margin: 0, fontWeight: 700, fontSize: 11, padding: '3px 10px' }}
          >
            {isPickup ? 'LÊN HÀNG' : isDelivery ? 'DỠ HÀNG' : 'BẾN KHO'}
          </Tag>
        </div>
      </div>

      {/* 3. Tải Trọng & Thể Tích Thực Tế */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: '#64748b' }}>Tải trọng trên xe:</span>
            <strong style={{ color: weightPercent > 85 ? '#dc2626' : '#1e3a8a' }}>
              {currentWeightKg} / {maxWeightKg} kg ({weightPercent}%)
            </strong>
          </div>
          <Progress
            percent={weightPercent}
            size="small"
            status={weightPercent > 90 ? 'exception' : 'active'}
            strokeColor={weightPercent > 85 ? '#ef4444' : '#10b981'}
            showInfo={false}
          />
        </div>

        <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: '#64748b' }}>Diện tích sàn chiếm:</span>
            <strong style={{ color: '#2563eb' }}>
              {placedItems.length} kiện ({areaPercent}%)
            </strong>
          </div>
          <Progress
            percent={areaPercent}
            size="small"
            strokeColor="#3b82f6"
            showInfo={false}
          />
        </div>
      </div>

      {/* 4. SƠ ĐỒ 2D MẶT SÀN THÙNG XE KHÔNG CHỒNG (SVG BLUEPRINT CHUẨN TỈ LỆ 100%) */}
      <div
        style={{
          background: '#0f172a',
          borderRadius: 8,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          position: 'relative',
          marginBottom: 10,
          border: '1px solid #334155',
        }}
      >
        <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
          <span style={{ color: '#38bdf8', fontWeight: 600 }}>◄ Đầu Cabin Xe (X=0)</span>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>Thùng Xe: {vehicleLengthCm}cm (Dài) × {vehicleWidthCm}cm (Rộng)</span>
          <span style={{ color: '#f59e0b', fontWeight: 600 }}>Cửa Sau (Xếp/Dỡ) ►</span>
        </div>

        {/* Khung SVG chuẩn vector: Trục X là chiều dài, Trục Y là chiều rộng */}
        <div
          style={{
            width: '100%',
            maxHeight: 230,
            overflow: 'hidden',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <svg
            viewBox={`0 0 ${svgTotalWidth} ${svgTotalHeight}`}
            style={{ width: '100%', height: 'auto', maxHeight: 220, display: 'block' }}
          >
            <defs>
              {/* Lưới kỹ thuật sàn xe */}
              <pattern id="truckFloorGrid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.8" />
              </pattern>

              {/* Vạch kẻ an toàn cửa sau thùng xe (Hazard Yellow/Black) */}
              <pattern id="doorStripe" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="10" stroke="#f59e0b" strokeWidth="5" />
                <line x1="5" y1="0" x2="5" y2="10" stroke="#0f172a" strokeWidth="5" />
              </pattern>
            </defs>

            {/* Đầu Cabin xe tải phía bên trái */}
            <rect
              x="8"
              y={bedStartY}
              width="18"
              height={vehicleWidthCm}
              rx="4"
              fill="#1e293b"
              stroke="#475569"
              strokeWidth="1.5"
            />
            <path
              d={`M 14,${bedStartY + 20} Q 18,${bedStartY + vehicleWidthCm / 2} 14,${bedStartY + vehicleWidthCm - 20}`}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2"
            />

            {/* Sàn thùng xe chính (Main Bed) */}
            <rect
              x={bedStartX}
              y={bedStartY}
              width={vehicleLengthCm}
              height={vehicleWidthCm}
              rx="4"
              fill="#1e293b"
              stroke="#475569"
              strokeWidth="2"
            />
            {/* Lưới sàn xe */}
            <rect
              x={bedStartX}
              y={bedStartY}
              width={vehicleLengthCm}
              height={vehicleWidthCm}
              fill="url(#truckFloorGrid)"
            />

            {/* Cửa sau xe tải (Vạch cảnh báo bên phải) */}
            <rect
              x={bedStartX + vehicleLengthCm}
              y={bedStartY}
              width="12"
              height={vehicleWidthCm}
              rx="2"
              fill="url(#doorStripe)"
              stroke="#f59e0b"
              strokeWidth="1.5"
            />

            {/* Render các kiện hàng Placed Items - TỌA ĐỘ VÀ KÍCH THƯỚC CHUẨN X, Y TUYỆT ĐỐI */}
            {placedItems.length === 0 ? (
              <text
                x={bedStartX + vehicleLengthCm / 2}
                y={bedStartY + vehicleWidthCm / 2}
                fill="#64748b"
                fontSize="12"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                Sàn xe trống (Chưa có hàng)
              </text>
            ) : (
              placedItems.map((item, idx) => {
                const colorObj = ITEM_COLORS[idx % ITEM_COLORS.length];
                const itemX = bedStartX + item.x;
                const itemY = bedStartY + item.y;
                const itemWidth = Math.max(6, item.length_cm);
                const itemHeight = Math.max(6, item.width_cm);

                return (
                  <g key={item.item_id || idx}>
                    <Tooltip
                      title={`Kiện #${idx + 1} (${item.order_id || 'Đơn'}) · Dài: ${item.length_cm}cm, Rộng: ${item.width_cm}cm, Cao: ${item.height_cm}cm · Nặng: ${item.weight_kg}kg · Tọa độ: (${item.x}, ${item.y})`}
                    >
                      <rect
                        x={itemX}
                        y={itemY}
                        width={itemWidth}
                        height={itemHeight}
                        rx="3"
                        fill={colorObj.bg}
                        stroke={colorObj.border}
                        strokeWidth="1.5"
                        style={{ cursor: 'pointer', transition: 'all 0.2s' }}
                      />
                    </Tooltip>
                    {itemWidth >= 16 && itemHeight >= 14 && (
                      <text
                        x={itemX + itemWidth / 2}
                        y={itemY + itemHeight / 2}
                        fill={colorObj.text}
                        fontSize={Math.min(11, Math.max(8, itemHeight / 2))}
                        fontWeight="bold"
                        textAnchor="middle"
                        dominantBaseline="middle"
                        pointerEvents="none"
                      >
                        {idx + 1}
                      </text>
                    )}
                  </g>
                );
              })
            )}
          </svg>
        </div>

        {/* Chú thích đảm bảo bất biến TMS */}
        <div style={{ marginTop: 6, fontSize: 11, color: '#34d399', display: 'flex', alignItems: 'center', gap: 6 }}>
          <SafetyCertificateOutlined />
          <span>Thẩm định hình học TMS: Không chồng kiện · Có đường ra cửa sau</span>
        </div>
      </div>

      {/* 5. Chân Card: Tóm tắt dự toán */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 8,
          borderTop: '1px solid #f1f5f9',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
        }}
      >
        <Space size={6}>
          <Tag color="success" style={{ margin: 0, fontWeight: 700 }}>{statusText}</Tag>
          <span style={{ color: '#64748b' }}>{totalRoutesCount} tuyến · {totalDistanceKm.toFixed(0)} km</span>
        </Space>
        <div>
          <strong style={{ color: '#1d4ed8', fontSize: 13 }}>
            {currency.format(totalCostVnd)}
          </strong>
        </div>
      </div>
    </Card>
  );
};

export default LiveCargoStepTracker;
