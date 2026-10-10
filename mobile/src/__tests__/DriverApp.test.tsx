import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { DriverApp } from "../DriverApp";
import { date, detail, harness, list, reply } from "./fixtures";
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));

test("login, list, detail and accept confirmation through UI", async () => {
  const h = harness();
  render(<DriverApp store={h.store} />);
  await screen.findByLabelText("Tên đăng nhập");
  fireEvent.changeText(screen.getByLabelText("Tên đăng nhập"), "a");
  fireEvent.changeText(screen.getByLabelText("Mật khẩu"), "password");
  fireEvent.press(screen.getByRole("button", { name: "Đăng nhập" }));
  await screen.findByText("Chuyến của tôi");
  fireEvent.press(screen.getByRole("button", { name: "Xem TRIP-A" }));
  await screen.findByText("Chuyến v2 · Phân công v1");
  fireEvent.press(screen.getByRole("button", { name: "Nhận chuyến" }));
  expect(screen.getByText("Xác nhận nhận chuyến này?")).toBeTruthy();
  expect(
    h.fetcher.mock.calls.some(([p]) => String(p).endsWith("/accept")),
  ).toBe(false);
  h.fetcher
    .mockResolvedValueOnce(
      reply({
        id: "a",
        status: "ACCEPTED",
        version: 2,
        tripId: "trip-a",
        tripVersion: 2,
        respondedAt: date,
      }),
    )
    .mockResolvedValueOnce(reply(list))
    .mockResolvedValueOnce(
      reply({ ...detail, status: "ACCEPTED", version: 2 }),
    );
  fireEvent.press(screen.getByRole("button", { name: "Xác nhận" }));
  await screen.findByText("Đã nhận");
  expect(screen.queryByRole("button", { name: "Nhận chuyến" })).toBeNull();
}, 20000);
test("reject UI requires reason and confirmed action", async () => {
  const h = harness("token-a");
  render(<DriverApp store={h.store} />);
  await screen.findByText("Chuyến của tôi");
  fireEvent.press(screen.getByRole("button", { name: "Xem TRIP-A" }));
  await screen.findByText("Chuyến v2 · Phân công v1");
  fireEvent.press(screen.getByRole("button", { name: "Từ chối chuyến" }));
  expect(screen.getByRole("button", { name: "Xác nhận" })).toBeDisabled();
  fireEvent.changeText(
    screen.getByLabelText("Lý do từ chối"),
    "Không thể nhận",
  );
  h.fetcher
    .mockResolvedValueOnce(
      reply({
        id: "a",
        status: "REJECTED",
        version: 2,
        tripId: "trip-a",
        tripVersion: 2,
        respondedAt: date,
      }),
    )
    .mockResolvedValueOnce(reply(list))
    .mockResolvedValueOnce(
      reply({
        ...detail,
        status: "REJECTED",
        version: 2,
        rejectionReason: "Không thể nhận",
      }),
    );
  fireEvent.press(screen.getByRole("button", { name: "Xác nhận" }));
  await screen.findByText("Đã từ chối");
  expect(screen.getByText("Lý do: Không thể nhận")).toBeTruthy();
});
test("empty list, network error, 403 retaining session and 401 login", async () => {
  const h = harness("token-a");
  render(<DriverApp store={h.store} />);
  await screen.findByText("Chuyến của tôi");
  h.fetcher.mockResolvedValueOnce(reply({ ...list, data: [], total: 0 }));
  await act(() => h.store.loadList());
  expect(screen.getByText("Chưa có chuyến được phân công.")).toBeTruthy();
  h.fetcher.mockRejectedValueOnce(new Error("offline"));
  fireEvent.press(screen.getByRole("button", { name: "Tải lại danh sách" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại; thao tác chưa được xác nhận.",
    ),
  );
  h.fetcher.mockResolvedValueOnce(reply({ message: "Thiếu quyền" }, 403));
  await act(() => h.store.loadList());
  expect(screen.getByRole("button", { name: "Đăng xuất" })).toBeTruthy();
  h.fetcher.mockResolvedValueOnce(reply({ message: "Phiên hết hạn" }, 401));
  await act(() => h.store.loadList());
  expect(screen.getByLabelText("Tên đăng nhập")).toBeTruthy();
});
