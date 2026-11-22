import { assertDemoStackSupports, matchesDemoStackingPolicy, readDemoStackingPolicy } from '../../src/trips/demo-stacking';

const settings = { TMS_DEMO_STACK_MAX_TIERS: '3', TMS_DEMO_STACK_CLEARANCE_MM: '50' };
const lower = { id: 'a', cargoKind: 'STANDARD' as const, allowUpperTier: false, noTopLoadRequested: false, maxTopLoadG: 30000, weightG: 100000n };
const upper = { ...lower, id: 'b', allowUpperTier: true, maxTopLoadG: null, weightG: 22000n };
const placement = { item_id: 'a', order_id: 'order-a', x: 0, y: 0, z: 0, length_cm: 100, width_cm: 100, height_cm: 25, weight_kg: 100 };
const placements = [placement, { ...placement, item_id: 'b', order_id: 'order-b', z: 25, weight_kg: 22, support_item_id: 'a' }];
const mixedOwners = new Map([['a', 'customer-a'], ['b', 'customer-b']]);

it('checks package ownership again before persisting a load plan', () => {
  const packages = new Map<string, typeof lower | typeof upper>([['a', lower], ['b', upper]]);
  const sameCustomer = readDemoStackingPolicy(settings);
  const anyCustomer = readDemoStackingPolicy({ ...settings, TMS_DEMO_STACK_OWNER_MODE: 'ANY_CUSTOMER' });
  expect(() => assertDemoStackSupports(placements, packages, mixedOwners, 1000, sameCustomer)).toThrow();
  expect(() => assertDemoStackSupports(placements, packages, mixedOwners, 1000, anyCustomer)).not.toThrow();
  expect(() => assertDemoStackSupports(placements, packages, new Map([['a', 'customer-a'], ['b', 'customer-a']]), 1000, sameCustomer)).not.toThrow();
  packages.set('a', { ...lower, noTopLoadRequested: true });
  expect(() => assertDemoStackSupports(placements, packages, mixedOwners, 1000, anyCustomer)).toThrow();
  expect(matchesDemoStackingPolicy(anyCustomer, sameCustomer)).toBe(false);
});


it('allows multiple smaller packages side-by-side on one larger base within deck bounds and cumulative limits', () => {
  const b1 = { ...upper, id: 'b1', maxTopLoadG: null, weightG: 14000n };
  const b2 = { ...upper, id: 'b2', maxTopLoadG: null, weightG: 14000n };
  const packages = new Map<string, typeof lower | typeof upper>([['a', lower], ['b1', b1], ['b2', b2]]);
  const owners = new Map([['a', 'cust'], ['b1', 'cust'], ['b2', 'cust']]);
  const policy = readDemoStackingPolicy(settings);
  const deckPlacements = [
    placement,
    { item_id: 'b1', order_id: 'order-a', x: 0, y: 0, z: 25, length_cm: 40, width_cm: 40, height_cm: 20, weight_kg: 14, support_item_id: 'a' },
    { item_id: 'b2', order_id: 'order-a', x: 40, y: 0, z: 25, length_cm: 40, width_cm: 40, height_cm: 20, weight_kg: 14, support_item_id: 'a' },
  ];
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy)).not.toThrow();

  // Overlapping siblings on the same deck are rejected.
  const overlapping = [
    placement,
    deckPlacements[1],
    { ...deckPlacements[2], x: 30 },
  ];
  expect(() => assertDemoStackSupports(overlapping, packages, owners, 1000, policy)).toThrow();

  // Overhanging outside base deck is rejected.
  const overhanging = [
    placement,
    { ...deckPlacements[1], x: 65 },
  ];
  expect(() => assertDemoStackSupports(overhanging, packages, owners, 1000, policy)).toThrow();

  // Exact 30% boundary (14 + 16 = 30kg <= 30% of 100kg) is allowed.
  packages.set('b2', { ...b2, weightG: 16000n });
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy)).not.toThrow();

  // Over 30% threshold (14 + 17 = 31kg > 30% of 100kg) across multiple upper siblings is rejected.
  packages.set('b2', { ...b2, weightG: 17000n });
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy)).toThrow();

  // Configurable max_top_load_percent (20% rejects 28kg, 40% allows 31kg with matching maxTopLoadG).
  packages.set('a', { ...lower, maxTopLoadG: 50000 });
  const policy40 = readDemoStackingPolicy({ ...settings, TMS_DEMO_STACK_MAX_TOP_LOAD_PERCENT: '40' });
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy40)).not.toThrow();
  const policy20 = readDemoStackingPolicy({ ...settings, TMS_DEMO_STACK_MAX_TOP_LOAD_PERCENT: '20' });
  packages.set('b2', { ...b2, weightG: 14000n });
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy20)).toThrow();
  packages.set('a', lower);

  // Cumulative maxTopLoadG across multiple upper siblings is enforced.
  packages.set('a', { ...lower, maxTopLoadG: 25000 });
  packages.set('b2', b2);
  expect(() => assertDemoStackSupports(deckPlacements, packages, owners, 1000, policy)).toThrow();
});

it('enforces transitive ancestor load limits and containment on 3-tier unequal stacks', () => {
  const tier1 = { ...lower, id: 'a', maxTopLoadG: 29500, weightG: 100000n };
  const tier2 = { ...lower, id: 'b', allowUpperTier: true, maxTopLoadG: 8000, weightG: 25000n };
  const tier3 = { ...upper, id: 'c', maxTopLoadG: null, weightG: 4000n };
  const packages = new Map<string, typeof lower | typeof upper>([['a', tier1], ['b', tier2], ['c', tier3]]);
  const owners = new Map([['a', 'cust'], ['b', 'cust'], ['c', 'cust']]);
  const policy = readDemoStackingPolicy(settings);
  const stackPlacements = [
    placement,
    { item_id: 'b', order_id: 'order-a', x: 10, y: 10, z: 25, length_cm: 60, width_cm: 60, height_cm: 25, weight_kg: 25, support_item_id: 'a' },
    { item_id: 'c', order_id: 'order-a', x: 20, y: 20, z: 50, length_cm: 30, width_cm: 30, height_cm: 20, weight_kg: 4, support_item_id: 'b' },
  ];
  expect(() => assertDemoStackSupports(stackPlacements, packages, owners, 1000, policy)).not.toThrow();

  // Tier 3 (6kg) + Tier 2 (25kg) = 31kg > 30% of 100kg base -> rejected on ancestor 'a'.
  packages.set('c', { ...tier3, weightG: 6000n });
  expect(() => assertDemoStackSupports(stackPlacements, packages, owners, 1000, policy)).toThrow();
});
