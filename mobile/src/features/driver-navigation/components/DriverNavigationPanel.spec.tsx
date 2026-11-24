import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { DriverNavigationPanel } from "./DriverNavigationPanel";
import { openExternalNavigation } from "@/features/driver-navigation/services/external-navigation.service";
import type { DriverNavigationSelection } from "@/features/driver-navigation/types/driver-navigation.types";

jest.mock(
  "@/features/driver-navigation/services/external-navigation.service",
  () => ({
    ...jest.requireActual(
      "@/features/driver-navigation/services/external-navigation.service",
    ),
    openExternalNavigation: jest.fn(),
  }),
);

const target: DriverNavigationSelection = {
  stop: {
    id: "stop-1",
    sequence: 1,
    stopType: "PICKUP",
    status: "PENDING",
    address: "10 Đường QA",
    latitude: 10.7769,
    longitude: 106.7009,
    contactName: null,
    contactPhone: null,
    plannedArrivalTime: null,
    plannedDepartureTime: null,
    actualArrivalTime: null,
    actualDepartureTime: null,
    tasks: [],
  },
  basis: "SERVER",
  contextLabel: "Điểm tiếp theo",
  offlinePresentation: "SERVER_CONFIRMED",
  coordinateValid: true,
  blockedReason: null,
};

describe("DriverNavigationPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(openExternalNavigation).mockResolvedValue();
  });

  it("hiển thị target và mở navigation đúng một lần", async () => {
    const view = await render(<DriverNavigationPanel target={target} />);
    expect(view.getByText("Điểm tiếp theo")).toBeTruthy();
    expect(view.getByText("Lấy hàng · Điểm 1")).toBeTruthy();
    await fireEvent.press(
      view.getByRole("button", { name: "Điều hướng" }),
    );
    await waitFor(() =>
      expect(openExternalNavigation).toHaveBeenCalledWith(target.stop),
    );
    expect(openExternalNavigation).toHaveBeenCalledTimes(1);
  });

  it("chặn double tap khi Linking đang mở", async () => {
    let resolveOpen!: () => void;
    jest.mocked(openExternalNavigation).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const view = await render(<DriverNavigationPanel target={target} />);
    const button = view.getByRole("button", { name: "Điều hướng" });
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(openExternalNavigation).toHaveBeenCalledTimes(1);
    await act(() => resolveOpen());
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Điều hướng" })).toBeTruthy(),
    );
  });

  it("hiển thị lỗi thân thiện khi Linking thất bại", async () => {
    jest
      .mocked(openExternalNavigation)
      .mockRejectedValueOnce(new Error("linking failed"));
    const view = await render(<DriverNavigationPanel target={target} />);
    await fireEvent.press(
      view.getByRole("button", { name: "Điều hướng" }),
    );
    expect(
      await view.findByText("Không thể mở ứng dụng bản đồ."),
    ).toBeTruthy();
  });

  it("disable và không gọi service khi coordinate không hợp lệ", async () => {
    const view = await render(
      <DriverNavigationPanel
        target={{ ...target, coordinateValid: false }}
      />,
    );
    expect(
      view.getByText("Điểm dừng chưa có tọa độ hợp lệ để điều hướng."),
    ).toBeTruthy();
    await fireEvent.press(
      view.getByRole("button", { name: "Điều hướng" }),
    );
    expect(openExternalNavigation).not.toHaveBeenCalled();
  });

  it("không quảng bá navigation khi queue conflict", async () => {
    const view = await render(
      <DriverNavigationPanel
        target={{ ...target, blockedReason: "Cần xử lý đồng bộ." }}
      />,
    );
    expect(view.getByText("Cần xử lý đồng bộ.")).toBeTruthy();
    await fireEvent.press(
      view.getByRole("button", { name: "Điều hướng" }),
    );
    expect(openExternalNavigation).not.toHaveBeenCalled();
  });

  it("không render khi Trip không có target navigation", async () => {
    const view = await render(<DriverNavigationPanel target={null} />);
    expect(view.queryByTestId("driver-navigation-panel")).toBeNull();
  });
});
