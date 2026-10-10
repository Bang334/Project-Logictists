// Two public test points, real provider, no database connection and no token logging.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { MapboxService } = require('../dist/src/mapbox/mapbox.service');
(async () => {
  const map = new MapboxService();
  const points = [[105.85, 21.03], [105.86, 21.04]];
  const [route, matrix] = await Promise.all([map.getRoute(points), map.getRoadMatrix(points)]);
  assert.ok(route.distanceKm > 0 && route.durationMinutes > 0 && route.geometry);
  assert.ok(matrix.durationsSeconds[0][1] > 0 && matrix.distancesMeters[0][1] > 0);
  console.log('PASS real Mapbox Directions + Matrix: positive road distance/duration and route geometry.');
})().catch(() => { console.error('FAIL Mapbox provider verification (no credentials logged)'); process.exitCode = 1; });
