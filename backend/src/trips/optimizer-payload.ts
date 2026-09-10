type PhysicalOrderItem = {
  id: string;
  orderId: string;
  description: string;
  quantity: number;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type OptimizerCargoUnit = {
  id: string;
  order_id: string;
  order_item_id: string;
  description: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  weight_kg: number;
  can_rotate: false;
};

/**
 * OrderItem là một dòng loại hàng: quantity là số kiện vật lý, weightKg là
 * tổng khối lượng dòng. Optimizer cần từng kiện có định danh riêng để packing.
 * Xoay kiện được khóa ở false cho tới khi có policy hướng xoay được phê duyệt.
 */
export function expandOrderItemsToCargoUnits(
  items: PhysicalOrderItem[],
): OptimizerCargoUnit[] {
  return items.flatMap((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Số lượng kiện của dòng hàng ${item.id} không hợp lệ`);
    }
    if (
      item.weightKg <= 0 ||
      item.lengthCm <= 0 ||
      item.widthCm <= 0 ||
      item.heightCm <= 0
    ) {
      throw new Error(`Khối lượng/kích thước dòng hàng ${item.id} không hợp lệ`);
    }
    const unitWeight = item.weightKg / item.quantity;
    const pad = String(item.quantity).length;
    return Array.from({ length: item.quantity }, (_, index) => ({
      id: `${item.id}#${String(index + 1).padStart(pad, '0')}`,
      order_id: item.orderId,
      order_item_id: item.id,
      description: item.description,
      length_cm: item.lengthCm,
      width_cm: item.widthCm,
      height_cm: item.heightCm,
      weight_kg: unitWeight,
      can_rotate: false as const,
    }));
  });
}
