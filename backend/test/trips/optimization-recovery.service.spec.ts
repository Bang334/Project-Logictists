import { OptimizationRecoveryService } from '../../src/trips/optimization-recovery.service';

describe('OptimizationRecoveryService', () => {
  const prisma = {
    optimizationJob: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const queue = {
    getJob: jest.fn(),
    add: jest.fn(),
  };
  const events = {
    emitOptimizationJobUpdate: jest.fn(),
  };
  let service: OptimizationRecoveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.optimizationJob.findMany.mockResolvedValue([]);
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    queue.add.mockResolvedValue({});
    service = new OptimizationRecoveryService(
      prisma as never,
      queue as never,
      events as never,
    );
  });

  it('finalizes abandoned CANCEL_REQUESTED jobs to CANCELLED and removes them from queue', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    prisma.optimizationJob.findMany
      .mockResolvedValueOnce([{ id: 'job-cancel', branchId: 'branch-1' }])
      .mockResolvedValueOnce([]);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('waiting'),
      remove,
    });

    await service.recover(false);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-cancel', status: 'CANCEL_REQUESTED' },
      data: expect.objectContaining({
        status: 'CANCELLED',
        leaseUntil: null,
        leaseOwner: null,
      }),
    });
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith('branch-1', {
      jobId: 'job-cancel',
      status: 'CANCELLED',
    });
  });

  it('skips jobs already active or waiting in BullMQ without re-adding them', async () => {
    prisma.optimizationJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'job-waiting', status: 'PENDING' }]);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn(),
    });

    await service.recover(false);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('removes stale failed/completed BullMQ remnant before re-enqueueing an expired RUNNING job', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    prisma.optimizationJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'job-stale', status: 'RUNNING' }]);
    queue.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('failed'),
      remove,
    });

    await service.recover(false);

    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'job-stale', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'RETRYING', leaseUntil: null, leaseOwner: null }),
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'run-automatic-optimization',
      { jobId: 'job-stale' },
      expect.objectContaining({ jobId: 'job-stale' }),
    );
  });
});
