import 'dotenv/config';
import { randomBytes, randomUUID } from 'crypto';
import { OptimizationProcessor } from '../../src/trips/optimization.processor';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';
import { OptimizationCancelledError, OptimizationJobControlService } from '../../src/trips/optimization-job-control.service';
import { PrismaService } from '../../src/prisma/prisma.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('Optimization job concurrency (PostgreSQL)', () => {
  let prisma: PrismaService;
  const suffix = randomUUID();
  let branchId: string;
  let userId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    const branch = await prisma.branch.create({
      data: {
        code: `IT-OPT-${suffix}`,
        name: 'Optimization integration test',
        address: 'Integration test only',
        latitude: 0,
        longitude: 0,
      },
    });
    branchId = branch.id;
    const user = await prisma.user.create({
      data: {
        username: `it-opt-${suffix}`,
        password: 'integration-test-not-a-real-credential',
        fullName: 'Optimization integration test',
        branchId,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.optimizationResult.deleteMany({ where: { optimizationJob: { branchId } } });
    await prisma.optimizationJob.deleteMany({ where: { branchId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  const createJob = (idempotencyKey: string) =>
    prisma.optimizationJob.create({
      data: {
        branchId,
        createdById: userId,
        idempotencyKey,
        requestHash: 'same-request',
        requestSnapshot: { branchId },
      },
    });

  it('allows only one concurrent job for the same actor and idempotency key', async () => {
    const key = `it-key-${suffix}`;
    const outcomes = await Promise.allSettled([createJob(key), createJob(key)]);

    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(await prisma.optimizationJob.count({ where: { createdById: userId, idempotencyKey: key } })).toBe(1);
  });

  it('allows only one worker to claim a pending job through compare-and-set', async () => {
    const job = await createJob(`claim-${suffix}`);
    const leaseUntil = new Date(Date.now() + 60_000);
    const claim = (worker: string) =>
      prisma.optimizationJob.updateMany({
        where: { id: job.id, status: 'PENDING', leaseOwner: null },
        data: { status: 'RUNNING', leaseOwner: worker, leaseUntil },
      });

    const [first, second] = await Promise.all([claim('worker-a'), claim('worker-b')]);
    expect(first.count + second.count).toBe(1);
    const stored = await prisma.optimizationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(['worker-a', 'worker-b']).toContain(stored.leaseOwner);
  });

  const candidate = (packingTrace: string) => ({
    proposal: { result: {
      status: 'SUCCESS', total_cost_vnd: 10, total_distance_km: 1,
      total_duration_minutes: 1, routes: [], unassigned_orders: [], diagnostics: [],
      packingTrace,
    } },
    signature: 'test-signature',
    isBestFound: true,
  });

  const runJob = (jobId: string, solve: () => unknown, control?: OptimizationJobControlService) => {
    const processor = new OptimizationProcessor(
      { principalForWorker: jest.fn().mockResolvedValue({ id: userId }) } as never,
      prisma,
      { executeAutomaticOptimization: solve } as never,
      { emitOptimizationJobUpdate: jest.fn() } as never,
      control,
    );
    return processor.process({
      name: 'run-automatic-optimization', data: { jobId }, attemptsMade: 0, opts: { attempts: 3 },
    } as never);
  };

  const seedPreviousResult = (optimizationJobId: string, candidateNumber: number) =>
    prisma.optimizationResult.create({ data: {
      optimizationJobId, candidateNumber, resultSnapshot: { previous: true },
      feasibilityStatus: 'FEASIBLE', objectiveBreakdown: {},
    } });

  it('stops the claimed job before declaring cancellation and can process a new job', async () => {
    const job = await createJob(`cancel-${suffix}`);
    const control = new OptimizationJobControlService();
    jest.spyOn(control, 'notifyPythonCancel').mockResolvedValue(undefined);
    const jobs = new OptimizationJobsService(prisma, {} as never, {} as never, {} as never, undefined, control);
    const user: Parameters<OptimizationJobsService['cancel']>[0] = {
      id: userId, username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId,
      grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId, permissions: ['trips.plan'] }],
    };
    let entered = () => {};
    const solverStarted = new Promise<void>(resolve => { entered = resolve; });
    let stopSolver = () => {};
    const stopping = new Promise<void>(resolve => { stopSolver = resolve; });
    const processing = runJob(job.id, async () => {
      entered();
      await stopping;
      throw new OptimizationCancelledError();
    }, control);

    try {
      await solverStarted;
      const signal = control.getSignal(job.id);
      expect(signal?.aborted).toBe(false);
      await expect(jobs.cancel(user, job.id)).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
      expect(signal?.aborted).toBe(true);
      await expect(jobs.cancel(user, job.id)).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
    } finally {
      stopSolver();
      await processing;
    }
    const stored = await prisma.optimizationJob.findUniqueOrThrow({
      where: { id: job.id }, include: { results: true },
    });
    expect(stored).toMatchObject({ status: 'CANCELLED', leaseOwner: null, leaseUntil: null, results: [] });
    expect(control.getSignal(job.id)).toBeUndefined();

    const next = await createJob(`after-cancel-${suffix}`);
    const best = candidate('new result');
    await runJob(next.id, () => ({ best, candidates: [best] }), control);
    await expect(prisma.optimizationJob.findUniqueOrThrow({ where: { id: next.id } }))
      .resolves.toMatchObject({ status: 'SUCCEEDED' });
  }, 20_000);

  it('atomically replaces ranked snapshots and stores the same best snapshot on the job', async () => {
    const job = await createJob(`write-${suffix}`);
    await seedPreviousResult(job.id, 1);
    await seedPreviousResult(job.id, 20);
    const candidates = Array.from({ length: 8 }, () => candidate(randomBytes(256 * 1024).toString('hex')));

    await runJob(job.id, () => ({ best: candidates[0], candidates }));

    const saved = await prisma.optimizationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { results: { orderBy: { candidateNumber: 'asc' } } },
    });
    expect(saved.status).toBe('SUCCEEDED');
    expect(saved.leaseOwner).toBeNull();
    expect(saved.results.map(row => row.candidateNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(saved.results.map(row => row.resultSnapshot)).toEqual(candidates);
    expect(saved.result).toEqual(candidates[0]);
  }, 20_000);

  it('leaves existing results and the current owner intact when a worker loses the lease', async () => {
    const job = await createJob(`lease-${suffix}`);
    await seedPreviousResult(job.id, 1);
    const best = candidate('new snapshot');
    await runJob(job.id, async () => {
      await prisma.optimizationJob.update({
        where: { id: job.id }, data: { leaseOwner: 'replacement-worker' },
      });
      return { best, candidates: [best] };
    });

    const saved = await prisma.optimizationJob.findUniqueOrThrow({
      where: { id: job.id }, include: { results: true },
    });
    expect(saved.status).toBe('RUNNING');
    expect(saved.leaseOwner).toBe('replacement-worker');
    expect(saved.result).toBeNull();
    expect(saved.results.map(row => row.resultSnapshot)).toEqual([{ previous: true }]);
  });

  it('preserves the previous candidate and rolls back completion when PostgreSQL rejects a snapshot', async () => {
    const job = await createJob(`rollback-${suffix}`);
    await seedPreviousResult(job.id, 1);
    const best = candidate('invalid PostgreSQL jsonb text\u0000');

    await expect(runJob(job.id, () => ({ best, candidates: [best] }))).rejects.toMatchObject({
      code: 'P2010',
    });

    const saved = await prisma.optimizationJob.findUniqueOrThrow({
      where: { id: job.id }, include: { results: true },
    });
    expect(saved.status).toBe('RETRYING');
    expect(saved.completedAt).toBeNull();
    expect(saved.result).toBeNull();
    expect(saved.results.map(row => row.resultSnapshot)).toEqual([{ previous: true }]);
  });
});
