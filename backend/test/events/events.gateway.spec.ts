import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Socket } from 'socket.io';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EventsGateway } from '../../src/events/events.gateway';

describe('EventsGateway', () => {
  const jwt = { verifyAsync: jest.fn() } as unknown as JwtService;
  const prisma = { user: { findUnique: jest.fn() } } as unknown as PrismaService;
  const gateway = new EventsGateway(jwt, prisma);

  const socket = (token?: string) =>
    ({
      id: 'socket-1',
      handshake: { auth: token ? { token } : {}, headers: {} },
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
    }) as unknown as Socket;

  beforeEach(() => jest.clearAllMocks());

  it('xác thực JWT, nạp user mới nhất và tự join room đúng scope', async () => {
    const client = socket('valid-token');
    (jwt.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'user-1' });
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'user-1',
      role: Role.STAFF,
      branchId: 'branch-1',
      locationId: 'location-1',
      active: true,
    });

    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.join).toHaveBeenCalledWith('branch:branch-1');
    expect(client.join).toHaveBeenCalledWith('location:location-1');
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('ngắt socket không có token hợp lệ', async () => {
    const client = socket();
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('không cho STAFF join location khác', () => {
    const client = socket('valid-token');
    client.data.user = {
      id: 'user-1',
      role: Role.STAFF,
      branchId: 'branch-1',
      locationId: 'location-1',
    };
    expect(gateway.handleJoinLocation(client, 'location-2')).toEqual({
      event: 'error',
      code: 'FORBIDDEN',
    });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('gắn event ID và thời điểm cho cập nhật optimization job', () => {
    const emit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit })) } as never;

    gateway.emitOptimizationJobUpdate('branch-1', {
      jobId: 'job-1',
      status: 'RUNNING',
    });

    expect(emit).toHaveBeenCalledWith(
      'optimization:job-updated',
      expect.objectContaining({
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        occurredAt: expect.any(String),
        jobId: 'job-1',
        status: 'RUNNING',
      }),
    );
  });
});
