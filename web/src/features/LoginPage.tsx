import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { LanguageSwitch, TextSizeSwitch } from '../components/Preferences';
import { Button, Card, Field, Notice, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // Demo mode only (spec §12). The server sends nothing here unless it is switched on.
  const demo = useQuery({ queryKey: ['demo-accounts'], queryFn: () => api.get<{ items: { role: 'ADMIN' | 'STAFF' | 'RESIDENT'; loginId: string; password: string }[] }>('/api/auth/demo-accounts'), retry: false, staleTime: Infinity });

  async function submit(e: FormEvent) {
    e.preventDefault();
    await signIn(loginId, password);
  }

  async function signIn(id: string, pw: string) {
    setBusy(true);
    setError(null);
    try {
      const { mustChangePassword } = await login(id, pw);
      navigate(mustChangePassword ? '/change-password' : from, { replace: true });
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LanguageSwitch />
        <TextSizeSwitch />
      </div>
      <div className="text-center">
        <p className="text-3xl font-bold text-brand-700">{t('app.building')}</p>
        <p className="text-muted">{t('app.name')}</p>
      </div>
      <Card>
        <h1 className="mb-1 text-2xl font-bold">{t('auth.loginTitle')}</h1>
        <p className="mb-4 text-muted">{t('auth.loginIntro')}</p>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error !== null && <Notice>{errorMessage(t, error)}</Notice>}
          <Field label={t('auth.loginId')}>
            {(p) => <TextInput {...p} name="loginId" autoComplete="username" autoCapitalize="none" required value={loginId} onChange={(e) => setLoginId(e.target.value)} />}
          </Field>
          <Field label={t('auth.password')}>
            {(p) => <TextInput {...p} name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" className="w-full" disabled={busy || !loginId || !password}>
            {busy ? t('auth.signingIn') : t('auth.signIn')}
          </Button>
        </form>
      </Card>
      {!!demo.data?.items.length && (
        <Card>
          <h2 className="mb-2 font-semibold">{t('auth.demoTitle')}</h2>
          <div className="flex flex-wrap gap-2">
            {demo.data.items.map((a) => (
              <Button key={a.role} variant="secondary" disabled={busy} onClick={() => void signIn(a.loginId, a.password)}>
                {t(`auth.demo${a.role}`)}
              </Button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
