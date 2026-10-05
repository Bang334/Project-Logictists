import { BadRequestException } from '@nestjs/common';

/** Canonical persisted units. Each entry represents exactly one physical package. */
export interface PackageMeasurements {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  weightG: bigint;
}

export function packageTotals(packages: readonly PackageMeasurements[]) {
  let weightG = 0n;
  let volumeMm3 = 0n;
  for (const [index, item] of packages.entries()) {
    if (![item.lengthMm, item.widthMm, item.heightMm].every(value => Number.isSafeInteger(value) && value > 0)
      || item.weightG <= 0n) {
      throw new BadRequestException({ code: 'INVALID_PACKAGE_MEASUREMENTS', message: 'Số đo kiện phải là số nguyên dương theo mm/gram', field: `packages.${index}` });
    }
    weightG += item.weightG;
    volumeMm3 += BigInt(item.lengthMm) * BigInt(item.widthMm) * BigInt(item.heightMm);
  }
  return { totalPackages: packages.length, weightG, volumeMm3 };
}

/** Decimal strings preserve bigint precision at the JSON boundary. */
export function serializePackageTotals(packages: readonly PackageMeasurements[]) {
  const totals = packageTotals(packages);
  return {
    totalPackages: totals.totalPackages,
    totalWeightG: totals.weightG.toString(),
    totalVolumeMm3: totals.volumeMm3.toString(),
  };
}
