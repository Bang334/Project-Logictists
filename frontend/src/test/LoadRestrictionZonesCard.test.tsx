import { App } from 'antd';
import { AxiosHeaders } from 'axios';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonesApi } from '../api/client';
import {
  HANOI_INNER_CITY_POLYGON,
  HANOI_INNER_CITY_PRESET,
  LoadRestrictionZonesCard,
} from '../components/settings/LoadRestrictionZonesCard';

vi.mock('../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    zonesApi: {
      ...original.zonesApi,
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  };
});

function isPointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const ccw = (p1: number[], p2: number[], p3: number[]) =>
    (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});

beforeEach(() => {
  vi.mocked(zonesApi.list).mockResolvedValue({
    data: [],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoadRestrictionZonesCard & HANOI_INNER_CITY_PRESET', () => {
  it('defines a closed, non-self-intersecting Hanoi Ring Road 3 & Red River west-bank polygon', () => {
    const ring = HANOI_INNER_CITY_POLYGON[0];
    expect(ring.length).toBeGreaterThanOrEqual(30);
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    for (let i = 0; i < ring.length - 1; i++) {
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        expect(segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])).toBe(false);
      }
    }

    // Inner districts inside Ring Road 3
    expect(isPointInRing(105.8556, 21.0245, ring)).toBe(true); // Hoàn Kiếm
    expect(isPointInRing(105.7908, 21.0368, ring)).toBe(true); // Cầu Giấy
    expect(isPointInRing(105.8071, 20.9964, ring)).toBe(true); // Thanh Xuân
    expect(isPointInRing(105.8029, 21.0692, ring)).toBe(true); // Tây Hồ (Xuân La)

    // Across Red River / outside Ring Road 3
    expect(isPointInRing(105.9082, 21.0345, ring)).toBe(false); // Long Biên Depot
    expect(isPointInRing(105.9412, 21.0498, ring)).toBe(false); // Gia Lâm
    expect(isPointInRing(105.8491, 21.1392, ring)).toBe(false); // Đông Anh
    expect(isPointInRing(105.7706, 21.0118, ring)).toBe(false); // Mỹ Đình
    expect(isPointInRing(105.8428, 20.9349, ring)).toBe(false); // Thanh Trì (Ngọc Hồi)
  });

  it('fills the realistic Hanoi Ring Road 3 polygon preset when clicked', async () => {
    render(
      <App>
        <LoadRestrictionZonesCard branchId="branch-han" branchName="Hà Nội" canManage />
      </App>,
    );

    await waitFor(() => expect(zonesApi.list).toHaveBeenCalledWith('branch-han'));

    fireEvent.click(screen.getByRole('button', { name: /Thêm vùng cấm tải/i }));
    const presetButton = await screen.findByRole('button', {
      name: /Điền nhanh mẫu Nội thành Hà Nội/i,
    });
    fireEvent.click(presetButton);

    const nameInput = screen.getByLabelText('Tên vùng') as HTMLInputElement;
    const polygonTextarea = screen.getByLabelText(/Đa giác GeoJSON/i) as HTMLTextAreaElement;

    expect(nameInput.value).toBe(HANOI_INNER_CITY_PRESET.name);
    expect(JSON.parse(polygonTextarea.value)).toEqual(HANOI_INNER_CITY_POLYGON);
  });
});
