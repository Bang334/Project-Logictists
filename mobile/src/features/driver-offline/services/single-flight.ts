export function createSingleFlight() {
  let active: Promise<void> | null = null;
  return {
    run(operation: () => Promise<void>): Promise<void> {
      if (active) return active;
      active = operation().finally(() => {
        active = null;
      });
      return active;
    },
  };
}
