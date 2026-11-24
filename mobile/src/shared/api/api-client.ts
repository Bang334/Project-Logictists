import { getApiBaseUrl } from '@/shared/config/environment';
import * as FileSystem from 'expo-file-system/legacy';
import { ApiError } from './api-error';

const DEFAULT_TIMEOUT_MS = 15_000;

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  errorCode?: string;
  message?: unknown;
  correlationId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  if (!isRecord(value)) return {};
  return {
    errorCode:
      typeof value.errorCode === 'string' ? value.errorCode : undefined,
    message: value.message,
    correlationId:
      typeof value.correlationId === 'string'
        ? value.correlationId
        : undefined,
  };
}

function readMessage(message: unknown, fallback: string): string {
  if (typeof message === 'string' && message.trim()) return message;
  if (
    Array.isArray(message) &&
    message.every((item) => typeof item === 'string')
  ) {
    return message.join('\n');
  }
  return fallback;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  return parseResponseText(text, response.status);
}

function parseResponseText(text: string, status: number): unknown {
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      'Máy chủ trả về dữ liệu không hợp lệ.',
      status,
      'INVALID_RESPONSE',
    );
  }
}

function toApiError(payload: unknown, status: number): ApiError {
  const envelope = parseErrorEnvelope(payload);
  return new ApiError(
    readMessage(envelope.message, `Yêu cầu thất bại (${status}).`),
    status,
    envelope.errorCode ?? `HTTP_${status}`,
    envelope.correlationId,
  );
}

export const apiClient = {
  async request(path: string, options: ApiRequestOptions = {}): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const isFormData =
      typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body !== undefined && !isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    let requestBody: BodyInit | undefined;
    if (options.body !== undefined) {
      requestBody = isFormData
        ? (options.body as FormData)
        : JSON.stringify(options.body);
    }

    try {
      const response = await fetch(`${getApiBaseUrl()}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: requestBody,
        signal: controller.signal,
      });
      const payload = await parseResponseBody(response);

      if (!response.ok) {
        throw toApiError(payload, response.status);
      }

      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError(
          'Yêu cầu quá thời gian. Vui lòng kiểm tra kết nối và thử lại.',
          0,
          'REQUEST_TIMEOUT',
        );
      }
      throw new ApiError(
        'Không thể kết nối máy chủ. Hãy kiểm tra mạng và địa chỉ API.',
        0,
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  },

  async uploadMultipartFile(
    path: string,
    options: {
      token: string;
      fileUri: string;
      mediaType: string;
      fields: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<unknown> {
    const uploadTask = FileSystem.createUploadTask(
      `${getApiBaseUrl()}${path}`,
      options.fileUri,
      {
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: options.mediaType,
        httpMethod: 'POST',
        parameters: options.fields,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.token}`,
        },
      },
    );
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        void uploadTask.cancelAsync();
        reject(
          new ApiError(
            'Yêu cầu quá thời gian. Vui lòng kiểm tra kết nối và thử lại.',
            0,
            'REQUEST_TIMEOUT',
          ),
        );
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        uploadTask.uploadAsync(),
        timeoutPromise,
      ]);
      if (!result) {
        throw new ApiError(
          timedOut
            ? 'Yêu cầu quá thời gian. Vui lòng kiểm tra kết nối và thử lại.'
            : 'Không thể kết nối máy chủ. Hãy kiểm tra mạng và địa chỉ API.',
          0,
          timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
        );
      }
      const payload = parseResponseText(result.body, result.status);
      if (result.status < 200 || result.status >= 300) {
        throw toApiError(payload, result.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        'Không thể kết nối máy chủ. Hãy kiểm tra mạng và địa chỉ API.',
        0,
        'NETWORK_ERROR',
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },
};
