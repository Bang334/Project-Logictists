import { useCallback, useRef, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { useAuth } from "@/features/auth/hooks/useAuth";
import { offlineDriverExecutionCoordinator } from "@/features/driver-offline/services/offline-driver-execution.coordinator";
import { driverTripsService } from "@/features/driver-trips/services/driver-trips.service";
import type { DriverTripStateCommandResponse } from "@/features/driver-trips/types/driver-trip.types";
import type { StopCompletionData } from "@/features/driver-trips/validation/driver-trip-execution.validation";
import { ApiError } from "@/shared/api/api-error";
import { useDriverTripApiError } from "./useDriverTripApiError";

type DriverCommand =
  "START_TRIP" | "ARRIVE_STOP" | "COMPLETE_STOP" | "COMPLETE_TRIP";

interface PendingDirectCommand {
  fingerprint: string;
  idempotencyKey: string;
}

interface ExecuteOptions {
  command: DriverCommand;
  tripId: string;
  stopId?: string;
  expectedTripVersion: number;
  completion?: StopCompletionData;
}

export interface DriverTrackingLifecycleCallbacks {
  onTripStarted(response: DriverTripStateCommandResponse): Promise<void>;
  onTripCompleted(response: DriverTripStateCommandResponse): Promise<void>;
  onCompleteUncertain(): Promise<void>;
}

const REFRESH_ERROR_CODES = new Set([
  "TRIP_VERSION_CONFLICT",
  "INVALID_TRIP_STATE",
  "INVALID_STOP_STATE",
  "STOP_OUT_OF_SEQUENCE",
  "UNRESOLVED_STOPS",
]);

async function isOnline() {
  const network = await NetInfo.fetch();
  return network.isConnected === true && network.isInternetReachable !== false;
}

function friendlyExecutionError(error: ApiError): string | null {
  const messages: Record<string, string> = {
    DRIVER_NOT_PRIMARY: "Bạn không phải tài xế chính của chuyến này.",
    TRIP_START_BEFORE_SERVICE_DAY: "Chưa đến ngày thực hiện chuyến theo lịch chi nhánh.",
    TRIP_START_TOO_EARLY: "Chỉ có thể bắt đầu trong vòng 30 phút trước giờ dự kiến.",
    TRIP_START_SERVICE_DAY_EXPIRED: "Chuyến đã qua ngày thực hiện. Hãy liên hệ điều phối để kiểm tra lịch.",
    TRIP_START_SCHEDULE_INVALID: "Lịch chuyến cần điều phối kiểm tra.",
    VEHICLE_ALREADY_ON_TRIP: "Xe đang thực hiện chuyến khác. Hãy liên hệ điều phối.",
    TRIP_START_RESOURCE_RESERVED: "Tài xế hoặc xe đang giữ lịch cho chuyến khác. Hãy liên hệ điều phối.",
    TRIP_VERSION_CONFLICT:
      "Dữ liệu chuyến vừa thay đổi. Ứng dụng đã tải lại, vui lòng kiểm tra trước khi thao tác.",
    INVALID_TRIP_STATE:
      "Trạng thái chuyến hiện tại không cho phép thao tác này.",
    INVALID_STOP_STATE:
      "Trạng thái điểm dừng hiện tại không cho phép thao tác này.",
    STOP_OUT_OF_SEQUENCE: "Bạn cần xử lý điểm dừng trước đó trước.",
    UNRESOLVED_STOPS: "Chuyến vẫn còn điểm dừng hoặc kiện hàng chưa xử lý.",
    POD_REQUIRED:
      "Cần tải ảnh bằng chứng giao hàng bắt buộc trước khi hoàn thành chuyến.",
    IDEMPOTENCY_PAYLOAD_MISMATCH:
      "Nội dung đã thay đổi sau lần gửi chưa rõ kết quả. Vui lòng kiểm tra và gửi lại.",
    INVALID_TASK_EXECUTION: "Số lượng hoặc thao tác kiện hàng không hợp lệ.",
    DATA_INTEGRITY_CONFLICT:
      "Dữ liệu chuyến không còn nhất quán. Vui lòng tải lại và liên hệ điều phối.",
  };
  const message = messages[error.code];
  return message ? `${message} [${error.code}]` : null;
}

export function useDriverTripExecution(
  reloadTrip: () => Promise<void>,
  trackingLifecycle?: DriverTrackingLifecycleCallbacks,
) {
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasUncertainCommand, setHasUncertainCommand] = useState(false);
  const pendingDirect = useRef<PendingDirectCommand | null>(null);
  const submitting = useRef(false);
  const handleApiError = useDriverTripApiError();

  const execute = useCallback(
    async (options: ExecuteOptions): Promise<boolean> => {
      if (submitting.current) return false;
      submitting.current = true;
      setIsSubmitting(true);
      setError(null);
      setNotice(null);
      setHasUncertainCommand(false);

      try {
        if (
          options.command === "ARRIVE_STOP" ||
          options.command === "COMPLETE_STOP"
        ) {
          const occurredAt = new Date().toISOString();
          if (!user || user.role !== "DRIVER" || !options.stopId) {
            setError(
              "Không xác định được tài khoản hoặc điểm dừng cần thao tác.",
            );
            return false;
          }
          if (options.command === "COMPLETE_STOP" && !options.completion) {
            setError("Nội dung hoàn thành điểm dừng không hợp lệ.");
            return false;
          }
          const enqueueResult = await offlineDriverExecutionCoordinator.enqueue(
            {
              ownerUserId: user.id,
              tripId: options.tripId,
              stopId: options.stopId,
              commandType: options.command,
              observedTripVersion: options.expectedTripVersion,
              occurredAt,
              payload:
                options.command === "ARRIVE_STOP"
                  ? { kind: "ARRIVE_STOP" }
                  : { kind: "COMPLETE_STOP", ...options.completion! },
            },
          );
          setNotice(
            enqueueResult.syncAttempted
              ? "Đã ghi nhận thao tác và thực hiện đồng bộ."
              : "Đã ghi nhận ngoại tuyến. Thao tác sẽ đồng bộ khi có mạng.",
          );
          if (enqueueResult.syncAttempted) await reloadTrip();
          return true;
        }

        if (!(await isOnline())) {
          setError(
            options.command === "START_TRIP"
              ? "Cần kết nối mạng để bắt đầu chuyến."
              : "Cần kết nối mạng và đồng bộ toàn bộ thao tác trước khi hoàn thành chuyến.",
          );
          return false;
        }
        if (
          options.command === "COMPLETE_TRIP" &&
          user?.id &&
          (await offlineDriverExecutionCoordinator.hasUnsynced(
            user.id,
            options.tripId,
          ))
        ) {
          setError("Cần đồng bộ toàn bộ thao tác trước khi hoàn thành chuyến.");
          return false;
        }

        const fingerprint = JSON.stringify(options);
        const idempotencyKey =
          pendingDirect.current?.fingerprint === fingerprint
            ? pendingDirect.current.idempotencyKey
            : Crypto.randomUUID();
        pendingDirect.current = { fingerprint, idempotencyKey };
        const payload = {
          idempotencyKey,
          expectedTripVersion: options.expectedTripVersion,
        };
        if (options.command === "START_TRIP") {
          const response = await driverTripsService.startTrip(
            options.tripId,
            payload,
          );
          try {
            await trackingLifecycle?.onTripStarted(response);
          } catch {
            // Backend success is authoritative; GPS lifecycle reconciles later.
          }
        } else if (options.command === "COMPLETE_TRIP") {
          const response = await driverTripsService.completeTrip(
            options.tripId,
            payload,
          );
          try {
            await trackingLifecycle?.onTripCompleted(response);
          } catch {
            // Backend success is authoritative; GPS lifecycle reconciles later.
          }
        }
        pendingDirect.current = null;
        await reloadTrip();
        return true;
      } catch (caughtError) {
        const uncertain =
          caughtError instanceof ApiError && caughtError.status === 0;
        if (!uncertain) pendingDirect.current = null;
        setHasUncertainCommand(uncertain);
        if (uncertain && options.command === "COMPLETE_TRIP") {
          try {
            await trackingLifecycle?.onCompleteUncertain();
          } catch {
            // Do not infer final Trip state from a telemetry failure.
          }
        }
        if (
          caughtError instanceof ApiError &&
          REFRESH_ERROR_CODES.has(caughtError.code)
        ) {
          await reloadTrip();
        }
        const mapped =
          caughtError instanceof ApiError
            ? friendlyExecutionError(caughtError)
            : null;
        setError(mapped ?? (await handleApiError(caughtError)));
        return false;
      } finally {
        submitting.current = false;
        setIsSubmitting(false);
      }
    },
    [handleApiError, reloadTrip, trackingLifecycle, user],
  );

  return {
    execute,
    isSubmitting,
    error,
    notice,
    hasUncertainCommand,
    clearError: () => setError(null),
  };
}
