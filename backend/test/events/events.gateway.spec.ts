import { Socket, Server } from 'socket.io';
import { AuthService } from '../../src/auth/auth.service';
import { ResourceAccess } from '../../src/auth/resource-access.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EventsGateway } from '../../src/events/events.gateway';

const branch = '00000000-0000-4000-8000-000000000001';
const location = '00000000-0000-4000-8000-000000000002';
describe('EventsGateway session and scope authorization', () => {
  const auth = { authenticateToken: jest.fn() };
  const access = { branch: jest.fn() };
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ active: true }]) };
  const prisma = { $transaction: jest.fn(async callback => callback(tx)) };
  const gateway = new EventsGateway(auth as unknown as AuthService, access as unknown as ResourceAccess, prisma as unknown as PrismaService);
  const socket = () => ({ id: 'socket-1', connected: true, handshake: { auth: { token: 'test' } }, rooms: new Set<string>(), join: jest.fn(), leave: jest.fn(), emit: jest.fn(), disconnect: jest.fn() }) as unknown as Socket;
  beforeEach(() => {
    jest.clearAllMocks();
    auth.authenticateToken.mockResolvedValue({ id: 'user-1', role: 'STAFF', locationId: location, grants: [] });
  });
  it('loads the current session and joins only its authorized location', async () => {
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.join).toHaveBeenCalledWith(`location:${location}`);
    expect(client.join).not.toHaveBeenCalledWith(`branch:${branch}`);
    expect(client.disconnect).not.toHaveBeenCalled();
  });
  it('disconnects a revoked session', async () => {
    const client = socket();
    auth.authenticateToken.mockRejectedValue(new Error('revoked'));
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
  it('rejects another location even when the socket claims a different role', async () => {
    const client = socket();
    expect(await gateway.handleJoinLocation(client, branch)).toEqual({ ok: false, code: 'PERMISSION_DENIED' });
    expect(client.join).not.toHaveBeenCalled();
  });
  it('rechecks current grants before sending job invalidations with event identity', async () => {
    const client = socket();
    client.rooms.add(`branch:${branch}`);
    auth.authenticateToken.mockResolvedValue({ id: 'user-1', grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: branch, permissions: ['trips.plan', 'trips.read'] }] });
    await gateway.handleConnection(client);
    gateway.server = { sockets: { sockets: new Map([[client.id, client]]) } } as unknown as Server;
    await gateway.emitOptimizationJobUpdate(branch, { jobId: 'job-1', status: 'RUNNING' });
    expect(client.emit).toHaveBeenCalledWith('optimization:job-updated', expect.objectContaining({ eventId: expect.stringMatching(/^[0-9a-f-]{36}$/), occurredAt: expect.any(String), jobId: 'job-1', status: 'RUNNING' }));
    jest.mocked(client.emit).mockClear();
    auth.authenticateToken.mockResolvedValue({ id: 'user-1', grants: [] });
    await gateway.emitOptimizationJobUpdate(branch, { jobId: 'job-1', status: 'SUCCEEDED' });
    expect(client.emit).not.toHaveBeenCalled();
  });
});
