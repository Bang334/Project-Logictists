export type ApiErrorCode =
  | 'NETWORK_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_RESPONSE'
  | string;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Đã có lỗi không xác định. Vui lòng thử lại.';
}
