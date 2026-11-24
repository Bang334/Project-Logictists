import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { fingerprintOfflinePayload } from "@/features/driver-offline/services/offline-command-serialization";
import { createOfflineDriverCommandSyncService } from "@/features/driver-offline/services/offline-driver-command-sync.service";
import { createSingleFlight } from "@/features/driver-offline/services/single-flight";
import { authService } from "@/features/auth/services/auth.service";
import { tokenStorage } from "@/shared/storage/token-storage";
import { ApiError } from "@/shared/api/api-error";
import { offlineDriverCommandStorage } from "@/features/driver-offline/storage/offline-driver-command.storage";
import type {
  OfflineDriverCommand,
  OfflineDriverCommandPayload,
  OfflineDriverQueueSnapshot,
  OfflineDriverQueueSummary,
} from "@/features/driver-offline/types/offline-driver-command.types";

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: OfflineDriverQueueSnapshot = {
  ownerUserId: null,
  commands: [],
  isSyncing: false,
  lastSyncAt: null,
};
let activation: { ownerUserId: string; run: ReturnType<typeof createSingleFlight>['run']; onRejected: () => Promise<void> } | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

async function connected(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return state.isConnected === true && state.isInternetReachable !== false;
}

async function refresh(ownerUserId: string) {
  if (snapshot.ownerUserId !== ownerUserId) return;
  const current = activation;
  const commands = await offlineDriverCommandStorage.listForOwner(ownerUserId);
  if (activation !== current || snapshot.ownerUserId !== ownerUserId) return;
  snapshot = { ...snapshot, commands };
  emit();
}

function clearRetryTimer() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleNextRetry(ownerUserId: string) {
  clearRetryTimer();
  if (snapshot.ownerUserId !== ownerUserId) return;
  const nextRetryAt = snapshot.commands
    .filter((command) => command.state === "RETRY_WAIT" && command.nextRetryAt)
    .map((command) => new Date(command.nextRetryAt!).getTime())
    .filter((time) => Number.isFinite(time) && time > Date.now())
    .sort((left, right) => left - right)[0];
  if (nextRetryAt === undefined) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void offlineDriverExecutionCoordinator.sync(ownerUserId);
    },
    Math.max(0, nextRetryAt - Date.now()),
  );
}

function isUnsynced(command: OfflineDriverCommand) {
  return command.state !== "SYNCED";
}

export function summarizeOfflineCommands(
  commands: OfflineDriverCommand[],
): OfflineDriverQueueSummary {
  const count = (state: OfflineDriverCommand["state"]) =>
    commands.filter((command) => command.state === state).length;
  return {
    pending: count("PENDING") + count("RETRY_WAIT") + count("AUTH_PAUSED"),
    syncing: count("SYNCING"),
    conflict: count("CONFLICT"),
    failed: count("FAILED"),
    blocked: count("BLOCKED"),
    totalUnsynced: commands.filter(isUnsynced).length,
  };
}

export const offlineDriverExecutionCoordinator = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot() {
    return snapshot;
  },

  async activate(ownerUserId: string, onRejected: () => Promise<void>) {
    clearRetryTimer();
    const current = { ownerUserId, run: createSingleFlight().run, onRejected };
    activation = current;
    snapshot = {
      ownerUserId,
      commands: [],
      isSyncing: false,
      lastSyncAt: snapshot.ownerUserId === ownerUserId ? snapshot.lastSyncAt : null,
    };
    await offlineDriverCommandStorage.recoverInterrupted(ownerUserId);
    const restoredCommands =
      await offlineDriverCommandStorage.listForOwner(ownerUserId);
    for (const command of restoredCommands) {
      if (activation !== current) return;
      if (command.state === "AUTH_PAUSED") {
        await offlineDriverCommandStorage.update(ownerUserId, command.id, {
          state: "PENDING",
          nextRetryAt: null,
        });
      }
    }
    await refresh(ownerUserId);
    if (activation === current) await this.sync(ownerUserId);
  },

  deactivate() {
    activation = null;
    clearRetryTimer();
    snapshot = {
      ownerUserId: null,
      commands: [],
      isSyncing: false,
      lastSyncAt: null,
    };
    emit();
  },

  async enqueue(input: {
    ownerUserId: string;
    tripId: string;
    stopId: string;
    commandType: "ARRIVE_STOP" | "COMPLETE_STOP";
    observedTripVersion: number;
    payload: OfflineDriverCommandPayload;
    occurredAt: string;
  }) {
    const current = activation;
    if (!current || current.ownerUserId !== input.ownerUserId) {
      throw new ApiError("Cần xác thực lại trước khi ghi thao tác.", 401, "DRIVER_SESSION_REQUIRED");
    }
    const payloadFingerprint = await fingerprintOfflinePayload(input.payload);
    const existing = (
      await offlineDriverCommandStorage.listForOwner(input.ownerUserId)
    ).find(
      (command) =>
        command.tripId === input.tripId &&
        command.stopId === input.stopId &&
        command.commandType === input.commandType &&
        command.payloadFingerprint === payloadFingerprint &&
        isUnsynced(command),
    );
    if (activation !== current) {
      throw new ApiError("Phiên đã thay đổi trước khi ghi thao tác.", 401, "DRIVER_SESSION_REQUIRED");
    }
    if (!existing) {
      await offlineDriverCommandStorage.enqueue({
        id: Crypto.randomUUID(),
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        stopId: input.stopId,
        commandType: input.commandType,
        idempotencyKey: Crypto.randomUUID(),
        payload: input.payload,
        payloadFingerprint,
        observedTripVersion: input.observedTripVersion,
        occurredAt: input.occurredAt,
      });
    }
    if (snapshot.ownerUserId === input.ownerUserId) {
      await refresh(input.ownerUserId);
    }
    const isOnline = await connected();
    if (isOnline) await this.sync(input.ownerUserId);
    return { queued: true, syncAttempted: isOnline };
  },

  async sync(ownerUserId: string, manual = false): Promise<void> {
    const current = activation;
    if (!current || current.ownerUserId !== ownerUserId || !(await connected()) || activation !== current) return;
    return current.run(async () => {
      snapshot = { ...snapshot, isSyncing: true };
      emit();
      let completed = false;
      try {
        const commands = await offlineDriverCommandStorage.listForOwner(ownerUserId);
        if (activation !== current || !commands.some((command) =>
          ['PENDING', 'RETRY_WAIT', 'SYNCING', 'SYNCED'].includes(command.state))) return;
        const token = await tokenStorage.get();
        if (!token || activation !== current) return;
        const profile = await authService.getProfile(token);
        if (activation !== current) return;
        if (!profile.active || profile.id !== ownerUserId || profile.role !== "DRIVER") {
          await current.onRejected();
          return;
        }
        if (manual) {
          for (const command of commands) {
            if (activation !== current) return;
            if (command.state === "RETRY_WAIT") {
              await offlineDriverCommandStorage.update(
                ownerUserId,
                command.id,
                {
                  state: "PENDING",
                  nextRetryAt: null,
                },
              );
            }
          }
        }
        const syncService = createOfflineDriverCommandSyncService(offlineDriverCommandStorage, token, () => activation === current);
        const result = await syncService.sync(ownerUserId);
        if (activation !== current) return;
        if (result === "AUTH_PAUSED") {
          await current.onRejected();
          return;
        }
        completed = true;
        snapshot = { ...snapshot, lastSyncAt: new Date().toISOString() };
      } catch (error) {
        if (activation === current && error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          await current.onRejected();
        }
      } finally {
        if (activation === current) await refresh(ownerUserId).catch(() => undefined);
        if (activation === current) {
          snapshot = { ...snapshot, isSyncing: false };
          emit();
          if (completed) scheduleNextRetry(ownerUserId);
        }
      }
    });
  },

  async hasUnsynced(ownerUserId: string, tripId?: string) {
    const commands =
      await offlineDriverCommandStorage.listForOwner(ownerUserId);
    return commands.some(
      (command) =>
        isUnsynced(command) &&
        (tripId === undefined || command.tripId === tripId),
    );
  },
};
