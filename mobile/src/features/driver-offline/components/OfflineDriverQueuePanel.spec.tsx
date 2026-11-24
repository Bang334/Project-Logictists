import { fireEvent, render } from "@testing-library/react-native";
import { OfflineDriverQueuePanel } from "./OfflineDriverQueuePanel";

const baseSummary = {
  pending: 2,
  syncing: 0,
  conflict: 0,
  failed: 0,
  blocked: 0,
  totalUnsynced: 2,
};

describe("OfflineDriverQueuePanel", () => {
  it("hiển thị pending và cho phép sync thủ công", async () => {
    const onSync = jest.fn(async () => undefined);
    const view = await render(
      <OfflineDriverQueuePanel
        summary={baseSummary}
        isSyncing={false}
        onSync={onSync}
        onReload={jest.fn()}
      />,
    );
    expect(view.getByText("Chờ đồng bộ: 2")).toBeTruthy();
    fireEvent.press(view.getByText("Thử đồng bộ"));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("phân biệt conflict và failed, không lộ raw payload", async () => {
    const view = await render(
      <OfflineDriverQueuePanel
        summary={{
          ...baseSummary,
          conflict: 1,
          failed: 1,
          totalUnsynced: 4,
        }}
        isSyncing={false}
        onSync={jest.fn()}
        onReload={jest.fn()}
      />,
    );
    expect(view.getByText(/Dữ liệu chuyến đã thay đổi/)).toBeTruthy();
    expect(view.getByText(/Không thể đồng bộ thao tác/)).toBeTruthy();
    expect(view.queryByText(/idempotency/i)).toBeNull();
  });
});
