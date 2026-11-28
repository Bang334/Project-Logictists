import React, { useMemo, useRef, useState } from 'react';
import { Button, Slider, Space, Tag, Tooltip } from 'antd';
import {
  CompassOutlined,
  ExpandOutlined,
  ReloadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import type { PackageAccessPathUI, PlacedItemUI } from '../types';
import {
  buildSortedBoxes3D,
  CAMERA_3D_PRESETS,
  computeCargoStackingMetrics,
  createProjectionContext,
  formatKgVi,
  getVisibleBoxFaces,
  projectPoint3D,
  type Camera3DPresetKey,
  type Camera3DState,
} from '../utils/cargo3d';
import { computeWeightBalance, getWeightBalanceMeta } from '../utils/weightBalance';

interface ItemColorStyle {
  bg: string;
  border?: string;
}

export interface Cargo3DVisualizerProps {
  lengthCm: number;
  widthCm: number;
  heightCm?: number;
  items: PlacedItemUI[];
  maxTopLoadPercent?: number;
  accessPaths?: PackageAccessPathUI[];
  showingUnload?: boolean;
  nextUnloadId?: string | null;
  hoveredItemId?: string | null;
  selectedItemId?: string | null;
  collidingIds?: Set<string>;
  getItemColor: (item: PlacedItemUI) => ItemColorStyle;
  getItemShortLabel: (item: PlacedItemUI) => string;
  isPathToDoorClear: (item: PlacedItemUI) => boolean;
  onHoverItem?: (itemId: string | null) => void;
  onSelectItem?: (itemId: string | null) => void;
}

const VIEW_W = 720;
const VIEW_H = 440;

function adjustHexBrightness(hex: string, factor: number): string {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return hex;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(0, 2), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(2, 4), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(4, 6), 16) * factor)));
  return `rgb(${r}, ${g}, ${b})`;
}

export const Cargo3DVisualizer: React.FC<Cargo3DVisualizerProps> = ({
  lengthCm,
  widthCm,
  heightCm,
  items,
  maxTopLoadPercent = 30,
  accessPaths,
  showingUnload = false,
  nextUnloadId = null,
  hoveredItemId = null,
  selectedItemId = null,
  collidingIds = new Set<string>(),
  getItemColor,
  getItemShortLabel,
  isPathToDoorClear,
  onHoverItem,
  onSelectItem,
}) => {
  const [presetKey, setPresetKey] = useState<Camera3DPresetKey | 'custom'>('iso');
  const [camera, setCamera] = useState<Camera3DState>(CAMERA_3D_PRESETS.iso.camera);
  const [explodeGapCm, setExplodeGapCm] = useState<number>(0);
  const [activeTierFilter, setActiveTierFilter] = useState<number | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number; az: number; el: number; moved: boolean } | null>(null);

  const maxStackTopCm = useMemo(
    () =>
      items.reduce(
        (acc, item) => Math.max(acc, (item.z ?? 0) + (item.height_cm || 35)),
        0,
      ),
    [items],
  );
  const effectiveHeightCm = heightCm && heightCm > 0 ? heightCm : Math.max(180, maxStackTopCm + 30);

  const stackingMetrics = useMemo(
    () => computeCargoStackingMetrics(items, maxTopLoadPercent),
    [items, maxTopLoadPercent],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.item_id, item])), [items]);
  const distinctTiers = stackingMetrics.maxTierCount;

  const maxVisualExtraCm = Math.max(0, distinctTiers - 1) * explodeGapCm;
  const ctx = useMemo(
    () =>
      createProjectionContext(
        { lengthCm, widthCm, heightCm: effectiveHeightCm },
        camera,
        VIEW_W,
        VIEW_H,
        maxVisualExtraCm * 0.5,
      ),
    [lengthCm, widthCm, effectiveHeightCm, camera, maxVisualExtraCm],
  );

  const sortedBoxes = useMemo(
    () => buildSortedBoxes3D(items, ctx, explodeGapCm),
    [items, ctx, explodeGapCm],
  );

  const boxById = useMemo(
    () => new Map(sortedBoxes.map((b) => [b.item.item_id, b])),
    [sortedBoxes],
  );

  const accessPathById = useMemo(() => {
    const map = new Map<string, PackageAccessPathUI>();
    (accessPaths || []).forEach((p) => map.set(p.item_id, p));
    return map;
  }, [accessPaths]);

  const weightBalance = useMemo(
    () => computeWeightBalance(items, lengthCm, widthCm),
    [items, lengthCm, widthCm],
  );
  const weightBalanceMeta = getWeightBalanceMeta(weightBalance.status);

  const focusItemId =
    selectedItemId || hoveredItemId || (showingUnload && nextUnloadId ? nextUnloadId : null);
  const focusBox = focusItemId ? boxById.get(focusItemId) || null : null;
  const focusAccessPath = focusItemId ? accessPathById.get(focusItemId) : undefined;
  const blockerSet = useMemo(
    () => new Set(focusAccessPath?.blocker_item_ids || []),
    [focusAccessPath],
  );

  const proj = (x: number, y: number, z: number) => {
    const pt = projectPoint3D(ctx, { x, y, z }, maxVisualExtraCm * 0.5);
    return `${pt.sx.toFixed(1)},${pt.sy.toFixed(1)}`;
  };

  const floorGridLines = useMemo(() => {
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const step = 50;
    for (let x = step; x < lengthCm; x += step) {
      const a = projectPoint3D(ctx, { x, y: 0, z: 0 }, maxVisualExtraCm * 0.5);
      const b = projectPoint3D(ctx, { x, y: widthCm, z: 0 }, maxVisualExtraCm * 0.5);
      lines.push({ x1: a.sx, y1: a.sy, x2: b.sx, y2: b.sy });
    }
    for (let y = step; y < widthCm; y += step) {
      const a = projectPoint3D(ctx, { x: 0, y, z: 0 }, maxVisualExtraCm * 0.5);
      const b = projectPoint3D(ctx, { x: lengthCm, y, z: 0 }, maxVisualExtraCm * 0.5);
      lines.push({ x1: a.sx, y1: a.sy, x2: b.sx, y2: b.sy });
    }
    return lines;
  }, [ctx, lengthCm, widthCm, maxVisualExtraCm]);

  const cabinLabelPt = projectPoint3D(
    ctx,
    { x: 0, y: widthCm / 2, z: effectiveHeightCm * 0.52 },
    maxVisualExtraCm * 0.5,
  );
  const doorLabelPt = projectPoint3D(
    ctx,
    { x: lengthCm + 18, y: widthCm / 2, z: 12 },
    maxVisualExtraCm * 0.5,
  );
  const doorArrowStart = projectPoint3D(
    ctx,
    { x: lengthCm, y: widthCm / 2, z: 4 },
    maxVisualExtraCm * 0.5,
  );
  const doorArrowEnd = projectPoint3D(
    ctx,
    { x: lengthCm + 38, y: widthCm / 2, z: 4 },
    maxVisualExtraCm * 0.5,
  );

  const handleSelectPreset = (key: Camera3DPresetKey) => {
    setPresetKey(key);
    setCamera(CAMERA_3D_PRESETS[key].camera);
  };

  const handleZoom = (delta: number) => {
    setCamera((prev) => ({
      ...prev,
      zoom: Math.max(0.65, Math.min(2.1, Number((prev.zoom + delta).toFixed(2)))),
    }));
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      az: camera.azimuthDeg,
      el: camera.elevationDeg,
      moved: false,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      origin.moved = true;
    }
    setPresetKey('custom');
    setCamera((prev) => ({
      ...prev,
      azimuthDeg: origin.az - dx * 0.45,
      elevationDeg: Math.max(2, Math.min(89, origin.el + dy * 0.45)),
    }));
  };

  const handleMouseUp = () => {
    if (dragOriginRef.current && !dragOriginRef.current.moved) {
      onSelectItem?.(null);
    }
    dragOriginRef.current = null;
  };

  const renderFocusPath = () => {
    if (!focusBox) return null;
    const pathPts = focusAccessPath?.points || [];
    const clear = isPathToDoorClear(focusBox.item);
    const stroke = clear ? '#22c55e' : '#ef4444';
    const boxHalfL = focusBox.item.length_cm / 2;
    const boxHalfW = focusBox.item.width_cm / 2;
    const boxHalfH = (focusBox.item.height_cm || 35) / 2;
    const explodeOffset = (focusBox.tierIndex - 1) * explodeGapCm;

    const worldPoints =
      pathPts.length >= 2
        ? pathPts.map((pt) => ({
            x: pt.x + boxHalfL,
            y: pt.y + boxHalfW,
            z: (pt.z ?? focusBox.actualZ) + explodeOffset + boxHalfH,
          }))
        : [
            {
              x: (focusBox.x0 + focusBox.x1) / 2,
              y: (focusBox.y0 + focusBox.y1) / 2,
              z: (focusBox.z0 + focusBox.z1) / 2,
            },
            {
              x: lengthCm + 24,
              y: (focusBox.y0 + focusBox.y1) / 2,
              z: (focusBox.z0 + focusBox.z1) / 2,
            },
          ];

    const screenPts = worldPoints.map((pt) =>
      projectPoint3D(ctx, pt, maxVisualExtraCm * 0.5),
    );
    const polyStr = screenPts.map((pt) => `${pt.sx.toFixed(1)},${pt.sy.toFixed(1)}`).join(' ');
    const last = screenPts[screenPts.length - 1];

    return (
      <g pointerEvents="none">
        <polyline
          points={polyStr}
          fill="none"
          stroke={stroke}
          strokeWidth={3}
          strokeDasharray={clear ? '6,4' : '4,4'}
          strokeLinecap="round"
        />
        <circle cx={last.sx} cy={last.sy} r={5} fill={stroke} stroke="#0f172a" strokeWidth={1.5} />
      </g>
    );
  };

  const ceilZ = effectiveHeightCm + maxVisualExtraCm;

  return (
    <div data-testid="cargo-3d-visualizer">
      {/* Thanh điều khiển góc nhìn 3D & Tách tầng */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 6,
          marginBottom: 8,
          padding: '6px 10px',
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
        }}
      >
        <Space size={4} wrap align="center">
          <CompassOutlined style={{ color: '#0284c7' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>Góc camera 3D:</span>
          {(Object.keys(CAMERA_3D_PRESETS) as Camera3DPresetKey[]).map((key) => (
            <Button
              key={key}
              size="small"
              type={presetKey === key ? 'primary' : 'default'}
              onClick={() => handleSelectPreset(key)}
            >
              {CAMERA_3D_PRESETS[key].label}
            </Button>
          ))}
        </Space>

        <Space size={8} wrap align="center">
          <Space size={4} align="center">
            <ExpandOutlined style={{ color: '#7c3aed', fontSize: 12 }} />
            <span style={{ fontSize: 12, color: '#334155', fontWeight: 500 }}>
              Tách tầng Z:
            </span>
            <Slider
              aria-label="Tách tầng Z"
              min={0}
              max={45}
              step={5}
              value={explodeGapCm}
              onChange={(val) => setExplodeGapCm(val)}
              style={{ width: 78, margin: '0 4px' }}
              tooltip={{ formatter: (v) => `+${v} cm mỗi tầng` }}
            />
            <span style={{ fontSize: 11, color: '#64748b', minWidth: 34 }}>+{explodeGapCm}cm</span>
          </Space>

          {distinctTiers > 1 && (
            <Space size={4}>
              <Button
                size="small"
                type={activeTierFilter === null ? 'primary' : 'default'}
                onClick={() => setActiveTierFilter(null)}
              >
                Mọi tầng
              </Button>
              {Array.from({ length: distinctTiers }, (_, i) => i + 1).map((tier) => (
                <Button
                  key={tier}
                  size="small"
                  type={activeTierFilter === tier ? 'primary' : 'default'}
                  onClick={() => setActiveTierFilter((prev) => (prev === tier ? null : tier))}
                >
                  T{tier}
                </Button>
              ))}
            </Space>
          )}

          <Space.Compact size="small">
            <Tooltip title="Phóng to">
              <Button icon={<ZoomInOutlined />} onClick={() => handleZoom(0.15)} />
            </Tooltip>
            <Tooltip title="Thu nhỏ">
              <Button icon={<ZoomOutOutlined />} onClick={() => handleZoom(-0.15)} />
            </Tooltip>
            <Tooltip title="Đặt lại góc mặc định">
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setExplodeGapCm(0);
                  setActiveTierFilter(null);
                  handleSelectPreset('iso');
                }}
              />
            </Tooltip>
          </Space.Compact>
        </Space>
      </div>

      {/* Khung vẽ SVG 3D Container + Khối hàng */}
      <div
        style={{
          position: 'relative',
          backgroundColor: '#0f172a',
          borderRadius: 10,
          border: '1px solid #334155',
          overflow: 'hidden',
          boxShadow: 'inset 0 2px 12px rgba(0,0,0,0.45)',
        }}
      >
        <svg
          width="100%"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            aspectRatio: `${VIEW_W} / ${VIEW_H}`,
            maxHeight: 460,
            cursor: dragOriginRef.current ? 'grabbing' : 'grab',
            userSelect: 'none',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            dragOriginRef.current = null;
          }}
          onWheel={(e) => {
            e.preventDefault();
            handleZoom(e.deltaY < 0 ? 0.1 : -0.1);
          }}
        >
          {/* Sàn thùng xe (Z = 0) */}
          <polygon
            points={[
              proj(0, 0, 0),
              proj(lengthCm, 0, 0),
              proj(lengthCm, widthCm, 0),
              proj(0, widthCm, 0),
            ].join(' ')}
            fill="#1e293b"
            stroke="#475569"
            strokeWidth={1.5}
          />

          {/* Lưới 50cm trên sàn */}
          {floorGridLines.map((ln, idx) => (
            <line
              key={idx}
              x1={ln.x1}
              y1={ln.y1}
              x2={ln.x2}
              y2={ln.y2}
              stroke="#334155"
              strokeWidth={0.8}
              strokeDasharray="3,3"
            />
          ))}

          {/* Vách đầu Cabin (X = 0) */}
          <polygon
            points={[
              proj(0, 0, 0),
              proj(0, widthCm, 0),
              proj(0, widthCm, ceilZ),
              proj(0, 0, ceilZ),
            ].join(' ')}
            fill="rgba(30, 58, 138, 0.22)"
            stroke="#3b82f6"
            strokeWidth={1.2}
          />

          {/* Mũi tên cửa sau bốc dỡ (X = lengthCm) */}
          <line
            x1={doorArrowStart.sx}
            y1={doorArrowStart.sy}
            x2={doorArrowEnd.sx}
            y2={doorArrowEnd.sy}
            stroke="#22c55e"
            strokeWidth={3}
          />
          <polygon
            points={[
              proj(lengthCm, 0, 0),
              proj(lengthCm, widthCm, 0),
              proj(lengthCm + 14, widthCm, 0),
              proj(lengthCm + 14, 0, 0),
            ].join(' ')}
            fill="rgba(245, 158, 11, 0.28)"
            stroke="#f59e0b"
            strokeWidth={1.2}
          />

          {/* Khung trần xe (Wireframe Z = heightCm) */}
          <polygon
            points={[
              proj(0, 0, ceilZ),
              proj(lengthCm, 0, ceilZ),
              proj(lengthCm, widthCm, ceilZ),
              proj(0, widthCm, ceilZ),
            ].join(' ')}
            fill="none"
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="5,4"
          />
          {[
            [0, 0],
            [lengthCm, 0],
            [lengthCm, widthCm],
            [0, widthCm],
          ].map(([cx, cy], idx) => {
            const bot = projectPoint3D(ctx, { x: cx, y: cy, z: 0 }, maxVisualExtraCm * 0.5);
            const top = projectPoint3D(ctx, { x: cx, y: cy, z: ceilZ }, maxVisualExtraCm * 0.5);
            return (
              <line
                key={idx}
                x1={bot.sx}
                y1={bot.sy}
                x2={top.sx}
                y2={top.sy}
                stroke={cx === lengthCm ? '#f59e0b' : '#475569'}
                strokeWidth={1}
                strokeDasharray="4,4"
                opacity={0.75}
              />
            );
          })}

          {/* Nhãn Cabin & Cửa sau */}
          <text
            x={cabinLabelPt.sx}
            y={cabinLabelPt.sy}
            fill="#93c5fd"
            fontSize={11}
            fontWeight="700"
            textAnchor="middle"
            pointerEvents="none"
          >
            CABIN (X=0)
          </text>
          <text
            x={doorLabelPt.sx}
            y={doorLabelPt.sy}
            fill="#34d399"
            fontSize={11}
            fontWeight="700"
            textAnchor="middle"
            pointerEvents="none"
          >
            CỬA SAU (+X) →
          </text>

          {/* Đường liên kết support khi tách tầng */}
          {explodeGapCm > 0 &&
            sortedBoxes.map((box) => {
              const supportId = stackingMetrics.byId.get(box.item.item_id)?.supportItemId;
              if (!supportId) return null;
              const sup = boxById.get(supportId);
              if (!sup) return null;
              const topCenter = projectPoint3D(
                ctx,
                {
                  x: (sup.x0 + sup.x1) / 2,
                  y: (sup.y0 + sup.y1) / 2,
                  z: sup.z1,
                },
                maxVisualExtraCm * 0.5,
              );
              const upperCenter = projectPoint3D(
                ctx,
                {
                  x: (box.x0 + box.x1) / 2,
                  y: (box.y0 + box.y1) / 2,
                  z: box.z0,
                },
                maxVisualExtraCm * 0.5,
              );
              return (
                <line
                  key={`link-${box.item.item_id}`}
                  x1={topCenter.sx}
                  y1={topCenter.sy}
                  x2={upperCenter.sx}
                  y2={upperCenter.sy}
                  stroke="#a78bfa"
                  strokeWidth={1.5}
                  strokeDasharray="3,3"
                  pointerEvents="none"
                />
              );
            })}

          {/* Vẽ các kiện hàng theo Painter's sort */}
          {sortedBoxes.map((box) => {
            const { item } = box;
            const color = getItemColor(item);
            const isSelected = selectedItemId === item.item_id;
            const isHovered = hoveredItemId === item.item_id;
            const isNext = showingUnload && nextUnloadId === item.item_id;
            const isBlocker = blockerSet.has(item.item_id);
            const isColliding = collidingIds.has(item.item_id);
            const dimmed = activeTierFilter !== null && box.tierIndex !== activeTierFilter;

            const faces = getVisibleBoxFaces(box, ctx, maxVisualExtraCm * 0.5);
            const topCenter = projectPoint3D(
              ctx,
              {
                x: (box.x0 + box.x1) / 2,
                y: (box.y0 + box.y1) / 2,
                z: box.z1,
              },
              maxVisualExtraCm * 0.5,
            );

            const strokeColor = isColliding
              ? '#ef4444'
              : isNext
              ? '#22c55e'
              : isBlocker
              ? '#f97316'
              : isSelected
              ? '#38bdf8'
              : isHovered
              ? '#facc15'
              : '#0f172a';
            const strokeWidth = isSelected || isNext || isColliding || isBlocker ? 2.4 : 1.1;

            const getShadeFill = (shade: string) => {
              if (isColliding) return shade === 'bright' ? '#ef4444' : '#b91c1c';
              if (shade === 'bright') return adjustHexBrightness(color.bg, 1.14);
              if (shade === 'side') return adjustHexBrightness(color.bg, 0.9);
              if (shade === 'mid') return adjustHexBrightness(color.bg, 0.78);
              return adjustHexBrightness(color.bg, 0.65);
            };

            const shortLabel = getItemShortLabel(item);
            const metrics = stackingMetrics.byId.get(item.item_id);
            const supportItem = metrics?.supportItemId
              ? itemById.get(metrics.supportItemId)
              : undefined;
            const loadSummary =
              metrics && metrics.maxTopLoadKg > 0
                ? `${formatKgVi(metrics.aboveWeightKg)} / tối đa ${formatKgVi(metrics.maxTopLoadKg)} kg (${metrics.loadPercentOfOwnWeight}% / ngưỡng ${maxTopLoadPercent}%)`
                : 'Không cho đặt đè phía trên';

            return (
              <g
                key={item.item_id}
                opacity={dimmed ? 0.22 : 1}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => onHoverItem?.(item.item_id)}
                onMouseLeave={() => onHoverItem?.(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectItem?.(isSelected ? null : item.item_id);
                }}
              >
                <title>
                  {[
                    `Kiện: ${shortLabel} (Tầng T${box.tierIndex})`,
                    `Cân nặng: ${formatKgVi(item.weight_kg)} kg`,
                    `Đang tải phía trên: ${loadSummary}`,
                    `Đặt trên: ${
                      supportItem
                        ? `${getItemShortLabel(supportItem)} (${formatKgVi(supportItem.weight_kg)} kg)`
                        : 'Sàn thùng xe'
                    }`,
                    `Kích thước: ${item.length_cm} × ${item.width_cm} × ${item.height_cm || 35} cm`,
                    `Cao độ Z: ${Math.round(box.actualZ)} → ${Math.round(
                      box.actualZ + (item.height_cm || 35),
                    )} cm`,
                    ...(item.cargo_kind === 'FRAGILE' ? ['Hàng dễ vỡ'] : []),
                    ...(item.no_top_load_requested ? ['Không đặt đè'] : []),
                    ...(item.floor_rotation_locked ? ['Khóa xoay 90° (LWH)'] : []),
                    isPathToDoorClear(item) ? 'Lối dỡ thông suốt' : 'Đang bị chắn lối dỡ',
                  ].join(' | ')}
                </title>
                {faces.map((face) => (
                  <polygon
                    key={face.key}
                    points={face.points}
                    fill={getShadeFill(face.shade)}
                    fillOpacity={isNext || isSelected ? 0.96 : 0.9}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeLinejoin="round"
                  />
                ))}

                {/* Nhãn kiện + tầng */}
                <text
                  x={topCenter.sx}
                  y={topCenter.sy + 3}
                  fill="#ffffff"
                  fontSize={10.5}
                  fontWeight="700"
                  textAnchor="middle"
                  pointerEvents="none"
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.85)' }}
                >
                  {getItemShortLabel(item)} · T{box.tierIndex}
                </text>
              </g>
            );
          })}

          {/* Quỹ đạo dỡ hàng 3D */}
          {renderFocusPath()}

          {/* Tâm trọng lượng (CG) trên mặt sàn 3D */}
          {items.length > 0 && (() => {
            const cgPt = projectPoint3D(ctx, {
              x: weightBalance.cg_x_cm,
              y: weightBalance.cg_y_cm,
              z: 0,
            });
            return (
              <g pointerEvents="none" data-testid="cargo-3d-cg">
                <circle
                  cx={cgPt.sx}
                  cy={cgPt.sy}
                  r={7}
                  fill="rgba(255,255,255,0.88)"
                  stroke={weightBalanceMeta.strokeColor}
                  strokeWidth={2.5}
                />
                <circle cx={cgPt.sx} cy={cgPt.sy} r={2.5} fill={weightBalanceMeta.strokeColor} />
              </g>
            );
          })()}
        </svg>

        {/* HUD thông tin nhanh góc trên trái & dưới phải */}
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 10,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            pointerEvents: 'none',
          }}
        >
          <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>
            Thùng: {lengthCm}×{widthCm}×{Math.round(effectiveHeightCm)} cm
            {!heightCm ? ' (mặc định C)' : ''}
          </Tag>
          {items.length === 0 && (
            <Tag color="default" style={{ margin: 0, fontSize: 11 }}>
              Thùng xe đang rỗng
            </Tag>
          )}
          {items.length > 0 && (
            <Tag color={weightBalanceMeta.tagColor} style={{ margin: 0, fontSize: 11 }}>
              Trọng tâm: {weightBalanceMeta.label} ({weightBalance.lateral_imbalance_percent}%)
            </Tag>
          )}
          {distinctTiers > 1 && (
            <Tag color="purple" style={{ margin: 0, fontSize: 11 }}>
              {distinctTiers} tầng · Cao đỉnh {Math.round(maxStackTopCm)} cm
            </Tag>
          )}
          {focusBox && (() => {
            const focusMetrics = stackingMetrics.byId.get(focusBox.item.item_id);
            const focusSupportItem = focusMetrics?.supportItemId
              ? itemById.get(focusMetrics.supportItemId)
              : undefined;
            const loadHudText =
              focusMetrics && focusMetrics.maxTopLoadKg > 0
                ? `Đè trên: ${formatKgVi(focusMetrics.aboveWeightKg)}/${formatKgVi(focusMetrics.maxTopLoadKg)} kg (${focusMetrics.loadPercentOfOwnWeight}%)`
                : 'Không đặt đè lên trên';
            const supportHudText = focusSupportItem
              ? `Trên ${getItemShortLabel(focusSupportItem)} (${formatKgVi(focusSupportItem.weight_kg)} kg)`
              : 'Trên sàn';

            return (
              <>
                <Tag
                  color={isPathToDoorClear(focusBox.item) ? 'success' : 'error'}
                  style={{ margin: 0, fontSize: 11, whiteSpace: 'normal' }}
                >
                  {getItemShortLabel(focusBox.item)} · T{focusBox.tierIndex} · Nặng {formatKgVi(focusBox.item.weight_kg)} kg · {loadHudText} · {supportHudText}
                </Tag>
                {focusBox.item.cargo_kind === 'FRAGILE' && (
                  <Tag color="gold" style={{ margin: 0, fontSize: 11 }}>Dễ vỡ</Tag>
                )}
                {focusBox.item.no_top_load_requested && (
                  <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>Cấm đè</Tag>
                )}
                {focusBox.item.floor_rotation_locked && (
                  <Tag color="purple" style={{ margin: 0, fontSize: 11 }}>Khóa xoay 90°</Tag>
                )}
              </>
            );
          })()}
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 10,
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            color: '#94a3b8',
            pointerEvents: 'none',
          }}
        >
          Kéo chuột xoay 3D · Cuộn để thu phóng · Click kiện ở mọi tầng để xem đường dỡ
        </div>
      </div>
    </div>
  );
};

export default Cargo3DVisualizer;
