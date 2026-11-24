import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import { driverPodService } from '@/features/driver-trips/services/driver-pod.service';
import type {
  DriverPodCollection,
  DriverPodEvidenceType,
  DriverPodLocalFile,
  DriverPodView,
} from '@/features/driver-trips/types/driver-trip.types';
import { validatePodLocalFile } from '@/features/driver-trips/validation/driver-pod.validation';
import { ApiError } from '@/shared/api/api-error';
import { useDriverTripApiError } from './useDriverTripApiError';

interface PendingUpload {
  fingerprint: string;
  idempotencyKey: string;
  evidenceType: DriverPodEvidenceType;
  file: DriverPodLocalFile;
  capturedAt: string;
  supersedesId?: string;
}

interface DriverPodUploadState {
  pending: PendingUpload | null;
  uploading: boolean;
}

const idleUpload: DriverPodUploadState = { pending: null, uploading: false };

export function createDriverPodUploadStore() {
  const uploads = new Map<string, DriverPodUploadState>();
  const listeners = new Set<() => void>();
  return {
    get: (attemptId: string) => uploads.get(attemptId) ?? idleUpload,
    set(attemptId: string, state: DriverPodUploadState) {
      if (state.uploading || state.pending) uploads.set(attemptId, state);
      else uploads.delete(attemptId);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type DriverPodUploadStore = ReturnType<typeof createDriverPodUploadStore>;

interface Options {
  tripId: string;
  stopId: string;
  attemptId: string;
  onUploadChange?: (uploading: boolean) => void;
  uploadStore?: DriverPodUploadStore;
}

export function useDriverPod({ tripId, stopId, attemptId, onUploadChange, uploadStore }: Options) {
  const [localStore] = useState(createDriverPodUploadStore);
  const store = uploadStore ?? localStore;
  const getUpload = useCallback(() => store.get(attemptId), [attemptId, store]);
  const uploadStatus = useSyncExternalStore(store.subscribe, getUpload, getUpload);
  const [pod, setPod] = useState<DriverPodCollection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isViewing, setIsViewing] = useState(false);
  const latestRead = useRef(0);
  const mounted = useRef(false);
  const handleApiError = useDriverTripApiError();

  const load = useCallback(() => {
    const read = ++latestRead.current;
    return driverPodService.getPod(tripId, stopId, attemptId)
      .then((next) => {
        if (read === latestRead.current) setPod(next);
      })
      .catch(async (caughtError: unknown) => {
        if (read !== latestRead.current) return;
        const message = await handleApiError(caughtError);
        if (read === latestRead.current) setError(message);
      })
      .finally(() => {
        if (read === latestRead.current) setIsLoading(false);
      });
  }, [attemptId, handleApiError, stopId, tripId]);

  const reload = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      latestRead.current += 1;
    };
  }, [load]);

  const performUpload = useCallback(
    async (upload: PendingUpload): Promise<boolean> => {
      if (getUpload().uploading) return false;
      store.set(attemptId, { uploading: true, pending: upload });
      onUploadChange?.(true);
      setError(null);
      let retryUpload: PendingUpload | null = null;
      try {
        await driverPodService.uploadPod(
          tripId,
          stopId,
          attemptId,
          upload.evidenceType,
          upload.file,
          upload.capturedAt,
          upload.idempotencyKey,
          upload.supersedesId,
        );
        if (mounted.current) await reload();
        return true;
      } catch (caughtError) {
        const shouldKeepForRetry =
          caughtError instanceof ApiError &&
          (caughtError.status === 0 ||
            caughtError.status === 503 ||
            caughtError.code === 'IDEMPOTENCY_COMMAND_IN_PROGRESS');
        if (shouldKeepForRetry) retryUpload = upload;
        if (mounted.current) {
          const message = await handleApiError(caughtError);
          if (mounted.current) setError(message);
        }
        return false;
      } finally {
        store.set(attemptId, { uploading: false, pending: retryUpload });
        onUploadChange?.(false);
      }
    },
    [attemptId, getUpload, handleApiError, onUploadChange, reload, stopId, store, tripId],
  );

  const upload = useCallback(
    async (
      evidenceType: DriverPodEvidenceType,
      file: DriverPodLocalFile,
      capturedAt: string,
      supersedesId?: string,
    ) => {
      const previous = getUpload();
      if (previous.uploading) return false;
      const validation = validatePodLocalFile(evidenceType, file);
      if (!validation.success) {
        setError(validation.message);
        return false;
      }
      const fingerprint = JSON.stringify({
        attemptId,
        evidenceType,
        uri: file.uri,
        name: file.name,
        sizeBytes: file.sizeBytes ?? null,
        capturedAt,
        supersedesId: supersedesId ?? null,
      });
      const next: PendingUpload =
        previous.pending?.fingerprint === fingerprint
          ? previous.pending
          : {
              fingerprint,
              idempotencyKey: Crypto.randomUUID(),
              evidenceType,
              file,
              capturedAt,
              supersedesId,
            };
      return performUpload(next);
    },
    [attemptId, getUpload, performUpload],
  );

  const retry = useCallback(() => {
    const { pending } = getUpload();
    return pending ? performUpload(pending) : Promise.resolve(false);
  }, [getUpload, performUpload]);

  const getView = useCallback(
    async (podFileId: string): Promise<DriverPodView | null> => {
      setIsViewing(true);
      setError(null);
      try {
        return await driverPodService.getPodView(
          tripId,
          stopId,
          attemptId,
          podFileId,
        );
      } catch (caughtError) {
        setError(await handleApiError(caughtError));
        return null;
      } finally {
        setIsViewing(false);
      }
    },
    [attemptId, handleApiError, stopId, tripId],
  );

  return {
    pod,
    isLoading,
    isUploading: uploadStatus.uploading,
    isViewing,
    error,
    canRetry: !uploadStatus.uploading && uploadStatus.pending !== null,
    upload,
    retry,
    reload,
    getView,
    clearError: () => setError(null),
  };
}
