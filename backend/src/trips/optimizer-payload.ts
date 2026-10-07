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

export type OptimizerFleetVehicle = {
  id: string;
  source_vehicle_id?: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  payload_limit_kg: number;
};

export type OptimizerLocation = {
  id: string;
  source_location_id?: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type OptimizerOrder = {
  id: string;
  source_order_id?: string;
  source_order_number?: string;
  split_group_id?: string;
  allowed_source_vehicle_ids?: string[];
  order_number: string;
  pickup_location: OptimizerLocation;
  delivery_location: OptimizerLocation;
  items: OptimizerCargoUnit[];
  ordered_at_sec: number;
  order_value_vnd: number;
  service_time_sec: number;
};


function cargoFitsVehicle(
  cargo: OptimizerCargoUnit,
  vehicle: OptimizerFleetVehicle,
): boolean {
  if (cargo.weight_kg > vehicle.payload_limit_kg) return false;
  if (cargo.height_cm > vehicle.height_cm) return false;
  const orientations = cargo.can_rotate
    ? [
        [cargo.length_cm, cargo.width_cm],
        [cargo.width_cm, cargo.length_cm],
      ]
    : [[cargo.length_cm, cargo.width_cm]];
  return orientations.some(
    ([length, width]) =>
      length <= vehicle.length_cm && width <= vehicle.width_cm,
  );
}

function cargoSetFitsVehicle(
  cargo: OptimizerCargoUnit[],
  vehicle: OptimizerFleetVehicle,
): boolean {
  return (
    cargo.every((item) => cargoFitsVehicle(item, vehicle)) &&
    cargo.reduce((total, item) => total + item.weight_kg, 0) <=
      vehicle.payload_limit_kg &&
    cargo.reduce((total, item) => total + item.length_cm * item.width_cm, 0) <=
      vehicle.length_cm * vehicle.width_cm
  );
}

type VehicleBin = {
  vehicle: OptimizerFleetVehicle;
  items: OptimizerCargoUnit[];
};

type CargoAllocationResult =
  | { status: 'SOLVED'; bins: VehicleBin[] }
  | { status: 'INFEASIBLE' }
  | { status: 'SEARCH_LIMIT' };

const MAX_CARGO_ALLOCATION_STATES = 250_000;

function minimumBinCountForTotal(
  required: number,
  capacities: number[],
): number {
  let accumulated = 0;
  const sortedCapacities = [...capacities].sort((left, right) => right - left);
  for (let index = 0; index < sortedCapacities.length; index += 1) {
    accumulated += sortedCapacities[index];
    if (accumulated >= required) return index + 1;
  }
  return sortedCapacities.length + 1;
}

function allocateCargoToPhysicalVehicles(
  cargoUnits: OptimizerCargoUnit[],
  physicalVehicles: OptimizerFleetVehicle[],
): CargoAllocationResult {
  const bins: VehicleBin[] = physicalVehicles
    .map((vehicle) => ({ vehicle, items: [] }))
    .sort(
      (left, right) =>
        right.vehicle.length_cm * right.vehicle.width_cm -
          left.vehicle.length_cm * left.vehicle.width_cm ||
        right.vehicle.payload_limit_kg - left.vehicle.payload_limit_kg,
    );
  const sortedCargo = [...cargoUnits].sort((left, right) => {
    const leftCompatible = physicalVehicles.filter((vehicle) =>
      cargoFitsVehicle(left, vehicle),
    ).length;
    const rightCompatible = physicalVehicles.filter((vehicle) =>
      cargoFitsVehicle(right, vehicle),
    ).length;
    return (
      leftCompatible - rightCompatible ||
      right.length_cm * right.width_cm - left.length_cm * left.width_cm ||
      right.weight_kg - left.weight_kg
    );
  });

  const totalCargoWeight = sortedCargo.reduce(
    (total, cargo) => total + cargo.weight_kg,
    0,
  );
  const totalCargoArea = sortedCargo.reduce(
    (total, cargo) => total + cargo.length_cm * cargo.width_cm,
    0,
  );
  if (
    totalCargoWeight >
      bins.reduce((total, bin) => total + bin.vehicle.payload_limit_kg, 0) ||
    totalCargoArea >
      bins.reduce(
        (total, bin) => total + bin.vehicle.length_cm * bin.vehicle.width_cm,
        0,
      )
  ) {
    return { status: 'INFEASIBLE' };
  }

  const minimumVehicleCount = Math.max(
    1,
    minimumBinCountForTotal(
      totalCargoWeight,
      bins.map((bin) => bin.vehicle.payload_limit_kg),
    ),
    minimumBinCountForTotal(
      totalCargoArea,
      bins.map(
        (bin) => bin.vehicle.length_cm * bin.vehicle.width_cm,
      ),
    ),
  );

  let visitedStates = 0;
  let searchLimitReached = false;
  for (
    let vehicleLimit = minimumVehicleCount;
    vehicleLimit <= bins.length;
    vehicleLimit += 1
  ) {
    bins.forEach((bin) => bin.items.splice(0));

    const search = (cargoIndex: number): boolean => {
      if (cargoIndex >= sortedCargo.length) return true;
      visitedStates += 1;
      if (visitedStates > MAX_CARGO_ALLOCATION_STATES) {
        searchLimitReached = true;
        return false;
      }

      const cargo = sortedCargo[cargoIndex];
      const usedBinCount = bins.filter((bin) => bin.items.length > 0).length;
      const candidates = bins
        .filter(
          (bin) =>
            (bin.items.length > 0 || usedBinCount < vehicleLimit) &&
            cargoSetFitsVehicle([...bin.items, cargo], bin.vehicle),
        )
        .sort((left, right) => {
          const leftIsOpen = left.items.length > 0;
          const rightIsOpen = right.items.length > 0;
          if (leftIsOpen !== rightIsOpen) return leftIsOpen ? -1 : 1;

          // Khi cần mở xe mới, thử xe có sức chứa lớn hơn trước.
          if (!leftIsOpen) {
            return (
              right.vehicle.length_cm * right.vehicle.width_cm -
                left.vehicle.length_cm * left.vehicle.width_cm ||
              right.vehicle.payload_limit_kg -
                left.vehicle.payload_limit_kg
            );
          }

          const remainingArea = (bin: VehicleBin) =>
            bin.vehicle.length_cm * bin.vehicle.width_cm -
            [...bin.items, cargo].reduce(
              (total, item) => total + item.length_cm * item.width_cm,
              0,
            );
          const remainingWeight = (bin: VehicleBin) =>
            bin.vehicle.payload_limit_kg -
            [...bin.items, cargo].reduce(
              (total, item) => total + item.weight_kg,
              0,
            );
          return (
            remainingArea(left) - remainingArea(right) ||
            remainingWeight(left) - remainingWeight(right)
          );
        });

      // Hai xe có cùng sức chứa còn lại là hai nhánh tương đương ở bước này.
      const triedEquivalentBins = new Set<string>();
      for (const bin of candidates) {
        const usedArea = bin.items.reduce(
          (total, item) => total + item.length_cm * item.width_cm,
          0,
        );
        const usedWeight = bin.items.reduce(
          (total, item) => total + item.weight_kg,
          0,
        );
        const signature = [
          bin.vehicle.length_cm,
          bin.vehicle.width_cm,
          bin.vehicle.height_cm,
          bin.vehicle.payload_limit_kg - usedWeight,
          bin.vehicle.length_cm * bin.vehicle.width_cm - usedArea,
        ].join(':');
        if (triedEquivalentBins.has(signature)) continue;
        triedEquivalentBins.add(signature);

        bin.items.push(cargo);
        if (search(cargoIndex + 1)) return true;
        bin.items.pop();
        if (searchLimitReached) return false;
      }
      return false;
    };

    if (search(0)) return { status: 'SOLVED', bins };
    if (searchLimitReached) return { status: 'SEARCH_LIMIT' };
  }

  return { status: 'INFEASIBLE' };
}

/**
 * Chia một đơn vượt sức chứa của mọi xe thành các phần theo kiện nguyên vẹn.
 *
 * Mỗi phần được gắn với một xe vật lý riêng. Đây là kiểm tra bảo thủ theo tải,
 * kích thước kiện và diện tích sàn; SpatialValidator vẫn là lớp quyết định cuối
 * cùng về bố trí và đường xếp/dỡ.
 */
export function splitOversizedOrdersAcrossFleet<T extends OptimizerOrder>(
  orders: T[],
  vehicles: OptimizerFleetVehicle[],
): T[] {
  const physicalVehicles = Array.from(
    new Map(
      vehicles.map((vehicle) => [
        vehicle.source_vehicle_id ?? vehicle.id,
        vehicle,
      ]),
    ).values(),
  );

  return orders.flatMap((order) => {
    if (
      order.items.length <= 1 ||
      physicalVehicles.some((vehicle) =>
        cargoSetFitsVehicle(order.items, vehicle),
      )
    ) {
      return [order];
    }

    if (
      order.items.some(
        (cargo) =>
          !physicalVehicles.some((vehicle) => cargoFitsVehicle(cargo, vehicle)),
      )
    ) {
      return [order];
    }

    const allocation = allocateCargoToPhysicalVehicles(
      order.items,
      physicalVehicles,
    );
    if (allocation.status === 'SEARCH_LIMIT') {
      throw new Error(
        `Không thể chứng minh cách chia kiện cho đơn ${order.order_number} trong giới hạn tìm kiếm`,
      );
    }
    if (allocation.status === 'INFEASIBLE') return [order];

    const usedBins = allocation.bins.filter((bin) => bin.items.length > 0);
    if (usedBins.length <= 1) return [order];

    return usedBins.map((bin, index) => {
      const allocationId = `${order.id}::split:${index + 1}`;
      const share = bin.items.length / order.items.length;
      return {
        ...order,
        id: allocationId,
        source_order_id: order.source_order_id ?? order.id,
        source_order_number: order.source_order_number ?? order.order_number,
        split_group_id: order.source_order_id ?? order.id,
        allowed_source_vehicle_ids: [
          bin.vehicle.source_vehicle_id ?? bin.vehicle.id,
        ],
        order_number: `${order.order_number} (${index + 1}/${usedBins.length})`,
        pickup_location: {
          ...order.pickup_location,
          id: `${order.pickup_location.id}::split:${index + 1}`,
          source_location_id:
            order.pickup_location.source_location_id ??
            order.pickup_location.id,
        },
        delivery_location: {
          ...order.delivery_location,
          id: `${order.delivery_location.id}::split:${index + 1}`,
          source_location_id:
            order.delivery_location.source_location_id ??
            order.delivery_location.id,
        },
        items: bin.items,
        order_value_vnd: Math.round(order.order_value_vnd * share),
      };
    });
  });
}
