import { act, fireEvent, render, waitFor, within } from "@testing-library/react-native";
import { Alert, FlatList, NativeModules, Platform } from "react-native";
import { startActivityAsync } from "expo-intent-launcher";
import { router, usePreventRemove } from "expo-router";
import { DriverTripDetailScreen } from "./DriverTripDetailScreen";
import { DriverTripListScreen } from "./DriverTripListScreen";
import { DriverTripStopsScreen } from "./DriverTripStopsScreen";
import { DriverStopExecutionScreen } from "./DriverStopExecutionScreen";
import { DriverStopPodScreen } from "./DriverStopPodScreen";
import { DriverTripIncidentsScreen } from "./DriverTripIncidentsScreen";
import { DriverTripSyncScreen } from "./DriverTripSyncScreen";
import { DriverPodPanel } from "../components/pod/DriverPodPanel";
import { DriverIncidentPanel } from "@/features/driver-incidents/components/DriverIncidentPanel";
import { driverPodService } from "../services/driver-pod.service";
import { DriverTripWorkspace, useDriverTripWorkspace } from "../providers/DriverTripWorkspace";
import { DriverTripMapScreen } from "@/features/driver-navigation/screens/DriverTripMapScreen";
import { useDriverTripDetail } from "@/features/driver-trips/hooks/useDriverTripDetail";
import { useDriverTripExecution } from "@/features/driver-trips/hooks/useDriverTripExecution";
import { useDriverTracking } from "@/features/driver-tracking/hooks/useDriverTracking";
import { useDriverTrips } from "@/features/driver-trips/hooks/useDriverTrips";
import { useOfflineDriverQueue } from "@/features/driver-offline/hooks/useOfflineDriverQueue";
import type { OfflineDriverCommand } from "@/features/driver-offline/types/offline-driver-command.types";
import type {
  DriverPodCollection,
  DriverTripDetail,
  DriverTripSummary,
} from "@/features/driver-trips/types/driver-trip.types";

const mockReload = jest.fn(async () => undefined);
const mockRefresh = jest.fn(async () => undefined);
const mockLoadMore = jest.fn(async () => undefined);
const mockLogout = jest.fn(async () => undefined);
const mockExecute = jest.fn(async () => true);
let mockPodSatisfied: boolean | null = true;
let mockIsOnline = true;
let mockStopId = "stop-1";
let mockTripId = "trip-1";
let mockAttemptId: string | undefined;
let mockFocused = true;
const mockMapRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };

jest.mock("@react-native-community/netinfo", () => ({
  useNetInfo: () => ({
    isConnected: mockIsOnline,
    isInternetReachable: mockIsOnline,
  }),
}));

jest.mock("expo-intent-launcher", () => ({ startActivityAsync: jest.fn() }));

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useRouter: () => mockMapRouter,
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest.requireActual("react").useEffect(() => mockFocused ? callback() : undefined, [callback, mockFocused]),
  useLocalSearchParams: () => ({ id: mockTripId, stopId: mockStopId, attemptId: mockAttemptId }),
  usePreventRemove: jest.fn(),
}));

jest.mock("@/features/driver-navigation/components/DriverTripMap", () => {
  const { Pressable, Text } = jest.requireActual("react-native");
  return {
    ConfiguredDriverTripMap: ({ onSelectStops }: { onSelectStops: (ids: string[]) => void }) => (
      <Pressable onPress={() => onSelectStops(["stop-1", "stop-2"])}><Text>QA marker group</Text></Pressable>
    ),
  };
});

jest.mock("@/features/auth/hooks/useAuth", () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

jest.mock("@/features/driver-trips/hooks/useDriverTrips", () => ({
  useDriverTrips: jest.fn(),
}));

jest.mock("@/features/driver-trips/hooks/useDriverTripDetail", () => ({
  useDriverTripDetail: jest.fn(),
}));

jest.mock("@/features/driver-trips/hooks/useDriverTripExecution", () => ({
  useDriverTripExecution: jest.fn(),
}));
jest.mock("@/features/driver-offline/hooks/useOfflineDriverQueue", () => ({
  useOfflineDriverQueue: jest.fn(),
}));
jest.mock("@/features/driver-tracking/hooks/useDriverTracking", () => ({
  useDriverTracking: jest.fn(),
}));
jest.mock("@/features/driver-tracking/components/DriverTrackingPanel", () => ({
  DriverTrackingPanel: () => null,
}));
jest.mock("@/features/driver-incidents/components/DriverIncidentPanel", () => ({
  DriverIncidentPanel: jest.fn(() => null),
}));
jest.mock("@/features/driver-trips/components/pod/DriverPodPanel", () => ({
  DriverPodPanel: jest.fn(() => null),
}));
jest.mock("../services/driver-pod.service", () => ({
  driverPodService: { getPod: jest.fn() },
}));

function podResult(attemptId: string, satisfied: boolean): DriverPodCollection {
  return {
    deliveryAttempt: { id: attemptId, result: "SUCCESS", recipientName: "QA" },
    requirements: {
      photoRequired: true, photoUploaded: satisfied, recipientRequired: true,
      recipientSatisfied: true, podSatisfied: satisfied,
    },
    items: satisfied ? [{
      id: "pod-1", evidenceType: "PHOTO", mediaType: "image/jpeg", sizeBytes: 1024,
      uploadStatus: "UPLOADED", capturedAt: "2026-11-20T00:00:00Z", uploadedAt: "2026-11-20T00:01:00Z",
      supersedesId: null, isSuperseded: false,
    }] : [],
  };
}

const summary: DriverTripSummary = {
  id: "trip-1",
  tripNumber: "TRIP-001",
  status: "DISPATCHED",
  version: 2,
  plannedStartTime: "2026-11-16T01:00:00.000Z",
  plannedEndTime: "2026-11-16T03:00:00.000Z",
  actualStartTime: null,
  actualEndTime: null,
  totalDistanceKm: 25.5,
  totalDurationMinutes: 120,
  vehicle: {
    id: "vehicle-1",
    plateNumber: "43C-12345",
    model: "Hino 500",
    vehicleType: "Truck",
  },
  assignment: {
    id: "assignment-1",
    role: "PRIMARY",
    status: "ASSIGNED",
    startTime: "2026-11-16T01:00:00.000Z",
    endTime: "2026-11-16T03:00:00.000Z",
  },
  stopCount: 2,
};

const detail: DriverTripDetail = {
  ...summary,
  stops: [
    {
      id: "stop-1",
      sequence: 1,
      stopType: "PICKUP",
      status: "PENDING",
      address: "Pickup address",
      latitude: 10,
      longitude: 106,
      contactName: "Sender",
      contactPhone: "0900000001",
      plannedArrivalTime: null,
      plannedDepartureTime: null,
      actualArrivalTime: null,
      actualDepartureTime: null,
      tasks: [
        {
          id: "task-load",
          action: "LOAD",
          plannedQuantity: 1,
          actualQuantity: null,
          order: { id: "order-1", orderNumber: "ORD-001" },
          package: {
            id: "package-1",
            packageCode: "PKG-001",
            weightKg: 12.5,
            lengthCm: 120,
            widthCm: 80,
            heightCm: 60,
            status: "ALLOCATED",
          },
        },
      ],
    },
    {
      id: "stop-2",
      sequence: 2,
      stopType: "DELIVERY",
      status: "ARRIVED",
      address: "Delivery address",
      latitude: 11,
      longitude: 107,
      contactName: "Receiver",
      contactPhone: "0900000002",
      plannedArrivalTime: null,
      plannedDepartureTime: null,
      actualArrivalTime: null,
      actualDepartureTime: null,
      tasks: [
        {
          id: "task-unload",
          action: "UNLOAD",
          plannedQuantity: 1,
          actualQuantity: 1,
          order: { id: "order-1", orderNumber: "ORD-001" },
          package: null,
        },
      ],
    },
  ],
};

function stopCompletionCommand(state: OfflineDriverCommand["state"]): OfflineDriverCommand {
  return {
    id: "cmd-1", ownerUserId: "driver-user", tripId: "trip-1", stopId: "stop-1",
    commandType: "COMPLETE_STOP", sequence: 1, idempotencyKey: "key",
    payload: { kind: "COMPLETE_STOP", tasks: [{ taskId: "task-load", actualQuantity: 1 }] },
    payloadFingerprint: "fingerprint", observedTripVersion: 2, wireExpectedVersion: null,
    transmissionState: "NEVER_SENT", state, occurredAt: "2026-11-16T01:00:00Z",
    retryCount: 0, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null,
    serverResult: null, createdAt: "2026-11-16T01:00:00Z", updatedAt: "2026-11-16T01:00:00Z", syncedAt: null,
  };
}

function completedStopsTrip(): DriverTripDetail {
  return {
    ...detail, status: "IN_PROGRESS", version: 8,
    stops: detail.stops.map((stop) => ({
      ...stop, status: "COMPLETED",
      tasks: stop.tasks.map((task) => ({ ...task, actualQuantity: 1 })),
      deliveryAttempt: stop.stopType === "DELIVERY"
        ? { id: "attempt-ready", attemptNumber: 1, result: "SUCCESS", recipientName: "QA" }
        : null,
    })),
  };
}

describe("Driver Trip screens", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPodSatisfied = true;
    mockIsOnline = true;
    mockStopId = "stop-1";
    mockTripId = "trip-1";
    mockAttemptId = undefined;
    mockFocused = true;
    jest.mocked(driverPodService.getPod).mockImplementation(async (_tripId, _stopId, attemptId) => {
      if (mockPodSatisfied === null) throw new Error("POD unavailable");
      return podResult(attemptId, mockPodSatisfied);
    });
    jest.mocked(useDriverTrips).mockReturnValue({
      hasSnapshot: true,
      loadMoreError: null,
      trips: [summary],
      error: null,
      isInitialLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      hasMore: false,
      reload: mockReload,
      refresh: mockRefresh,
      loadMore: mockLoadMore,
    });
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: detail,
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    jest.mocked(useDriverTripExecution).mockReturnValue({
      execute: mockExecute,
      isSubmitting: false,
      error: null,
      notice: null,
      hasUncertainCommand: false,
      clearError: jest.fn(),
    });
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      commands: [],
      summary: {
        pending: 0,
        syncing: 0,
        conflict: 0,
        failed: 0,
        blocked: 0,
        totalUnsynced: 0,
      },
      isSyncing: false,
      lastSyncAt: null,
      sync: jest.fn(async () => undefined),
    });
    jest.mocked(useDriverTracking).mockReturnValue({
      snapshot: {
        mode: "IDLE",
        tripId: null,
        pendingCount: 0,
        lastSyncAt: null,
        errorCode: null,
        warning: null,
      },
      lifecycle: {
        onTripStarted: jest.fn(),
        onTripCompleted: jest.fn(),
        onCompleteUncertain: jest.fn(),
      },
      retryPermissions: jest.fn(),
      flush: jest.fn(),
      openSettings: jest.fn(),
      startTracking: jest.fn(),
      isStartingTracking: false,
    });
  });

  it("yêu cầu tải đúng chuyến khi mở bản đồ từ trạng thái loading ban đầu", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: null,
      isLoading: true,
      error: null,
      reload: mockReload,
    });
    await render(<DriverTripMapScreen />);

    expect(useDriverTripDetail).toHaveBeenCalledWith("trip-1");
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it("báo thiếu Mapbox native và giữ nút điều hướng ngoài", async () => {
    const view = await render(<DriverTripMapScreen />);

    expect(view.getByText(/Ứng dụng đang mở thiếu Mapbox native/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Chỉ đường ngoài" })).toBeTruthy();
  });

  it("giữ vùng bản đồ tách khỏi vùng cuộn chi tiết", async () => {
    const view = await render(<DriverTripMapScreen />);
    const mapArea = view.getByTestId("driver-map-area");
    const scroll = view.getByTestId("driver-map-details");

    for (let ancestor = mapArea.parent; ancestor; ancestor = ancestor.parent) {
      expect(ancestor).not.toBe(scroll);
      expect(ancestor.props.testID).not.toBe("driver-map-details");
    }
    expect(scroll).toBeTruthy();
  });

  it("Map mở đúng Stop, có chi tiết liên hệ và Back về đúng chuyến khi đi từ deep link", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(<DriverTripMapScreen />);
    expect(view.getByText("1. Lấy hàng")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Chi tiết và chú giải" }));
    expect(view.getByText("Sender · 0900000001")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Mở điểm dừng" }));
    expect(mockMapRouter.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-1" },
    });
    expect(mockExecute).not.toHaveBeenCalled();
    await fireEvent.press(view.getByRole("button", { name: "Quay lại" }));
    expect(mockMapRouter.back).toHaveBeenCalledTimes(1);
    mockMapRouter.canGoBack.mockReturnValueOnce(false);
    await fireEvent.press(view.getByRole("button", { name: "Quay lại" }));
    expect(mockMapRouter.replace).toHaveBeenCalledWith({ pathname: "/trips/[id]", params: { id: "trip-1" } });
  });

  it("Map cho phép xem đúng từng Stop cùng tọa độ và quay về điểm hiện tại mà không tạo lệnh", async () => {
    const priorNative = NativeModules.RNMBXModule;
    const priorToken = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
    NativeModules.RNMBXModule = {};
    process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = "pk.test";
    try {
      jest.mocked(useDriverTripDetail).mockReturnValue({
        trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
      });
      const view = await render(<DriverTripMapScreen />);
      await fireEvent.press(view.getByText("QA marker group"));
      expect(view.getByText("Các điểm cùng tọa độ")).toBeTruthy();
      await fireEvent.press(view.getByRole("button", { name: "2. Giao hàng" }));
      expect(view.getByText("Delivery address")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Chỉ đường ngoài" })).toBeNull();
      await fireEvent.press(view.getByRole("button", { name: "Xem điểm dừng" }));
      expect(mockMapRouter.push).toHaveBeenCalledWith({
        pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-2" },
      });
      await fireEvent.press(view.getByRole("button", { name: "Về điểm hiện tại" }));
      expect(view.getByText("Pickup address")).toBeTruthy();
      expect(mockExecute).not.toHaveBeenCalled();
    } finally {
      if (priorNative === undefined) delete NativeModules.RNMBXModule;
      else NativeModules.RNMBXModule = priorNative;
      if (priorToken === undefined) delete process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
      else process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = priorToken;
    }
  });

  it("Map cho RELIEF xem điểm theo phân công và chặn nhãn thực thi", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", assignment: { ...detail.assignment, role: "RELIEF" } },
      isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(<DriverTripMapScreen />);
    expect(view.queryByRole("button", { name: "Mở điểm dừng" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Xem điểm dừng" }));
    expect(mockMapRouter.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-1" },
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("Map giữ ngữ cảnh xung đột tại đúng Stop và ẩn chỉ đường ngoài", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue(detail.id);
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [stopCompletionCommand("CONFLICT")],
      summary: { ...queue.summary, conflict: 1, totalUnsynced: 1 },
    });
    const view = await render(<DriverTripMapScreen />);
    expect(view.getByText("Điểm cần xử lý đồng bộ")).toBeTruthy();
    expect(view.getByText("Pickup address")).toBeTruthy();
    expect(view.getByText("Cần kiểm tra xung đột đồng bộ")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Chỉ đường ngoài" })).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["trip-1", "BACKGROUND", 0, "GPS · Đã có vị trí"],
    ["trip-1", "BACKGROUND", 121, "GPS · Vị trí đã cũ (> 2 phút)"],
    ["trip-1", "PERMISSION_DENIED", 0, "GPS · Chưa cấp quyền vị trí"],
    ["trip-1", "LOCATION_DISABLED", 0, "GPS · Dịch vụ vị trí đang tắt"],
    ["trip-other", "BACKGROUND", 0, "GPS · Chưa có vị trí"],
  ] as const)("Map scope GPS %s · %s · tuổi mẫu %s giây", async (gpsTripId, mode, age, label) => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const tracking = useDriverTracking(detail.id);
    jest.mocked(useDriverTracking).mockReturnValue({
      ...tracking,
      snapshot: { ...tracking.snapshot, tripId: gpsTripId, mode,
        latestLocalLocation: { latitude: 10, longitude: 106, measuredAt: new Date(Date.now() - age * 1000).toISOString() } },
    });
    const view = await render(<DriverTripMapScreen />);
    expect(view.getByText(label)).toBeTruthy();
    expect(tracking.startTracking).not.toHaveBeenCalled();
  });

  it("hiển thị list và điều hướng sang detail", async () => {
    const view = await render(<DriverTripListScreen />);

    expect(view.getByText("TRIP-001")).toBeTruthy();
    expect(view.getByText("43C-12345 · Truck")).toBeTruthy();
    fireEvent.press(view.getByLabelText("Xem chuyến TRIP-001"));

    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]",
      params: { id: "trip-1" },
    });
  });

  it("đổi status filter và gọi hook với trạng thái tương ứng", async () => {
    const view = await render(<DriverTripListScreen />);
    await act(async () => {
      fireEvent.press(view.getByText("Đang thực hiện"));
    });
    expect(useDriverTrips).toHaveBeenLastCalledWith("IN_PROGRESS");
  });

  it("header Chuyến giữ Back cho màn ngoài thanh tab", async () => {
    const view = await render(<DriverTripListScreen />);
    expect(view.queryByText("Đăng xuất")).toBeNull();
    expect(view.queryByRole("button", { name: "Tài khoản" })).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Quay lại" }));
    expect(router.back).toHaveBeenCalled();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("giữ mã đầy đủ cho TalkBack, mở đúng ID và hiển thị RELIEF chỉ xem", async () => {
    const code = "QA-DRIVER-2026-11-20-DISPATCH-000000000418";
    jest.mocked(useDriverTrips).mockReturnValue({
      ...useDriverTrips("ALL"),
      trips: [{ ...summary, tripNumber: code, assignment: { ...summary.assignment, role: "RELIEF" } }],
    });
    const view = await render(<DriverTripListScreen />);
    expect(view.getByText(/điểm dừng · Chỉ xem/)).toBeTruthy();
    expect(view.queryByText(code)).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: `Xem chuyến ${code}` }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]", params: { id: "trip-1" } });
  });

  it("phân biệt tải lần đầu, lỗi API và rỗng theo filter", async () => {
    const original = useDriverTrips("ALL");
    jest.mocked(useDriverTrips).mockReturnValue({ ...original, trips: [], isInitialLoading: true, hasSnapshot: false });
    const screen = () => <DriverTripListScreen initialStatus="COMPLETED" />;
    const view = await render(screen());
    expect(view.getByText("Đang tải chuyến…")).toBeTruthy();
    expect(view.queryByText("Không có chuyến theo bộ lọc")).toBeNull();
    jest.mocked(useDriverTrips).mockReturnValue({
      ...original, trips: [], isInitialLoading: false, hasSnapshot: false, error: "Không tải được danh sách",
    });
    await view.rerender(screen());
    expect(view.getByText("Không tải được danh sách")).toBeTruthy();
    expect(view.queryByText("Không có chuyến theo bộ lọc")).toBeNull();
    jest.mocked(useDriverTrips).mockReturnValue({ ...original, trips: [], isInitialLoading: false });
    await view.rerender(screen());
    expect(view.getByText("Không có chuyến theo bộ lọc")).toBeTruthy();
    await fireEvent.press(view.getByText("Xem tất cả chuyến"));
    expect(useDriverTrips).toHaveBeenLastCalledWith("ALL");
  });

  it("lỗi tải thêm giữ card và cho thử lại, offline giữ snapshot và khóa retry", async () => {
    jest.mocked(useDriverTrips).mockReturnValue({ ...useDriverTrips("ALL"), loadMoreError: "Lỗi trang tiếp" });
    const view = await render(<DriverTripListScreen />);
    expect(view.getByText("TRIP-001")).toBeTruthy();
    expect(view.getByText("Lỗi trang tiếp")).toBeTruthy();
    mockLoadMore.mockClear();
    await fireEvent.press(view.getByRole("button", { name: "Thử tải thêm" }));
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    mockIsOnline = false;
    await view.rerender(<DriverTripListScreen />);
    expect(view.getByText("Ngoại tuyến · Dữ liệu đã tải có thể đã cũ.")).toBeTruthy();
    expect(view.getByText("TRIP-001")).toBeTruthy();
    expect(view.getByRole("button", { name: "Thử tải thêm" })).toBeDisabled();
  });

  const overview = () => <DriverTripWorkspace tripId="trip-1"><DriverTripDetailScreen /></DriverTripWorkspace>;
  const stopsScreen = () => <DriverTripWorkspace tripId="trip-1"><DriverTripStopsScreen /></DriverTripWorkspace>;
  const stopScreen = () => <DriverTripWorkspace tripId="trip-1"><DriverStopExecutionScreen /></DriverTripWorkspace>;
  const syncScreen = () => <DriverTripWorkspace tripId="trip-1"><DriverTripSyncScreen /></DriverTripWorkspace>;
  const podScreen = () => <DriverTripWorkspace tripId="trip-1"><DriverStopPodScreen /></DriverTripWorkspace>;
  const incidentScreen = () => <DriverTripWorkspace tripId="trip-1"><DriverTripIncidentsScreen /></DriverTripWorkspace>;

  it("giữ Overview gọn và mở route danh sách điểm hoặc bản đồ", async () => {
    const view = await render(overview());

    expect(view.getByText("0/2 điểm đã xác nhận")).toBeTruthy();
    expect(view.queryByText("Delivery address")).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: "Xem tất cả điểm dừng" }));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops",
      params: { id: "trip-1" },
    });
    expect(view.queryByText("totalAmount")).toBeNull();
    expect(view.queryByText("planningSnapshot")).toBeNull();
    fireEvent.press(view.getByRole("button", { name: "Bản đồ" }));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/map",
      params: { id: "trip-1" },
    });
  });

  it.each([0, 1, 4, 50, 75])("giữ đủ %i điểm theo sequence, với danh sách dài chỉ mount một cửa sổ", async (count) => {
    const stops = Array.from({ length: count }, (_, index) => ({
      ...detail.stops[0]!,
      id: `stop-id-${index + 1}`, sequence: index + 1, address: `Đường QA ${index + 1}`,
    })).reverse();
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip: { ...detail, stops }, isLoading: false, error: null, reload: mockReload });
    const view = await render(stopsScreen());
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(view.getByText(`${count} điểm`)).toBeTruthy();
    expect(view.getByText("Điểm dừng hiển thị theo thứ tự kế hoạch.")).toBeTruthy();
    if (count === 0) {
      expect(view.getByText("Chuyến chưa có điểm dừng.")).toBeTruthy();
    } else {
      const renderedRows = view.getAllByTestId(/^driver-stop-row-/);
      expect(renderedRows[0]?.props.testID).toBe("driver-stop-row-stop-id-1");
      expect(renderedRows).toHaveLength(Math.min(8, count));
      await fireEvent.changeText(view.getByLabelText("Tìm điểm dừng"), `#${count}`);
      expect(view.getByTestId(`driver-stop-row-stop-id-${count}`)).toBeTruthy();
      expect(view.getByText(`1/${count} điểm hiển thị`)).toBeTruthy();
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("hiển thị công việc và kiện liên kết riêng, tìm tiếng Việt và liên hệ, rồi mở đúng ID", async () => {
    const pickup = { ...detail.stops[0]!, address: "Đường Nguyễn Huệ", plannedArrivalTime: detail.plannedStartTime };
    pickup.tasks = [
      ...pickup.tasks,
      { ...pickup.tasks[0]!, id: "task-2", order: { id: "ord-2", orderNumber: "ORD-2" } },
      { ...pickup.tasks[0]!, id: "task-3", package: null },
    ];
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, stops: [pickup, { ...detail.stops[1]!, plannedDepartureTime: detail.plannedEndTime }] },
      isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopsScreen());
    expect(view.getByText("3 công việc · 1 kiện liên kết")).toBeTruthy();
    expect(view.getByText(/Dự kiến đến/)).toBeTruthy();
    expect(view.getByText(/Dự kiến rời/)).toBeTruthy();
    const search = view.getByLabelText("Tìm điểm dừng");
    await fireEvent.changeText(search, "duong nguyen hue");
    expect(view.queryByTestId("driver-stop-row-stop-2")).toBeNull();
    await fireEvent.changeText(search, "090 000 0002");
    expect(view.getByTestId("driver-stop-row-stop-2")).toBeTruthy();
    await fireEvent.changeText(search, "Receiver");
    await fireEvent.press(view.getByTestId("driver-stop-row-stop-2"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-2" } });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["PENDING", "Đang xử lý", "Đã thực hiện trên máy · Chờ đồng bộ"],
    ["CONFLICT", "Cần chú ý", "Cần kiểm tra xung đột đồng bộ"],
    ["FAILED", "Cần chú ý", "Đồng bộ thất bại hoặc bị chặn"],
  ] as const)("thể hiện %s riêng với trạng thái server và giữ RELIEF chỉ xem", async (state, filter, label) => {
    mockIsOnline = false;
    const completed = { ...detail.stops[1]!, status: "COMPLETED" as const };
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", assignment: { ...detail.assignment, role: "RELIEF" }, stops: [detail.stops[0]!, completed] },
      isLoading: false, error: null, reload: mockReload,
    });
    jest.mocked(useOfflineDriverQueue).mockReturnValue({ ...useOfflineDriverQueue("trip-1"), commands: [stopCompletionCommand(state)] });
    const view = await render(stopsScreen());
    expect(view.getByText(/Ngoại tuyến/)).toBeTruthy();
    expect(view.getByText("Phân công này chỉ có quyền xem.")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Đã hoàn thành" }));
    expect(view.getByText("Đã hoàn tất")).toBeTruthy();
    expect(view.queryByTestId("driver-stop-row-stop-1")).toBeNull();
    await fireEvent.press(view.getByRole("button", { name: filter }));
    expect(view.getByRole("button", { name: "Xem điểm 1: Lấy hàng" })).toBeTruthy();
    expect(view.getByText("Chờ đến điểm")).toBeTruthy();
    expect(view.getByText(label)).toBeTruthy();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("bỏ bộ lọc đang ẩn điểm hiện tại và thử lại scrollToIndex sau khi đo hàng", async () => {
    const stops = Array.from({ length: 55 }, (_, index) => ({
      ...detail.stops[0]!, id: `stop-${index + 1}`, sequence: index + 1,
      status: index === 52 ? "ARRIVED" as const : index < 52 ? "COMPLETED" as const : "PENDING" as const,
    }));
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", stops }, isLoading: false, error: null, reload: mockReload,
    });
    const scrollToIndex = jest.spyOn(FlatList.prototype, "scrollToIndex")
      .mockImplementationOnce(function (this: FlatList, { index }) {
        this.props.onScrollToIndexFailed?.({ index, highestMeasuredFrameIndex: 7, averageItemLength: 140 });
      }).mockImplementation(() => {});
    const scrollToOffset = jest.spyOn(FlatList.prototype, "scrollToOffset").mockImplementation(() => {});
    try {
      const view = await render(stopsScreen());
      await fireEvent.press(view.getByRole("button", { name: "Chưa thực hiện" }));
      await fireEvent.changeText(view.getByLabelText("Tìm điểm dừng"), "#54");
      await fireEvent.press(view.getByRole("button", { name: "Đến điểm hiện tại" }));
      expect(view.getByText(/Đã bỏ bộ lọc/)).toBeTruthy();
      expect(view.getByRole("button", { name: "Tất cả" }).props.accessibilityState.selected).toBe(true);
      expect(view.getByLabelText("Tìm điểm dừng")).toHaveDisplayValue("");
      await waitFor(() => expect(scrollToIndex).toHaveBeenCalledTimes(2));
      expect(scrollToIndex).toHaveBeenNthCalledWith(2, expect.objectContaining({ index: 52, animated: false }));
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 52 * 140, animated: false });
      expect(mockExecute).not.toHaveBeenCalled();
    } finally {
      scrollToIndex.mockRestore();
      scrollToOffset.mockRestore();
    }
  });

  it("giữ tổng và số điểm còn lại theo server khi tìm/lọc, xóa tìm kiếm và mở bản đồ", async () => {
    const completed = { ...detail.stops[1]!, status: "COMPLETED" as const };
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", stops: [detail.stops[0]!, completed] },
      isLoading: false, error: null, reload: mockReload,
    });
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...useOfflineDriverQueue("trip-1"), commands: [stopCompletionCommand("PENDING")],
    });
    const view = await render(stopsScreen());
    expect(view.getByLabelText(`Mã chuyến ${detail.tripNumber}`)).toBeTruthy();
    expect(view.getByText("2 điểm")).toBeTruthy();
    expect(view.getByTestId("driver-stop-filters").props.horizontal).toBe(true);
    expect(view.getByText("1 điểm còn lại")).toBeTruthy();
    await fireEvent.changeText(view.getByLabelText("Tìm điểm dừng"), "Receiver");
    expect(view.getByRole("button", { name: "Đang xử lý" }).props.accessibilityHint).toBe("0 điểm");
    expect(view.getByRole("button", { name: "Đã hoàn thành" }).props.accessibilityHint).toBe("1 điểm");
    expect(view.getByText("1 điểm còn lại")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Xóa tìm kiếm" }));
    expect(view.queryByRole("button", { name: "Xóa tìm kiếm" })).toBeNull();
    expect(view.getByTestId("driver-stop-row-stop-1")).toBeTruthy();
    await fireEvent.press(within(view.getByTestId("driver-stop-map-bar")).getByRole("button", { name: "Bản đồ chuyến" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/map", params: { id: "trip-1" } });
    await fireEvent.press(view.getByRole("button", { name: "Quay lại" }));
    expect(router.back).toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("phân biệt Deep Link đang tải và lỗi tải danh sách", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip: null, isLoading: true, error: null, reload: mockReload });
    const view = await render(stopsScreen());
    expect(view.getByLabelText("Đang tải điểm dừng")).toBeTruthy();
    expect(view.queryByText("Chuyến chưa có điểm dừng.")).toBeNull();
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip: null, isLoading: false, error: "Không thể tải chuyến.", reload: mockReload });
    await view.rerender(stopsScreen());
    expect(view.getByText("Không thể tải chuyến.")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Thử lại" }));
    expect(mockReload).toHaveBeenCalledTimes(2);
  });

  it("giữ chi tiết task và package trong màn hình của đúng một điểm", async () => {
    const view = await render(stopScreen());
    expect(view.getByText(/Xếp hàng/)).toBeTruthy();
    expect(view.getByText("PKG-001")).toBeTruthy();
    expect(view.getByText("Đã phân bổ · 12,5 kg")).toBeTruthy();
    expect(view.getByText("120 × 80 × 60 cm")).toBeTruthy();
    expect(view.queryByText(/Dỡ hàng/)).toBeNull();
  });

  it("DISPATCHED hiển thị Start Trip và gửi current version", async () => {
    const view = await render(overview());
    expect(view.getByTestId("driver-navigation-panel")).toBeTruthy();
    expect(view.getByText("Điểm xem trước")).toBeTruthy();
    fireEvent.press(view.getByText("Bắt đầu chuyến"));
    expect(mockExecute).toHaveBeenCalledWith({
      command: "START_TRIP",
      tripId: "trip-1",
      expectedTripVersion: 2,
    });
  });

  it("IN_PROGRESS mở đúng route actionable và không tự ARRIVE", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", version: 3 },
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    const view = await render(overview());
    await fireEvent.press(view.getByText("Mở điểm hiện tại"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops/[stopId]",
      params: { id: "trip-1", stopId: "stop-1" },
    });
    expect(mockExecute).not.toHaveBeenCalled();
    const stopView = await render(stopScreen());
    await fireEvent.press(stopView.getByText("Đã đến điểm"));
    expect(mockExecute).toHaveBeenCalledWith({
      command: "ARRIVE_STOP",
      tripId: "trip-1",
      stopId: "stop-1",
      expectedTripVersion: 3,
    });
  });

  it("từ chối stopId ngoài chuyến và stop chưa đến lượt", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" },
      isLoading: false, error: null, reload: mockReload,
    });
    mockStopId = "unknown";
    const view = await render(stopScreen());
    expect(view.getByText("Không tìm thấy điểm dừng thuộc chuyến này.")).toBeTruthy();
    mockStopId = "stop-2";
    await view.rerender(stopScreen());
    expect(view.queryByText("Đã đến điểm")).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("giữ draft khi reload và xác nhận trước khi bỏ bằng Back", async () => {
    const trip: DriverTripDetail = {
      ...detail, status: "IN_PROGRESS",
      stops: detail.stops.map((stop) => stop.id === "stop-1" ? { ...stop, status: "ARRIVED" } : stop),
    };
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip, isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopScreen());
    await fireEvent.press(view.getByText("Lý do và ghi chú"));
    await fireEvent.changeText(view.getByLabelText("Ghi chú (không bắt buộc)"), "Nháp tại điểm lấy");
    await view.rerender(stopScreen());
    expect(view.getByDisplayValue("Nháp tại điểm lấy")).toBeTruthy();
    const [prevent, onBack] = jest.mocked(usePreventRemove).mock.lastCall ?? [];
    const repeat = jest.fn();
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    expect(prevent).toBe(true);
    onBack?.({ data: { action: { type: "GO_BACK" } }, repeat });
    expect(alert).toHaveBeenCalledWith("Bỏ nội dung đang nhập?", expect.any(String), expect.any(Array));
    expect(repeat).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  describe("liên hệ tại điểm dừng", () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, "OS", "android");
      jest.mocked(startActivityAsync).mockResolvedValue({ resultCode: 0 });
    });

    afterEach(() => jest.restoreAllMocks());

    it.each([
      ["DISPATCHED", "RELIEF", "stop-1", "0900000001"],
      ["IN_PROGRESS", "PRIMARY", "stop-2", "0900000002"],
    ] as const)("cho phép gọi với %s / %s", async (status, role, stopId, phone) => {
      mockStopId = stopId;
      jest.mocked(useDriverTripDetail).mockReturnValue({
        trip: { ...detail, status, assignment: { ...detail.assignment, role } },
        isLoading: false, error: null, reload: mockReload,
      });
      const view = await render(stopScreen());
      expect(view.getByText("Liên hệ tại điểm dừng")).toBeTruthy();
      expect(view.getByText(phone)).toBeTruthy();
      if (role === "RELIEF") expect(view.queryByText("Đã đến điểm")).toBeNull();
      await fireEvent.press(view.getByRole("button", { name: "Gọi điện" }));
      expect(startActivityAsync).toHaveBeenCalledTimes(1);
      expect(startActivityAsync).toHaveBeenCalledWith("android.intent.action.DIAL", { data: `tel:${phone}` });
      expect(router.push).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it.each(["COMPLETED", "CANCELLED"] as const)("che số ở chuyến %s", async (status) => {
      jest.mocked(useDriverTripDetail).mockReturnValue({
        trip: { ...detail, status }, isLoading: false, error: null, reload: mockReload,
      });
      const view = await render(stopScreen());
      expect(view.getByText("Sender")).toBeTruthy();
      expect(view.queryByText("0900000001")).toBeNull();
      expect(view.queryByRole("button", { name: "Gọi điện" })).toBeNull();
    });

    it.each([null, "0900000001;ext=1"])("ẩn gọi khi số thiếu hoặc không an toàn: %s", async (phone) => {
      const [first, ...rest] = detail.stops;
      if (!first) throw new Error("QA fixture requires a stop");
      jest.mocked(useDriverTripDetail).mockReturnValue({
        trip: { ...detail, stops: [{ ...first, contactPhone: phone }, ...rest] },
        isLoading: false, error: null, reload: mockReload,
      });
      const view = await render(stopScreen());
      expect(view.getByText("Chưa có số điện thoại hợp lệ.")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Gọi điện" })).toBeNull();
      expect(startActivityAsync).not.toHaveBeenCalled();
    });

    it("giữ một contact cấp điểm khi có nhiều Order và giữ nháp sau khi quay lại", async () => {
      const [first, ...rest] = detail.stops;
      const task = first?.tasks[0];
      if (!first || !task) throw new Error("QA fixture requires a task");
      const trip: DriverTripDetail = {
        ...detail, status: "IN_PROGRESS",
        stops: [{ ...first, status: "ARRIVED", tasks: [
          task, { ...task, id: "another-task", order: { id: "order-2", orderNumber: "ORD-002" } },
        ] }, ...rest],
      };
      mockIsOnline = false;
      jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
      const view = await render(stopScreen());
      await fireEvent.press(view.getByText("Lý do và ghi chú"));
      await fireEvent.changeText(view.getByLabelText("Ghi chú (không bắt buộc)"), "Nháp tại điểm lấy");
      expect(view.getAllByText("0900000001")).toHaveLength(1);
      await fireEvent.press(view.getByRole("button", { name: "Gọi điện" }));
      await view.rerender(stopScreen());
      expect(view.getByDisplayValue("Nháp tại điểm lấy")).toBeTruthy();
      expect(mockExecute).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    });

    it("thông báo có thể thử lại khi hệ thống không mở được Dialer", async () => {
      jest.mocked(startActivityAsync).mockRejectedValueOnce(new Error("no activity"));
      const view = await render(stopScreen());
      await fireEvent.press(view.getByRole("button", { name: "Gọi điện" }));
      expect(await view.findByText("Không thể mở trình quay số trên thiết bị này.")).toBeTruthy();
      expect(view.getByRole("button", { name: "Gọi điện" }).props.accessibilityState.disabled).toBe(false);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  it("chuyển route trong cùng workspace không gọi lifecycle GPS hay tự gửi lệnh", async () => {
    const track = useDriverTracking("trip-1");
    const view = await render(overview());
    await view.rerender(stopScreen());
    expect(useDriverTripExecution).toHaveBeenLastCalledWith(mockReload, track.lifecycle);
    expect(track.lifecycle.onTripStarted).not.toHaveBeenCalled();
    expect(track.lifecycle.onTripCompleted).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("chỉ đếm server-confirmed nếu stop đã hoàn thành trên máy và chưa đồng bộ", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue("trip-1");
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [stopCompletionCommand("PENDING")],
      summary: { ...queue.summary, pending: 1, totalUnsynced: 1 },
    });
    const view = await render(overview());
    expect(view.getByText("0/2 điểm đã xác nhận")).toBeTruthy();
    expect(view.getByText("Hoàn thành trên máy, chờ đồng bộ: 1")).toBeTruthy();
    await fireEvent.press(view.getByText("Mở điểm hiện tại"));
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ params: { id: "trip-1", stopId: "stop-2" } }));
  });

  it("ưu tiên xem đồng bộ khi conflict và chặn thao tác trên stop", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue("trip-1");
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [stopCompletionCommand("CONFLICT")],
      summary: { ...queue.summary, conflict: 1, totalUnsynced: 1 },
    });
    const view = await render(overview());
    await fireEvent.press(view.getByText("Xem đồng bộ"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/sync", params: { id: "trip-1" } });
    expect(view.queryByTestId("offline-driver-queue-panel")).toBeNull();
    const syncView = await render(syncScreen());
    expect(syncView.getByText("Xung đột dữ liệu")).toBeTruthy();
    const stopView = await render(stopScreen());
    expect(stopView.getByText("Cần kiểm tra xung đột đồng bộ")).toBeTruthy();
    expect(stopView.queryByText("Đã đến điểm")).toBeNull();
  });

  it("mở đồng bộ ngay cạnh chỉ báo và thử lại sau khi có mạng", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue("trip-1");
    const sync = jest.fn(async () => undefined);
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, sync, commands: [stopCompletionCommand("PENDING")],
      summary: { ...queue.summary, pending: 1, totalUnsynced: 1 },
    });
    mockIsOnline = false;
    const overviewView = await render(overview());
    expect(overviewView.getByText("Đồng bộ chuyến · 1 chưa đồng bộ")).toBeTruthy();
    await fireEvent.press(overviewView.getByRole("button", { name: "Đồng bộ" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/sync", params: { id: "trip-1" } });
    const view = await render(syncScreen());
    expect(view.getByText("Kết nối mạng để đồng bộ thao tác đã lưu.")).toBeTruthy();
    await fireEvent.press(view.getByText("Thử đồng bộ"));
    expect(sync).not.toHaveBeenCalled();
    mockIsOnline = true;
    await view.rerender(syncScreen());
    mockReload.mockClear();
    await fireEvent.press(view.getByText("Thử đồng bộ"));
    expect(sync).toHaveBeenCalledTimes(1);
    expect(mockReload).toHaveBeenCalled();
  });

  it("báo lỗi nếu thử đồng bộ thất bại và giữ số lệnh chờ", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue("trip-1");
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue,
      sync: jest.fn(async () => { throw new Error("sync failed"); }),
      commands: [stopCompletionCommand("PENDING")],
      summary: { ...queue.summary, pending: 1, totalUnsynced: 1 },
    });
    const view = await render(syncScreen());
    await fireEvent.press(view.getByText("Thử đồng bộ"));
    expect(await view.findByText("Chưa thể đồng bộ. Các thao tác vẫn được giữ trong hàng đợi.")).toBeTruthy();
    expect(view.getByText("Chờ đồng bộ: 1")).toBeTruthy();
  });

  it("hiển thị từng trạng thái hàng đợi của chuyến, gồm lệnh đã đồng bộ còn lưu", async () => {
    const queue = useOfflineDriverQueue("trip-1");
    const commands = [
      ["PENDING", "Chờ đồng bộ"],
      ["SYNCING", "Đang đồng bộ"],
      ["RETRY_WAIT", "Chờ thử lại"],
      ["AUTH_PAUSED", "Tạm dừng do phiên đăng nhập"],
      ["CONFLICT", "Xung đột dữ liệu"],
      ["FAILED", "Đồng bộ thất bại"],
      ["BLOCKED", "Bị chặn bởi thao tác trước"],
      ["SYNCED", "Đã đồng bộ"],
    ] as const;
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue,
      commands: commands.map(([state], index) => ({ ...stopCompletionCommand(state), id: `cmd-${index}` })),
      summary: { ...queue.summary, pending: 2, syncing: 1, conflict: 1, failed: 1, blocked: 1, totalUnsynced: 7 },
    });
    const view = await render(syncScreen());
    for (const [, label] of commands) expect(view.getByText(label)).toBeTruthy();
    expect(useOfflineDriverQueue).toHaveBeenCalledWith("trip-1");
  });

  it("chỉ hiển thị lệnh của chuyến, ưu tiên lỗi, giữ sequence và không tự đồng bộ khi mở lại", async () => {
    const queue = useOfflineDriverQueue("trip-1");
    const conflict = { ...stopCompletionCommand("CONFLICT"), sequence: 2, id: "conflict",
      lastErrorCode: "TRIP_VERSION_CONFLICT", lastErrorMessage: "secret from server" };
    const pending = { ...stopCompletionCommand("PENDING"), sequence: 1, id: "pending",
      transmissionState: "SENT_UNCERTAIN" as const };
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [pending, conflict, { ...conflict, id: "other", tripId: "trip-2" }],
    });
    const view = await render(syncScreen());
    expect(view.getAllByTestId(/^driver-sync-command/).map((item) => item.props.testID))
      .toEqual(["driver-sync-command-conflict", "driver-sync-command-pending"]);
    expect(view.getByText(/Phiên bản chuyến đã thay đổi/)).toBeTruthy();
    expect(view.queryByText(/secret from server/)).toBeNull();
    expect(view.getByText(/Chưa xác định kết quả gửi trước/)).toBeTruthy();
    expect(queue.commands).toHaveLength(0);
    await fireEvent.press(view.getByRole("button", { name: "Xem điểm dừng" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-1" } });
    await view.unmount();
    const reopened = await render(syncScreen());
    expect(reopened.getByTestId("driver-sync-command-pending")).toBeTruthy();
    expect(queue.sync).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("chuyến khác lỗi không làm mất trạng thái rỗng của chuyến hiện tại", async () => {
    const queue = useOfflineDriverQueue("trip-1");
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [{ ...stopCompletionCommand("FAILED"), tripId: "trip-2" }],
    });
    const view = await render(syncScreen());
    expect(view.getByText("Không có thao tác chờ đồng bộ.")).toBeTruthy();
    expect(view.queryByText("Đồng bộ thất bại")).toBeNull();
  });

  it("mở Sự cố từ Stop đang thực hiện bằng đúng Trip ID", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS" }, isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopScreen());
    await fireEvent.press(view.getByRole("button", { name: "Xem sự cố của chuyến" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/incidents", params: { id: "trip-1" } });
  });

  it.each([{ role: "RELIEF", status: "ASSIGNED" }, { role: "PRIMARY", status: "RELEASED" }])(
    "không cho execution khi phân công là %j",
    async (assignment) => {
      const trip = { ...detail, status: "IN_PROGRESS" as const, assignment: { ...detail.assignment, ...assignment } };
      jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
      const view = await render(overview());
      expect(view.getByText("Phân công này chỉ có quyền xem.")).toBeTruthy();
      expect(view.queryByText("Mở điểm hiện tại")).toBeNull();
      await fireEvent.press(view.getByRole("button", { name: "Xem điểm dừng" }));
      expect(router.push).toHaveBeenCalledWith({
        pathname: "/trips/[id]/stops/[stopId]", params: { id: "trip-1", stopId: "stop-1" },
      });
      const stopView = await render(stopScreen());
      expect(stopView.queryByText("Đã đến điểm")).toBeNull();
      expect(stopView.queryByTestId("driver-stop-action-bar")).toBeNull();
      expect(stopView.getByText("Phân công này chỉ có quyền xem.")).toBeTruthy();
      expect(mockExecute).not.toHaveBeenCalled();
    },
  );

  it("gửi COMPLETE_STOP điểm kho khi offline với đúng version và payload", async () => {
    mockIsOnline = false;
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail, status: "IN_PROGRESS", version: 7,
        stops: detail.stops.map((stop, index) => index === 0
          ? { ...stop, status: "ARRIVED", stopType: "DEPOT_START", tasks: [] }
          : stop),
      },
      isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopScreen());
    await fireEvent.press(view.getByText("Hoàn thành điểm kho"));
    expect(mockExecute).toHaveBeenCalledWith({
      command: "COMPLETE_STOP", tripId: "trip-1", stopId: "stop-1", expectedTripVersion: 7,
      completion: { tasks: [], note: null },
    });
  });

  it("giữ lý do, số lượng và người nhận khi giao một phần từ Stop", async () => {
    mockStopId = "stop-2";
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail, status: "IN_PROGRESS", version: 5,
        stops: detail.stops.map((stop) => stop.id === "stop-1"
          ? { ...stop, status: "COMPLETED" }
          : { ...stop, tasks: stop.tasks.map((task) => ({ ...task, plannedQuantity: 2 })) }),
      },
      isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopScreen());
    await fireEvent.changeText(view.getByLabelText("Số lượng thực tế task-unload"), "1");
    expect(view.getByText("Kết quả: Giao một phần")).toBeTruthy();
    await fireEvent.press(view.getByText("Sai số lượng"));
    await fireEvent.changeText(view.getByLabelText(/Người nhận/), "Người nhận QA");
    await fireEvent.press(view.getByText("Hoàn thành giao hàng"));
    expect(mockExecute).toHaveBeenCalledWith({
      command: "COMPLETE_STOP", tripId: "trip-1", stopId: "stop-2", expectedTripVersion: 5,
      completion: {
        tasks: [{ taskId: "task-unload", actualQuantity: 1 }],
        deliveryResult: "PARTIAL", reasonCode: "QUANTITY_MISMATCH", note: null, recipientName: "Người nhận QA",
      },
    });
  });

  it("Stop chỉ có một hàng task, giữ bàn phím số và nút xác nhận ngoài vùng cuộn", async () => {
    mockStopId = "stop-2";
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail, status: "IN_PROGRESS",
        stops: detail.stops.map((stop) => stop.id === "stop-1"
          ? { ...stop, status: "COMPLETED" }
          : { ...stop, tasks: stop.tasks.map((task) => ({ ...task, plannedQuantity: 3 })) }),
      },
      isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(stopScreen());
    const fields = within(view.getByTestId("driver-stop-scroll"));
    const action = within(view.getByTestId("driver-stop-action-bar"));
    expect(fields.getAllByText("Kế hoạch: 3")).toHaveLength(1);
    expect(fields.queryByRole("button", { name: "Giao thành công" })).toBeNull();
    const quantity = fields.getByLabelText("Số lượng thực tế task-unload");
    expect(quantity.props.keyboardType).toBe("number-pad");
    await fireEvent.changeText(quantity, "4");
    await fireEvent.press(action.getByRole("button"));
    expect(fields.getByRole("alert")).toHaveTextContent("Số lượng thực tế không được vượt quá 3.");
    expect(mockExecute).not.toHaveBeenCalled();
    await fireEvent.changeText(quantity, "3");
    await fireEvent.press(action.getByRole("button"));
    expect(fields.getByRole("alert")).toHaveTextContent(/Vui lòng nhập tên người nhận/);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("mất mạng không ẩn external navigation của Stop hợp lệ", async () => {
    mockIsOnline = false;
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...detail, status: "IN_PROGRESS", version: 3 },
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    const view = await render(overview());
    expect(view.getByTestId("driver-navigation-panel")).toBeTruthy();
    expect(view.getByRole("button", { name: "Điều hướng" })).toBeTruthy();
    expect(view.getByText("Mở điểm hiện tại")).toBeTruthy();
  });

  it("chỉ hiển thị Complete Trip khi mọi stop resolved", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail,
        status: "IN_PROGRESS",
        version: 8,
        stops: detail.stops.map((stop) => ({
          ...stop,
          status: "COMPLETED",
          tasks: stop.tasks.map((task) => ({ ...task, actualQuantity: 1 })),
          deliveryAttempt:
            stop.stopType === "DELIVERY"
              ? {
                  id: "attempt-ready",
                  attemptNumber: 1,
                  result: "SUCCESS" as const,
                  recipientName: "Receiver",
                }
              : null,
        })),
      },
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    const view = await render(overview());
    expect(driverPodService.getPod).toHaveBeenCalledWith("trip-1", "stop-2", "attempt-ready");
    expect(DriverPodPanel).not.toHaveBeenCalled();
    expect(DriverIncidentPanel).not.toHaveBeenCalled();
    fireEvent.press(await view.findByText("Hoàn thành chuyến"));
    expect(mockExecute).toHaveBeenCalledWith({
      command: "COMPLETE_TRIP",
      tripId: "trip-1",
      expectedTripVersion: 8,
    });
  });

  it.each([false, null])("chặn Complete Trip khi readiness e-POD là %s", async (readiness) => {
    mockPodSatisfied = readiness;
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail,
        status: "IN_PROGRESS",
        version: 8,
        stops: detail.stops.map((stop) => ({
          ...stop,
          status: "COMPLETED",
          tasks: stop.tasks.map((task) => ({ ...task, actualQuantity: 1 })),
          deliveryAttempt:
            stop.stopType === "DELIVERY"
              ? {
                  id: "attempt-1",
                  attemptNumber: 1,
                  result: "SUCCESS" as const,
                  recipientName: "Receiver",
                }
              : null,
        })),
      },
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    const view = await render(overview());
    expect(
      await view.findByText(
        readiness === null
          ? "Chưa xác nhận được trạng thái e-POD. Kiểm tra bằng chứng trước khi hoàn thành chuyến."
          : "Cần tải ảnh e-POD bắt buộc trước khi hoàn thành chuyến.",
      ),
    ).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("ẩn Complete Trip khi mất mạng dù queue sạch và e-POD đã đủ", async () => {
    mockIsOnline = false;
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail,
        status: "IN_PROGRESS",
        version: 8,
        stops: detail.stops.map((stop) => ({
          ...stop,
          status: "COMPLETED",
          deliveryAttempt:
            stop.stopType === "DELIVERY"
              ? {
                  id: "attempt-ready",
                  attemptNumber: 1,
                  result: "SUCCESS" as const,
                  recipientName: "Receiver",
                }
              : null,
        })),
      },
      isLoading: false,
      error: null,
      reload: mockReload,
    });
    const view = await render(overview());
    expect(
      await view.findByText("Cần kết nối mạng để hoàn thành chuyến."),
    ).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("ẩn Complete Trip dù e-POD đã đủ nếu hàng đợi vẫn còn lệnh", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: {
        ...detail, status: "IN_PROGRESS",
        stops: detail.stops.map((stop) => ({
          ...stop, status: "COMPLETED",
          deliveryAttempt: stop.stopType === "DELIVERY"
            ? { id: "attempt-ready", attemptNumber: 1, result: "SUCCESS", recipientName: "QA" }
            : null,
        })),
      },
      isLoading: false, error: null, reload: mockReload,
    });
    const queue = useOfflineDriverQueue("trip-1");
    jest.mocked(useOfflineDriverQueue).mockReturnValue({
      ...queue, commands: [stopCompletionCommand("PENDING")],
      summary: { ...queue.summary, pending: 1, totalUnsynced: 1 },
    });
    const view = await render(overview());
    expect(view.getByText("Chờ đồng bộ điểm dừng trước khi hoàn thành chuyến.")).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("khóa hoàn thành trong lúc tải e-POD và bỏ qua phản hồi cũ của version trước", async () => {
    const trip = completedStopsTrip();
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip, isLoading: false, error: null, reload: mockReload,
    });
    let resolveOld!: (pod: DriverPodCollection) => void;
    jest.mocked(driverPodService.getPod)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(podResult("attempt-ready", false));
    const view = await render(overview());
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: { ...trip, version: 9 }, isLoading: false, error: null, reload: mockReload,
    });
    await view.rerender(overview());
    expect(await view.findByText(/Cần tải ảnh e-POD bắt buộc/)).toBeTruthy();
    await act(async () => resolveOld(podResult("attempt-ready", true)));
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it.each(["FAILED", "SUPERSEDED", "LOCAL"] as const)("chặn ảnh không phải POD active do server xác nhận: %s", async (kind) => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: completedStopsTrip(), isLoading: false, error: null, reload: mockReload,
    });
    const pod = podResult("attempt-ready", true);
    pod.items = kind === "LOCAL" ? [] : [{
      ...pod.items[0]!, isSuperseded: kind === "SUPERSEDED",
      uploadStatus: kind === "FAILED" ? "FAILED" : "UPLOADED",
    }];
    jest.mocked(driverPodService.getPod).mockResolvedValueOnce(pod);
    const view = await render(overview());
    expect(await view.findByText(/Cần tải ảnh e-POD bắt buộc/)).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("đọc tất cả lần giao của các điểm và chặn nếu một ảnh thiếu", async () => {
    const trip = completedStopsTrip();
    const firstDelivery = trip.stops[1]!;
    trip.stops.push({
      ...firstDelivery, id: "stop-3", sequence: 3,
      deliveryAttempt: { ...firstDelivery.deliveryAttempt!, id: "attempt-2" },
    });
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    jest.mocked(driverPodService.getPod)
      .mockResolvedValueOnce(podResult("attempt-ready", true))
      .mockResolvedValueOnce(podResult("attempt-2", false));
    const view = await render(overview());
    expect(await view.findByText(/Cần tải ảnh e-POD bắt buộc/)).toBeTruthy();
    expect(driverPodService.getPod).toHaveBeenCalledTimes(2);
    expect(driverPodService.getPod).toHaveBeenCalledWith("trip-1", "stop-3", "attempt-2");
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    await fireEvent.press(view.getByText("Bổ sung bằng chứng"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops/[stopId]/pod",
      params: { id: "trip-1", stopId: "stop-3", attemptId: "attempt-2" },
    });
  });

  it("đọc attempt mới khi sync cập nhật dữ liệu chuyến", async () => {
    const trip = completedStopsTrip();
    const delivery = trip.stops[1]!;
    const firstSnapshot = { ...trip, stops: [trip.stops[0]!, { ...delivery, deliveryAttempt: null }] };
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: firstSnapshot, isLoading: false, error: null, reload: mockReload,
    });
    const view = await render(overview());
    expect(driverPodService.getPod).not.toHaveBeenCalled();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    await view.rerender(overview());
    expect(await view.findByText("Hoàn thành chuyến")).toBeTruthy();
    expect(driverPodService.getPod).toHaveBeenCalledWith("trip-1", "stop-2", "attempt-ready");
  });

  it("khóa Complete nếu server chưa xác nhận số lượng thực tế của task", async () => {
    const trip = completedStopsTrip();
    trip.stops[0]!.tasks[0]!.actualQuantity = null;
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    const view = await render(overview());
    expect(view.getByText(/Còn công việc tại điểm dừng/)).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("làm mới khi Overview focus trở lại sau khi ảnh thay đổi và không polling qua render", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: completedStopsTrip(), isLoading: false, error: null, reload: mockReload,
    });
    mockPodSatisfied = false;
    const view = await render(overview());
    expect(await view.findByText(/Cần tải ảnh e-POD bắt buộc/)).toBeTruthy();
    mockFocused = false;
    await view.rerender(overview());
    mockPodSatisfied = true;
    mockFocused = true;
    await view.rerender(overview());
    expect(await view.findByText("Hoàn thành chuyến")).toBeTruthy();
    await view.rerender(overview());
    expect(driverPodService.getPod).toHaveBeenCalledTimes(2);
    expect(mockReload).toHaveBeenCalledTimes(2);
    expect(DriverPodPanel).not.toHaveBeenCalled();
  });

  it("khóa Complete khi upload đang chạy và xác minh lại từ API sau khi upload hoặc thay thế", async () => {
    jest.mocked(useDriverTripDetail).mockReturnValue({
      trip: completedStopsTrip(), isLoading: false, error: null, reload: mockReload,
    });
    let reportUpload!: (uploading: boolean) => void;
    function ObserveWorkspace() {
      reportUpload = useDriverTripWorkspace().recordPodUploadActivity;
      return <DriverTripDetailScreen />;
    }
    const view = await render(
      <DriverTripWorkspace tripId="trip-1"><ObserveWorkspace /></DriverTripWorkspace>,
    );
    expect(await view.findByText("Hoàn thành chuyến")).toBeTruthy();
    await act(async () => reportUpload(true));
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    expect(driverPodService.getPod).toHaveBeenCalledTimes(1);
    mockPodSatisfied = false;
    await act(async () => reportUpload(false));
    expect(await view.findByText(/Cần tải ảnh e-POD bắt buộc/)).toBeTruthy();
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    expect(driverPodService.getPod).toHaveBeenCalledTimes(2);
  });

  it.each([0, 2])("khóa hoàn thành nếu số lần giao quan sát được là %s", async (attemptNumber) => {
    const trip = completedStopsTrip();
    const delivery = trip.stops[1]!;
    delivery.deliveryAttempt = attemptNumber ? { ...delivery.deliveryAttempt!, attemptNumber } : null;
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    const view = await render(overview());
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
    expect(driverPodService.getPod).toHaveBeenCalledTimes(attemptNumber ? 1 : 0);
    if (!attemptNumber) expect(view.queryByText("Bằng chứng giao hàng")).toBeNull();
  });

  it("từ Stop mở e-POD đúng Trip/Stop/attempt và cho phép đọc trên chuyến hoàn thành", async () => {
    mockStopId = "stop-2";
    const trip = { ...completedStopsTrip(), status: "COMPLETED" as const };
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    const stop = await render(stopScreen());
    await fireEvent.press(stop.getByText("Bằng chứng giao hàng"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/trips/[id]/stops/[stopId]/pod",
      params: { id: "trip-1", stopId: "stop-2", attemptId: "attempt-ready" },
    });
    const pod = await render(podScreen());
    expect(jest.mocked(DriverPodPanel).mock.lastCall?.[0]).toMatchObject({
      tripId: "trip-1", stop: { id: "stop-2" }, readOnly: true,
    });
    await fireEvent.press(pod.getByLabelText("Quay lại"));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("chặn deep link POD sai attempt hoặc chưa được server xác nhận", async () => {
    mockStopId = "stop-2";
    mockAttemptId = "attempt-other";
    const trip = completedStopsTrip();
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    const view = await render(podScreen());
    expect(view.getByText(/Lần giao không còn khớp/)).toBeTruthy();
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip: detail, isLoading: false, error: null, reload: mockReload });
    await view.rerender(podScreen());
    expect(view.getByText(/Cần đồng bộ lần giao/)).toBeTruthy();
    expect(DriverPodPanel).not.toHaveBeenCalled();
  });

  it("RELIEF xem kết quả giao ở Stop nhưng không mở hồ sơ ảnh của tài xế chính", async () => {
    mockStopId = "stop-2";
    const completed = completedStopsTrip();
    const trip = { ...completed, assignment: { ...completed.assignment, role: "RELIEF" } };
    jest.mocked(useDriverTripDetail).mockReturnValue({ trip, isLoading: false, error: null, reload: mockReload });
    const stop = await render(stopScreen());
    expect(stop.getByText("Giao thành công")).toBeTruthy();
    expect(stop.queryByText("Bằng chứng giao hàng")).toBeNull();
    const pod = await render(podScreen());
    expect(pod.getByText(/Chỉ tài xế chính/)).toBeTruthy();
    expect(DriverPodPanel).not.toHaveBeenCalled();
  });

  it("mở Incident với trip đúng và chặn đọc theo params khác workspace", async () => {
    const overviewView = await render(overview());
    await fireEvent.press(overviewView.getByText("Sự cố"));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/trips/[id]/incidents", params: { id: "trip-1" } });
    await render(incidentScreen());
    expect(jest.mocked(DriverIncidentPanel).mock.lastCall?.[0]).toMatchObject({ trip: { id: "trip-1" }, isOnline: true });
    mockTripId = "trip-other";
    jest.mocked(DriverIncidentPanel).mockClear();
    const invalid = await render(incidentScreen());
    expect(invalid.getByText("Không tìm thấy chuyến được phân công.")).toBeTruthy();
    expect(DriverIncidentPanel).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "%s không hiển thị active navigation",
    async (status) => {
      jest.mocked(useDriverTripDetail).mockReturnValue({
        trip: { ...detail, status },
        isLoading: false,
        error: null,
        reload: mockReload,
      });
      const view = await render(overview());
      expect(view.queryByTestId("driver-navigation-panel")).toBeNull();
      expect(view.queryByText("Bắt đầu chuyến")).toBeNull();
      expect(view.queryByText("Mở điểm hiện tại")).toBeNull();
    },
  );
});
