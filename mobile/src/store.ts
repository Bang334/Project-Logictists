import { z } from "zod";
import { Api, ApiError } from "./api";
import {
  AssignmentDetail,
  AssignmentList,
  detailSchema,
  listSchema,
  loginSchema,
  Profile,
  profileSchema,
  responseSchema,
} from "./contracts";
export interface TokenStorage {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}
type Intent = {
  id: string;
  action: "accept" | "reject";
  key: string;
  body: {
    expectedVersion: number;
    expectedTripVersion: number;
    reason?: string;
  };
};
export interface State {
  authenticated: boolean;
  restoring: boolean;
  profile: Profile | null;
  list: AssignmentList | null;
  detail: AssignmentDetail | null;
  busy: boolean;
  loadingList: boolean;
  loadingDetail: boolean;
  error: string | null;
  notice: string | null;
  intent: Intent | null;
}
const initial = (): State => ({
  authenticated: false,
  restoring: true,
  profile: null,
  list: null,
  detail: null,
  busy: false,
  loadingList: false,
  loadingDetail: false,
  error: null,
  notice: null,
  intent: null,
});
export class DriverStore {
  private state = initial();
  private token: string | null = null;
  private epoch = 0;
  private listRequest = 0;
  private detailRequest = 0;
  private storageTail: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(
    private readonly api: Api,
    private readonly storage: TokenStorage,
    private readonly uuid: () => string,
  ) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private set(change: Partial<State>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((fn) => fn());
  }
  private persist(operation: () => Promise<void>) {
    const next = this.storageTail.then(operation, operation);
    this.storageTail = next;
    return next;
  }
  private async failure(error: unknown, epoch: number) {
    if (epoch !== this.epoch) return;
    if (error instanceof ApiError && error.status === 401) {
      await this.logout(false);
      this.set({ error: this.state.error ? `${error.message}\n${this.state.error}` : error.message });
    } else
      this.set({
        error: error instanceof Error ? error.message : "Thao tác thất bại",
      });
  }
  async restore() {
    if (this.state.busy || (this.state.restoring && this.token)) return;
    const epoch = ++this.epoch;
    this.set({
      restoring: true,
      error: null,
      profile: null,
      list: null,
      detail: null,
      loadingDetail: false,
      loadingList: false,
    });
    try {
      const token = await this.storage.read();
      if (epoch !== this.epoch) return;
      this.token = token;
      this.set({ authenticated: !!token });
      if (token) {
        const profile = await this.api.call("/driver/me", profileSchema, token);
        if (epoch !== this.epoch) return;
        this.set({ profile });
        await this.loadList();
      }
    } catch (e) {
      await this.failure(e, epoch);
    } finally {
      if (epoch === this.epoch) this.set({ restoring: false });
    }
  }
  async login(username: string, password: string) {
    if (this.state.busy) return;
    if (!username.trim() || !password) {
      this.set({ error: "Nhập tên đăng nhập và mật khẩu." });
      return;
    }
    const epoch = ++this.epoch;
    this.set({ ...initial(), restoring: false, busy: true });
    let issued: string | null = null;
    try {
      const result = await this.api.call("/auth/login", loginSchema, null, {
        username: username.trim(),
        password,
      });
      issued = result.accessToken;
      const profile = await this.api.call("/driver/me", profileSchema, issued);
      if (epoch !== this.epoch) return;
      await this.persist(() => this.storage.write(result.accessToken));
      if (epoch !== this.epoch) return;
      this.token = issued;
      this.set({ authenticated: true, profile });
      await this.loadList();
    } catch (e) {
      if (issued) {
        try {
          await this.api.call("/auth/logout", z.unknown(), issued, {});
        } catch {
          /* Original login failure remains visible. */
        }
      }
      await this.failure(e, epoch);
    } finally {
      if (epoch === this.epoch) this.set({ busy: false });
    }
  }
  async logout(remote = true) {
    const token = this.token;
    const epoch = ++this.epoch;
    this.token = null;
    this.state = { ...initial(), restoring: false, busy: true };
    this.set({});
    let cleared = false;
    try {
      await this.persist(() => this.storage.clear());
      cleared = true;
    } catch {
      if (epoch === this.epoch)
        this.set({
          error:
            "Không xóa được phiên an toàn trên thiết bị. Hãy thử đăng xuất lại.",
          authenticated: true,
        });
    }
    if (remote && token) {
      try {
        await this.api.call("/auth/logout", z.unknown(), token, {});
      } catch {
        if (epoch === this.epoch)
          this.set({
            notice: cleared
              ? "Đã xóa phiên trên thiết bị; chưa xác nhận thu hồi phiên trên máy chủ do lỗi kết nối."
              : "Chưa xác nhận thu hồi phiên trên máy chủ do lỗi kết nối.",
          });
      }
    }
    if (epoch === this.epoch) this.set({ busy: false });
  }
  async loadList(page = 1) {
    const epoch = this.epoch,
      request = ++this.listRequest,
      token = this.token;
    if (!token) return;
    this.set({ loadingList: true, error: null });
    try {
      const list = await this.api.call(
        `/driver/assignments?page=${page}&limit=20`,
        listSchema,
        token,
      );
      if (epoch === this.epoch && request === this.listRequest)
        this.set({ list });
    } catch (e) {
      if (request === this.listRequest) await this.failure(e, epoch);
    } finally {
      if (epoch === this.epoch && request === this.listRequest)
        this.set({ loadingList: false });
    }
  }
  async open(id: string) {
    const epoch = this.epoch,
      request = ++this.detailRequest,
      token = this.token;
    if (!token) return;
    this.set({ loadingDetail: true, detail: null, error: null });
    try {
      const detail = await this.api.call(
        `/driver/assignments/${id}`,
        detailSchema,
        token,
      );
      if (epoch === this.epoch && request === this.detailRequest)
        this.set({ detail });
    } catch (e) {
      if (request === this.detailRequest) await this.failure(e, epoch);
    } finally {
      if (epoch === this.epoch && request === this.detailRequest)
        this.set({ loadingDetail: false });
    }
  }
  back() {
    ++this.detailRequest;
    this.set({ detail: null, loadingDetail: false, error: null });
  }
  async respond(action: "accept" | "reject", reason = "") {
    if (this.state.busy || !this.token) return;
    const detail = this.state.detail;
    let intent = this.state.intent;
    if (!intent) {
      if (!detail || detail.status !== "ASSIGNED") return;
      if (
        action === "reject" &&
        (!reason.trim() || reason.trim().length > 1000)
      ) {
        this.set({ error: "Nhập lý do từ chối (1–1000 ký tự)." });
        return;
      }
      intent = {
        id: detail.id,
        action,
        key: this.uuid(),
        body: {
          expectedVersion: detail.version,
          expectedTripVersion: detail.trip.version,
          ...(action === "reject" ? { reason: reason.trim() } : {}),
        },
      };
    }
    const epoch = this.epoch,
      token = this.token;
    this.set({ intent, busy: true, error: null, notice: null });
    try {
      await this.api.call(
        `/driver/assignments/${intent.id}/${intent.action}`,
        responseSchema,
        token,
        intent.body,
        intent.key,
      );
      if (epoch !== this.epoch) return;
      this.set({ intent: null, notice: "Máy chủ đã xác nhận phản hồi." });
      await this.loadList();
      if (epoch === this.epoch) await this.open(intent.id);
    } catch (e) {
      if (epoch !== this.epoch) return;
      if (e instanceof ApiError && e.status === 409) {
        this.set({
          intent: null,
          notice:
            "Kế hoạch hoặc phân công đã thay đổi. Đang tải lại; hãy kiểm tra trước khi phản hồi.",
        });
        await this.loadList();
        if (epoch === this.epoch) await this.open(intent.id);
      } else {
        // Uncertain transport failure retains the exact key and payload for retry.
        if (e instanceof ApiError && e.status >= 400 && e.status < 500)
          this.set({ intent: null });
        await this.failure(e, epoch);
      }
    } finally {
      if (epoch === this.epoch) this.set({ busy: false });
    }
  }
}
