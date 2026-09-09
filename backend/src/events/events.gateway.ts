import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('EventsGateway');

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Phát sự kiện cập nhật chuyến đi đến các Dispatchers
   */
  emitTripUpdate(trip: any) {
    this.server.emit('trip:updated', trip);
  }

  /**
   * Phát sự kiện cập nhật vị trí GPS xe
   */
  emitLocationUpdate(locationData: { vehicleId: string; lat: number; lng: number; speed?: number }) {
    this.server.emit('location:updated', locationData);
  }

  @SubscribeMessage('join:branch')
  handleJoinBranch(client: Socket, branchId: string) {
    client.join(`branch:${branchId}`);
    return { event: 'joined', branchId };
  }
}
