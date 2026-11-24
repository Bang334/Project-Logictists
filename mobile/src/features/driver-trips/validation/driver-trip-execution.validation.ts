import type {
  CompleteDriverStopPayload,
  DriverDeliveryResult,
  DriverExecutionReasonCode,
  DriverTripStop,
} from "@/features/driver-trips/types/driver-trip.types";

export interface DriverStopExecutionForm {
  quantities: Record<string, string>;
  reasonCode: DriverExecutionReasonCode | null;
  note: string;
  recipientName: string;
}

export type StopCompletionData = Omit<
  CompleteDriverStopPayload,
  "idempotencyKey" | "expectedTripVersion" | "occurredAt"
>;

export type StopCompletionValidation =
  | { success: true; data: StopCompletionData }
  | { success: false; message: string };

export function createStopExecutionForm(
  stop: DriverTripStop,
): DriverStopExecutionForm {
  return {
    quantities: Object.fromEntries(
      stop.tasks.map((task) => [task.id, String(task.plannedQuantity)]),
    ),
    reasonCode: null,
    note: "",
    recipientName: "",
  };
}

export function inferDeliveryResult(
  stop: DriverTripStop,
  quantities: Record<string, string>,
): DriverDeliveryResult | null {
  if (stop.stopType !== "DELIVERY" || stop.tasks.length === 0) return null;
  const actual = stop.tasks.map((task) => Number(quantities[task.id]));
  if (actual.some((quantity) => !Number.isInteger(quantity))) return null;
  if (actual.every((quantity) => quantity === 0)) return "FAILED";
  if (
    actual.every(
      (quantity, index) => quantity === stop.tasks[index]?.plannedQuantity,
    )
  ) {
    return "SUCCESS";
  }
  return "PARTIAL";
}

export function validateStopCompletion(
  stop: DriverTripStop,
  form: DriverStopExecutionForm,
): StopCompletionValidation {
  const isDepot =
    stop.stopType === "DEPOT_START" || stop.stopType === "DEPOT_END";
  if (isDepot) {
    if (stop.tasks.length > 0) {
      return {
        success: false,
        message: "Điểm kho có task bất thường. Hãy tải lại chuyến.",
      };
    }
    return {
      success: true,
      data: { tasks: [], note: form.note.trim() || null },
    };
  }

  const expectedAction = stop.stopType === "PICKUP" ? "LOAD" : "UNLOAD";
  if (stop.tasks.some((task) => task.action !== expectedAction)) {
    return {
      success: false,
      message: "Loại thao tác của kiện hàng không khớp điểm dừng.",
    };
  }

  const tasks = [];
  for (const task of stop.tasks) {
    const raw = form.quantities[task.id]?.trim() ?? "";
    if (!/^\d+$/.test(raw)) {
      return {
        success: false,
        message: "Số lượng thực tế phải là số nguyên không âm.",
      };
    }
    const actualQuantity = Number(raw);
    if (actualQuantity > task.plannedQuantity) {
      return {
        success: false,
        message: `Số lượng thực tế không được vượt quá ${task.plannedQuantity}.`,
      };
    }
    tasks.push({ taskId: task.id, actualQuantity });
  }

  const hasShortage = tasks.some(
    (task, index) =>
      task.actualQuantity < (stop.tasks[index]?.plannedQuantity ?? 0),
  );
  const deliveryResult = inferDeliveryResult(stop, form.quantities);
  const needsReason =
    hasShortage || deliveryResult === "PARTIAL" || deliveryResult === "FAILED";
  if (needsReason && !form.reasonCode) {
    return {
      success: false,
      message: "Vui lòng chọn lý do khi số lượng thực tế bị thiếu.",
    };
  }
  if (form.reasonCode === "OTHER" && !form.note.trim()) {
    return {
      success: false,
      message: "Vui lòng nhập ghi chú khi chọn lý do Khác.",
    };
  }
  if (stop.stopType === "DELIVERY" && !deliveryResult) {
    return {
      success: false,
      message: "Không xác định được kết quả giao hàng.",
    };
  }
  if (
    stop.stopType === "DELIVERY" &&
    (deliveryResult === "SUCCESS" || deliveryResult === "PARTIAL") &&
    !form.recipientName.trim()
  ) {
    return {
      success: false,
      message:
        "Vui lòng nhập tên người nhận khi giao thành công hoặc một phần.",
    };
  }

  return {
    success: true,
    data: {
      tasks,
      deliveryResult,
      reasonCode: form.reasonCode,
      note: form.note.trim() || null,
      recipientName:
        stop.stopType === "DELIVERY" ? form.recipientName.trim() || null : null,
    },
  };
}
