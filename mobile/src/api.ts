import { z } from "zod";
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function apiUrl(value: string | undefined): string {
  if (!value?.trim())
    throw new Error(
      "Thiếu EXPO_PUBLIC_API_URL. Cấu hình URL backend rồi khởi động lại Expo.",
    );
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(
      "EXPO_PUBLIC_API_URL phải là URL http/https hợp lệ, không chứa thông tin đăng nhập.",
    );
  }
}
export class Api {
  constructor(
    private readonly base: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async call<T>(
    path: string,
    schema: z.ZodType<T>,
    token: string | null,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await this.fetcher(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        signal: abort.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data: unknown;
      try { data = await response.json(); }
      catch {
        if (response.ok) throw new ApiError(502, 'INVALID_RESPONSE', 'Dữ liệu máy chủ không hợp lệ. Vui lòng thử tải lại.');
        // A proxy may return HTML; the HTTP auth status still invalidates access.
        data = undefined;
      }
      if (!response.ok) {
        const error = z
          .object({
            code: z.string().optional(),
            message: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .safeParse(data);
        const message = error.success ? error.data.message : undefined;
        throw new ApiError(
          response.status,
          error.success ? (error.data.code ?? "API_ERROR") : "API_ERROR",
          Array.isArray(message)
            ? message.join("\n")
            : (message ?? "Yêu cầu thất bại"),
        );
      }
      const result = schema.safeParse(data);
      if (!result.success)
        throw new ApiError(
          502,
          "INVALID_RESPONSE",
          "Dữ liệu máy chủ không hợp lệ. Vui lòng thử tải lại.",
        );
      return result.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại; thao tác chưa được xác nhận.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
