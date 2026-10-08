import { Api, apiUrl } from "../api";
import { profileSchema } from "../contracts";
import { DriverStore } from "../store";
import {
  assignment,
  date,
  detail,
  harness,
  list,
  profile,
  reply,
} from "./fixtures";

test("configuration is explicit and rejects credentials", () => {
  expect(() => apiUrl(undefined)).toThrow("EXPO_PUBLIC_API_URL");
  expect(() => apiUrl("http://user:secret@host")).toThrow();
  expect(apiUrl("http://host/")).toBe("http://host");
});
test("login validates driver profile before storing token; double submit is ignored", async () => {
  const h = harness();
  await Promise.all([
    h.store.login(" a ", "password"),
    h.store.login("a", "password"),
  ]);
  expect(h.store.snapshot().profile?.id).toBe("driver-a");
  expect(h.saved()).toBe("token-a");
  expect(
    h.fetcher.mock.calls.filter(([p]) => String(p).endsWith("/auth/login")),
  ).toHaveLength(1);
  expect(h.store.snapshot().list?.data[0].id).toBe("a");
});
test.each([401, 403])(
  "login error %i never persists a session",
  async (status) => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(
      reply({ code: "DENIED", message: "Không được đăng nhập" }, status),
    );
    await h.store.login("a", "bad");
    expect(h.saved()).toBeNull();
    expect(h.store.snapshot().authenticated).toBe(false);
    expect(h.store.snapshot().error).toBe("Không được đăng nhập");
  },
);
test("login with no driver link revokes issued session and does not continue", async () => {
  const h = harness();
  h.fetcher
    .mockResolvedValueOnce(reply({ accessToken: "issued", expiresAt: date }))
    .mockResolvedValueOnce(reply({ message: "Thiếu quyền" }, 403));
  await h.store.login("a", "password");
  expect(h.saved()).toBeNull();
  expect(h.store.snapshot().profile).toBeNull();
  expect(
    h.fetcher.mock.calls.some(([p]) => String(p).endsWith("/auth/logout")),
  ).toBe(true);
});
test("backend unavailable is explicit; restore retains token for retry", async () => {
  const h = harness("token-a");
  h.fetcher.mockRejectedValueOnce(new Error("offline"));
  await h.store.restore();
  expect(h.store.snapshot().error).toContain("Không kết nối");
  expect(h.store.snapshot().profile).toBeNull();
  expect(h.saved()).toBe("token-a");
  await h.store.restore();
  expect(h.store.snapshot().profile?.id).toBe("driver-a");
});
test("reopen verifies profile, loads fresh assignments; logout clears storage and cache", async () => {
  const h = harness("token-a");
  await h.store.restore();
  expect(h.store.snapshot().profile?.id).toBe("driver-a");
  await h.store.open("a");
  expect(h.store.snapshot().detail?.trip.stops[0].tasks[0].package?.id).toBe(
    "parcel",
  );
  await h.store.logout();
  expect(h.saved()).toBeNull();
  expect(h.store.snapshot()).toMatchObject({
    authenticated: false,
    list: null,
    detail: null,
    profile: null,
  });
});
test("list loading, empty, failure and recovery", async () => {
  const h = harness("token-a");
  await h.store.restore();
  let resolve: (r: Response) => void = () => {
    throw new Error("not initialized");
  };
  h.fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const loading = h.store.loadList();
  expect(h.store.snapshot().loadingList).toBe(true);
  resolve(reply({ ...list, data: [], total: 0 }));
  await loading;
  expect(h.store.snapshot().list?.data).toEqual([]);
  h.fetcher.mockRejectedValueOnce(new Error("offline"));
  await h.store.loadList();
  expect(h.store.snapshot().error).toContain("Không kết nối");
  await h.store.loadList();
  expect(h.store.snapshot().list?.total).toBe(1);
});
test.each([401, 403])(
  "request %i has correct session behavior",
  async (status) => {
    const h = harness("token-a");
    await h.store.restore();
    h.fetcher.mockResolvedValueOnce(reply({ message: "Bị từ chối" }, status));
    await h.store.loadList();
    expect(h.store.snapshot().authenticated).toBe(status === 403);
    expect(h.saved()).toBe(status === 403 ? "token-a" : null);
  },
);
test.each(["accept", "reject"] as const)(
  "%s sends versions, trims reason, blocks duplicates and reloads server data",
  async (action) => {
    const h = harness("token-a");
    await h.store.restore();
    await h.store.open("a");
    const status = action === "accept" ? "ACCEPTED" : "REJECTED";
    h.fetcher
      .mockResolvedValueOnce(
        reply({
          id: "a",
          status,
          version: 2,
          tripId: "trip-a",
          tripVersion: 2,
          respondedAt: date,
        }),
      )
      .mockResolvedValueOnce(
        reply({ ...list, data: [{ ...assignment, status, version: 2 }] }),
      )
      .mockResolvedValueOnce(reply({ ...detail, status, version: 2 }));
    await Promise.all([
      h.store.respond(action, "  Lý do  "),
      h.store.respond(action, "Lý do"),
    ]);
    const commands = h.fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/" + action),
    );
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0][1]?.body))).toEqual({
      expectedVersion: 1,
      expectedTripVersion: 2,
      ...(action === "reject" ? { reason: "Lý do" } : {}),
    });
    expect(h.store.snapshot().detail?.status).toBe(status);
    expect(h.store.snapshot().intent).toBeNull();
  },
);
test("reject requires reason; uncertain retry reuses original key and payload", async () => {
  const h = harness("token-a");
  await h.store.restore();
  await h.store.open("a");
  await h.store.respond("reject", " ");
  expect(h.store.snapshot().error).toContain("lý do");
  h.fetcher.mockRejectedValueOnce(new Error("response lost"));
  await h.store.respond("reject", "Lý do");
  const intent = h.store.snapshot().intent;
  expect(intent).not.toBeNull();
  expect(h.store.snapshot().notice).toBeNull();
  h.fetcher.mockResolvedValueOnce(
    reply({
      id: "a",
      status: "REJECTED",
      version: 2,
      tripId: "trip-a",
      tripVersion: 2,
      respondedAt: date,
    }),
  );
  await h.store.respond("accept");
  const calls = h.fetcher.mock.calls.filter(([url]) =>
    String(url).endsWith("/reject"),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  expect(calls[0][1]?.headers).toEqual(calls[1][1]?.headers);
});
test("409 reloads detail and explains conflict", async () => {
  const h = harness("token-a");
  await h.store.restore();
  await h.store.open("a");
  h.fetcher
    .mockResolvedValueOnce(reply({ code: "VERSION_CONFLICT" }, 409))
    .mockResolvedValueOnce(reply(list))
    .mockResolvedValueOnce(reply({ ...detail, version: 3 }));
  await h.store.respond("accept");
  expect(h.store.snapshot().detail?.version).toBe(3);
  expect(h.store.snapshot().notice).toContain("đã thay đổi");
  expect(h.store.snapshot().intent).toBeNull();
});
test("old account response cannot populate the next account cache", async () => {
  const h = harness("token-a");
  await h.store.restore();
  let resolve: (r: Response) => void = () => {
    throw new Error("not initialized");
  };
  h.fetcher.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const oldRequest = h.store.open("a");
  await h.store.logout();
  h.fetcher
    .mockResolvedValueOnce(reply({ accessToken: "token-b", expiresAt: date }))
    .mockResolvedValueOnce(reply({ ...profile, id: "driver-b" }))
    .mockResolvedValueOnce(reply({ ...list, data: [], total: 0 }));
  await h.store.login("b", "password");
  resolve(reply(detail));
  await oldRequest;
  expect(h.store.snapshot().profile?.id).toBe("driver-b");
  expect(h.store.snapshot().detail).toBeNull();
  expect(h.store.snapshot().list?.data).toEqual([]);
});
test("malformed successful response is rejected at runtime", async () => {
  const api = new Api(
    "http://test",
    jest.fn(async () => reply({ password: "not-profile" })),
  );
  await expect(
    api.call("/driver/me", profileSchema, "token"),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
test("secure storage failure never reports successful login", async () => {
  const h = harness();
  h.storage.write = jest.fn(async () => {
    throw new Error("SecureStore unavailable");
  });
  const store = new DriverStore(
    new Api("http://test", h.fetcher),
    h.storage,
    () => "key",
  );
  await store.login("a", "password");
  expect(store.snapshot().authenticated).toBe(false);
  expect(store.snapshot().error).toContain("SecureStore");
});


test('foreground verification clears stale loading state and ignores the old detail request', async () => {
  const h = harness('token-a'); await h.store.restore();
  let resolve: (r: Response) => void = () => { throw new Error('not initialized'); };
  h.fetcher.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = h.store.open('a'); expect(h.store.snapshot().loadingDetail).toBe(true);
  await h.store.restore(); expect(h.store.snapshot().loadingDetail).toBe(false);
  resolve(reply(detail)); await pending;
  expect(h.store.snapshot().detail).toBeNull(); expect(h.store.snapshot().profile?.id).toBe('driver-a');
});
test('non-JSON 401 still clears the session', async () => {
  const h = harness('token-a'); await h.store.restore();
  h.fetcher.mockResolvedValueOnce({ ...reply(null, 401), json: async () => { throw new Error('HTML proxy error'); } });
  await h.store.loadList(); expect(h.saved()).toBeNull(); expect(h.store.snapshot().authenticated).toBe(false);
});
test('failed local logout never claims the token was erased', async () => {
  const h = harness('token-a'); await h.store.restore();
  h.storage.clear = jest.fn(async () => { throw new Error('secure storage unavailable'); });
  h.fetcher.mockRejectedValueOnce(new Error('offline'));
  await h.store.logout(); expect(h.saved()).toBe('token-a');
  expect(h.store.snapshot().error).toContain('Không xóa được');
  expect(h.store.snapshot().notice).not.toContain('Đã xóa');
  expect(h.store.snapshot().list).toBeNull(); expect(h.store.snapshot().profile).toBeNull();
});
