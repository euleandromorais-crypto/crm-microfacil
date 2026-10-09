import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'seller';
  teamId: number | null;
  phone?: string | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  mailEnabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  isManager: boolean;
  isAdmin: boolean;
}

const Ctx = createContext<AuthState>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mailEnabled, setMailEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: User; mailEnabled: boolean }>('/api/auth/me');
      setUser(r.user);
      setMailEnabled(r.mailEnabled);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    void refresh();
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: User }>('/api/auth/login', { email, password });
    setUser(r.user);
    void refresh();
  };
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  };
  return (
    <Ctx.Provider value={{ user, loading, mailEnabled, login, logout, refresh, isManager: user?.role === 'admin' || user?.role === 'manager', isAdmin: user?.role === 'admin' }}>
      {children}
    </Ctx.Provider>
  );
}
