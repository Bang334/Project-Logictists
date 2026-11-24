import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { useDriverPod } from "@/features/driver-trips/hooks/useDriverPod";
import type { DriverPodFile, DriverTripStop } from "@/features/driver-trips/types/driver-trip.types";
import { DriverPodPanel } from "./DriverPodPanel";

jest.mock("expo-image-picker", () => ({
  CameraType: { back: "back" },
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock("@/features/driver-trips/hooks/useDriverPod", () => ({
  useDriverPod: jest.fn(),
}));

const stop: DriverTripStop = {
  id: "stop-1",
  sequence: 1,
  stopType: "DELIVERY",
  status: "COMPLETED",
  address: "Delivery",
  latitude: 10,
  longitude: 106,
  contactName: "Người nhận",
  contactPhone: "0900000000",
  plannedArrivalTime: null,
  plannedDepartureTime: null,
  actualArrivalTime: "2026-11-16T08:00:00.000Z",
  actualDepartureTime: "2026-11-16T08:10:00.000Z",
  deliveryAttempt: {
    id: "attempt-1",
    attemptNumber: 1,
    result: "SUCCESS",
    recipientName: "Người nhận",
  },
  tasks: [],
};

const upload = jest.fn(async () => true);
const retry = jest.fn(async () => true);
const reload = jest.fn(async () => undefined);
const getView = jest.fn(async () => null);

describe("DriverPodPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useDriverPod).mockReturnValue({
      pod: {
        deliveryAttempt: {
          id: "attempt-1",
          result: "SUCCESS",
          recipientName: "Người nhận",
        },
        requirements: {
          photoRequired: true,
          photoUploaded: false,
          recipientRequired: true,
          recipientSatisfied: true,
          podSatisfied: false,
        },
        items: [],
      },
      isLoading: false,
      isUploading: false,
      isViewing: false,
      error: null,
      canRetry: false,
      upload,
      retry,
      reload,
      getView,
      clearError: jest.fn(),
    });
  });

  it("hiển thị trạng thái POD và signature là tùy chọn", async () => {
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    expect(view.getByText("Chưa có ảnh bắt buộc")).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText("Thêm chữ ký (tùy chọn)"));
    });
    expect(await view.findByTestId("signature-canvas")).toBeTruthy();
    expect(view.getByText("Xóa nét ký")).toBeTruthy();
    expect(view.getByText("Dùng chữ ký")).toBeTruthy();
  });

  it("ẩn chụp, ký và retry upload khi Trip chỉ xem", async () => {
    const state = useDriverPod({ tripId: "trip-1", stopId: stop.id, attemptId: "attempt-1" });
    jest.mocked(useDriverPod).mockReturnValue({ ...state, canRetry: true });
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} readOnly />);
    expect(view.getByText("Chưa có ảnh bắt buộc")).toBeTruthy();
    expect(view.queryByText("Chụp ảnh bằng chứng")).toBeNull();
    expect(view.queryByText("Thêm chữ ký (tùy chọn)")).toBeNull();
    expect(view.queryByText("Thử tải lại file vừa chọn")).toBeNull();
    expect(view.getByText("Làm mới trạng thái POD")).toBeTruthy();
  });

  it("phân biệt ảnh đã thay thế, ảnh lỗi và chữ ký với ảnh bắt buộc còn thiếu", async () => {
    const current = useDriverPod({ tripId: "trip-1", stopId: stop.id, attemptId: "attempt-1" });
    const file: DriverPodFile = {
      id: "old-photo", evidenceType: "PHOTO", mediaType: "image/jpeg", sizeBytes: 100,
      uploadStatus: "UPLOADED", capturedAt: null, uploadedAt: null, supersedesId: null, isSuperseded: true,
    };
    jest.mocked(useDriverPod).mockReturnValue({
      ...current, pod: {
        ...current.pod!, items: [
          file,
          { ...file, id: "failed-photo", isSuperseded: false, uploadStatus: "FAILED" },
          { ...file, id: "signature", isSuperseded: false, evidenceType: "SIGNATURE", mediaType: "image/png" },
        ],
      },
    });
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    expect(view.getByText("Chưa có ảnh bắt buộc")).toBeTruthy();
    expect(view.getByText("Đã được thay thế")).toBeTruthy();
    expect(view.getByText("Tải lên thất bại")).toBeTruthy();
    await fireEvent.press(view.getByRole("button", { name: "Xem lại chữ ký" }));
    expect(getView).toHaveBeenCalledWith("signature");
    expect(view.queryByText("Hoàn thành chuyến")).toBeNull();
  });

  it("khóa cuộn màn hình cha trong lúc một ngón tay đang ký", async () => {
    const onInteractionChange = jest.fn();
    const view = await render(
      <DriverPodPanel
        tripId="trip-1"
        stop={stop}
        onSignatureInteractionChange={onInteractionChange}
      />,
    );
    await act(async () => {
      fireEvent.press(view.getByText("Thêm chữ ký (tùy chọn)"));
    });
    const touchArea = view.getByTestId("signature-touch-area");

    await act(async () => {
      fireEvent(touchArea, "touchStart");
    });
    expect(onInteractionChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent(touchArea, "touchEnd");
    });
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
  });

  it("camera permission denied hiển thị lỗi và không upload", async () => {
    jest
      .mocked(ImagePicker.requestCameraPermissionsAsync)
      .mockResolvedValue({ granted: false } as ImagePicker.PermissionResponse);
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    await act(async () => {
      fireEvent.press(view.getByText("Chụp ảnh bằng chứng"));
    });
    await waitFor(() =>
      expect(view.getByText(/cần quyền camera/)).toBeTruthy(),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("hủy camera không upload", async () => {
    jest
      .mocked(ImagePicker.requestCameraPermissionsAsync)
      .mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    jest
      .mocked(ImagePicker.launchCameraAsync)
      .mockResolvedValue({ canceled: true, assets: null });
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    await act(async () => {
      fireEvent.press(view.getByText("Chụp ảnh bằng chứng"));
    });
    await waitFor(() =>
      expect(ImagePicker.launchCameraAsync).toHaveBeenCalled(),
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("camera JPEG chỉ upload sau bước xem trước và xác nhận", async () => {
    jest
      .mocked(ImagePicker.requestCameraPermissionsAsync)
      .mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    jest.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///photo.jpg",
          width: 1200,
          height: 900,
          fileName: "photo.jpg",
          fileSize: 1024,
          mimeType: "image/jpeg",
        },
      ],
    });
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    await act(async () => {
      fireEvent.press(view.getByText("Chụp ảnh bằng chứng"));
    });
    expect(await view.findByTestId("pod-local-photo-preview")).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(view.getByText("Xác nhận tải ảnh lên"));
    });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      "PHOTO",
      expect.objectContaining({
        uri: "file:///photo.jpg",
        mediaType: "image/jpeg",
        sizeBytes: 1024,
      }),
      expect.any(String),
      undefined,
    );
  });

  it("hủy ảnh ở bước xem trước không upload", async () => {
    jest
      .mocked(ImagePicker.requestCameraPermissionsAsync)
      .mockResolvedValue({ granted: true } as ImagePicker.PermissionResponse);
    jest.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///photo.jpg",
          width: 1200,
          height: 900,
          fileName: "photo.jpg",
          fileSize: 1024,
          mimeType: "image/jpeg",
        },
      ],
    });
    const view = await render(<DriverPodPanel tripId="trip-1" stop={stop} />);
    await act(async () => {
      fireEvent.press(view.getByText("Chụp ảnh bằng chứng"));
    });
    expect(await view.findByTestId("pod-local-photo-preview")).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText("Hủy ảnh"));
    });
    await waitFor(() =>
      expect(view.queryByTestId("pod-local-photo-preview")).toBeNull(),
    );
    expect(upload).not.toHaveBeenCalled();
  });
});
