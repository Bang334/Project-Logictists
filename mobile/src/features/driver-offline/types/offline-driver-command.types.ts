import type {
  DriverDeliveryResult,
  DriverExecutionReasonCode,
  DriverStopCommandResponse,
  DriverTaskExecutionPayload,
} from "@/features/driver-trips/types/driver-trip.types";

export type OfflineDriverCommandType = "ARRIVE_STOP" | "COMPLETE_STOP";

export type OfflineDriverCommandState =
  | "PENDING"
  | "SYNCING"
  | "RETRY_WAIT"
  | "AUTH_PAUSED"
  | "CONFLICT"
  | "FAILED"
  | "BLOCKED"
  | "SYNCED";

export type OfflineDriverTransmissionState = "NEVER_SENT" | "SENT_UNCERTAIN";

export interface OfflineArrivePayload {
  kind: "ARRIVE_STOP";
}

export interface OfflineCompletePayload {
  kind: "COMPLETE_STOP";
  tasks: DriverTaskExecutionPayload[];
  deliveryResult?: DriverDeliveryResult | null;
  reasonCode?: DriverExecutionReasonCode | null;
  note?: string | null;
  recipientName?: string | null;
}

export type OfflineDriverCommandPayload =
  OfflineArrivePayload | OfflineCompletePayload;

export interface OfflineDriverCommand {
  id: string;
  ownerUserId: string;
  tripId: string;
  stopId: string;
  commandType: OfflineDriverCommandType;
  sequence: number;
  idempotencyKey: string;
  payload: OfflineDriverCommandPayload;
  payloadFingerprint: string;
  observedTripVersion: number;
  wireExpectedVersion: number | null;
  transmissionState: OfflineDriverTransmissionState;
  state: OfflineDriverCommandState;
  occurredAt: string;
  retryCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  serverResult: DriverStopCommandResponse | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface EnqueueOfflineDriverCommandInput {
  id: string;
  ownerUserId: string;
  tripId: string;
  stopId: string;
  commandType: OfflineDriverCommandType;
  idempotencyKey: string;
  payload: OfflineDriverCommandPayload;
  payloadFingerprint: string;
  observedTripVersion: number;
  occurredAt: string;
}

export interface OfflineDriverQueueSnapshot {
  ownerUserId: string | null;
  commands: OfflineDriverCommand[];
  isSyncing: boolean;
  lastSyncAt: string | null;
}

export interface OfflineDriverQueueSummary {
  pending: number;
  syncing: number;
  conflict: number;
  failed: number;
  blocked: number;
  totalUnsynced: number;
}

export interface OfflineDriverCommandRepository {
  enqueue(
    input: EnqueueOfflineDriverCommandInput,
  ): Promise<OfflineDriverCommand>;
  listForOwner(ownerUserId: string): Promise<OfflineDriverCommand[]>;
  update(
    ownerUserId: string,
    commandId: string,
    changes: Partial<
      Pick<
        OfflineDriverCommand,
        | "state"
        | "transmissionState"
        | "wireExpectedVersion"
        | "retryCount"
        | "nextRetryAt"
        | "lastErrorCode"
        | "lastErrorMessage"
        | "serverResult"
        | "syncedAt"
      >
    >,
  ): Promise<void>;
  blockDescendants(
    ownerUserId: string,
    tripId: string,
    sequence: number,
  ): Promise<void>;
  deleteSyncedForTrip(ownerUserId: string, tripId: string): Promise<void>;
  recoverInterrupted(ownerUserId: string): Promise<void>;
}
