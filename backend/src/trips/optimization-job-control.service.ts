import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export class OptimizationCancelledError extends Error {
  constructor(message = 'Job tối ưu đã bị hủy') {
    super(message);
    this.name = 'OptimizationCancelledError';
  }
}

export function isOptimizationAbortError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  if (error instanceof OptimizationCancelledError) return true;
  if (typeof axios.isCancel === 'function' && axios.isCancel(error)) return true;
  const candidate = error as { code?: unknown; name?: unknown } | undefined;
  return (
    candidate?.code === 'ERR_CANCELED' ||
    candidate?.name === 'AbortError' ||
    candidate?.name === 'CanceledError'
  );
}

export function throwIfOptimizationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OptimizationCancelledError();
  }
}

@Injectable()
export class OptimizationJobControlService {
  private readonly logger = new Logger(OptimizationJobControlService.name);
  private readonly activeControllers = new Map<string, AbortController>();

  register(jobId: string): AbortController {
    const previous = this.activeControllers.get(jobId);
    if (previous && !previous.signal.aborted) {
      previous.abort();
    }
    const controller = new AbortController();
    this.activeControllers.set(jobId, controller);
    return controller;
  }

  unregister(jobId: string, controller: AbortController): void {
    if (this.activeControllers.get(jobId) === controller) {
      this.activeControllers.delete(jobId);
    }
  }

  abort(jobId: string): boolean {
    const controller = this.activeControllers.get(jobId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  getSignal(jobId: string): AbortSignal | undefined {
    return this.activeControllers.get(jobId)?.signal;
  }

  async notifyPythonCancel(jobId: string): Promise<void> {
    const baseUrl = process.env.OPTIMIZER_URL || 'http://localhost:8000';
    try {
      await axios.post(
        `${baseUrl}/optimize-fleet/jobs/${encodeURIComponent(jobId)}/cancel`,
        undefined,
        { timeout: 1500 },
      );
    } catch (error) {
      const code = (error as { code?: unknown; response?: { status?: number } })?.code;
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (code === 'ECONNREFUSED' || status === 404) {
        return;
      }
      this.logger.debug(
        `Không thể gửi tín hiệu hủy job ${jobId} tới optimizer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
