import { ConflictException } from '@nestjs/common';
import type { Package } from '@prisma/client';
import type { FleetOptimizationResult } from './optimizer-contract';

export function readDemoStackingPolicy(config: Record<string, unknown>) {
  const tiers = config.TMS_DEMO_STACK_MAX_TIERS;
  const clearance = config.TMS_DEMO_STACK_CLEARANCE_MM;
  const ownerMode = config.TMS_DEMO_STACK_OWNER_MODE ?? 'SAME_CUSTOMER';
  if (tiers === undefined && clearance === undefined) return undefined;
  if (config.NODE_ENV === 'production' || typeof tiers !== 'string' || !/^(?:[2-9]|1[0-9]|20)$/.test(tiers) ||
    typeof clearance !== 'string' || !/^[1-9][0-9]{0,8}$/.test(clearance) ||
    (ownerMode !== 'SAME_CUSTOMER' && ownerMode !== 'ANY_CUSTOMER')) {
    throw new Error('Xếp chồng demo cần số tầng (2–20), khoảng hở (> 0) và chế độ SAME_CUSTOMER hoặc ANY_CUSTOMER, ở môi trường ngoài production');
  }
  return { max_tiers: Number(tiers), lift_clearance_cm: Number(clearance) / 10, owner_mode: ownerMode };
}

type Placements = FleetOptimizationResult['routes'][number]['spatial_validation']['step_states'][number]['placed_items'];
type StackPackage = Pick<Package, 'id' | 'allowUpperTier' | 'cargoKind' | 'noTopLoadRequested' | 'maxTopLoadG' | 'weightG'>;

export function matchesDemoStackingPolicy(current: ReturnType<typeof readDemoStackingPolicy>, saved: unknown): boolean {
  return !!current && !!saved && typeof saved === 'object' &&
    'max_tiers' in saved && saved.max_tiers === current.max_tiers &&
    'lift_clearance_cm' in saved && saved.lift_clearance_cm === current.lift_clearance_cm &&
    ('owner_mode' in saved ? saved.owner_mode : 'SAME_CUSTOMER') === current.owner_mode;
}

export function assertDemoStackSupports(
  placements: Placements,
  packageByCargoId: ReadonlyMap<string, StackPackage>,
  customerByPackageId: ReadonlyMap<string, string>,
  heightMm: number,
  policy: ReturnType<typeof readDemoStackingPolicy>,
) {
  const elevated = placements.filter(item => (item.z ?? 0) !== 0 || item.support_item_id != null);
  if (!elevated.length) return;
  const reject = () => { throw new ConflictException('Quan hệ đỡ, tầng hoặc tải phía trên của kiện không hợp lệ'); };
  if (!policy) return reject();

  const byId = new Map(placements.map(placement => [placement.item_id, placement]));
  if (byId.size !== placements.length) return reject();
  const above = new Map<string, bigint>();
  const supportedBy = new Set<string>();
  const mm = (value: number) => Math.round(value * 10);

  for (const item of elevated) {
    const physical = packageByCargoId.get(item.item_id);
    if (!physical?.allowUpperTier || physical.cargoKind !== 'STANDARD' || (item.z ?? 0) <= 0 ||
      mm((item.z ?? 0) + item.height_cm + policy.lift_clearance_cm) > heightMm ||
      !item.support_item_id || supportedBy.has(item.support_item_id)) return reject();
    supportedBy.add(item.support_item_id);

    let layer = item;
    let tier = 1;
    while (layer.support_item_id) {
      const base = byId.get(layer.support_item_id);
      const support = packageByCargoId.get(layer.support_item_id);
      if (!base || !support || ++tier > policy.max_tiers ||
        !customerByPackageId.has(physical.id) || !customerByPackageId.has(support.id) ||
        (policy.owner_mode === 'SAME_CUSTOMER' && customerByPackageId.get(physical.id) !== customerByPackageId.get(support.id)) ||
        support.cargoKind !== 'STANDARD' || support.noTopLoadRequested || support.maxTopLoadG == null ||
        mm(layer.x) !== mm(base.x) || mm(layer.y) !== mm(base.y) ||
        mm(layer.length_cm) !== mm(base.length_cm) || mm(layer.width_cm) !== mm(base.width_cm) ||
        mm(layer.z ?? 0) !== mm((base.z ?? 0) + base.height_cm)) return reject();
      const total = (above.get(base.item_id) ?? 0n) + physical.weightG;
      if (total * 10n >= support.weightG * 3n || total > BigInt(support.maxTopLoadG)) return reject();
      above.set(base.item_id, total);
      layer = base;
    }
    if (mm(layer.z ?? 0) !== 0) return reject();
  }
}
