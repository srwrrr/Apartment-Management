import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Button, Card, Field, Notice, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const { user, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const fields = fieldErrorsOf(t, error);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      await refresh();
      setDone(true);
      setCurrent('');
      setNext('');
      setTimeout(() => navigate('/', { replace: true }), 1200);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <Card>
        <h1 className="mb-2 text-2xl font-bold">{t('auth.changeTitle')}</h1>
        {user?.mustChangePassword && <div className="mb-4"><Notice tone="info">{t('auth.changeTempIntro')}</Notice></div>}
        {done && <div className="mb-4"><Notice tone="info">{t('auth.changed')}</Notice></div>}
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error !== null && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, error)}</Notice>}
          <Field label={t('auth.currentPassword')} error={fields.currentPassword}>
            {(p) => <TextInput {...p} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label={t('auth.newPassword')} error={fields.newPassword} help={t('auth.passwordHelp')}>
            {(p) => <TextInput {...p} type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !current || !next}>
              {t('common.save')}
            </Button>
            {user?.mustChangePassword && (
              <Button
                variant="ghost"
                onClick={async () => {
                  await logout();
                  navigate('/login');
                }}
              >
                {t('common.logout')}
              </Button>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
