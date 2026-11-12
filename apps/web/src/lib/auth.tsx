import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUserDto, SessionResponse } from '@teachgrow/shared';
import { api, refreshSession, session } from './api';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: AuthUserDto | null;
  login(email: string, password: string): Promise<AuthUserDto>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUserDto | null>(null);

  const signedOut = useCallback(() => {
    session.set(null);
    setUser(null);
    setStatus('signedOut');
    queryClient.clear();
  }, [queryClient]);

  // On load the only thing that can prove who this is is the HttpOnly refresh cookie.
  useEffect(() => {
    let cancelled = false;
    session.onLost(signedOut);
    refreshSession()
      .then((renewed) => {
        if (cancelled) return;
        if (renewed) {
          setUser(renewed.user);
          setStatus('signedIn');
        } else {
          setStatus('signedOut');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('signedOut');
      });
    return () => {
      cancelled = true;
      session.onLost(null);
    };
  }, [signedOut]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<SessionResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password, client: 'web' },
      auth: false,
      csrf: true,
    });
    session.set(res.accessToken);
    setUser(res.user);
    setStatus('signedIn');
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {}, auth: false, csrf: true });
    } catch {
      /* signing out must always work from the person's side */
    }
    signedOut();
  }, [signedOut]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    const me = await api<{ user: AuthUserDto }>('/api/auth/me');
    setUser(me.user);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, user, login, logout, changePassword }),
    [status, user, login, logout, changePassword],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
