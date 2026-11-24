import { isDriverPodPhotoRequired } from "../../src/trips/driver-pod-policy";

describe("Driver POD policy", () => {
  it.each(["SUCCESS", "PARTIAL"])("yêu cầu ảnh cho kết quả %s", (result) => {
    expect(isDriverPodPhotoRequired(result, null)).toBe(true);
  });

  it.each(["ADDRESS_ISSUE", "ACCESS_RESTRICTED", "PACKAGE_DAMAGED"])(
    "yêu cầu ảnh khi giao thất bại do %s",
    (reason) => {
      expect(isDriverPodPhotoRequired("FAILED", reason)).toBe(true);
    },
  );

  it("không bắt buộc ảnh cho failed reason còn lại", () => {
    expect(isDriverPodPhotoRequired("FAILED", "RECIPIENT_UNAVAILABLE")).toBe(
      false,
    );
  });
});
