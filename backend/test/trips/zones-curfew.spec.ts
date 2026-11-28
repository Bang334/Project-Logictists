import {
  expandZoneCurfewsRelativeToEpoch,
  isPointInPolygon,
  parseTimeToMinutes,
  type ZoneCurfewRecord,
} from '../../src/zones/geo.utils';

describe('Zone geo & curfew utilities', () => {
  const hanoiPolygon = [
    [
      [105.78, 20.95],
      [105.87, 20.95],
      [105.87, 21.08],
      [105.78, 21.08],
      [105.78, 20.95],
    ],
  ];

  it('parses HH:mm including 24:00 and rejects invalid times', () => {
    expect(parseTimeToMinutes('06:00')).toBe(360);
    expect(parseTimeToMinutes('24:00')).toBe(1440);
    expect(() => parseTimeToMinutes('25:00')).toThrow();
    expect(() => parseTimeToMinutes('invalid')).toThrow();
  });

  it('detects point inside polygon and outside polygon / inside hole', () => {
    // Hoan Kiem (inside)
    expect(isPointInPolygon(105.8556, 21.0245, hanoiPolygon)).toBe(true);
    // Depot Long Bien (outside)
    expect(isPointInPolygon(105.9082, 21.0345, hanoiPolygon)).toBe(false);

    const polygonWithHole = [
      hanoiPolygon[0],
      [
        [105.84, 21.01],
        [105.86, 21.01],
        [105.86, 21.03],
        [105.84, 21.03],
        [105.84, 21.01],
      ],
    ];
    expect(isPointInPolygon(105.85, 21.02, polygonWithHole)).toBe(false);
  });

  const realisticHanoiPolygon = [
    [
      [105.78781, 21.08405],
      [105.78817, 21.08046],
      [105.78578, 21.07566],
      [105.78493, 21.06712],
      [105.78175, 21.0537],
      [105.78055, 21.03823],
      [105.77847, 21.02486],
      [105.77975, 21.02047],
      [105.80342, 20.99172],
      [105.81552, 20.97525],
      [105.81793, 20.9733],
      [105.82621, 20.97049],
      [105.8345, 20.9663],
      [105.85034, 20.96552],
      [105.86568, 20.96363],
      [105.87259, 20.9643],
      [105.87618, 20.96598],
      [105.88147, 20.97245],
      [105.88806, 20.97759],
      [105.89307, 20.98353],
      [105.89476, 20.9834],
      [105.89483, 20.98664],
      [105.89205, 20.99245],
      [105.89222, 20.99637],
      [105.8837, 21.00096],
      [105.88198, 21.00125],
      [105.87939, 21.00065],
      [105.87712, 21.00189],
      [105.8718, 21.00322],
      [105.86529, 21.00943],
      [105.86361, 21.01247],
      [105.86049, 21.02467],
      [105.85479, 21.0352],
      [105.83822, 21.05265],
      [105.83292, 21.06093],
      [105.83172, 21.06406],
      [105.82914, 21.065],
      [105.82653, 21.06831],
      [105.82573, 21.07296],
      [105.82072, 21.07756],
      [105.81456, 21.08828],
      [105.81277, 21.08965],
      [105.81074, 21.09007],
      [105.79737, 21.08929],
      [105.78733, 21.09088],
      [105.78781, 21.08405],
    ],
  ];

  it('classifies real Hanoi inner-city stops inside Vanh dai 3 / De Huu Hong and outer districts outside', () => {
    const ring = realisticHanoiPolygon[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    // No self-intersecting edges
    const ccw = (p1: number[], p2: number[], p3: number[]) =>
      (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
    const intersects = (a1: number[], a2: number[], b1: number[], b2: number[]) =>
      ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
    for (let i = 0; i < ring.length - 1; i++) {
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        expect(intersects(ring[i], ring[i + 1], ring[j], ring[j + 1])).toBe(false);
      }
    }

    // Inside Ring Road 3 & Red River west bank
    expect(isPointInPolygon(105.8556, 21.0245, realisticHanoiPolygon)).toBe(true); // Hoan Kiem
    expect(isPointInPolygon(105.8071, 20.9964, realisticHanoiPolygon)).toBe(true); // Nguyen Trai, Thanh Xuan
    expect(isPointInPolygon(105.7908, 21.0368, realisticHanoiPolygon)).toBe(true); // Cau Giay
    expect(isPointInPolygon(105.8029, 21.0692, realisticHanoiPolygon)).toBe(true); // Xuan La, Tay Ho
    expect(isPointInPolygon(105.8674, 20.9992, realisticHanoiPolygon)).toBe(true); // 458 Minh Khai, Hai Ba Trung

    // Outside: across Red River (Long Bien, Gia Lam, Dong Anh) and outside Ring Road 3 (My Dinh, Ngoc Hoi)
    expect(isPointInPolygon(105.9082, 21.0345, realisticHanoiPolygon)).toBe(false); // Depot Long Bien
    expect(isPointInPolygon(105.9412, 21.0498, realisticHanoiPolygon)).toBe(false); // Gia Lam
    expect(isPointInPolygon(105.8491, 21.1392, realisticHanoiPolygon)).toBe(false); // Dong Anh
    expect(isPointInPolygon(105.7706, 21.0118, realisticHanoiPolygon)).toBe(false); // My Dinh (west of Pham Hung)
    expect(isPointInPolygon(105.8428, 20.9349, realisticHanoiPolygon)).toBe(false); // Ngoc Hoi, Thanh Tri
  });

  it('expands active curfews relative to ICT planningEpoch across multiple days', () => {
    const zones: ZoneCurfewRecord[] = [
      {
        id: 'z-1',
        name: 'Noi thanh HN',
        active: true,
        maxPayloadKg: 2500,
        polygon: hanoiPolygon,
        curfewWindows: [
          { startTime: '06:00', endTime: '09:00' },
          { startTime: '16:00', endTime: '20:00' },
        ],
      },
      {
        id: 'z-inactive',
        name: 'Disabled zone',
        active: false,
        maxPayloadKg: 1000,
        polygon: hanoiPolygon,
        curfewWindows: [{ startTime: '00:00', endTime: '24:00' }],
      },
    ];

    // 2026-11-26 00:00:00 ICT == 2026-11-25T17:00:00.000Z
    const epoch = new Date('2026-11-25T17:00:00.000Z');
    const windows = expandZoneCurfewsRelativeToEpoch(
      zones,
      21.0245,
      105.8556,
      epoch,
      1,
      'Asia/Ho_Chi_Minh',
    );

    // Day 0 & Day 1 -> 2 windows * 2 days = 4 windows (inactive zone excluded)
    expect(windows).toHaveLength(4);
    expect(windows[0]).toEqual({
      max_payload_kg: 2500,
      start_sec: 6 * 3600,
      end_sec: 9 * 3600,
    });
    expect(windows[1]).toEqual({
      max_payload_kg: 2500,
      start_sec: 16 * 3600,
      end_sec: 20 * 3600,
    });
    expect(windows[2]).toEqual({
      max_payload_kg: 2500,
      start_sec: 24 * 3600 + 6 * 3600,
      end_sec: 24 * 3600 + 9 * 3600,
    });

    // Outside polygon returns empty
    expect(
      expandZoneCurfewsRelativeToEpoch(zones, 21.0345, 105.9082, epoch, 1),
    ).toEqual([]);
  });
});
