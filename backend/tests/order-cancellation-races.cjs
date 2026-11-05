const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TripsService } = require('../dist/src/trips/trips.service');
const { OrdersService } = require('../dist/src/orders/orders.service');
const { ResourceAccess } = require('../dist/src/auth/resource-access.service');
const { OutboxService } = require('../dist/src/common/services/outbox.service');
const { signOptimizationProposal } = require('../dist/src/trips/optimization-proposal');

// Pause after the real PostgreSQL row lock, without replacing any reads/writes.
function pauseAfterOrderLock(db) {
  let signal, release;
  const locked = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const client = new Proxy(db, { get(target, property) {
    if (property !== '$transaction') { const value = target[property]; return typeof value === 'function' ? value.bind(target) : value; }
    return (callback, options) => target.$transaction(async tx => callback(new Proxy(tx, { get(inner, key) {
      if (key !== '$queryRaw') { const value = inner[key]; return typeof value === 'function' ? value.bind(inner) : value; }
      return async (...args) => {
        const rows = await inner.$queryRaw(...args);
        const sql = args[0].strings ? args[0].strings.join(' ') : Array.isArray(args[0]) ? args[0].join(' ') : '';
        if (/FROM orders/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          const [{ pid }] = await inner.$queryRaw`SELECT pg_backend_pid() AS pid`;
          signal(pid); await gate;
        }
        return rows;
      };
    } })), { ...options, timeout: 20000 });
  } });
  return { client, locked, release: () => release() };
}
async function waitForBlocked(db, pid) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Expected competing command to wait for a PostgreSQL lock');
}
async function fixture(db, branch, order) {
  const suffix = randomUUID();
  const vt = await db.vehicleType.create({ data: { code: 'CANCEL-' + suffix, name: '[TEST]', payloadCapacityKg: 1000, volumeCapacityM3: 20, lengthCm: 300, widthCm: 200, heightCm: 200 } });
  const depot = await db.location.create({ data: { code: 'CANCEL-' + suffix, name: '[TEST]', type: 'CENTRAL_WAREHOUSE', managingBranchId: branch.id, address: '[TEST]', latitude: 21, longitude: 105 } });
  const vehicle = await db.vehicle.create({ data: { plateNumber: 'CANCEL-' + suffix, model: '[TEST]', vehicleTypeId: vt.id, homeBranchId: branch.id, homeDepotLocationId: depot.id } });
  const driver = await db.driver.create({ data: { fullName: '[TEST]', citizenId: suffix, phone: suffix, licenseNumber: suffix, licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } });
  const p = order.items[0].packages[0];
  const placement = { item_id: p.id, order_id: order.id, x: 0, y: 0, length_cm: 40, width_cm: 30, height_cm: 20, weight_kg: 10 };
  const spatial = { is_valid: true, max_weight_kg: 10, max_area_cm2: 1200, step_states: order.stops.map((s, i) => ({ step_index: i + 1, stop_id: s.id, stop_type: s.type, action_description: '[TEST]', placed_items: i ? [] : [placement], current_weight_kg: i ? 0 : 10, current_occupied_area_cm2: i ? 0 : 1200, floor_area_cm2: 60000, weight_utilization_percent: i ? 0 : 1, area_utilization_percent: i ? 0 : 2, is_valid: true, package_access_paths: [] })) };
  const cost = Object.fromEntries(['base_fuel_cost_vnd','load_fuel_surcharge_vnd','fuel_cost_vnd','cargo_holding_cost_vnd','late_delivery_penalty_vnd','cargo_distance_ton_km','cargo_time_ton_hours','vehicle_fixed_cost_vnd','driver_fixed_salary_allocation_vnd','driver_trip_pay_vnd','total_cost_vnd'].map(k => [k, 0]));
  const proposal = { branchId: branch.id, planningEpochIso: '2031-01-01T00:00:00Z', expiresAt: new Date(Date.now() + 600000).toISOString(), resources: {
    orders: [{ id: order.id, version: order.version }], vehicles: [{ id: vehicle.id, updatedAt: vehicle.updatedAt.toISOString(), vehicleTypeUpdatedAt: vt.updatedAt.toISOString() }], drivers: [{ id: driver.id, updatedAt: driver.updatedAt.toISOString() }],
  }, result: { job_id: suffix, status: 'SUCCESS', unassigned_orders: [], total_distance_km: 10, total_duration_minutes: 30, total_cost_vnd: 0, diagnostics: [], routes: [{
    route_id: suffix, vehicle_id: vehicle.id, plate_number: vehicle.plateNumber, vehicle_length_cm: 300, vehicle_width_cm: 200, driver_id: driver.id, driver_name: driver.fullName, driver_license_class: 'C', service_day_index: 0, start_time_sec: 0, end_time_sec: 1800, total_distance_km: 10, total_duration_minutes: 30, cost, spatial_validation: spatial,
    stops: order.stops.map((s, i) => ({ sequence: i + 1, location_id: s.id, location_name: s.address, stop_type: s.type, order_id: order.id, allocation_id: order.id, order_stop_id: s.id, latitude: s.latitude, longitude: s.longitude, arrival_time_sec: i ? 1200 : 60, departure_time_sec: i ? 1260 : 120, travel_time_sec: i ? 1080 : 60, waiting_time_sec: 0, service_time_sec: 60, items_loaded: i ? [] : [p.id], items_unloaded: i ? [p.id] : [], current_weight_kg: i ? 0 : 10 })),
  }] } };
  const endpoint = { address: '[TEST]', latitude: 21, longitude: 105 };
  const manual = { branchId: branch.id, idempotencyKey: randomUUID(), vehicleId: vehicle.id, driverId: driver.id, orderIds: [order.id], plannedStartTime: proposal.planningEpochIso, plannedEndTime: '2031-01-01T01:00:00Z', startLocation: endpoint, endLocation: endpoint };
  // Only external planning responses are fixtures. The real create/apply transaction,
  // resource validation, persistence, reservations and outbox run on PostgreSQL.
  const planning = { getRoute: async () => ({ distanceKm: 10, durationMinutes: 5, geometry: null }), getRoadMatrix: async coords => ({ durationsSeconds: coords.map((_, i) => coords.map((_, j) => i === j ? 0 : 60)) }) };
  const service = client => {
    const s = new TripsService(client, planning, new OutboxService(db), new ResourceAccess(db));
    s.validateSpatialPlan = async () => spatial;
    return s;
  };
  return { proposal, manual, service };
}
exports.exerciseDispatchRaces = async ({ t, db, principal, make, cancel, branch }) => {
  await t.test('running multi-order job remains intact; persisted old candidate cannot apply after cancellation', async () => {
    const o = await make(true), other = await make(true), f = await fixture(db, branch, o);
    const job = await db.optimizationJob.create({ data: { branchId: branch.id, createdById: principal.id, status: 'RUNNING', requestHash: randomUUID(), idempotencyKey: randomUUID(), requestSnapshot: { orders: [o.id, other.id] } } });
    assert.equal((await cancel(o)).status, 201);
    assert.equal((await db.optimizationJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'RUNNING');
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: other.id } })).status, 'CONFIRMED');
    const stored = { proposal: f.proposal, signature: signOptimizationProposal(f.proposal, process.env.JWT_SECRET) };
    await db.optimizationResult.create({ data: { optimizationJobId: job.id, candidateNumber: 1, resultSnapshot: stored, feasibilityStatus: 'FEASIBLE', objectiveBreakdown: {} } });
    await db.optimizationJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED' } });
    const { OptimizationJobsService } = require('../dist/src/trips/optimization-jobs.service');
    const jobs = new OptimizationJobsService(db, {}, f.service(db), new OutboxService(db));
    await assert.rejects(jobs.apply(principal, job.id, 1), e => e.getStatus() === 409);
    assert.equal((await db.optimizationJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'SUCCEEDED', 'failed apply must roll back APPLYING claim');
    assert.equal(await db.allocation.count({ where: { orderItem: { orderId: o.id } } }), 0);
  });
  for (const mode of ['manual', 'automatic']) for (const winner of ['cancel', 'dispatch']) {
    await t.test(`${mode}: ${winner} commits first; real competing transaction cannot also succeed`, async () => {
      const o = await make(true), f = await fixture(db, branch, o), paused = pauseAfterOrderLock(db);
      const dispatch = client => mode === 'manual' ? f.service(client).create(f.manual, principal) : f.service(client).applyAutomaticOptimization({ proposal: f.proposal, signature: signOptimizationProposal(f.proposal, process.env.JWT_SECRET) }, principal);
      const cancellation = client => new OrdersService(client, new ResourceAccess(db)).cancel(o.id, { version: o.version, reason: '[TEST] race' }, principal, randomUUID());
      const settle = p => p.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      const first = settle(winner === 'cancel' ? cancellation(paused.client) : dispatch(paused.client));
      let second;
      try {
        const pid = await Promise.race([paused.locked, first.then(r => { throw r.error || new Error('First command ended before acquiring row lock'); })]);
        second = settle(winner === 'cancel' ? dispatch(db) : cancellation(db));
        await waitForBlocked(db, pid);
      } finally { paused.release(); }
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.ok, true, firstResult.error?.stack);
      assert.equal(secondResult.ok, false, 'both commands must not commit');
      assert.ok([400, 409].includes(secondResult.error.getStatus()), secondResult.error.stack);
      const saved = await db.order.findUniqueOrThrow({ where: { id: o.id } });
      assert.equal(saved.status, winner === 'cancel' ? 'CANCELLED' : 'ASSIGNED');
      assert.equal(saved.version, o.version + 1);
      assert.equal(await db.allocation.count({ where: { orderItem: { orderId: o.id } } }), winner === 'cancel' ? 0 : 1);
      assert.equal(await db.orderEvent.count({ where: { orderId: o.id, eventType: 'CANCELLED' } }), winner === 'cancel' ? 1 : 0);
      if (winner === 'cancel' && mode === 'automatic') await assert.rejects(dispatch(db), e => e.getStatus() === 409);
      if (winner === 'dispatch') assert.equal((await cancel({ ...o, version: saved.version })).status, 409);
    });
  }
};
