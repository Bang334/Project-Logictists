import { io, Socket } from 'socket.io-client';

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:4000';

let socket: Socket | null = null;

export const getRealtimeSocket = (): Socket | null => {
  const token = localStorage.getItem('tms_token');
  if (!token) return null;
  if (!socket) {
    socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
  } else {
    socket.auth = { token };
    if (!socket.connected) socket.connect();
  }
  return socket;
};
