export const TOP_LOAD_PROTECTION_CHARGE = 'TOP_LOAD_PROTECTION';

export function readTopLoadProtectionFee(config: Record<string, unknown>): number | undefined {
  const value = config.TMS_TOP_LOAD_PROTECTION_FEE_VND;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error('TMS_TOP_LOAD_PROTECTION_FEE_VND phải là số VND nguyên dương');
  }
  return Number(value);
}

type ProtectionItem = { packages: Array<{ cargoKind?: string; noTopLoadRequested?: boolean; maxTopLoadG?: number | null }> };

export function hasOptionalTopLoadProtection(items: ProtectionItem[]): boolean {
  return items.some(item => item.packages.some(pkg =>
    pkg.cargoKind === 'STANDARD' && pkg.noTopLoadRequested === true && pkg.maxTopLoadG != null,
  ));
}
