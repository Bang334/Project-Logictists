import * as Linking from "expo-linking";
import {
  ExternalNavigationError,
  buildGoogleMapsNavigationUrl,
  hasValidNavigationCoordinates,
  openExternalNavigation,
} from "./external-navigation.service";

jest.mock("expo-linking", () => ({ openURL: jest.fn() }));

describe("external navigation service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Linking.openURL).mockResolvedValue(true);
  });

  it.each([
    { latitude: -90, longitude: -180 },
    { latitude: 90, longitude: 180 },
    { latitude: 10.7769, longitude: 106.7009 },
  ])("chấp nhận tọa độ hợp lệ %#", (target) => {
    expect(hasValidNavigationCoordinates(target)).toBe(true);
  });

  it.each([
    { latitude: Number.NaN, longitude: 106 },
    { latitude: Number.POSITIVE_INFINITY, longitude: 106 },
    { latitude: 91, longitude: 106 },
    { latitude: -91, longitude: 106 },
    { latitude: 10, longitude: 181 },
    { latitude: 10, longitude: -181 },
    { latitude: undefined, longitude: 106 },
    { latitude: 10, longitude: null },
    { latitude: "10", longitude: 106 },
  ])("từ chối tọa độ không hợp lệ %#", (target) => {
    expect(hasValidNavigationCoordinates(target)).toBe(false);
  });

  it("tạo Google Maps URL đã encode với driving và navigate", () => {
    const url = buildGoogleMapsNavigationUrl({
      latitude: 10.7769,
      longitude: 106.7009,
    });
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=10.7769%2C106.7009&travelmode=driving&dir_action=navigate",
    );
  });

  it("không tạo URL khi thiếu tọa độ", () => {
    expect(() =>
      buildGoogleMapsNavigationUrl({
        latitude: undefined,
        longitude: undefined,
      }),
    ).toThrow(
      expect.objectContaining<Partial<ExternalNavigationError>>({
        code: "INVALID_COORDINATE",
      }),
    );
  });

  it("mở đúng URL đúng một lần", async () => {
    await openExternalNavigation({ latitude: 10, longitude: 106 });
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://www.google.com/maps/dir/?api=1&destination=10%2C106&travelmode=driving&dir_action=navigate",
    );
  });

  it("không gọi Linking khi tọa độ không hợp lệ", async () => {
    await expect(
      openExternalNavigation({ latitude: Number.NaN, longitude: 106 }),
    ).rejects.toMatchObject({ code: "INVALID_COORDINATE" });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it("chuẩn hóa lỗi Linking", async () => {
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      openExternalNavigation({ latitude: 10, longitude: 106 }),
    ).rejects.toMatchObject({
      code: "OPEN_FAILED",
      message: "Không thể mở ứng dụng bản đồ.",
    });
  });
});
