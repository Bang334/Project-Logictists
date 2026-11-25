import { parsePlannedRoute } from './planned-route.selector';

it('keeps all coordinates in the stored Mapbox LineString', () => {
  const geometry = { type: 'LineString', coordinates: [[105.9, 21], [105.8, 21.1], [105.7, 21]] };
  expect(parsePlannedRoute(JSON.stringify(geometry))).toEqual(geometry);
});

it.each([
  null,
  'encoded-polyline',
  '{"type":"Point","coordinates":[105,21]}',
  '{"type":"LineString","coordinates":[[105,21]]}',
  '{"type":"LineString","coordinates":[[105,21],[181,22]]}',
  '{"type":"LineString","coordinates":[[105,21],[106,"22"]]}',
])('omits unavailable or invalid planned routes (%s)', (stored) => {
  expect(parsePlannedRoute(stored)).toBeNull();
});
