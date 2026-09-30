import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayInit, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { ResourceAccess } from '../auth/resource-access.service';
import { hasPermission, Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@WebSocketGateway({ cors: { origin: true } })
export class EventsGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private timer?: ReturnType<typeof setInterval>;
  private readonly identities = new WeakMap<Socket, string>();
  constructor(private readonly auth: AuthService, private readonly access: ResourceAccess, private readonly prisma: PrismaService) {}
  afterInit(server: Server) {
    server.use(async (client, next) => {
      try { const user = await this.identity(client); this.identities.set(client, user.id); next(); } catch { next(new Error('SESSION_INVALID')); }
    });
    this.timer = setInterval(() => {
      for (const client of server.sockets.sockets.values()) void this.revalidate(client);
    }, 10000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  handleConnection(client: Socket) { void this.revalidate(client); }
  disconnectUser(userId: string) {
    for (const client of this.server.sockets.sockets.values()) {
      if (this.identities.get(client) === userId) client.disconnect(true);
    }
  }
  private async emitAuthorized(client: Socket, emit: (user: Principal, db: Prisma.TransactionClient) => Promise<void>) {
    const id = this.identities.get(client);
    if (!id) throw new Error('SESSION_INVALID');
    // Serialize delivery with account locking, including across backend processes.
    // A lock waits for an already authorized send; later sends see active=false.
    await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ active: boolean }>>`SELECT active FROM users WHERE id = ${id} FOR SHARE`;
      if (!rows[0]?.active) throw new Error('SESSION_INVALID');
      const user = await this.identity(client, tx);
      if (client.connected) await emit(user, tx);
    });
  }
  private identity(client: Socket, db: Prisma.TransactionClient = this.prisma) {
    const token: unknown = client.handshake.auth.token;
    if (typeof token !== 'string') throw new Error('SESSION_INVALID');
    return this.auth.authenticateToken(token, db);
  }
  private async revalidate(client: Socket) {
    try {
      const user = await this.identity(client);
      for (const room of client.rooms) {
        if (room.startsWith('branch:') && !hasPermission(user, 'trips.read', room.slice(7))) {
          await client.leave(room);
          client.emit('scope:revoked', { code: 'PERMISSION_DENIED' });
        }
      }
    } catch { client.disconnect(true); }
  }
  @SubscribeMessage('join:branch')
  async handleJoinBranch(@ConnectedSocket() client: Socket, @MessageBody() branchId: unknown) {
    try {
      if (typeof branchId !== 'string' || !isUUID(branchId)) return { ok: false, code: 'INVALID_BRANCH' };
      const user = await this.identity(client);
      await this.access.branch(user, 'trips.read', branchId);
      for (const room of client.rooms) if (room.startsWith('branch:')) await client.leave(room);
      await client.join(`branch:${branchId}`);
      return { ok: true, branchId };
    } catch { return { ok: false, code: 'PERMISSION_DENIED' }; }
  }
  // Only invalidation metadata is sent; authorized clients reload the scoped HTTP snapshot.
  async emitTripUpdate(input: { id: string }) {
    const trip = await this.prisma.trip.findUnique({ where: { id: input.id }, select: { id: true, managingBranchId: true, version: true } });
    if (!trip?.managingBranchId) return;
    for (const client of this.server.sockets.sockets.values()) {
      if (!client.rooms.has(`branch:${trip.managingBranchId}`)) continue;
      try {
        await this.emitAuthorized(client, async (user, db) => {
          await this.access.trip(user, trip.id, 'trips.read', db);
          client.emit('trip:updated', { id: trip.id, version: trip.version });
        });
      } catch { await client.leave(`branch:${trip.managingBranchId}`); await this.revalidate(client); }
    }
  }
  async emitLocationUpdate(data: { vehicleId: string; lat: number; lng: number; speed?: number }) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: data.vehicleId }, select: { homeBranchId: true } });
    if (!vehicle) return;
    for (const client of this.server.sockets.sockets.values()) {
      if (!client.rooms.has(`branch:${vehicle.homeBranchId}`)) continue;
      try {
        await this.emitAuthorized(client, async user => {
          if (hasPermission(user, 'vehicles.read', vehicle.homeBranchId)) client.emit('location:updated', data);
        });
      } catch { client.disconnect(true); }
    }
  }
}
