import {
  OptimizationProposal,
  signOptimizationProposal,
  verifyOptimizationProposalSignature,
} from './optimization-proposal';

const proposal = (): OptimizationProposal => ({
  branchId: 'branch-1',
  planningEpochIso: '2026-09-11T00:00:00.000Z',
  expiresAt: '2026-09-11T00:30:00.000Z',
  resources: {
    orders: [{ id: 'order-1', version: 2 }],
    vehicles: [{ id: 'vehicle-1', updatedAt: '2026-09-10T00:00:00.000Z' }],
    drivers: [{ id: 'driver-1', updatedAt: '2026-09-10T00:00:00.000Z' }],
  },
  result: {
    job_id: 'request-1',
    status: 'SUCCESS',
    routes: [],
    unassigned_orders: [],
    total_distance_km: 0,
    total_duration_minutes: 0,
    total_cost_vnd: 0,
    diagnostics: [],
  },
});

describe('optimization proposal signature', () => {
  it('xác nhận proposal nguyên vẹn mà không cần lưu database', () => {
    const value = proposal();
    const signature = signOptimizationProposal(value, 'test-secret');

    expect(
      verifyOptimizationProposalSignature(value, signature, 'test-secret'),
    ).toBe(true);
  });

  it('từ chối kết quả đã bị thay đổi ở client', () => {
    const value = proposal();
    const signature = signOptimizationProposal(value, 'test-secret');
    value.result.total_cost_vnd = 1;

    expect(
      verifyOptimizationProposalSignature(value, signature, 'test-secret'),
    ).toBe(false);
  });

  it('không phụ thuộc thứ tự key của object', () => {
    const value = proposal();
    const signature = signOptimizationProposal(value, 'test-secret');
    const reordered = JSON.parse(JSON.stringify(value)) as OptimizationProposal;

    expect(
      verifyOptimizationProposalSignature(reordered, signature, 'test-secret'),
    ).toBe(true);
  });
});
