import * as Crypto from "expo-crypto";
import type {
  OfflineDriverCommandPayload,
  OfflineCompletePayload,
} from "@/features/driver-offline/types/offline-driver-command.types";

function canonicalComplete(payload: OfflineCompletePayload) {
  return {
    kind: payload.kind,
    tasks: [...payload.tasks]
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map((task) => ({
        taskId: task.taskId,
        actualQuantity: task.actualQuantity,
      })),
    deliveryResult: payload.deliveryResult ?? null,
    reasonCode: payload.reasonCode ?? null,
    note: payload.note ?? null,
    recipientName: payload.recipientName ?? null,
  };
}

export function canonicalizeOfflinePayload(
  payload: OfflineDriverCommandPayload,
): string {
  return JSON.stringify(
    payload.kind === "ARRIVE_STOP"
      ? { kind: "ARRIVE_STOP" }
      : canonicalComplete(payload),
  );
}

export async function fingerprintOfflinePayload(
  payload: OfflineDriverCommandPayload,
): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonicalizeOfflinePayload(payload),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOfflinePayload(
  value: string,
): OfflineDriverCommandPayload {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || typeof parsed.kind !== "string") {
    throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
  }
  if (parsed.kind === "ARRIVE_STOP") return { kind: "ARRIVE_STOP" };
  if (parsed.kind !== "COMPLETE_STOP" || !Array.isArray(parsed.tasks)) {
    throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
  }
  const tasks = parsed.tasks.map((task) => {
    if (
      !isRecord(task) ||
      typeof task.taskId !== "string" ||
      typeof task.actualQuantity !== "number" ||
      !Number.isInteger(task.actualQuantity) ||
      task.actualQuantity < 0
    ) {
      throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
    }
    return { taskId: task.taskId, actualQuantity: task.actualQuantity };
  });
  const nullableString = (field: string): string | null | undefined => {
    const fieldValue = parsed[field];
    if (fieldValue === undefined) return undefined;
    if (fieldValue === null || typeof fieldValue === "string")
      return fieldValue;
    throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
  };
  const deliveryResult = nullableString("deliveryResult");
  if (
    deliveryResult !== undefined &&
    deliveryResult !== null &&
    !["SUCCESS", "PARTIAL", "FAILED"].includes(deliveryResult)
  ) {
    throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
  }
  return {
    kind: "COMPLETE_STOP",
    tasks,
    deliveryResult: deliveryResult as OfflineCompletePayload["deliveryResult"],
    reasonCode: nullableString(
      "reasonCode",
    ) as OfflineCompletePayload["reasonCode"],
    note: nullableString("note"),
    recipientName: nullableString("recipientName"),
  };
}
