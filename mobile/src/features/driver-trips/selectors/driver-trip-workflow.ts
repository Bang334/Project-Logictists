import { firstLocallyActionableStop, stopOfflinePresentation } from '@/features/driver-offline/selectors/offline-driver-overlay';
import type { OfflineDriverCommand, OfflineDriverQueueSummary } from '@/features/driver-offline/types/offline-driver-command.types';
import type { DriverTripDetail, DriverTripStop } from '../types/driver-trip.types';

export type TripPrimaryAction =
  | 'START' | 'OPEN_STOP' | 'SYNC' | 'POD' | 'COMPLETE' | null;

export const isDepot = (stop: DriverTripStop) =>
  stop.stopType === 'DEPOT_START' || stop.stopType === 'DEPOT_END';

const isResolved = (stop: DriverTripStop) =>
  stop.status === 'COMPLETED' || stop.status === 'SKIPPED';

export function selectTripWorkflow(
  trip: DriverTripDetail,
  commands: OfflineDriverCommand[],
  queue: OfflineDriverQueueSummary,
  readiness: Readonly<Record<string, boolean | null>>,
  online: boolean,
) {
  const resolvedCount = trip.stops.filter(isResolved).length;
  const skippedCount = trip.stops.filter((stop) => stop.status === 'SKIPPED').length;
  const canOperate = trip.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED';
  const active = trip.status === 'IN_PROGRESS';
  const blocked = queue.conflict + queue.failed + queue.blocked > 0;
  const actionable = active
    ? firstLocallyActionableStop(trip.stops, commands)
    : undefined;
  const actionableState = actionable ? stopOfflinePresentation(actionable.id, commands) : null;
  const localCompletedCount = trip.stops.filter((stop) =>
    !isResolved(stop) && stopOfflinePresentation(stop.id, commands) === 'COMPLETED_PENDING_SYNC',
  ).length;
  const missingPods = trip.stops.filter((stop) =>
    stop.stopType === 'DELIVERY' && stop.status === 'COMPLETED' &&
    (!stop.deliveryAttempt || readiness[stop.deliveryAttempt.id] !== true),
  );
  const podStop = missingPods.find((stop) => stop.deliveryAttempt);
  const unresolvedTasks = trip.stops.some((stop) => stop.tasks.some((task) => task.actualQuantity == null));
  const hasUnknownPod = missingPods.some((stop) =>
    stop.deliveryAttempt && readiness[stop.deliveryAttempt.id] == null,
  );
  let action: TripPrimaryAction = null;
  let message: string | null = null;
  if (canOperate && trip.status === 'DISPATCHED') {
    if (online) action = 'START';
    else message = 'Cần kết nối mạng để bắt đầu chuyến.';
  } else if (canOperate && active) {
    if (blocked) {
      action = 'SYNC';
      message = 'Kiểm tra thao tác bị xung đột hoặc chưa thể đồng bộ.';
    } else if (actionable) {
      action = 'OPEN_STOP';
    } else if (queue.totalUnsynced > 0) {
      action = 'SYNC';
      message = 'Chờ đồng bộ điểm dừng trước khi hoàn thành chuyến.';
    } else if (trip.stops.length === 0) {
      message = 'Chưa có điểm dừng để thực hiện.';
    } else if (!online) {
      message = 'Cần kết nối mạng để hoàn thành chuyến.';
    } else if (resolvedCount === trip.stops.length && unresolvedTasks) {
      message = 'Còn công việc tại điểm dừng chưa được máy chủ xác nhận.';
    } else if (resolvedCount === trip.stops.length && missingPods.length > 0) {
      action = podStop ? 'POD' : null;
      message = hasUnknownPod
        ? 'Chưa xác nhận được trạng thái e-POD. Kiểm tra bằng chứng trước khi hoàn thành chuyến.'
        : 'Cần tải ảnh e-POD bắt buộc trước khi hoàn thành chuyến.';
    } else if (resolvedCount === trip.stops.length) {
      action = 'COMPLETE';
    }
  }

  return { action, message, resolvedCount, skippedCount, localCompletedCount, actionable,
    actionableState, canOperate, blocked, hasUnknownPod, podStop };
}

export function selectStopAction(
  trip: DriverTripDetail,
  stop: DriverTripStop,
  commands: OfflineDriverCommand[],
  queue: OfflineDriverQueueSummary,
) {
  const presentation = stopOfflinePresentation(stop.id, commands);
  const allowed = trip.status === 'IN_PROGRESS' &&
    trip.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED' &&
    queue.conflict + queue.failed + queue.blocked === 0 &&
    firstLocallyActionableStop(trip.stops, commands)?.id === stop.id &&
    !['CONFLICT', 'FAILED', 'COMPLETED_PENDING_SYNC'].includes(presentation);
  if (allowed && stop.status === 'PENDING' && presentation === 'SERVER_CONFIRMED') {
    return { action: 'ARRIVE' as const, presentation };
  }
  if (allowed && (stop.status === 'ARRIVED' || presentation === 'ARRIVED_PENDING_SYNC')) {
    return { action: 'COMPLETE' as const, presentation };
  }
  return { action: null, presentation };
}

export const offlineStopLabel = {
  SERVER_CONFIRMED: null,
  ARRIVED_PENDING_SYNC: 'Đã đến · Chờ đồng bộ',
  COMPLETED_PENDING_SYNC: 'Đã thực hiện trên máy · Chờ đồng bộ',
  CONFLICT: 'Cần kiểm tra xung đột đồng bộ',
  FAILED: 'Đồng bộ thất bại hoặc bị chặn',
} as const;
