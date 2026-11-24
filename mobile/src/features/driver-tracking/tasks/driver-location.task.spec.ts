import * as TaskManager from 'expo-task-manager';
import type { TaskManagerTaskBody } from 'expo-task-manager';
import type { LocationObject } from 'expo-location';
import { defineDriverLocationTask } from './driver-location.registration';

jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn(),
}));

const name = 'smart-tms-driver-location-123e4567-e89b-42d3-a456-426614174000';

function setup() {
  const collect = jest.fn<Promise<void>, [string, LocationObject[]]>();
  const onError = jest.fn<Promise<void>, [string]>().mockResolvedValue();
  defineDriverLocationTask(name, collect, onError);
  const execute = jest.mocked(TaskManager.defineTask).mock.lastCall![1];
  const body = {
    data: { locations: [{}] },
    error: null,
    executionInfo: { eventId: 'event', taskName: name },
  } as TaskManagerTaskBody;
  return { collect, onError, execute, body };
}

it('pins callback dispatch to its own registration name', async () => {
  const { collect, execute, body } = setup();
  await execute({ ...body, executionInfo: { ...body.executionInfo, taskName: 'different-task' } });
  expect(collect).not.toHaveBeenCalled();
  await execute(body);
  expect(collect).toHaveBeenCalledWith(name, [{}]);
});

it('finishes the native job even if GPS persistence and scoped error handling fail', async () => {
  const { collect, onError, execute, body } = setup();
  collect.mockRejectedValue(new Error('database is locked'));
  onError.mockRejectedValue(new Error('database is locked'));
  await expect(execute(body)).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith(name);
});
