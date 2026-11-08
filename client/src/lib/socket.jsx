import { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './auth';

const SocketCtx = createContext({ socket: null, connected: false });

// One Socket.IO connection per logged-in session, authenticated with the JWT.
export function SocketProvider({ children }) {
  const { token, user } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token || !user) return undefined;
    const s = io({ auth: { token, visible: document.visibilityState === 'visible' }, transports: ['websocket', 'polling'] });
    // Tell the server when the app goes to the background, so calls also ring the phone by push.
    const onVis = () => { const visible = document.visibilityState === 'visible'; s.auth.visible = visible; s.emit('presence', { visible }); };
    document.addEventListener('visibilitychange', onVis);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);
    return () => { document.removeEventListener('visibilitychange', onVis); s.close(); setSocket(null); setConnected(false); };
  }, [token, user]);

  return <SocketCtx.Provider value={{ socket, connected }}>{children}</SocketCtx.Provider>;
}

export const useSocket = () => useContext(SocketCtx);

// Subscribe to a socket event for the lifetime of a component.
export function useSocketEvent(event, handler) {
  const { socket } = useSocket();
  useEffect(() => {
    if (!socket) return undefined;
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, [socket, event, handler]);
}