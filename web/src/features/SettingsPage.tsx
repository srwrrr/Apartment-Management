import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, Field, Notice, PageHeader, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';

interface Settings {
  buildingName: string;
  goLiveDate: string;
  defaultDueDay: number;
}

/** Building name, the day the system starts being used, and the usual due day (BR-10, BR-22). */
export function SettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const [form, setForm] = useState({ buildingName: '', goLiveDate: '', defaultDueDay: '10' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (q.data) setForm({ buildingName: q.data.buildingName, goLiveDate: q.data.goLiveDate, defaultDueDay: String(q.data.defaultDueDay) });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.put<Settings>('/api/settings', { buildingName: form.buildingName.trim(), goLiveDate: form.goLiveDate, defaultDueDay: Number(form.defaultDueDay) }),
    onSuccess: async (data) => {
      qc.setQueryData(['settings'], data);
      await qc.invalidateQueries({ queryKey: ['public-settings'] });
      setSaved(true);
    },
  });
  const fields = fieldErrorsOf(t, save.error);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <Card className="max-w-xl">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {saved && <Notice tone="info">{t('settings.saved')}</Notice>}
          {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
          <Field label={t('settings.buildingName')} error={fields.buildingName}>
            {(p) => <TextInput {...p} required maxLength={80} value={form.buildingName} onChange={set('buildingName')} />}
          </Field>
          <Field label={t('settings.goLiveDate')} help={t('settings.goLiveHelp')} error={fields.goLiveDate}>
            {(p) => <TextInput {...p} type="date" required value={form.goLiveDate} onChange={set('goLiveDate')} />}
          </Field>
          <Field label={t('settings.defaultDueDay')} help={t('settings.dueDayHelp')} error={fields.defaultDueDay}>
            {(p) => <TextInput {...p} type="number" inputMode="numeric" min={1} max={28} required value={form.defaultDueDay} onChange={set('defaultDueDay')} />}
          </Field>
          <Button type="submit" disabled={save.isPending}>
            {t('common.save')}
          </Button>
        </form>
      </Card>
    </>
  );
}
