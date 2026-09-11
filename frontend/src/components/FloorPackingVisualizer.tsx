import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Progress,
  Row,
  Col,
  Space,
  Tag,
  Tooltip,
  Typography,
  Table,
} from 'antd';
import {
  InboxOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  CaretRightOutlined,
  PauseOutlined,
  AimOutlined,
  DashboardOutlined,
  SafetyCertificateOutlined,
  FilterOutlined,
  AppstoreOutlined,
  SwapOutlined,
  CarOutlined,
  DownOutlined,
  UpOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { Select } from 'antd';
import { FloorStepStateUI, PlacedItemUI, Vehicle, OptimizedRouteUI } from '../types';

const { Text } = Typography;
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

interface Props {
  vehicle?: Vehicle | null;
  vehicleDimensions?: { lengthCm: number; widthCm: number };
  stepStates: FloorStepStateUI[];
  isValid: boolean;
  violations?: string[];
  selectedStepIndex?: number;
  onStepChange?: (index: number) => void;
  // Props tích hợp khi đặt làm tracker chính phía trên
  route?: OptimizedRouteUI | null;
  allRoutes?: OptimizedRouteUI[];
  onSelectRoute?: (vehicleId: string) => void;
  isSimulating?: boolean;
}

// Bảng màu sang trọng và đồng nhất theo đơn hàng
const ORDER_COLOR_PALETTE = [
  { bg: '#2563eb', border: '#1d4ed8', light: '#dbeafe', name: 'Blue' },
  { bg: '#059669', border: '#047857', light: '#d1fae5', name: 'Emerald' },
  { bg: '#d97706', border: '#b45309', light: '#fef3c7', name: 'Amber' },
  { bg: '#7c3aed', border: '#6d28d2', light: '#ede9fe', name: 'Purple' },
  { bg: '#e11d48', border: '#be123c', light: '#ffe4e6', name: 'Rose' },
  { bg: '#0891b2', border: '#0e7490', light: '#cffafe', name: 'Cyan' },
  { bg: '#ea580c', border: '#c2410c', light: '#ffedd5', name: 'Orange' },
  { bg: '#4f46e5', border: '#4338ca', light: '#e0e7ff', name: 'Indigo' },
  { bg: '#65a30d', border: '#4d7c0f', light: '#ecfccb', name: 'Lime' },
  { bg: '#c026d3', border: '#a21caf', light: '#fae8ff', name: 'Fuchsia' },
];

export const FloorPackingVisualizer: React.FC<Props> = ({
  vehicle,
  vehicleDimensions,
  stepStates,
  isValid,
  violations = [],
  selectedStepIndex,
  onStepChange,
  route,
  allRoutes,
  onSelectRoute,
  isSimulating,
}) => {
  const [internalStep, setInternalStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedOrderFilter, setSelectedOrderFilter] = useState<string | null>(null);
  const [expandedOrderKeys, setExpandedOrderKeys] = useState<React.Key[]>([]);
  const playTimerRef = useRef<number | null>(null);

  const bedLength = vehicleDimensions?.lengthCm || vehicle?.lengthCm || 620;
  const bedWidth = vehicleDimensions?.widthCm || vehicle?.widthCm || 215;

  // Bổ sung bước 0: Xuất bến tại Chi nhánh / Kho (Thùng xe rỗng sẵn sàng nhận hàng)
  // Đảm bảo khi xe chưa tới điểm 1 để lấy hàng, thùng xe hiển thị rỗng đúng thực tế nghiệp vụ
  const effectiveStepStates: FloorStepStateUI[] = useMemo(() => {
    if (!stepStates || stepStates.length === 0) return [];
    const depotName = route?.depot?.name || vehicle?.homeBranch?.name || 'Chi nhánh / Kho xuất phát';
    const totalFloor = bedLength * bedWidth;
    const startState: FloorStepStateUI = {
      step_index: 0,
      stop_id: 'depot-start',
      stop_type: 'PICKUP',
      action_description: `Xuất bến tại ${depotName} (Xe rỗng sẵn sàng nhận hàng)`,
      placed_items: [],
      current_weight_kg: 0,
      current_occupied_area_cm2: 0,
      floor_area_cm2: totalFloor,
      weight_utilization_percent: 0,
      area_utilization_percent: 0,
      is_valid: true,
      package_access_paths: [],
    };
    return [startState, ...stepStates];
  }, [stepStates, route?.depot?.name, vehicle?.homeBranch?.name, bedLength, bedWidth]);

  const currentStep = selectedStepIndex !== undefined ? selectedStepIndex : internalStep;
  const clampedStep = Math.max(0, Math.min(effectiveStepStates.length - 1, currentStep));

  const handleStepChange = (newStep: number) => {
    const clamped = Math.max(0, Math.min(effectiveStepStates.length - 1, newStep));
    setInternalStep(clamped);
    setSelectedItemId(null); // Reset chọn kiện khi đổi bước
    if (onStepChange) {
      onStepChange(clamped);
    }
  };

  // Tự động phát trình chiếu xếp dỡ qua các stops (Autoplay)
  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = window.setInterval(() => {
        setInternalStep((prev) => {
          const next = prev + 1 >= effectiveStepStates.length ? 0 : prev + 1;
          if (onStepChange) onStepChange(next);
          return next;
        });
      }, 1800);
    } else if (playTimerRef.current) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    return () => {
      if (playTimerRef.current) window.clearInterval(playTimerRef.current);
    };
  }, [isPlaying, effectiveStepStates.length, onStepChange]);

  if (!effectiveStepStates || effectiveStepStates.length === 0) {
    return (
      <Card
        id="floor-visualizer-section"
        title={
          <Space>
            <InboxOutlined style={{ color: '#1677ff' }} />
            <span>Mặt Sàn Thùng Xe 2D (Dynamic Floor Packing)</span>
          </Space>
        }
        className="card-elevation"
      >
        <Empty description="Chưa có dữ liệu mô phỏng xếp dỡ 2D cho chuyến đi này" />
      </Card>
    );
  }

  const activeState = effectiveStepStates[clampedStep];

  // Diện tích thùng và phần chiếm dụng
  const totalFloorAreaM2 = (bedLength * bedWidth) / 10000;
  const occupiedAreaM2 = (activeState.current_occupied_area_cm2 || 0) / 10000;
  const freeAreaM2 = Math.max(0, totalFloorAreaM2 - occupiedAreaM2);
  const freeAreaPercent = Math.max(0, 100 - (activeState.area_utilization_percent || 0));

  // Lập bản đồ màu sắc duy nhất cho từng Đơn Hàng (Order ID)
  const orderColorMap = useMemo(() => {
    const map = new Map<string, typeof ORDER_COLOR_PALETTE[0]>();
    let colorIdx = 0;
    effectiveStepStates.forEach((state) => {
      state.placed_items.forEach((item) => {
        const orderKey = item.order_id || item.item_id.split('#')[0] || 'DEFAULT';
        if (!map.has(orderKey)) {
          map.set(orderKey, ORDER_COLOR_PALETTE[colorIdx % ORDER_COLOR_PALETTE.length]);
          colorIdx++;
        }
      });
    });
    return map;
  }, [effectiveStepStates]);

  const getItemColor = (item: PlacedItemUI) => {
    const orderKey = item.order_id || item.item_id.split('#')[0] || 'DEFAULT';
    return orderColorMap.get(orderKey) || ORDER_COLOR_PALETTE[0];
  };

  // Tạo nhãn ngắn thân thiện cho kiện
  const getItemShortLabel = (item: PlacedItemUI) => {
    if (item.item_id.includes('#')) {
      const parts = item.item_id.split('#');
      const orderPart = parts[0].slice(-3).toUpperCase();
      return `${orderPart}#${parts[1]}`;
    }
    return item.item_id.slice(-4).toUpperCase();
  };

  // Tính toán biến động (delta) kiện bốc/dỡ tại bước hiện tại so với bước trước
  const stepDelta = useMemo(() => {
    if (!activeState) return { type: 'DEPOT', count: 0, weight: 0 };
    if (clampedStep === 0) {
      return {
        type: 'DEPOT',
        count: 0,
        weight: 0,
      };
    }
    const curr = activeState.placed_items || [];
    const prev = effectiveStepStates[clampedStep - 1]?.placed_items || [];
    const prevIds = new Set(prev.map((i) => i.item_id));
    const currIds = new Set(curr.map((i) => i.item_id));
    const loaded = curr.filter((i) => !prevIds.has(i.item_id));
    const unloaded = prev.filter((i) => !currIds.has(i.item_id));

    if (activeState.stop_type === 'PICKUP' || loaded.length > 0) {
      const weight = loaded.reduce((sum, i) => sum + i.weight_kg, 0);
      return { type: 'PICKUP', count: loaded.length || curr.length, weight: weight || activeState.current_weight_kg };
    } else {
      const weight = unloaded.reduce((sum, i) => sum + i.weight_kg, 0);
      return { type: 'DELIVERY', count: unloaded.length, weight };
    }
  }, [activeState, clampedStep, effectiveStepStates]);

  // Backend là nguồn sự thật cho đường thao tác 2D; frontend không lặp lại
  // thuật toán hình học vì sẽ dễ báo khác kết quả validator.
  const accessPathByItem = useMemo(
    () => new Map(
      (activeState.package_access_paths || []).map((accessPath) => [accessPath.item_id, accessPath]),
    ),
    [activeState.package_access_paths],
  );

  const isPathToDoorClear = (target: PlacedItemUI): boolean =>
    accessPathByItem.get(target.item_id)?.is_clear === true;

  const getBlockingItems = (target: PlacedItemUI): PlacedItemUI[] => {
    const blockerIds = new Set(
      accessPathByItem.get(target.item_id)?.blocker_item_ids || [],
    );
    return activeState.placed_items.filter((item) => blockerIds.has(item.item_id));
  };

  // Số lượng kiện có lối ra cửa sau thông suốt
  const clearCorridorCount = useMemo(() => {
    return (activeState.placed_items || []).filter(isPathToDoorClear).length;
  }, [activeState.placed_items, accessPathByItem]);

  // Gom nhóm kiện theo Đơn hàng có trên xe tại điểm này
  const orderGroups = useMemo(() => {
    const groups = new Map<string, { orderKey: string; items: PlacedItemUI[]; totalWeight: number; color: typeof ORDER_COLOR_PALETTE[0] }>();
    (activeState.placed_items || []).forEach((item) => {
      const orderKey = item.order_id || item.item_id.split('#')[0] || 'DEFAULT';
      const color = getItemColor(item);
      if (!groups.has(orderKey)) {
        groups.set(orderKey, { orderKey, items: [], totalWeight: 0, color });
      }
      const grp = groups.get(orderKey)!;
      grp.items.push(item);
      grp.totalWeight += item.weight_kg;
    });
    return Array.from(groups.values());
  }, [activeState.placed_items, orderColorMap]);

  // Kiện được chọn hoặc hover để vẽ hành lang ra cửa sau
  const activeHighlightedItem = useMemo(() => {
    const targetId = selectedItemId || hoveredItemId;
    if (!targetId) return null;
    return activeState.placed_items.find((item) => item.item_id === targetId) || null;
  }, [selectedItemId, hoveredItemId, activeState.placed_items]);

  // Kích thước khung vẽ SVG
  const cabinWidth = 72; // Đầu cabin phía trước bên trái
  const rearDoorWidth = 56; // Cửa sau bốc dỡ bên phải
  const bedCanvasWidth = 620;
  const totalSvgWidth = cabinWidth + bedCanvasWidth + rearDoorWidth;

  const bedCanvasHeight = Math.max(180, Math.round((bedWidth / bedLength) * bedCanvasWidth));
  const totalSvgHeight = bedCanvasHeight + 40; // +40px cho thước đo centimet phía trên

  const scaleX = bedCanvasWidth / bedLength;
  const scaleY = bedCanvasHeight / bedWidth;
  const bedStartX = cabinWidth;
  const bedStartY = 30;



  return (
    <Card
      id="floor-visualizer-section"
      title={
        <Space size={8}>
          <InboxOutlined style={{ color: '#1677ff', fontSize: 16 }} />
          <span style={{ fontWeight: 600, fontSize: 15, color: '#0f172a' }}>
            Sơ đồ xếp dỡ thùng xe
          </span>
        </Space>
      }
      extra={
        <Space size={8} wrap>
          {isValid ? (
            <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
              Chuẩn T21–T27
            </Tag>
          ) : (
            <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ margin: 0 }}>
              Vi phạm ({violations.length})
            </Tag>
          )}
          <Tag color="processing" style={{ margin: 0, fontSize: 12 }}>
            Thùng: <b>{bedLength} × {bedWidth} cm</b> ({totalFloorAreaM2.toFixed(2)} m²)
          </Tag>
        </Space>
      }
      className="card-elevation"
      style={{ marginTop: route ? 0 : 16 }}
      styles={{
        header: {
          padding: '0 16px',
          minHeight: 52,
          borderBottom: '1px solid #f1f5f9',
        },
        body: {
          padding: '16px',
        },
      }}
    >
      {/* ============================================================ */}
      {/* THANH THÔNG TIN TUYẾN XE & TÀI XẾ (ĐỒNG BỘ MAP TOOLBAR)     */}
      {/* ============================================================ */}
      {route && (
        <div className="automatic-map-toolbar">
          <div className="automatic-map-filter">
            <Text strong>Tuyến xe</Text>
            {allRoutes && allRoutes.length > 1 && onSelectRoute ? (
              <Select
                size="small"
                value={route.vehicle_id}
                onChange={onSelectRoute}
                popupMatchSelectWidth={false}
                options={allRoutes.map((r, index) => ({
                  value: r.vehicle_id,
                  label: (
                    <span>
                      <span
                        className="route-color-dot"
                        style={{
                          backgroundColor: ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2'][index % 6],
                        }}
                        aria-hidden="true"
                      />
                      {r.plate_number} · {r.driver_name || 'Chưa có tài xế'}
                    </span>
                  ),
                }))}
              />
            ) : (
              <strong style={{ fontSize: 14, color: '#0f172a' }}>
                {route.plate_number} · {route.driver_name || 'Chưa có tài xế'}
              </strong>
            )}
          </div>

          <Space size={10} align="center">
            <span style={{ fontSize: 12, color: '#64748b' }}>Chi phí tuyến:</span>
            <strong style={{ color: '#1677ff', fontSize: 14 }}>
              {currency.format(route.cost?.total_cost_vnd || 0)}
            </strong>
            {isSimulating && (
              <Badge
                status="processing"
                text={<span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Mô phỏng</span>}
              />
            )}
          </Space>
        </div>
      )}
      {violations.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="Phát hiện vi phạm không gian sàn xe (Scenarios T21–T27):"
          description={
            <ul style={{ paddingLeft: 20, margin: 0 }}>
              {violations.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {/* ============================================================ */}
      {/* 1. THANH ĐIỀU KHIỂN BƯỚC XẾP DỠ (NAVIGATION & PLAYBACK)       */}
      {/* ============================================================ */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          padding: '6px 10px',
          minHeight: 38,
          borderRadius: 8,
          marginBottom: 10,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <Space wrap size={8} align="center">
          <Button.Group size="small">
            <Tooltip title="Về điểm đầu tiên">
              <Button
                icon={<StepBackwardOutlined />}
                disabled={clampedStep === 0}
                onClick={() => handleStepChange(0)}
              />
            </Tooltip>
            <Tooltip title="Điểm trước">
              <Button
                disabled={clampedStep === 0}
                onClick={() => handleStepChange(clampedStep - 1)}
              >
                Trước
              </Button>
            </Tooltip>
            <Tooltip title={isPlaying ? 'Tạm dừng' : 'Tự động trình chiếu xếp dỡ'}>
              <Button
                type={isPlaying ? 'primary' : 'default'}
                icon={isPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
                onClick={() => setIsPlaying(!isPlaying)}
              >
                {isPlaying ? 'Dừng' : 'Chiếu'}
              </Button>
            </Tooltip>
            <Tooltip title="Điểm tiếp theo">
              <Button
                disabled={clampedStep === effectiveStepStates.length - 1}
                onClick={() => handleStepChange(clampedStep + 1)}
              >
                Tiếp
              </Button>
            </Tooltip>
            <Tooltip title="Đến điểm cuối cùng">
              <Button
                icon={<StepForwardOutlined />}
                disabled={clampedStep === effectiveStepStates.length - 1}
                onClick={() => handleStepChange(effectiveStepStates.length - 1)}
              />
            </Tooltip>
          </Button.Group>

          <Tag
            color={clampedStep === 0 ? 'blue' : activeState.stop_type === 'PICKUP' ? 'success' : 'warning'}
            style={{ margin: 0, fontWeight: 600, fontSize: 12 }}
          >
            {clampedStep === 0 ? 'XUẤT BẾN' : activeState.stop_type === 'PICKUP' ? 'NHẬN' : 'GIAO'}
          </Tag>

          <Text strong style={{ fontSize: 12 }}>
            {clampedStep === 0
              ? 'Khởi hành:'
              : `Điểm dừng ${clampedStep}/${effectiveStepStates.length - 1}:`}
          </Text>
          <Text type="secondary" style={{ maxWidth: 220, fontSize: 12 }} ellipsis>
            {activeState.action_description}
          </Text>
        </Space>

        <Space wrap size={8} align="center">
          <Tooltip title="Tỷ lệ diện tích sàn bị chiếm dụng">
            <span style={{ fontSize: 12, color: '#475569' }}>Sàn:</span>
            <Progress
              type="circle"
              percent={Number((activeState.area_utilization_percent || 0).toFixed(0))}
              size={24}
              strokeColor={activeState.area_utilization_percent > 85 ? '#ef4444' : '#3b82f6'}
            />
          </Tooltip>

          <Tag color="cyan" style={{ margin: 0 }}>
            Kiện: <b>{activeState.placed_items?.length || 0}</b>
          </Tag>
          <Tag color="blue" style={{ margin: 0 }}>
            Tải: <b>{activeState.current_weight_kg?.toFixed(0) || 0} kg</b>
          </Tag>
        </Space>
      </div>

      {/* ============================================================ */}
      {/* 2. BẢNG 4 METRIC CARDS CHI TIẾT KỸ THUẬT (PHẦN TRÊN CHI TIẾT HƠN) */}
      {/* ============================================================ */}
      <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={6}>
          <div
            style={{
              backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '8px 10px',
              height: '100%',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Tải trọng trên xe</span>
              <DashboardOutlined style={{ color: '#2563eb', fontSize: 13 }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {activeState.current_weight_kg?.toFixed(0)} <span style={{ fontSize: 12, fontWeight: 500 }}>kg</span>
            </div>
            <div style={{ fontSize: 11, color: '#475569' }}>
              Hiệu suất: <b>{activeState.weight_utilization_percent?.toFixed(1) || '0.0'}%</b>
            </div>
          </div>
        </Col>

        <Col xs={12} sm={6}>
          <div
            style={{
              backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '8px 10px',
              height: '100%',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Biến động tại điểm</span>
              <SwapOutlined
                style={{
                  color: stepDelta.type === 'DEPOT' ? '#2563eb' : stepDelta.type === 'PICKUP' ? '#16a34a' : '#ea580c',
                  fontSize: 13,
                }}
              />
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: stepDelta.type === 'DEPOT' ? '#2563eb' : stepDelta.type === 'PICKUP' ? '#16a34a' : '#ea580c',
                marginTop: 2,
              }}
            >
              {stepDelta.type === 'DEPOT'
                ? '0 kiện'
                : stepDelta.type === 'PICKUP'
                ? `+${stepDelta.count} kiện`
                : `-${stepDelta.count} kiện`}
            </div>
            <div style={{ fontSize: 11, color: '#475569' }}>
              {stepDelta.type === 'DEPOT' ? 'Thùng xe:' : stepDelta.type === 'PICKUP' ? 'Bốc nhận:' : 'Dỡ giao:'}{' '}
              <b>{stepDelta.type === 'DEPOT' ? 'Xe rỗng' : `${stepDelta.weight.toFixed(0)} kg`}</b>
            </div>
          </div>
        </Col>

        <Col xs={12} sm={6}>
          <div
            style={{
              backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '8px 10px',
              height: '100%',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Diện tích mặt sàn</span>
              <AppstoreOutlined style={{ color: '#0891b2', fontSize: 13 }} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {occupiedAreaM2.toFixed(2)} <span style={{ fontSize: 12, fontWeight: 500 }}>/ {totalFloorAreaM2.toFixed(2)} m²</span>
            </div>
            <div style={{ fontSize: 11, color: '#475569' }}>
              Trống: <b>{freeAreaM2.toFixed(2)} m²</b> ({freeAreaPercent.toFixed(1)}%)
            </div>
          </div>
        </Col>

        <Col xs={12} sm={6}>
          <div
            style={{
              backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
              padding: '8px 10px',
              height: '100%',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Lối dỡ cửa sau T21–T27</span>
              <SafetyCertificateOutlined
                style={{
                  color: clampedStep === 0 ? '#3b82f6' : clearCorridorCount === activeState.placed_items.length ? '#16a34a' : '#eab308',
                  fontSize: 13,
                }}
              />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {clampedStep === 0
                ? '0 / 0 '
                : `${clearCorridorCount} / ${activeState.placed_items.length} `}
              <span style={{ fontSize: 12, fontWeight: 500 }}>kiện</span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: clampedStep === 0
                  ? '#3b82f6'
                  : clearCorridorCount === activeState.placed_items.length
                  ? '#16a34a'
                  : '#d97706',
              }}
            >
              {clampedStep === 0
                ? '✓ Sàn xe sẵn sàng'
                : clearCorridorCount === activeState.placed_items.length
                ? '✓ 100% thông thoáng'
                : `${activeState.placed_items.length - clearCorridorCount} kiện chờ dỡ sau`}
            </div>
          </div>
        </Col>
      </Row>

      {/* ============================================================ */}
      {/* 3. DẢI BỘ LỌC THEO ĐƠN HÀNG TRÊN XE (ORDER PALETTE FILTERS)   */}
      {/* ============================================================ */}
      {orderGroups.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 10,
            overflowX: 'auto',
            paddingBottom: 2,
          }}
        >
          <span style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>
            <FilterOutlined style={{ marginRight: 3 }} /> Lọc đơn trên xe:
          </span>
          <Tag
            color={selectedOrderFilter === null ? 'blue' : 'default'}
            style={{ cursor: 'pointer', fontSize: 11, margin: 0 }}
            onClick={() => setSelectedOrderFilter(null)}
          >
            Tất cả ({activeState.placed_items.length} kiện)
          </Tag>
          {orderGroups.map((grp) => {
            const isSelected = selectedOrderFilter === grp.orderKey;
            return (
              <Tag
                key={grp.orderKey}
                style={{
                  cursor: 'pointer',
                  fontSize: 11,
                  margin: 0,
                  border: `1px solid ${grp.color.border}`,
                  backgroundColor: isSelected ? grp.color.light : '#f8fafc',
                  color: isSelected ? grp.color.border : '#334155',
                  fontWeight: isSelected ? 600 : 400,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                onClick={() => setSelectedOrderFilter(isSelected ? null : grp.orderKey)}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    backgroundColor: grp.color.bg,
                  }}
                />
                <span>Đơn {grp.orderKey.slice(-6).toUpperCase()}</span>
                <span style={{ color: '#64748b', fontSize: 10 }}>({grp.items.length} kiện - {grp.totalWeight.toFixed(0)}kg)</span>
              </Tag>
            );
          })}
        </div>
      )}

      {/* KHUNG VẼ XE TẢI & MẶT SÀN 2D SVG BLUEPRINT */}
      <div
        style={{
          border: '2px solid #334155',
          borderRadius: 10,
          backgroundColor: '#0f172a', // Màu nền Slate công nghiệp cao cấp
          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5), 0 4px 12px rgba(0,0,0,0.08)',
          position: 'relative',
          overflow: 'hidden',
          padding: '12px 8px',
        }}
      >
        <svg
          width="100%"
          viewBox={`0 0 ${totalSvgWidth} ${totalSvgHeight}`}
          style={{ display: 'block', maxHeight: 380 }}
        >
          <defs>
            {/* Lưới kỹ thuật sàn xe */}
            <pattern id="cargoGrid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1" />
            </pattern>

            {/* Dải sọc an toàn cảnh báo cửa sau (Hazard Stripe) */}
            <pattern id="hazardStripe" width="20" height="20" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="20" stroke="#f59e0b" strokeWidth="10" />
              <line x1="10" y1="0" x2="10" y2="20" stroke="#1e293b" strokeWidth="10" />
            </pattern>

            {/* Hiệu ứng bóng nổi kiện hàng */}
            <filter id="boxShadow" x="-10%" y="-10%" width="130%" height="130%">
              <feDropShadow dx="2" dy="3" stdDeviation="2" floodColor="#000000" floodOpacity="0.4" />
            </filter>

            {/* Hiệu ứng kiện phát sáng khi chọn */}
            <filter id="glowEffect" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* ============================================================ */}
          {/* THƯỚC ĐO KÍCH THƯỚC CHIỀU DÀI TRÊN SÀN (RULER 0 -> bedLength cm) */}
          {/* ============================================================ */}
          <g transform={`translate(${bedStartX}, 18)`}>
            <line x1="0" y1="0" x2={bedCanvasWidth} y2="0" stroke="#64748b" strokeWidth="1.5" />
            {[0, 100, 200, 300, 400, 500, 600, bedLength].map((mark) => {
              if (mark > bedLength) return null;
              const mx = mark * scaleX;
              return (
                <g key={mark} transform={`translate(${mx}, 0)`}>
                  <line x1="0" y1="-5" x2="0" y2="5" stroke="#94a3b8" strokeWidth="1.5" />
                  <text
                    x="0"
                    y="-8"
                    fill="#94a3b8"
                    fontSize="9"
                    fontWeight="500"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    {mark}cm
                  </text>
                </g>
              );
            })}
          </g>

          {/* ============================================================ */}
          {/* THƯỚC ĐO CHIỀU RỘNG SÀN Y-AXIS (0 -> bedWidth cm) CẠNH CABIN  */}
          {/* ============================================================ */}
          <g transform={`translate(${bedStartX - 6}, ${bedStartY})`}>
            <line x1="0" y1="0" x2="0" y2={bedCanvasHeight} stroke="#64748b" strokeWidth="1.5" />
            {[0, 50, 100, 150, 200, bedWidth].map((mark) => {
              if (mark > bedWidth) return null;
              const my = mark * scaleY;
              return (
                <g key={mark} transform={`translate(0, ${my})`}>
                  <line x1="-4" y1="0" x2="0" y2="0" stroke="#94a3b8" strokeWidth="1.5" />
                  <text
                    x="-6"
                    y="3"
                    fill="#94a3b8"
                    fontSize="8"
                    fontWeight="500"
                    textAnchor="end"
                    fontFamily="monospace"
                  >
                    {mark}
                  </text>
                </g>
              );
            })}
          </g>

          {/* ============================================================ */}
          {/* ĐẦU CABIN XE TẢI (Vector Truck Cabin Top-down) bên trái */}
          {/* ============================================================ */}
          <g transform={`translate(4, ${bedStartY})`}>
            {/* Thân Cabin */}
            <rect
              x="8"
              y="0"
              width={cabinWidth - 14}
              height={bedCanvasHeight}
              rx="12"
              fill="#1e293b"
              stroke="#334155"
              strokeWidth="2"
            />
            {/* Kính chắn gió cong */}
            <path
              d={`M 26,10 Q 12,${bedCanvasHeight / 2} 26,${bedCanvasHeight - 10} L 36,${bedCanvasHeight - 14} Q 24,${bedCanvasHeight / 2} 36,14 Z`}
              fill="#38bdf8"
              opacity="0.75"
            />
            {/* Vô lăng lái */}
            <circle cx="44" cy={bedCanvasHeight * 0.75} r="9" fill="none" stroke="#64748b" strokeWidth="2.5" />
            <circle cx="44" cy={bedCanvasHeight * 0.75} r="3" fill="#64748b" />

            {/* Mui lướt gió khí động học (Wind deflector) */}
            <path
              d={`M 48,16 L 62,${bedCanvasHeight / 2} L 48,${bedCanvasHeight - 16} Z`}
              fill="#0f172a"
              opacity="0.8"
            />

            {/* Bánh xe trước bên trái */}
            <rect x="18" y="-12" width="28" height="10" rx="3" fill="#020617" stroke="#475569" strokeWidth="1.5" />
            {/* Bánh xe trước bên phải */}
            <rect x="18" y={bedCanvasHeight + 2} width="28" height="10" rx="3" fill="#020617" stroke="#475569" strokeWidth="1.5" />

            {/* Đèn pha phía trước */}
            <circle cx="12" cy="14" r="4" fill="#fef08a" opacity="0.9" />
            <circle cx="12" cy={bedCanvasHeight - 14} r="4" fill="#fef08a" opacity="0.9" />

            {/* Nhãn Cabin đầu xe */}
            <text
              x="52"
              y={bedCanvasHeight / 2}
              fill="#94a3b8"
              fontSize="10"
              fontWeight="bold"
              textAnchor="middle"
              transform={`rotate(-90 52 ${bedCanvasHeight / 2})`}
              letterSpacing="2"
            >
              CABIN (x=0)
            </text>
          </g>

          {/* ============================================================ */}
          {/* MẶT SÀN THÙNG XE (Truck Cargo Bed Floor) */}
          {/* ============================================================ */}
          <g transform={`translate(${bedStartX}, ${bedStartY})`}>
            {/* Nền sàn kim loại có lưới */}
            <rect
              x="0"
              y="0"
              width={bedCanvasWidth}
              height={bedCanvasHeight}
              fill="#0f172a"
              stroke="#475569"
              strokeWidth="2.5"
            />
            <rect
              x="0"
              y="0"
              width={bedCanvasWidth}
              height={bedCanvasHeight}
              fill="url(#cargoGrid)"
            />

            {/* Vạch đo chiều rộng (Y-Axis) */}
            <line x1="0" y1="0" x2="0" y2={bedCanvasHeight} stroke="#64748b" strokeWidth="2" />

            {/* ============================================================ */}
            {/* HÀNH LANG DỠ HÀNG RA CỬA SAU (EXIT CORRIDOR) CỦA KIỆN ĐANG CHỌN */}
            {/* ============================================================ */}
            {activeHighlightedItem && (
              (() => {
                const rx = activeHighlightedItem.x * scaleX;
                const ry = activeHighlightedItem.y * scaleY;
                const rw = activeHighlightedItem.length_cm * scaleX;
                const rh = activeHighlightedItem.width_cm * scaleY;
                const accessPath = accessPathByItem.get(activeHighlightedItem.item_id);
                const isClear = accessPath?.is_clear === true;
                const polylinePoints = (accessPath?.points || [])
                  .map((point) => (
                    `${(point.x + activeHighlightedItem.length_cm / 2) * scaleX},${
                      (point.y + activeHighlightedItem.width_cm / 2) * scaleY
                    }`
                  ))
                  .join(' ');

                return (
                  <g>
                    {isClear && accessPath && accessPath.points.length >= 2 ? (
                      <>
                        <polyline
                          points={polylinePoints}
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="3"
                          strokeDasharray="7 4"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        {accessPath.points.slice(1, -1).map((point, index) => (
                          <circle
                            key={`${point.x}-${point.y}-${index}`}
                            cx={(point.x + activeHighlightedItem.length_cm / 2) * scaleX}
                            cy={(point.y + activeHighlightedItem.width_cm / 2) * scaleY}
                            r="4"
                            fill="#34d399"
                          />
                        ))}
                        <text
                          x={Math.min(bedCanvasWidth - 8, rx + rw / 2 + 8)}
                          y={Math.max(12, ry + rh / 2 - 8)}
                          fill="#34d399"
                          fontSize="9"
                          fontWeight="bold"
                        >
                          ĐƯỜNG RA 2D
                        </text>
                      </>
                    ) : (
                      <>
                        <line
                          x1={rx + rw / 2}
                          y1={ry + rh / 2}
                          x2={bedCanvasWidth}
                          y2={ry + rh / 2}
                          stroke="#ef4444"
                          strokeWidth="2"
                          strokeDasharray="4 4"
                        />
                        <text
                          x={Math.min(bedCanvasWidth - 8, rx + rw / 2 + 8)}
                          y={Math.max(12, ry + rh / 2 - 8)}
                          fill="#f87171"
                          fontSize="9"
                          fontWeight="bold"
                        >
                          KHÔNG CÓ ĐƯỜNG 2D
                        </text>
                      </>
                    )}
                  </g>
                );
              })()
            )}

            {/* ============================================================ */}
            {/* CÁC KIỆN HÀNG ĐẶT TRÊN MẶT SÀN (CARGO ITEMS) */}
            {/* ============================================================ */}
            {activeState.placed_items.map((item) => {
              const rx = item.x * scaleX;
              const ry = item.y * scaleY;
              const rw = item.length_cm * scaleX;
              const rh = item.width_cm * scaleY;
              const colorInfo = getItemColor(item);
              const isHovered = hoveredItemId === item.item_id;
              const isSelected = selectedItemId === item.item_id;
              const isClear = isPathToDoorClear(item);
              const label = getItemShortLabel(item);

              // Xử lý làm mờ nếu đang lọc theo đơn hàng khác
              const orderKey = item.order_id || item.item_id.split('#')[0] || 'DEFAULT';
              const isDimmed = selectedOrderFilter !== null && orderKey !== selectedOrderFilter;

              return (
                <g
                  key={item.item_id}
                  style={{ cursor: 'pointer', transition: 'opacity 0.2s ease' }}
                  opacity={isDimmed ? 0.25 : 1}
                  onMouseEnter={() => setHoveredItemId(item.item_id)}
                  onMouseLeave={() => setHoveredItemId(null)}
                  onClick={() => setSelectedItemId(isSelected ? null : item.item_id)}
                >
                  {/* Tooltip gốc SVG hiển thị kích thước và khối lượng khi rê chuột */}
                  <title>{`Kiện: ${label} (Đơn ${item.order_id ? item.order_id.slice(-6).toUpperCase() : 'N/A'})\nKích thước: ${item.length_cm} × ${item.width_cm} × ${item.height_cm} cm\nKhối lượng: ${item.weight_kg.toFixed(1)} kg`}</title>
                  {/* Khối kiện hàng */}
                  <rect
                    x={rx}
                    y={ry}
                    width={rw}
                    height={rh}
                    rx="4"
                    ry="4"
                    fill={colorInfo.bg}
                    fillOpacity={isHovered || isSelected ? 1.0 : 0.9}
                    stroke={isSelected ? '#ffffff' : isHovered ? '#67e8f9' : colorInfo.border}
                    strokeWidth={isSelected ? 3 : isHovered ? 2 : 1}
                    filter={isSelected ? 'url(#glowEffect)' : 'url(#boxShadow)'}
                  />

                  {/* Viền sáng nổi khối 2.5D ở cạnh trên kiện */}
                  {rw > 15 && rh > 10 && (
                    <line
                      x1={rx + 2}
                      y1={ry + 2}
                      x2={rx + rw - 2}
                      y2={ry + 2}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      strokeOpacity="0.55"
                    />
                  )}

                  {/* Nhãn mã kiện hàng */}
                  {rw >= 28 && rh >= 16 && (
                    <text
                      x={rx + rw / 2}
                      y={ry + rh / 2 + (rw >= 40 && rh >= 28 ? -2 : 4)}
                      fill="#ffffff"
                      fontSize={Math.min(12, Math.max(9, rh / 2.2))}
                      fontWeight="bold"
                      textAnchor="middle"
                      pointerEvents="none"
                      fontFamily="system-ui, sans-serif"
                    >
                      {label}
                    </text>
                  )}

                  {/* Nhãn kích thước (D×R) thu nhỏ nếu ô đủ lớn */}
                  {rw >= 50 && rh >= 30 && (
                    <text
                      x={rx + rw / 2}
                      y={ry + rh / 2 + 10}
                      fill="#ffffff"
                      fillOpacity="0.85"
                      fontSize="9"
                      textAnchor="middle"
                      pointerEvents="none"
                      fontFamily="monospace"
                    >
                      {item.length_cm}×{item.width_cm}
                    </text>
                  )}

                  {/* Chỉ báo trạng thái lối ra cửa sau (chấm tròn xanh/đỏ góc kiện) */}
                  {rw >= 20 && (
                    <circle
                      cx={rx + rw - 6}
                      cy={ry + 6}
                      r="3.5"
                      fill={isClear ? '#22c55e' : '#ef4444'}
                      stroke="#ffffff"
                      strokeWidth="1"
                    />
                  )}
                </g>
              );
            })}

            {/* Thông báo khi xe ở bước khởi hành rỗng (chưa tới Điểm 1) */}
            {clampedStep === 0 && (
              <g transform={`translate(${bedCanvasWidth / 2}, ${bedCanvasHeight / 2})`}>
                <rect
                  x="-175"
                  y="-34"
                  width="350"
                  height="68"
                  rx="8"
                  fill="rgba(30, 41, 59, 0.92)"
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  strokeDasharray="5 3"
                />
                <text
                  x="0"
                  y="-6"
                  fill="#60a5fa"
                  fontSize="13"
                  fontWeight="600"
                  textAnchor="middle"
                >
                  🚚 Xe đang xuất bến từ công ty / kho
                </text>
                <text
                  x="0"
                  y="16"
                  fill="#94a3b8"
                  fontSize="11"
                  textAnchor="middle"
                >
                  Thùng xe rỗng · Chưa tới Điểm 1 để lấy hàng
                </text>
              </g>
            )}
          </g>

          {/* ============================================================ */}
          {/* CỬA SAU BỐC DỠ XE TẢI (Vector Rear Doors & Ramp) bên phải */}
          {/* ============================================================ */}
          <g transform={`translate(${bedStartX + bedCanvasWidth}, ${bedStartY})`}>
            {/* Dải vạch an toàn cảnh báo mở cửa (Hazard Stripe) */}
            <rect
              x="2"
              y="0"
              width="14"
              height={bedCanvasHeight}
              fill="url(#hazardStripe)"
              stroke="#f59e0b"
              strokeWidth="1.5"
            />

            {/* Dốc bốc dỡ mở ra ngoài (Loading Ramp) */}
            <path
              d={`M 16,4 L ${rearDoorWidth - 4},16 L ${rearDoorWidth - 4},${bedCanvasHeight - 16} L 16,${bedCanvasHeight - 4} Z`}
              fill="#334155"
              stroke="#64748b"
              strokeWidth="1.5"
              opacity="0.85"
            />

            {/* Mũi tên chỉ hướng dỡ hàng ra ngoài */}
            <g transform={`translate(${rearDoorWidth / 2}, ${bedCanvasHeight / 2})`}>
              <line x1="-10" y1="0" x2="10" y2="0" stroke="#22c55e" strokeWidth="2.5" />
              <polygon points="10,0 4,-5 4,5" fill="#22c55e" />
            </g>

            {/* Nhãn Cửa sau xe */}
            <text
              x={rearDoorWidth - 10}
              y={bedCanvasHeight / 2}
              fill="#34d399"
              fontSize="10"
              fontWeight="bold"
              textAnchor="middle"
              transform={`rotate(90 ${rearDoorWidth - 10} ${bedCanvasHeight / 2})`}
              letterSpacing="1"
            >
              CỬA SAU BỐC DỠ
            </text>
          </g>
        </svg>

        {/* Chú thích thông tin trực quan nổi dưới góc sơ đồ */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 12,
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(4px)',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            color: '#94a3b8',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#22c55e', marginRight: 4 }} />
            Lối ra thông suốt
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444', marginRight: 4 }} />
            Bị chắn
          </span>
          <span style={{ color: '#38bdf8' }}>
            <AimOutlined /> Click kiện để soi hành lang
          </span>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. THÔNG TIN KIỆN HÀNG TRÊN XE (KIỆN LỚN & CHI TIẾT KIỆN CON) */}
      {/* ============================================================ */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid #f1f5f9',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 10,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Space size={8}>
            <AppstoreOutlined style={{ color: '#1677ff', fontSize: 16 }} />
            <strong style={{ fontSize: 14, color: '#0f172a' }}>
              Thông tin kiện hàng trên xe ({activeState.placed_items?.length || 0} kiện)
            </strong>
          </Space>

          {clampedStep > 0 && orderGroups.length > 0 && (
            <Space size={8}>
              <Button
                size="small"
                type="text"
                icon={expandedOrderKeys.length === orderGroups.length ? <UpOutlined /> : <DownOutlined />}
                onClick={() => {
                  if (expandedOrderKeys.length === orderGroups.length) {
                    setExpandedOrderKeys([]);
                  } else {
                    setExpandedOrderKeys(orderGroups.map((g) => g.orderKey));
                  }
                }}
              >
                {expandedOrderKeys.length === orderGroups.length ? 'Thu gọn tất cả' : 'Mở rộng tất cả'}
              </Button>
            </Space>
          )}
        </div>

        {clampedStep === 0 ? (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              backgroundColor: '#f8fafc',
              borderRadius: 8,
              border: '1px dashed #cbd5e1',
            }}
          >
            <InboxOutlined style={{ fontSize: 32, color: '#94a3b8', marginBottom: 8 }} />
            <div style={{ fontWeight: 600, color: '#334155', fontSize: 14 }}>
              Thùng xe đang trống (Xe rỗng chuẩn bị nhận hàng)
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Xe đang khởi hành từ chi nhánh. Hàng hóa sẽ được bốc lên xe khi xe di chuyển tới Điểm 1.
            </Text>
          </div>
        ) : orderGroups.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Thùng xe đang trống tại điểm dừng này (chưa có kiện hàng nào trên xe)"
            style={{ margin: '16px 0' }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orderGroups.map((group) => {
              const isExpanded = expandedOrderKeys.includes(group.orderKey);
              const clearCount = group.items.filter(isPathToDoorClear).length;
              const isAllClear = clearCount === group.items.length;
              const areaM2 = group.items.reduce((s, it) => s + (it.length_cm * it.width_cm), 0) / 10000;
              const pct = totalFloorAreaM2 > 0 ? ((areaM2 / totalFloorAreaM2) * 100).toFixed(1) : '0';
              const shortOrderKey = group.orderKey.length > 10 ? `${group.orderKey.slice(0, 8)}...` : group.orderKey;

              return (
                <div
                  key={group.orderKey}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 8,
                    backgroundColor: '#ffffff',
                    overflow: 'hidden',
                    transition: 'all 0.2s ease',
                    boxShadow: isExpanded ? '0 2px 8px rgba(0,0,0,0.06)' : 'none',
                  }}
                >
                  {/* HÀNG HEADER KIỆN LỚN (ĐƠN HÀNG) */}
                  <div
                    onClick={() => {
                      if (isExpanded) {
                        setExpandedOrderKeys(expandedOrderKeys.filter((k) => k !== group.orderKey));
                      } else {
                        setExpandedOrderKeys([...expandedOrderKeys, group.orderKey]);
                      }
                    }}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 14px',
                      backgroundColor: isExpanded ? '#f8fafc' : '#ffffff',
                      cursor: 'pointer',
                      userSelect: 'none',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span
                        className="route-color-dot"
                        style={{
                          backgroundColor: group.color.bg,
                          width: 12,
                          height: 12,
                          marginRight: 0,
                          flexShrink: 0,
                        }}
                      />
                      <strong style={{ fontSize: 13, color: '#0f172a' }}>
                        Đơn {shortOrderKey}
                      </strong>
                      <Tag color="blue" style={{ margin: 0, fontWeight: 600, fontSize: 12 }}>
                        {group.items.length} kiện con
                      </Tag>
                      <span style={{ fontSize: 12, color: '#475569' }}>
                        <b>{group.totalWeight.toFixed(0)}</b> kg
                      </span>
                      <span style={{ fontSize: 12, color: '#64748b' }}>
                        · {areaM2.toFixed(2)} m² ({pct}%)
                      </span>
                      {selectedOrderFilter === group.orderKey && (
                        <Tag color="processing" style={{ margin: 0, fontSize: 11 }}>Đang lọc trên xe</Tag>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {isAllClear ? (
                        <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0, fontSize: 11 }}>
                          Thông suốt ({clearCount}/{group.items.length})
                        </Tag>
                      ) : (
                        <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ margin: 0, fontSize: 11 }}>
                          Bị chắn ({group.items.length - clearCount} kiện)
                        </Tag>
                      )}

                      <Tooltip title="Lọc hiển thị đơn này trên sơ đồ thùng xe">
                        <Button
                          size="small"
                          type={selectedOrderFilter === group.orderKey ? 'primary' : 'default'}
                          icon={<FilterOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOrderFilter(selectedOrderFilter === group.orderKey ? null : group.orderKey);
                          }}
                        />
                      </Tooltip>

                      <Button
                        size="small"
                        type={isExpanded ? 'primary' : 'default'}
                        icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                        style={{ fontSize: 12 }}
                      >
                        {isExpanded ? 'Đóng' : 'Xem kiện con'}
                      </Button>
                    </div>
                  </div>

                  {/* BẢNG CHI TIẾT CÁC KIỆN CON (KHI MỞ RỘNG) */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: '12px 14px',
                        borderTop: '1px solid #f1f5f9',
                        backgroundColor: '#fafbfc',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>
                          Danh sách {group.items.length} kiện con thuộc Đơn hàng:
                        </span>
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          Bấm nút <AimOutlined /> để soi vị trí và đường ra cửa sau trên sơ đồ xe
                        </span>
                      </div>

                      <Table
                        size="small"
                        dataSource={group.items}
                        rowKey="item_id"
                        pagination={false}
                        scroll={group.items.length > 6 ? { y: 260 } : undefined}
                        onRow={(it) => ({
                          onClick: () => setSelectedItemId(selectedItemId === it.item_id ? null : it.item_id),
                          onMouseEnter: () => setHoveredItemId(it.item_id),
                          onMouseLeave: () => setHoveredItemId(null),
                          style: {
                            cursor: 'pointer',
                            backgroundColor: selectedItemId === it.item_id ? '#eff6ff' : undefined,
                          },
                        })}
                        columns={[
                          {
                            title: 'Mã kiện',
                            dataIndex: 'item_id',
                            key: 'item_id',
                            width: 100,
                            render: (_, it) => (
                              <Space size={6}>
                                <strong style={{ color: '#1e40af' }}>{getItemShortLabel(it)}</strong>
                                {selectedItemId === it.item_id && <Badge status="processing" />}
                              </Space>
                            ),
                          },
                          {
                            title: 'Kích thước (D×R×C)',
                            key: 'dimensions',
                            render: (_, it) => (
                              <span>
                                {it.length_cm} × {it.width_cm} × {it.height_cm || 40} cm
                              </span>
                            ),
                          },
                          {
                            title: 'Tọa độ sàn (X, Y)',
                            key: 'position',
                            render: (_, it) => (
                              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#0369a1' }}>
                                x={it.x}cm, y={it.y}cm
                              </span>
                            ),
                          },
                          {
                            title: 'Tải trọng',
                            key: 'weight',
                            width: 80,
                            render: (_, it) => <span><b>{it.weight_kg}</b> kg</span>,
                          },
                          {
                            title: 'Lối ra cửa',
                            key: 'clear',
                            render: (_, it) => {
                              const clear = isPathToDoorClear(it);
                              const blockers = getBlockingItems(it);
                              return clear ? (
                                <Tag color="success" style={{ margin: 0, fontSize: 11 }}>
                                  ✓ Thông suốt
                                </Tag>
                              ) : (
                                <Tooltip title={`Bị chặn bởi: ${blockers.map((b) => getItemShortLabel(b)).join(', ')}`}>
                                  <Tag color="error" style={{ margin: 0, fontSize: 11 }}>
                                    ✕ Bị chắn ({blockers.length})
                                  </Tag>
                                </Tooltip>
                              );
                            },
                          },
                          {
                            title: 'Soi',
                            key: 'action',
                            align: 'center',
                            width: 55,
                            render: (_, it) => (
                              <Tooltip title="Định vị kiện trên sơ đồ thùng xe">
                                <Button
                                  size="small"
                                  type={selectedItemId === it.item_id ? 'primary' : 'default'}
                                  icon={<AimOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedItemId(selectedItemId === it.item_id ? null : it.item_id);
                                  }}
                                />
                              </Tooltip>
                            ),
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

export default FloorPackingVisualizer;
