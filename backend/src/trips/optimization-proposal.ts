import { createHmac, timingSafeEqual } from 'crypto';
import {
  assertFleetOptimizationResult,
  FleetOptimizationResult,
} from './optimizer-contract';

export type OptimizationResourceVersions = {
  orders: Array<{ id: string; version: number }>;
  vehicles: Array<{ id: string; updatedAt: string }>;
  drivers: Array<{ id: string; updatedAt: string }>;
};

export type OptimizationProposal = {
  branchId: string;
  planningEpochIso: string;
  expiresAt: string;
  resources: OptimizationResourceVersions;
  result: FleetOptimizationResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertVersionRows(
  value: unknown,
  kind: 'orders' | 'vehicles' | 'drivers',
): void {
  if (!Array.isArray(value)) {
    throw new Error(`Proposal thiếu resources.${kind}`);
  }
  for (const row of value) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      throw new Error(`Proposal có resources.${kind} không hợp lệ`);
    }
    if (kind === 'orders') {
      if (!Number.isInteger(row.version) || Number(row.version) < 1) {
        throw new Error('Proposal có version đơn hàng không hợp lệ');
      }
    } else if (!isValidDateString(row.updatedAt)) {
      throw new Error(`Proposal có updatedAt của ${kind} không hợp lệ`);
    }
  }
}

export function assertOptimizationProposal(
  value: unknown,
): asserts value is OptimizationProposal {
  if (!isRecord(value)) throw new Error('Proposal phải là object');
  if (typeof value.branchId !== 'string' || value.branchId.length === 0) {
    throw new Error('Proposal thiếu branchId');
  }
  if (!isValidDateString(value.planningEpochIso)) {
    throw new Error('Proposal thiếu planningEpochIso hợp lệ');
  }
  if (!isValidDateString(value.expiresAt)) {
    throw new Error('Proposal thiếu expiresAt hợp lệ');
  }
  if (!isRecord(value.resources)) {
    throw new Error('Proposal thiếu resources');
  }
  assertVersionRows(value.resources.orders, 'orders');
  assertVersionRows(value.resources.vehicles, 'vehicles');
  assertVersionRows(value.resources.drivers, 'drivers');
  assertFleetOptimizationResult(value.result);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Không thể ký số không hữu hạn');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  throw new Error('Proposal chứa kiểu dữ liệu không thể ký');
}

export function signOptimizationProposal(
  proposal: OptimizationProposal,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(canonicalize(proposal))
    .digest('base64url');
}

export function verifyOptimizationProposalSignature(
  proposal: OptimizationProposal,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signOptimizationProposal(proposal, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
