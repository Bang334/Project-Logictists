import {
  canonicalizeOfflinePayload,
  parseOfflinePayload,
} from "./offline-command-serialization";

describe("offline command serialization", () => {
  it("round-trip ARRIVE giữ nguyên business intent", () => {
    expect(
      parseOfflinePayload(JSON.stringify({ kind: "ARRIVE_STOP" })),
    ).toEqual({ kind: "ARRIVE_STOP" });
  });

  it("round-trip COMPLETE delivery giữ nguyên quantity và thông tin giao hàng", () => {
    const payload = {
      kind: "COMPLETE_STOP" as const,
      tasks: [{ taskId: "task-1", actualQuantity: 2 }],
      deliveryResult: "PARTIAL" as const,
      reasonCode: "QUANTITY_MISMATCH" as const,
      note: "Thiếu một kiện",
      recipientName: "Nguyễn Văn A",
    };
    expect(parseOfflinePayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("tạo canonical payload ổn định dù thứ tự task khác nhau", () => {
    const left = canonicalizeOfflinePayload({
      kind: "COMPLETE_STOP",
      tasks: [
        { taskId: "task-b", actualQuantity: 2 },
        { taskId: "task-a", actualQuantity: 1 },
      ],
    });
    const right = canonicalizeOfflinePayload({
      kind: "COMPLETE_STOP",
      tasks: [
        { taskId: "task-a", actualQuantity: 1 },
        { taskId: "task-b", actualQuantity: 2 },
      ],
      deliveryResult: null,
      reasonCode: null,
      note: null,
      recipientName: null,
    });
    expect(left).toBe(right);
  });

  it("từ chối payload SQLite không hợp lệ", () => {
    expect(() =>
      parseOfflinePayload(
        JSON.stringify({
          kind: "COMPLETE_STOP",
          tasks: [{ taskId: "task-1", actualQuantity: -1 }],
        }),
      ),
    ).toThrow("OFFLINE_COMMAND_PAYLOAD_INVALID");
  });
});
