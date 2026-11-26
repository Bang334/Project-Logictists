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
