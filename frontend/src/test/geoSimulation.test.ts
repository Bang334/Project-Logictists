import { expect, it } from 'vitest';
import { buildRouteProfile, calculateStopMilestonesKm, getStepIndexForDistance } from '../utils/geoSimulation';

it('uses provider visit boundaries for repeated pickups and deliveries', () => {
  const profile = buildRouteProfile([[108, 16], [108.01, 16], [108, 16], [108.01, 16], [108, 16]]);
  const stops = [
    { longitude: 108, latitude: 16 },
    { longitude: 108.01, latitude: 16 },
    { longitude: 108, latitude: 16 },
    { longitude: 108.01, latitude: 16 },
  ];
  const milestones = calculateStopMilestonesKm(profile, stops, [0, 0, 1, 2, 3, 4]);
  expect(milestones).toEqual(profile.cumulativeDistances.slice(0, 4));
  expect(getStepIndexForDistance(milestones, milestones[2])).toBe(3);
  expect(getStepIndexForDistance(milestones, milestones[3] - 0.01)).toBe(3);
});

it('keeps the first nearby visit in older plans when a later visit snaps closer', () => {
  const profile = buildRouteProfile([[108, 16], [108.01, 16.00001], [108.02, 16], [108.01, 16]]);
  const milestones = calculateStopMilestonesKm(profile, [{ longitude: 108.01, latitude: 16 }]);
  expect(milestones).toEqual([profile.cumulativeDistances[1]]);
});
