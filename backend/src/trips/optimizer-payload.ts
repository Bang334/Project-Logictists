import { PackageMeasurements, packageTotals } from '../orders/package-measurements';
export type PhysicalPackageLine = {
  id: string; orderId: string; description: string; quantity: number;
  packages: Array<PackageMeasurements & { id: string; orderItemId: string | null }>;
};
export type OptimizerCargoUnit = {
  id: string; order_id: string; order_item_id: string; description: string;
  length_cm: number; width_cm: number; height_cm: number; weight_kg: number; can_rotate: false;
};
/** Only persisted packages. Compatibility units are converted once at this boundary. */
export function packagesToCargoUnits(items: PhysicalPackageLine[]): OptimizerCargoUnit[] {
  const seen = new Set<string>();
  return items.flatMap(item => {
    if (!item.packages.length || item.quantity !== item.packages.length) throw new Error('Danh sách Package chưa được đối soát');
    packageTotals(item.packages);
    return item.packages.map(p => {
      if (p.orderItemId !== item.id || seen.has(p.id)) throw new Error('ID kiện trùng hoặc sai dòng hàng');
      if (p.weightG > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Khối lượng vượt độ chính xác contract optimizer');
      seen.add(p.id);
      return { id: p.id, order_id: item.orderId, order_item_id: item.id, description: item.description, length_cm: p.lengthMm / 10, width_cm: p.widthMm / 10, height_cm: p.heightMm / 10, weight_kg: Number(p.weightG) / 1000, can_rotate: false as const };
    });
  });
}
