import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';

type SocketUser = {
  id: string;
  role: Role;
  branchId: string | null;
  locationId: string | null;
};

@WebSocketGateway()
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('EventsGateway');

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, branchId: true, locationId: true, active: true },
      });
      if (!user?.active) throw new Error('inactive socket user');

      client.data.user = {
        id: user.id,
        role: user.role,
        branchId: user.branchId,
        locationId: user.locationId,
      } satisfies SocketUser;
      client.join(`user:${user.id}`);
      if (user.branchId) client.join(`branch:${user.branchId}`);
      if (user.locationId) client.join(`location:${user.locationId}`);
      this.logger.log(`Authenticated socket connected: ${client.id}`);
    } catch {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Phát sự kiện cập nhật chuyến đi đến các Dispatchers
   */
  emitTripUpdate(branchId: string, trip: unknown) {
    this.server.to(`branch:${branchId}`).emit('trip:updated', trip);
  }

  /**
   * Phát sự kiện cập nhật vị trí GPS xe
   */
  emitLocationUpdate(
    branchId: string,
    locationData: { vehicleId: string; lat: number; lng: number; speed?: number },
  ) {
    this.server.to(`branch:${branchId}`).emit('location:updated', locationData);
  }

  @SubscribeMessage('join:branch')
  handleJoinBranch(client: Socket, branchId: string) {
    const user = client.data.user as SocketUser | undefined;
    if (!user || (user.role !== Role.ADMIN && user.branchId !== branchId)) {
      return { event: 'error', code: 'FORBIDDEN' };
    }
    client.join(`branch:${branchId}`);
    return { event: 'joined', branchId };
  }

  @SubscribeMessage('join:location')
  handleJoinLocation(client: Socket, locationId: string) {
    const user = client.data.user as SocketUser | undefined;
    if (!user || (user.role !== Role.ADMIN && user.locationId !== locationId)) {
      return { event: 'error', code: 'FORBIDDEN' };
    }
    client.join(`location:${locationId}`);
    return { event: 'joined', locationId };
  }

  emitToLocations(locationIds: string[], event: string, payload: unknown) {
    if (!this.server) throw new Error('Socket.IO server chưa sẵn sàng');
    for (const locationId of new Set(locationIds.filter(Boolean))) {
      this.server.to(`location:${locationId}`).emit(event, payload);
    }
  }

  private extractToken(client: Socket): string {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
    const authorization = client.handshake.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice(7).trim();
    }
    throw new Error('missing socket token');
  }
}
