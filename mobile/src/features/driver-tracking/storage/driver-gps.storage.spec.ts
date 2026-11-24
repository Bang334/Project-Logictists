import * as SQLite from 'expo-sqlite';
import { driverGpsStorage } from './driver-gps.storage';

const mockExecAsync = jest.fn();
const mockRunAsync = jest.fn();
const mockDatabase = {
  execAsync: mockExecAsync,
  runAsync: mockRunAsync,
};

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDatabase),
}));

describe('M3.6C driverGpsStorage SQLite contention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecAsync.mockResolvedValue(undefined);
    mockRunAsync.mockResolvedValue({ changes: 1, lastInsertRowId: 0 });
  });

  it('cấu hình WAL và busy timeout khi mở database', async () => {
    await driverGpsStorage.updateSession('session-1', { errorCode: null });

    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('smart-tms-driver-gps.db');
    expect(mockExecAsync).toHaveBeenCalledWith(expect.stringContaining('PRAGMA busy_timeout = 5000'));
    expect(mockExecAsync).toHaveBeenCalledWith(expect.stringContaining('PRAGMA journal_mode = WAL'));
  });

  it('retry thao tác ghi khi SQLite tạm thời báo database is locked', async () => {
    mockRunAsync
      .mockRejectedValueOnce(new Error('Error code 5: database is locked'))
      .mockResolvedValueOnce({ changes: 1, lastInsertRowId: 0 });

    await driverGpsStorage.updateSession('session-1', {
      lastSyncAt: '2026-11-17T04:44:37.000Z',
    });

    expect(mockRunAsync).toHaveBeenCalledTimes(2);
  });

  it('tuần tự hóa hai thao tác ghi đồng thời', async () => {
    let finishFirstWrite!: () => void;
    mockRunAsync
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstWrite = () => resolve({ changes: 1, lastInsertRowId: 0 });
          }),
      )
      .mockResolvedValueOnce({ changes: 1, lastInsertRowId: 0 });

    const first = driverGpsStorage.updateSession('session-1', { warning: null });
    const second = driverGpsStorage.updateSession('session-1', { errorCode: null });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockRunAsync).toHaveBeenCalledTimes(1);
    finishFirstWrite();
    await Promise.all([first, second]);
    expect(mockRunAsync).toHaveBeenCalledTimes(2);
  });
});
