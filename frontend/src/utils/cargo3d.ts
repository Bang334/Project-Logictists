import type { PlacedItemUI } from '../types';

export interface Camera3DState {
  azimuthDeg: number;
  elevationDeg: number;
  zoom: number;
}

export type Camera3DPresetKey = 'iso' | 'side' | 'rear' | 'top';

export const CAMERA_3D_PRESETS: Record<Camera3DPresetKey, { label: string; camera: Camera3DState }> = {
  iso: {
    label: '3D Nghiêng',
    camera: { azimuthDeg: -36, elevationDeg: 25, zoom: 1 },
  },
  side: {
    label: 'Nhìn ngang X-Z',
    camera: { azimuthDeg: 0, elevationDeg: 4, zoom: 1.05 },
  },
  rear: {
    label: 'Cửa sau Y-Z',
    camera: { azimuthDeg: -90, elevationDeg: 10, zoom: 1.08 },
  },
  top: {
    label: 'Từ trên X-Y',
    camera: { azimuthDeg: 0, elevationDeg: 89, zoom: 0.96 },
  },
};

export interface TruckDimensionsCm {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface Point3DCm {
  x: number;
  y: number;
  z: number;
}

export interface ProjectedPoint2D {
  sx: number;
  sy: number;
  depth: number;
}

export interface ProjectionContext {
  dims: TruckDimensionsCm;
  camera: Camera3DState;
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  cosAz: number;
  sinAz: number;
  cosEl: number;
  sinEl: number;
  camDir: Point3DCm;
}

export interface PositionedBox3D {
  item: PlacedItemUI;
  tierIndex: number;
  actualZ: number;
  visualZ: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  depth: number;
}

export type BoxFaceKey = 'top' | 'bottom' | 'rear' | 'cabin' | 'frontY' | 'backY';

export interface ProjectedFacePolygon {
  key: BoxFaceKey;
  points: string;
  shade: 'bright' | 'mid' | 'dark' | 'side';
}

const EPS = 0.05;

export function createProjectionContext(
  dims: TruckDimensionsCm,
  camera: Camera3DState,
  viewportWidth: number,
  viewportHeight: number,
  extraHeadroomCm = 0,
): ProjectionContext {
  const azRad = (camera.azimuthDeg * Math.PI) / 180;
  const elRad = (Math.max(2, Math.min(89, camera.elevationDeg)) * Math.PI) / 180;
  const cosAz = Math.cos(azRad);
  const sinAz = Math.sin(azRad);
  const cosEl = Math.cos(elRad);
  const sinEl = Math.sin(elRad);

  const effHeight = dims.heightCm + Math.max(0, extraHeadroomCm);
  const halfL = dims.lengthCm / 2;
  const halfW = dims.widthCm / 2;
  const halfH = effHeight / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const sxSign of [-1, 1]) {
    for (const sySign of [-1, 1]) {
      for (const szSign of [-1, 1]) {
        const dx = sxSign * halfL;
        const dy = sySign * halfW;
        const dz = szSign * halfH;
        const rx = dx * cosAz + dy * sinAz;
        const ry = -dx * sinAz + dy * cosAz;
        const px = rx;
        const py = -dz * cosEl + ry * sinEl;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const padX = Math.max(60, viewportWidth * 0.14);
  const padY = Math.max(54, viewportHeight * 0.16);
  const fitScale = Math.min((viewportWidth - padX) / spanX, (viewportHeight - padY) / spanY);

  return {
    dims: { ...dims, heightCm: dims.heightCm },
    camera,
    viewportWidth,
    viewportHeight,
    scale: Math.max(0.05, fitScale * camera.zoom),
    cosAz,
    sinAz,
    cosEl,
    sinEl,
    // Hướng vector từ tâm thùng xe về phía camera (trùng hướng tăng depth)
    camDir: {
      x: -sinAz * cosEl,
      y: cosAz * cosEl,
      z: sinEl,
    },
  };
}

export function projectPoint3D(ctx: ProjectionContext, pt: Point3DCm, explodeExtraCm = 0): ProjectedPoint2D {
  const effH = ctx.dims.heightCm + Math.max(0, explodeExtraCm);
  const dx = pt.x - ctx.dims.lengthCm / 2;
  const dy = pt.y - ctx.dims.widthCm / 2;
  const dz = pt.z - effH / 2;

  const rx = dx * ctx.cosAz + dy * ctx.sinAz;
  const ry = -dx * ctx.sinAz + dy * ctx.cosAz;
  const depth = dz * ctx.sinEl + ry * ctx.cosEl;

  return {
    sx: ctx.viewportWidth / 2 + rx * ctx.scale,
    sy: ctx.viewportHeight / 2 + (-dz * ctx.cosEl + ry * ctx.sinEl) * ctx.scale,
    depth,
  };
}

/**
 * Sắp xếp thứ tự vẽ kiện hàng bằng Painter's topological sort trên 3 trục tọa độ
 * để xử lý đúng mọi góc xoay, tránh xuyên mặt phẳng khi nhìn ngang hoặc nhìn dọc.
 */
export function buildSortedBoxes3D(
  items: PlacedItemUI[],
  ctx: ProjectionContext,
  explodeGapCm = 0,
): PositionedBox3D[] {
  const sortedUniqueZ = Array.from(
    new Set(items.map((item) => Math.round((item.z ?? 0) * 10) / 10)),
  ).sort((a, b) => a - b);

  const tierMap = new Map<number, number>();
  sortedUniqueZ.forEach((zVal, idx) => tierMap.set(zVal, idx));

  const boxes: PositionedBox3D[] = items.map((item) => {
    const actualZ = item.z ?? 0;
    const tierIndex = tierMap.get(Math.round(actualZ * 10) / 10) ?? 0;
    const visualZ = actualZ + tierIndex * explodeGapCm;
    const height = Math.max(4, item.height_cm || 35);
    const center = projectPoint3D(ctx, {
      x: item.x + item.length_cm / 2,
      y: item.y + item.width_cm / 2,
      z: visualZ + height / 2,
    });
    return {
      item,
      tierIndex: tierIndex + 1,
      actualZ,
      visualZ,
      x0: item.x,
      x1: item.x + item.length_cm,
      y0: item.y,
      y1: item.y + item.width_cm,
      z0: visualZ,
      z1: visualZ + height,
      depth: center.depth,
    };
  });

  const n = boxes.length;
  if (n <= 1) return boxes;

  const screenBounds = boxes.map((b) => {
    const corners = [
      projectPoint3D(ctx, { x: b.x0, y: b.y0, z: b.z0 }),
      projectPoint3D(ctx, { x: b.x1, y: b.y0, z: b.z0 }),
      projectPoint3D(ctx, { x: b.x1, y: b.y1, z: b.z0 }),
      projectPoint3D(ctx, { x: b.x0, y: b.y1, z: b.z0 }),
      projectPoint3D(ctx, { x: b.x0, y: b.y0, z: b.z1 }),
      projectPoint3D(ctx, { x: b.x1, y: b.y0, z: b.z1 }),
      projectPoint3D(ctx, { x: b.x1, y: b.y1, z: b.z1 }),
      projectPoint3D(ctx, { x: b.x0, y: b.y1, z: b.z1 }),
    ];
    return {
      minX: Math.min(...corners.map((c) => c.sx)),
      maxX: Math.max(...corners.map((c) => c.sx)),
      minY: Math.min(...corners.map((c) => c.sy)),
      maxY: Math.max(...corners.map((c) => c.sy)),
    };
  });

  const adj: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);

  const isBehind = (a: PositionedBox3D, b: PositionedBox3D): boolean => {
    if (ctx.camDir.z > 1e-4 && a.z1 <= b.z0 + EPS) return true;
    if (ctx.camDir.z < -1e-4 && b.z1 <= a.z0 + EPS) return true;
    if (ctx.camDir.x > 1e-4 && a.x1 <= b.x0 + EPS) return true;
    if (ctx.camDir.x < -1e-4 && b.x1 <= a.x0 + EPS) return true;
    if (ctx.camDir.y > 1e-4 && a.y1 <= b.y0 + EPS) return true;
    if (ctx.camDir.y < -1e-4 && b.y1 <= a.y0 + EPS) return true;
    return false;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = screenBounds[i];
      const sj = screenBounds[j];
      const screenOverlap =
        si.maxX > sj.minX - 0.5 &&
        sj.maxX > si.minX - 0.5 &&
        si.maxY > sj.minY - 0.5 &&
        sj.maxY > si.minY - 0.5;
      if (!screenOverlap) continue;

      const iBehindJ = isBehind(boxes[i], boxes[j]);
      const jBehindI = isBehind(boxes[j], boxes[i]);
      if (iBehindJ && !jBehindI) {
        adj[i].push(j);
        indeg[j]++;
      } else if (jBehindI && !iBehindJ) {
        adj[j].push(i);
        indeg[i]++;
      }
    }
  }

  const ordered: PositionedBox3D[] = [];
  const remaining = new Set<number>(Array.from({ length: n }, (_, idx) => idx));

  while (remaining.size > 0) {
    const ready = Array.from(remaining)
      .filter((idx) => indeg[idx] === 0)
      .sort((a, b) => boxes[a].depth - boxes[b].depth);

    const pick =
      ready.length > 0
        ? ready[0]
        : Array.from(remaining).sort((a, b) => boxes[a].depth - boxes[b].depth)[0];

    remaining.delete(pick);
    ordered.push(boxes[pick]);
    for (const next of adj[pick]) {
      indeg[next] = Math.max(0, indeg[next] - 1);
    }
  }

  return ordered;
}

export function getVisibleBoxFaces(
  box: PositionedBox3D,
  ctx: ProjectionContext,
  explodeExtraCm = 0,
): ProjectedFacePolygon[] {
  const { x0, x1, y0, y1, z0, z1 } = box;
  const p = (x: number, y: number, z: number) => projectPoint3D(ctx, { x, y, z }, explodeExtraCm);
  const toSvgPoints = (pts: ProjectedPoint2D[]) =>
    pts.map((pt) => `${pt.sx.toFixed(1)},${pt.sy.toFixed(1)}`).join(' ');

  const faces: ProjectedFacePolygon[] = [];

  if (ctx.camDir.y > 0) {
    faces.push({
      key: 'frontY',
      points: toSvgPoints([p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)]),
      shade: 'mid',
    });
  } else if (ctx.camDir.y < 0) {
    faces.push({
      key: 'backY',
      points: toSvgPoints([p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)]),
      shade: 'mid',
    });
  }

  if (ctx.camDir.x > 0) {
    faces.push({
      key: 'rear',
      points: toSvgPoints([p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]),
      shade: 'side',
    });
  } else if (ctx.camDir.x < 0) {
    faces.push({
      key: 'cabin',
      points: toSvgPoints([p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)]),
      shade: 'dark',
    });
  }

  if (ctx.camDir.z > 0) {
    faces.push({
      key: 'top',
      points: toSvgPoints([p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]),
      shade: 'bright',
    });
  } else if (ctx.camDir.z < 0) {
    faces.push({
      key: 'bottom',
      points: toSvgPoints([p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)]),
      shade: 'dark',
    });
  }

  return faces;
}
