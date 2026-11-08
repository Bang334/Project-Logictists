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
