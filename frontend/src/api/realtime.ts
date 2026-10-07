import { io, Socket } from 'socket.io-client';

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:4000';

let socket: Socket | null = null;
let socketToken: string | null = null;
export const disconnectRealtimeSocket = () => {
  socket?.disconnect(); socket = null; socketToken = null;
};

export const getRealtimeSocket = (): Socket | null => {
  const token = sessionStorage.getItem('tms_token');
  if (token !== socketToken) disconnectRealtimeSocket();
  if (!token) return null;
  if (!socket) {
    socketToken = token;
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
