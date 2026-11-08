import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import { syncPush, unlinkPush } from './push';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setTok] = useState(getToken());
  const [loading, setLoading] = useState(!!getToken());

  const logout = useCallback(() => {
    unlinkPush().finally(() => setToken(null)); // stop ringing this device for this account
    setTok(null); setUser(null);
  }, []);

  useEffect(() => {
    const h = () => logout();
    window.addEventListener('ov:logout', h);
    return () => window.removeEventListener('ov:logout', h);
  }, [logout]);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    api.get('/auth/me').then((d) => { setUser(d.user); syncPush(); }).catch(() => logout()).finally(() => setLoading(false));
  }, [token, logout]);

  const finish = (d) => { setToken(d.token); setTok(d.token); setUser(d.user); return d.user; };
  const login = async (email, password, role) => finish(await api.post('/auth/login', { email, password, role }));
  const register = async (body) => finish(await api.post('/auth/register', body));

  return <AuthCtx.Provider value={{ user, token, loading, login, register, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);