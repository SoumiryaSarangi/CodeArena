'use client';
import type { Me } from '@codearena/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, apiFetch, auth } from './api';

export type SessionState =
  { status: 'loading'; me: null } | { status: 'guest'; me: null } | { status: 'authed'; me: Me };

interface SessionContext {
  session: SessionState;
  /** Re-reads `/api/me` (after choosing a handle, say). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionContext | null>(null);

/**
 * Knows who is signed in. On load it asks the API to trade the refresh cookie for an access token
 * and reads `/api/me`; a failure to reach the API leaves the user a guest, never an error screen.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading', me: null });

  const reload = useCallback(async () => {
    try {
      const token = await auth.accessToken();
      if (!token) return setSession({ status: 'guest', me: null });
      const me = await apiFetch<Me>('GET', '/me');
      setSession({ status: 'authed', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) auth.clear();
      setSession({ status: 'guest', me: null });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('POST', '/auth/logout');
    } finally {
      auth.clear();
      setSession({ status: 'guest', me: null });
    }
  }, []);

  const value = useMemo(() => ({ session, reload, signOut }), [session, reload, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

/** Where to send someone who has to sign in first, coming back here afterwards. */
export const signInHref = (returnTo: string) => `/signin?returnTo=${encodeURIComponent(returnTo)}`;
