import { createSingleFlight } from "./single-flight";

describe("createSingleFlight", () => {
  it("foreground và reconnect dùng chung một sync loop", async () => {
    const guard = createSingleFlight();
    const operation = jest.fn();
    let finish!: () => void;
    operation.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const first = guard.run(operation);
    const second = guard.run(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    finish();
    await Promise.all([first, second]);

    await guard.run(async () => undefined);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
