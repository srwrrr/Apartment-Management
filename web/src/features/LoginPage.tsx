import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { LanguageSwitch, TextSizeSwitch } from '../components/Preferences';
import { BrandMark } from '../components/BrandMark';
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
    <div className="mx-auto grid min-h-screen w-full max-w-6xl items-center gap-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_27rem]">
      <div className="flex flex-col gap-4 lg:gap-6">
        <BrandMark className="size-12 lg:size-16" />
        <div>
          <p className="font-display text-3xl font-bold leading-tight tracking-tight lg:text-5xl">{t('app.building')}</p>
          <p className="mt-1 text-muted lg:mt-3 lg:text-xl">{t('app.name')}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <LanguageSwitch />
          <TextSizeSwitch />
        </div>
        <Card className="sm:!p-7">
          <h1 className="heading-page mb-1">{t('auth.loginTitle')}</h1>
          <p className="mb-5 text-muted">{t('auth.loginIntro')}</p>
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
          <Card className="!p-4">
            <h2 className="heading-card mb-3">{t('auth.demoTitle')}</h2>
            <div className="flex flex-wrap gap-2">
              {demo.data.items.map((a) => (
                <Button key={a.role} variant="secondary" className="flex-auto whitespace-nowrap !px-3" disabled={busy} onClick={() => void signIn(a.loginId, a.password)}>
                  {t(`auth.demo${a.role}`)}
                </Button>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
