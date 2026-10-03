import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  InputNumber,
  Progress,
  Row,
  Col,
  Space,
  Tag,
  Tooltip,
  Typography,
  Table,
  Select,
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
  DownOutlined,
  UpOutlined,
  DragOutlined,
  RotateRightOutlined,
  UndoOutlined,
  ReloadOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  WarningOutlined,
} from '@ant-design/icons';
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
  onSelectRoute?: (routeId: string) => void;
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

  // ============================================================
  // STATE MÔ PHỎNG DI CHUYỂN HÀNG THỦ CÔNG (CLIENT-SIDE SIMULATION)
  // ============================================================
  const [isManualMode, setIsManualMode] = useState(false);
  const [manualPlacedItemsByStep, setManualPlacedItemsByStep] = useState<Record<number, PlacedItemUI[]>>({});
  const [draggingState, setDraggingState] = useState<{
    itemId: string;
    grabOffsetCmX: number;
    grabOffsetCmY: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

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

  const activeState = effectiveStepStates[clampedStep];

  // Danh sách kiện thực tế đang hiển thị cho bước hiện tại (ưu tiên bản chỉnh sửa mô phỏng nếu có)
  const isStepEdited = Boolean(manualPlacedItemsByStep[clampedStep]);
  const hasAnyStepEdited = Object.keys(manualPlacedItemsByStep).length > 0;

  const currentPlacedItems: PlacedItemUI[] = useMemo(() => {
    if (manualPlacedItemsByStep[clampedStep]) {
      return manualPlacedItemsByStep[clampedStep];
    }
    return activeState?.placed_items || [];
  }, [manualPlacedItemsByStep, clampedStep, activeState?.placed_items]);

  // Kiểm tra va chạm chồng lấn giữa các kiện hàng (Bất biến T21-T27: Không được xếp chồng)
  const collisionInfo = useMemo(() => {
    const collidingIds = new Set<string>();
    const pairs: { item1: PlacedItemUI; item2: PlacedItemUI }[] = [];

    for (let i = 0; i < currentPlacedItems.length; i++) {
      for (let j = i + 1; j < currentPlacedItems.length; j++) {
        const a = currentPlacedItems[i];
        const b = currentPlacedItems[j];
        const isOverlap =
          a.x < b.x + b.length_cm &&
          a.x + a.length_cm > b.x &&
          a.y < b.y + b.width_cm &&
          a.y + a.width_cm > b.y;

        if (isOverlap) {
          collidingIds.add(a.item_id);
          collidingIds.add(b.item_id);
          pairs.push({ item1: a, item2: b });
        }
      }
    }
    return { collidingIds, pairs };
  }, [currentPlacedItems]);

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

  // Backend là nguồn sự thật cho đường thao tác 2D;
  const accessPathByItem = useMemo(() => {
    return new Map(
      (activeState?.package_access_paths || []).map((accessPath) => [accessPath.item_id, accessPath]),
    );
  }, [activeState?.package_access_paths]);

  // Sau chỉnh sửa chỉ hiển thị ước tính cục bộ; backend vẫn phải xác nhận lại toàn bộ thao tác.
  const accessPathInfo = useMemo(() => {
    const map = new Map<string, { isClear: boolean; blockerIds: string[]; points?: { x: number; y: number }[] }>();

    currentPlacedItems.forEach((itemA) => {
      if (!isStepEdited) {
        const backendPath = accessPathByItem.get(itemA.item_id);
        map.set(itemA.item_id, {
          isClear: backendPath?.is_clear === true,
          blockerIds: backendPath?.blocker_item_ids || [],
          points: backendPath?.points,
        });
        return;
      }

      // Khi đã chỉnh sửa mô phỏng: kiểm tra xem có kiện nào chắn dải thoát hiểm ra cửa sau không
      const blockers: string[] = [];
      currentPlacedItems.forEach((itemB) => {
        if (itemB.item_id === itemA.item_id) return;
        const isBehind = itemB.x + itemB.length_cm > itemA.x + itemA.length_cm && itemB.x < bedLength;
        const yOverlap = itemA.y < itemB.y + itemB.width_cm && itemA.y + itemA.width_cm > itemB.y;
        if (isBehind && yOverlap) {
          blockers.push(itemB.item_id);
        }
      });

      const isClear = blockers.length === 0;
      map.set(itemA.item_id, {
        isClear,
        blockerIds: blockers,
        points: isClear
          ? [
              { x: itemA.x, y: itemA.y },
              { x: bedLength - itemA.length_cm / 2, y: itemA.y },
            ]
          : undefined,
      });
    });

    return map;
  }, [isStepEdited, currentPlacedItems, accessPathByItem, bedLength]);

  const isPathToDoorClear = (target: PlacedItemUI): boolean =>
    accessPathInfo.get(target.item_id)?.isClear === true;

  const getBlockingItems = (target: PlacedItemUI): PlacedItemUI[] => {
    const blockerIds = new Set(accessPathInfo.get(target.item_id)?.blockerIds || []);
    return currentPlacedItems.filter((item) => blockerIds.has(item.item_id));
  };

  // Số lượng kiện có lối ra cửa sau thông suốt
  const clearCorridorCount = currentPlacedItems.filter(isPathToDoorClear).length;

  // Diện tích thùng và phần chiếm dụng động
  const totalFloorAreaM2 = (bedLength * bedWidth) / 10000;
  const occupiedAreaCm2 = currentPlacedItems.reduce((sum, it) => sum + it.length_cm * it.width_cm, 0);
  const occupiedAreaM2 = occupiedAreaCm2 / 10000;
  const freeAreaM2 = Math.max(0, totalFloorAreaM2 - occupiedAreaM2);
  const dynamicAreaPercent = totalFloorAreaM2 > 0 ? (occupiedAreaM2 / totalFloorAreaM2) * 100 : 0;
  const freeAreaPercent = Math.max(0, 100 - dynamicAreaPercent);

  // Lập bản đồ màu sắc duy nhất cho từng Đơn Hàng (Order ID)
  const orderColorMap = (() => {
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
  })();

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
  const stepDelta = (() => {
    if (!activeState) return { type: 'DEPOT', count: 0, weight: 0 };
    if (clampedStep === 0) {
      return {
        type: 'DEPOT',
        count: 0,
        weight: 0,
      };
    }
    const curr = currentPlacedItems;
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
  })();

  // Gom nhóm kiện theo Đơn hàng có trên xe tại điểm này
  const orderGroups = (() => {
    const groups = new Map<string, { orderKey: string; items: PlacedItemUI[]; totalWeight: number; color: typeof ORDER_COLOR_PALETTE[0] }>();
    currentPlacedItems.forEach((item) => {
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
  })();

  // Kiện được chọn hoặc hover để vẽ hành lang ra cửa sau
  const activeHighlightedItem = (() => {
    const targetId = selectedItemId || hoveredItemId;
    if (!targetId) return null;
    return currentPlacedItems.find((item) => item.item_id === targetId) || null;
  })();

  // Xử lý kéo thả chuột trên SVG
  const handleMouseDownItem = (e: React.MouseEvent, item: PlacedItemUI) => {
    if (!isManualMode) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedItemId(item.item_id);

    if (!svgRef.current) return;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const svgP = pt.matrixTransform(ctm.inverse());

    const floorClickX = (svgP.x - bedStartX) / scaleX;
    const floorClickY = (svgP.y - bedStartY) / scaleY;

    setDraggingState({
      itemId: item.item_id,
      grabOffsetCmX: floorClickX - item.x,
      grabOffsetCmY: floorClickY - item.y,
    });
  };

  useEffect(() => {
    if (!draggingState) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!svgRef.current) return;
      const pt = svgRef.current.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svgRef.current.getScreenCTM();
      if (!ctm) return;
      const svgP = pt.matrixTransform(ctm.inverse());

      const floorX = (svgP.x - bedStartX) / scaleX;
      const floorY = (svgP.y - bedStartY) / scaleY;

      let targetX = floorX - draggingState.grabOffsetCmX;
      let targetY = floorY - draggingState.grabOffsetCmY;

      // Snap to grid 5cm để dễ xếp thẳng hàng
      targetX = Math.round(targetX / 5) * 5;
      targetY = Math.round(targetY / 5) * 5;

      const baseItems = manualPlacedItemsByStep[clampedStep] || activeState?.placed_items || [];
      const targetItem = baseItems.find((i) => i.item_id === draggingState.itemId);
      if (!targetItem) return;

      // Giới hạn trong lòng sàn xe (boundary clamp)
      targetX = Math.max(0, Math.min(bedLength - targetItem.length_cm, targetX));
      targetY = Math.max(0, Math.min(bedWidth - targetItem.width_cm, targetY));

      const updated = baseItems.map((i) =>
        i.item_id === draggingState.itemId ? { ...i, x: targetX, y: targetY } : i
      );

      setManualPlacedItemsByStep((prev) => ({
        ...prev,
        [clampedStep]: updated,
      }));
    };

    const handleWindowMouseUp = () => {
      setDraggingState(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [draggingState, manualPlacedItemsByStep, clampedStep, activeState?.placed_items, bedStartX, bedStartY, scaleX, scaleY, bedLength, bedWidth]);

  // Xoay kiện 90° (đổi length_cm và width_cm)
  const handleRotateItem = (itemId: string) => {
    const baseItems = manualPlacedItemsByStep[clampedStep] || activeState?.placed_items || [];
    const targetItem = baseItems.find((i) => i.item_id === itemId);
    if (!targetItem) return;

    const newLength = targetItem.width_cm;
    const newWidth = targetItem.length_cm;

    let newX = targetItem.x;
    let newY = targetItem.y;
    if (newX + newLength > bedLength) {
      newX = Math.max(0, bedLength - newLength);
    }
    if (newY + newWidth > bedWidth) {
      newY = Math.max(0, bedWidth - newWidth);
    }

    const updated = baseItems.map((i) =>
      i.item_id === itemId
        ? { ...i, length_cm: newLength, width_cm: newWidth, x: newX, y: newY }
        : i
    );

    setManualPlacedItemsByStep((prev) => ({
      ...prev,
      [clampedStep]: updated,
    }));
  };

  // Dịch chuyển kiện từng bước nhỏ (cm)
  const handleNudgeItem = (itemId: string, dx: number, dy: number) => {
    const baseItems = manualPlacedItemsByStep[clampedStep] || activeState?.placed_items || [];
    const targetItem = baseItems.find((i) => i.item_id === itemId);
    if (!targetItem) return;

    const newX = Math.max(0, Math.min(bedLength - targetItem.length_cm, targetItem.x + dx));
    const newY = Math.max(0, Math.min(bedWidth - targetItem.width_cm, targetItem.y + dy));

    const updated = baseItems.map((i) =>
      i.item_id === itemId ? { ...i, x: newX, y: newY } : i
    );

    setManualPlacedItemsByStep((prev) => ({
      ...prev,
      [clampedStep]: updated,
    }));
  };

  // Đổi tọa độ trực tiếp từ input
  const handleDirectCoordChange = (itemId: string, newX: number, newY: number) => {
    const baseItems = manualPlacedItemsByStep[clampedStep] || activeState?.placed_items || [];
    const targetItem = baseItems.find((i) => i.item_id === itemId);
    if (!targetItem) return;

    const clampedX = Math.max(0, Math.min(bedLength - targetItem.length_cm, newX));
    const clampedY = Math.max(0, Math.min(bedWidth - targetItem.width_cm, newY));

    const updated = baseItems.map((i) =>
      i.item_id === itemId ? { ...i, x: clampedX, y: clampedY } : i
    );

    setManualPlacedItemsByStep((prev) => ({
      ...prev,
      [clampedStep]: updated,
    }));
  };

  // Căn sát các mép thùng xe
  const handleAlignItem = (itemId: string, align: 'cabin' | 'door' | 'top' | 'bottom') => {
    const baseItems = manualPlacedItemsByStep[clampedStep] || activeState?.placed_items || [];
    const targetItem = baseItems.find((i) => i.item_id === itemId);
    if (!targetItem) return;

    let newX = targetItem.x;
    let newY = targetItem.y;

    if (align === 'cabin') newX = 0;
    if (align === 'door') newX = Math.max(0, bedLength - targetItem.length_cm);
    if (align === 'top') newY = 0;
    if (align === 'bottom') newY = Math.max(0, bedWidth - targetItem.width_cm);

    const updated = baseItems.map((i) =>
      i.item_id === itemId ? { ...i, x: newX, y: newY } : i
    );

    setManualPlacedItemsByStep((prev) => ({
      ...prev,
      [clampedStep]: updated,
    }));
  };

  // Khôi phục về vị trí ban đầu của AI cho bước này
  const handleResetCurrentStep = () => {
    setManualPlacedItemsByStep((prev) => {
      const next = { ...prev };
      delete next[clampedStep];
      return next;
    });
  };

  // Khôi phục tất cả các bước về AI
  const handleResetAllSteps = () => {
    setManualPlacedItemsByStep({});
  };

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
          {hasAnyStepEdited && (
            <Tag color="purple" style={{ margin: 0, fontWeight: 600 }}>
              Mô phỏng thủ công
            </Tag>
          )}
          {hasAnyStepEdited && (
            <Tooltip title="Khôi phục toàn bộ các bước về phương án ban đầu của AI">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleResetAllSteps}
              >
                Khôi phục tất cả
              </Button>
            </Tooltip>
          )}
          {isValid && collisionInfo.pairs.length === 0 ? (
            <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
              Chuẩn T21–T27
            </Tag>
          ) : (
            <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ margin: 0 }}>
              {collisionInfo.pairs.length > 0
                ? `Va chạm (${collisionInfo.pairs.length})`
                : `Vi phạm (${violations.length})`}
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
                value={route.route_id}
                onChange={onSelectRoute}
                popupMatchSelectWidth={false}
                options={allRoutes.map((r, index) => ({
                  value: r.route_id,
                  label: (
                    <span>
                      <span
                        className="route-color-dot"
                        style={{
                          backgroundColor: ['#1677ff', '#52c41a', '#fa8c16', '#722ed1', '#eb2f96', '#13c2c2'][index % 6],
                        }}
                        aria-hidden="true"
                      />
                      Ngày {r.service_day_index + 1} · {r.plate_number} · {r.driver_name || 'Chưa có tài xế'}
                    </span>
                  ),
                }))}
              />
            ) : (
              <strong style={{ fontSize: 14, color: '#0f172a' }}>
                Ngày {route.service_day_index + 1} · {route.plate_number} · {route.driver_name || 'Chưa có tài xế'}
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
          style={{ marginBottom: 12 }}
        />
      )}

      {/* CẢNH BÁO VA CHẠM CHỒNG LẤN KHI MÔ PHỎNG THỦ CÔNG */}
      {collisionInfo.pairs.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined style={{ color: '#ef4444' }} />}
          message="Cảnh báo va chạm chồng lấn (Vi phạm Bất biến T21–T27: Không được xếp chồng hàng):"
          description={
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {collisionInfo.pairs.map((pair, idx) => (
                <div key={idx} style={{ marginBottom: 2 }}>
                  • Kiện <strong style={{ color: '#b91c1c' }}>{getItemShortLabel(pair.item1)}</strong> đang bị chồng lấn với kiện <strong style={{ color: '#b91c1c' }}>{getItemShortLabel(pair.item2)}</strong>
                </div>
              ))}
              <div style={{ marginTop: 4, color: '#475569' }}>
                💡 Hãy kéo thả tách các kiện hàng ra hoặc dùng bảng điều khiển bên dưới để di chuyển/xoay kiện về vị trí hợp lệ.
              </div>
            </div>
          }
          style={{ marginBottom: 12, border: '1px solid #fca5a5', backgroundColor: '#fef2f2' }}
        />
      )}

      {/* HƯỚNG DẪN KHI BẬT CHẾ ĐỘ DI CHUYỂN THỦ CÔNG */}
      {isManualMode && (
        <Alert
          type="info"
          showIcon
          message="Chế độ mô phỏng di chuyển kiện hàng thủ công đang BẬT"
          description={
            <span style={{ fontSize: 12 }}>
              Nhấn giữ chuột trái vào kiện trên sàn xe để <b>kéo thả (Drag & Drop)</b> đến vị trí mong muốn (tự động căn lưới 5cm và chặn mép thùng xe). Bạn cũng có thể click chọn kiện để xoay 90° hoặc nhập tọa độ cm chính xác. <i>(Mọi thay đổi chỉ là mô phỏng tạm thời trên giao diện, không lưu vào database).</i>
            </span>
          }
          style={{ marginBottom: 12, backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0' }}
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
          <Text type="secondary" style={{ maxWidth: 180, fontSize: 12 }} ellipsis>
            {activeState.action_description}
          </Text>

          {/* CÔNG TẮC BẬT/TẮT CHẾ ĐỘ DI CHUYỂN THỦ CÔNG */}
          <Button
            size="small"
            type={isManualMode ? 'primary' : 'default'}
            icon={<DragOutlined />}
            onClick={() => {
              setIsManualMode(!isManualMode);
              if (isPlaying) setIsPlaying(false);
            }}
            style={{
              fontWeight: 500,
              backgroundColor: isManualMode ? '#7c3aed' : undefined,
              borderColor: isManualMode ? '#6d28d2' : undefined,
            }}
          >
            {isManualMode ? 'Thoát di chuyển' : 'Di chuyển hàng thủ công'}
          </Button>

          {/* NÚT KHÔI PHỤC BƯỚC NÀY VỀ AI NẾU CÓ CHỈNH SỬA */}
          {isStepEdited && (
            <Tooltip title="Khôi phục vị trí các kiện ở bước này về phương án tính toán ban đầu của AI">
              <Button
                size="small"
                icon={<UndoOutlined />}
                danger
                onClick={handleResetCurrentStep}
              >
                Khôi phục bước (AI)
              </Button>
            </Tooltip>
          )}

          {isStepEdited && (
            <Tag color="purple" style={{ margin: 0, fontSize: 11 }}>
              Đã chỉnh sửa
            </Tag>
          )}
        </Space>

        <Space wrap size={8} align="center">
          <Tooltip title="Tỷ lệ diện tích sàn bị chiếm dụng">
            <span style={{ fontSize: 12, color: '#475569' }}>Sàn:</span>
            <Progress
              type="circle"
              percent={Number(dynamicAreaPercent.toFixed(0))}
              size={24}
              strokeColor={dynamicAreaPercent > 85 ? '#ef4444' : '#3b82f6'}
            />
          </Tooltip>

          <Tag color="cyan" style={{ margin: 0 }}>
            Kiện: <b>{currentPlacedItems.length}</b>
          </Tag>
          <Tag color="blue" style={{ margin: 0 }}>
            Tải: <b>{currentPlacedItems.reduce((s, i) => s + i.weight_kg, 0).toFixed(0)} kg</b>
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
                  color: clampedStep === 0 ? '#3b82f6' : clearCorridorCount === currentPlacedItems.length ? '#16a34a' : '#eab308',
                  fontSize: 13,
                }}
              />
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {clampedStep === 0
                ? '0 / 0 '
                : `${clearCorridorCount} / ${currentPlacedItems.length} `}
              <span style={{ fontSize: 12, fontWeight: 500 }}>kiện</span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: clampedStep === 0
                  ? '#3b82f6'
                  : clearCorridorCount === currentPlacedItems.length
                  ? '#16a34a'
                  : '#d97706',
              }}
            >
              {clampedStep === 0
                ? '✓ Sàn xe sẵn sàng'
                : clearCorridorCount === currentPlacedItems.length
                ? '✓ 100% thông thoáng'
                : `${currentPlacedItems.length - clearCorridorCount} kiện chờ dỡ sau`}
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
            Tất cả ({currentPlacedItems.length} kiện)
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
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${totalSvgWidth} ${totalSvgHeight}`}
          style={{ display: 'block', maxHeight: 380, userSelect: 'none' }}
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

            {/* Hiệu ứng phát sáng đỏ khi kiện bị va chạm chồng lấn */}
            <filter id="collidingGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#ef4444" floodOpacity="0.9" />
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
                const accessInfo = accessPathInfo.get(activeHighlightedItem.item_id);
                const isClear = accessInfo?.isClear === true;
                const polylinePoints = (accessInfo?.points || [])
                  .map((point) => (
                    `${(point.x + activeHighlightedItem.length_cm / 2) * scaleX},${
                      (point.y + activeHighlightedItem.width_cm / 2) * scaleY
                    }`
                  ))
                  .join(' ');

                return (
                  <g>
                    {isClear && accessInfo && accessInfo.points && accessInfo.points.length >= 2 ? (
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
                        {accessInfo.points.slice(1, -1).map((point, index) => (
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
            {currentPlacedItems.map((item) => {
              const rx = item.x * scaleX;
              const ry = item.y * scaleY;
              const rw = item.length_cm * scaleX;
              const rh = item.width_cm * scaleY;
              const colorInfo = getItemColor(item);
              const isHovered = hoveredItemId === item.item_id;
              const isSelected = selectedItemId === item.item_id;
              const isClear = isPathToDoorClear(item);
              const isColliding = collisionInfo.collidingIds.has(item.item_id);
              const isDragging = draggingState?.itemId === item.item_id;
              const label = getItemShortLabel(item);

              // Xử lý làm mờ nếu đang lọc theo đơn hàng khác
              const orderKey = item.order_id || item.item_id.split('#')[0] || 'DEFAULT';
              const isDimmed = selectedOrderFilter !== null && orderKey !== selectedOrderFilter;

              return (
                <g
                  key={item.item_id}
                  style={{
                    cursor: isManualMode ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
                    transition: isDragging ? 'none' : 'opacity 0.2s ease',
                  }}
                  opacity={isDimmed ? 0.25 : 1}
                  onMouseEnter={() => setHoveredItemId(item.item_id)}
                  onMouseLeave={() => setHoveredItemId(null)}
                  onMouseDown={(e) => handleMouseDownItem(e, item)}
                  onClick={() => {
                    if (!draggingState) {
                      setSelectedItemId(isSelected ? null : item.item_id);
                    }
                  }}
                >
                  {/* Tooltip gốc SVG hiển thị kích thước và khối lượng khi rê chuột */}
                  <title>{`Kiện: ${label} (Đơn ${item.order_id ? item.order_id.slice(-6).toUpperCase() : 'N/A'})\nKích thước: ${item.length_cm} × ${item.width_cm} × ${item.height_cm || 40} cm\nKhối lượng: ${item.weight_kg.toFixed(1)} kg\nTọa độ: x=${item.x}cm, y=${item.y}cm${isColliding ? '\n⚠️ Đang bị chồng lấn!' : ''}`}</title>
                  {/* Khối kiện hàng */}
                  <rect
                    x={rx}
                    y={ry}
                    width={rw}
                    height={rh}
                    rx="4"
                    ry="4"
                    fill={isColliding ? '#b91c1c' : colorInfo.bg}
                    fillOpacity={isColliding ? 0.95 : isHovered || isSelected ? 1.0 : 0.9}
                    stroke={isColliding ? '#fca5a5' : isSelected ? '#ffffff' : isHovered ? '#67e8f9' : colorInfo.border}
                    strokeWidth={isColliding ? 2.5 : isSelected ? 3 : isHovered ? 2 : 1}
                    strokeDasharray={isColliding ? '5 3' : undefined}
                    filter={isColliding ? 'url(#collidingGlow)' : isSelected ? 'url(#glowEffect)' : 'url(#boxShadow)'}
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

                  {/* Huy hiệu cảnh báo va chạm chồng lấn (icon đỏ) */}
                  {isColliding && rw >= 24 && (
                    <g transform={`translate(${rx + 3}, ${ry + 3})`} pointerEvents="none">
                      <circle cx="5" cy="5" r="5" fill="#ef4444" stroke="#ffffff" strokeWidth="1" />
                      <text x="5" y="8" fill="#ffffff" fontSize="8" fontWeight="bold" textAnchor="middle">
                        !
                      </text>
                    </g>
                  )}

                  {/* Nhãn hiển thị tọa độ bay khi đang kéo hoặc được chọn trong chế độ thủ công */}
                  {(isDragging || (isManualMode && isSelected)) && (
                    <g transform={`translate(${rx + rw / 2}, ${Math.max(12, ry - 6)})`} pointerEvents="none">
                      <rect
                        x="-38"
                        y="-14"
                        width="76"
                        height="16"
                        rx="4"
                        fill="rgba(15, 23, 42, 0.95)"
                        stroke={isColliding ? '#ef4444' : '#38bdf8'}
                        strokeWidth="1"
                      />
                      <text
                        x="0"
                        y="-3"
                        fill={isColliding ? '#fca5a5' : '#38bdf8'}
                        fontSize="9"
                        fontWeight="bold"
                        textAnchor="middle"
                        fontFamily="monospace"
                      >
                        {item.x}, {item.y} cm
                      </text>
                    </g>
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
          {isManualMode && (
            <span style={{ color: '#a78bfa', fontWeight: 600 }}>
              <DragOutlined style={{ marginRight: 4 }} /> Kéo thả chuột để di chuyển
            </span>
          )}
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
      {/* 2.5. BẢNG ĐIỀU KHIỂN NHANH KIỆN HÀNG ĐANG CHỌN (QUICK PANEL) */}
      {/* ============================================================ */}
      {(() => {
        const selectedItem = currentPlacedItems.find((i) => i.item_id === selectedItemId);
        if (!selectedItem) return null;
        const isColliding = collisionInfo.collidingIds.has(selectedItem.item_id);
        const isClear = isPathToDoorClear(selectedItem);
        const blockers = getBlockingItems(selectedItem);

        return (
          <div
            style={{
              marginTop: 10,
              padding: '10px 14px',
              backgroundColor: '#f8fafc',
              border: isColliding ? '1.5px solid #f87171' : '1px solid #cbd5e1',
              borderRadius: 8,
              boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
              transition: 'all 0.2s ease',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <Space size={8} wrap align="center">
                <span
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: getItemColor(selectedItem).bg,
                  }}
                />
                <strong style={{ fontSize: 13, color: '#0f172a' }}>
                  Đang chọn kiện: {getItemShortLabel(selectedItem)}
                </strong>
                <span style={{ fontSize: 12, color: '#475569' }}>
                  ({selectedItem.length_cm} × {selectedItem.width_cm} × {selectedItem.height_cm || 40} cm · {selectedItem.weight_kg} kg)
                </span>
                {isColliding ? (
                  <Tag color="error" icon={<ExclamationCircleOutlined />} style={{ margin: 0 }}>
                    Chồng lấn!
                  </Tag>
                ) : (
                  <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
                    {isStepEdited ? 'Không chồng lấn cục bộ' : 'Backend xác nhận hợp lệ'}
                  </Tag>
                )}
                {isClear ? (
                  <Tag color="success" style={{ margin: 0 }}>
                    {isStepEdited ? 'Ước tính: lối thẳng không bị chắn' : '✓ Backend xác nhận lối dỡ'}
                  </Tag>
                ) : (
                  <Tooltip title={`Bị chắn bởi: ${blockers.map((b) => getItemShortLabel(b)).join(', ')}`}>
                    <Tag color="warning" style={{ margin: 0 }}>
                      {isStepEdited ? 'Ước tính: ' : 'Backend: '}bị chắn ({blockers.length} kiện)
                    </Tag>
                  </Tooltip>
                )}
              </Space>

              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={() => setSelectedItemId(null)}
              >
                Bỏ chọn
              </Button>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10,
                paddingTop: 8,
                borderTop: '1px dashed #e2e8f0',
              }}
            >
              {/* Nhóm điều khiển vị trí & xoay */}
              <Space size={8} wrap align="center">
                <Tooltip title="Xoay 90° (hoán đổi Chiều Dài ↔ Chiều Rộng)">
                  <Button
                    size="small"
                    type="primary"
                    icon={<RotateRightOutlined />}
                    onClick={() => handleRotateItem(selectedItem.item_id)}
                    style={{ backgroundColor: '#2563eb' }}
                  >
                    Xoay 90° ({selectedItem.width_cm}×{selectedItem.length_cm})
                  </Button>
                </Tooltip>

                <span style={{ fontSize: 12, color: '#64748b', marginLeft: 4 }}>Dịch chuyển:</span>
                <Button.Group size="small">
                  <Tooltip title="Dịch sang trái 5cm (về phía Cabin X=0)">
                    <Button
                      icon={<ArrowLeftOutlined />}
                      onClick={() => handleNudgeItem(selectedItem.item_id, -5, 0)}
                    >
                      -5cm
                    </Button>
                  </Tooltip>
                  <Tooltip title="Dịch sang phải 5cm (về phía Cửa sau)">
                    <Button
                      icon={<ArrowRightOutlined />}
                      onClick={() => handleNudgeItem(selectedItem.item_id, 5, 0)}
                    >
                      +5cm
                    </Button>
                  </Tooltip>
                  <Tooltip title="Dịch lên trên 5cm (về vách Y=0)">
                    <Button
                      icon={<ArrowUpOutlined />}
                      onClick={() => handleNudgeItem(selectedItem.item_id, 0, -5)}
                    >
                      ↑5cm
                    </Button>
                  </Tooltip>
                  <Tooltip title="Dịch xuống dưới 5cm (về vách dưới)">
                    <Button
                      icon={<ArrowDownOutlined />}
                      onClick={() => handleNudgeItem(selectedItem.item_id, 0, 5)}
                    >
                      ↓5cm
                    </Button>
                  </Tooltip>
                </Button.Group>

                <span style={{ fontSize: 12, color: '#64748b', marginLeft: 4 }}>Neo nhanh:</span>
                <Button.Group size="small">
                  <Button onClick={() => handleAlignItem(selectedItem.item_id, 'cabin')}>Sát Cabin</Button>
                  <Button onClick={() => handleAlignItem(selectedItem.item_id, 'door')}>Sát Cửa sau</Button>
                  <Button onClick={() => handleAlignItem(selectedItem.item_id, 'top')}>Mép trên</Button>
                  <Button onClick={() => handleAlignItem(selectedItem.item_id, 'bottom')}>Mép dưới</Button>
                </Button.Group>
              </Space>

              {/* Ô nhập tọa độ chính xác X, Y */}
              <Space size={6} align="center">
                <span style={{ fontSize: 12, color: '#334155', fontWeight: 500 }}>Tọa độ cm:</span>
                <span style={{ fontSize: 12, color: '#64748b' }}>X=</span>
                <InputNumber
                  size="small"
                  min={0}
                  max={bedLength - selectedItem.length_cm}
                  value={selectedItem.x}
                  onChange={(val) => handleDirectCoordChange(selectedItem.item_id, val ?? 0, selectedItem.y)}
                  style={{ width: 68 }}
                />
                <span style={{ fontSize: 12, color: '#64748b' }}>Y=</span>
                <InputNumber
                  size="small"
                  min={0}
                  max={bedWidth - selectedItem.width_cm}
                  value={selectedItem.y}
                  onChange={(val) => handleDirectCoordChange(selectedItem.item_id, selectedItem.x, val ?? 0)}
                  style={{ width: 68 }}
                />
              </Space>
            </div>
          </div>
        );
      })()}

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
              Thông tin kiện hàng trên xe ({currentPlacedItems.length} kiện)
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
                            width: 120,
                            render: (_, it) => (
                              <Space size={6} wrap>
                                <strong style={{ color: '#1e40af' }}>{getItemShortLabel(it)}</strong>
                                {selectedItemId === it.item_id && <Badge status="processing" />}
                                {collisionInfo.collidingIds.has(it.item_id) && (
                                  <Tag color="error" style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>
                                    Chồng lấn
                                  </Tag>
                                )}
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
                            title: 'Thao tác',
                            key: 'action',
                            align: 'center',
                            width: 90,
                            render: (_, it) => (
                              <Space size={4}>
                                {isManualMode && (
                                  <Tooltip title="Xoay 90° kiện này">
                                    <Button
                                      size="small"
                                      icon={<RotateRightOutlined />}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRotateItem(it.item_id);
                                      }}
                                    />
                                  </Tooltip>
                                )}
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
                              </Space>
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
