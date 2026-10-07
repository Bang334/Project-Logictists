import 'dotenv/config';
import { randomUUID } from 'crypto';
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
});
