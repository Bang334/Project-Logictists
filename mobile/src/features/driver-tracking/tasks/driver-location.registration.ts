import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export const DRIVER_LOCATION_TASK = 'smart-tms-driver-location';

export function isDriverLocationTask(name: string): boolean {
  return name === DRIVER_LOCATION_TASK ||
    (name.startsWith(`${DRIVER_LOCATION_TASK}-`) &&
      /^[\da-f-]{36}$/i.test(name.slice(DRIVER_LOCATION_TASK.length + 1)));
}

export function defineDriverLocationTask(
  name: string,
  collect: (taskName: string, locations: LocationObject[]) => Promise<void>,
  onError: (taskName: string) => Promise<void>,
) {
  if (TaskManager.isTaskDefined(name)) return;
  TaskManager.defineTask<{ locations?: LocationObject[] }>(name, async ({ data, error, executionInfo }) => {
    if (executionInfo.taskName !== name) return;
    try {
      if (error) await onError(name);
      else if (data?.locations?.length) await collect(name, data.locations);
    } catch {
      await onError(name).catch(() => undefined);
    }
  });
}
