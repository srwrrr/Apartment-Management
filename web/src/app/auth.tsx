import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { hasPermission, type Permission } from '@apt/shared';
import { api, ApiError, onUnauthenticated, setCsrfToken } from '../lib/api';
import i18n, { safeGet, safeRemove, safeSet, type Lang } from '../lib/i18n';
import type { Role } from '../lib/types';

export interface AuthUser {
  id: string;
  loginId: string;
  fullName: string;
  role: Role;
  language: 'EN' | 'BN';
  textSize: 'NORMAL' | 'LARGE';
  mustChangePassword: boolean;
  permissions: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (loginId: string, password: string) => Promise<{ mustChangePassword: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
  language: Lang;
  setLanguage: (l: Lang) => void;
  largeText: boolean;
  setLargeText: (large: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readLargeText(): boolean {
  try {
    return localStorage.getItem('textSize') === 'LARGE';
  } catch {
    return false;
  }
}

// Language / text size picked on the login page, before anyone is logged in, is a deliberate choice:
// it is saved to the account at login instead of being overridden by the old setting.
// It lives in local storage so it survives a page refresh before logging in.
const LOGIN_CHOICE_KEY = 'loginChoice';
type LoginChoice = { language?: 'EN' | 'BN'; textSize?: 'NORMAL' | 'LARGE' };
function readLoginChoice(): LoginChoice {
  try {
    return JSON.parse(safeGet(LOGIN_CHOICE_KEY) ?? '{}') as LoginChoice;
  } catch {
    return {};
  }
}
function writeLoginChoice(patch: LoginChoice) {
  safeSet(LOGIN_CHOICE_KEY, JSON.stringify({ ...readLoginChoice(), ...patch }));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { i18n: i18nHook } = useTranslation();

  const me = useQuery({
    queryKey: ['me'],
    staleTime: Infinity,
    retry: false,
    queryFn: async (): Promise<AuthUser | null> => {
      try {
        const res = await api.get<{ user: AuthUser; csrfToken: string }>('/api/auth/me');
        setCsrfToken(res.csrfToken);
        return res.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
  const user = me.data ?? null;

  // A session that expires while the app is open sends the user back to the login page.
  useEffect(() => {
    onUnauthenticated(() => {
      setCsrfToken(null);
      qc.setQueryData(['me'], null);
    });
    return () => onUnauthenticated(null);
  }, [qc]);

  // The signed-in user's saved preferences win over whatever the browser remembered.
  useEffect(() => {
    if (!user) return;
    const lang: Lang = user.language === 'BN' ? 'bn' : 'en';
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
    safeSet('lang', lang);
    safeSet('textSize', user.textSize);
    document.documentElement.classList.toggle('text-large', user.textSize === 'LARGE');
  }, [user]);

  useEffect(() => {
    document.documentElement.lang = i18nHook.language === 'bn' ? 'bn' : 'en';
  }, [i18nHook.language]);

  useEffect(() => {
    if (!user) document.documentElement.classList.toggle('text-large', readLargeText());
  }, [user]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);


  const login = useCallback(
    async (loginId: string, password: string) => {
      const res = await api.post<{ csrfToken: string; mustChangePassword: boolean }>('/api/auth/login', { loginId, password });
      setCsrfToken(res.csrfToken);
      const choice = readLoginChoice();
      safeRemove(LOGIN_CHOICE_KEY);
      if (choice.language || choice.textSize) {
        try {
          await api.patch('/api/me/preferences', choice);
        } catch {
          /* not worth failing the login for */
        }
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
      return { mustChangePassword: res.mustChangePassword };
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setCsrfToken(null);
      // Drop everything the last user could see, but keep the 'me' query mounted: clear() would detach it
      // from the screen and leave the UI still showing the old user.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const setLanguage = useCallback(
    (l: Lang) => {
      void i18n.changeLanguage(l);
      safeSet('lang', l);
      if (!user) writeLoginChoice({ language: l === 'bn' ? 'BN' : 'EN' });
      if (user) {
        void api.patch('/api/me/preferences', { language: l === 'bn' ? 'BN' : 'EN' }).then(() =>
          qc.setQueryData(['me'], (u: AuthUser | null | undefined) => (u ? { ...u, language: l === 'bn' ? 'BN' : 'EN' } : u)),
        );
      }
    },
    [user, qc],
  );

  const [anonLarge, setAnonLarge] = useState(readLargeText);
  const largeText = user ? user.textSize === 'LARGE' : anonLarge;
  const setLargeText = useCallback(
    (large: boolean) => {
      document.documentElement.classList.toggle('text-large', large);
      safeSet('textSize', large ? 'LARGE' : 'NORMAL');
      if (user) {
        void api.patch('/api/me/preferences', { textSize: large ? 'LARGE' : 'NORMAL' }).then(() =>
          qc.setQueryData(['me'], (u: AuthUser | null | undefined) => (u ? { ...u, textSize: large ? 'LARGE' : 'NORMAL' } : u)),
        );
      } else {
        setAnonLarge(large);
        writeLoginChoice({ textSize: large ? 'LARGE' : 'NORMAL' });
      }
    },
    [user, qc],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading: me.isLoading,
      login,
      logout,
      refresh,
      can: (p) => !!user && hasPermission(user, p),
      language: i18nHook.language === 'bn' ? 'bn' : 'en',
      setLanguage,
      largeText,
      setLargeText,
    }),
    [user, me.isLoading, login, logout, refresh, i18nHook.language, setLanguage, largeText, setLargeText],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
