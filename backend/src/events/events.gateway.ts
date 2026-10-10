import { randomUUID } from 'crypto';
import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayInit, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { ResourceAccess } from '../auth/resource-access.service';
import { hasPermission, Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@WebSocketGateway()
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
  async handleConnection(client: Socket) {
    try {
      const user = await this.identity(client);
      this.identities.set(client, user.id);
      await client.join(`user:${user.id}`);
      if (user.locationId && this.canUseLocation(user, user.locationId)) await client.join(`location:${user.locationId}`);
      await this.revalidate(client);
    } catch { client.disconnect(true); }
  }
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

  private canUseLocation(user: Principal, locationId: string) {
    return (user.role === 'STAFF' && user.locationId === locationId) || user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY');
  }
  @SubscribeMessage('join:location')
  async handleJoinLocation(@ConnectedSocket() client: Socket, @MessageBody() locationId: unknown) {
    try {
      if (typeof locationId !== 'string' || !isUUID(locationId)) return { ok: false, code: 'INVALID_LOCATION' };
      const user = await this.identity(client);
      if (!this.canUseLocation(user, locationId)) return { ok: false, code: 'PERMISSION_DENIED' };
      await client.join(`location:${locationId}`);
      return { ok: true, locationId };
    } catch { return { ok: false, code: 'PERMISSION_DENIED' }; }
  }
  async emitToLocations(locationIds: string[], event: string, payload: unknown) {
    if (!this.server) throw new Error('Socket.IO server chưa sẵn sàng');
    for (const client of this.server.sockets.sockets.values()) {
      const matching = locationIds.filter(id => client.rooms.has(`location:${id}`));
      if (!matching.length) continue;
      try { await this.emitAuthorized(client, async user => {
        if (matching.some(id => this.canUseLocation(user, id))) client.emit(event, payload);
      }); } catch { client.disconnect(true); }
    }
  }
  async emitOptimizationJobUpdate(branchId: string, payload: { jobId: string; status: string }) {
    if (!this.server) return;
    for (const client of this.server.sockets.sockets.values()) {
      if (!client.rooms.has(`branch:${branchId}`)) continue;
      try { await this.emitAuthorized(client, async user => {
        if (hasPermission(user, 'trips.plan', branchId)) client.emit('optimization:job-updated', { eventId: randomUUID(), occurredAt: new Date().toISOString(), ...payload });
      }); } catch { client.disconnect(true); }
    }
  }
}
