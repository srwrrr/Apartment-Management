import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Button, Card, Field, Notice, PageHeader, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { EmergencyContact } from '../lib/types';

type Draft = Omit<EmergencyContact, 'id'>;
const blank: Draft = { name: '', role: '', phone: '', hours: '' };

/** FR-52: the whole list is edited here and saved in one go, in the order shown. */
function Editor({ items }: { items: EmergencyContact[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rows, setRows] = useState<Draft[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => setRows(items.map(({ name, role, phone, hours }) => ({ name, role, phone, hours }))), [items]);

  const save = useMutation({
    mutationFn: () => api.put<{ items: EmergencyContact[] }>('/api/emergency-contacts', { contacts: rows }),
    onMutate: () => setSaved(false),
    onSuccess: (data) => {
      qc.setQueryData(['emergency-contacts'], data);
      setSaved(true);
    },
  });
  const fe = fieldErrorsOf(t, save.error);
  const change = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row!);
    setRows(next);
  };

  return (
    <Card className="mt-4">
      <h2 className="mb-1 text-xl font-bold">{t('common.edit')}</h2>
      <p className="mb-4 text-muted">{t('emergency.manageHelp')}</p>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {rows.map((r, i) => (
          <fieldset key={i} className="space-y-3 rounded-lg border border-line p-3" data-testid="emergency-row">
            <legend className="px-1 font-semibold">{t('emergency.contact', { number: i + 1 })}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('emergency.name')} error={fe[`contacts.${i}.name`]}>{(p) => <TextInput {...p} value={r.name} onChange={(e) => change(i, { name: e.target.value })} />}</Field>
              <Field label={t('emergency.role')} error={fe[`contacts.${i}.role`]}>{(p) => <TextInput {...p} value={r.role} onChange={(e) => change(i, { role: e.target.value })} />}</Field>
              <Field label={t('emergency.phone')} error={fe[`contacts.${i}.phone`]}>{(p) => <TextInput {...p} inputMode="tel" value={r.phone} onChange={(e) => change(i, { phone: e.target.value })} />}</Field>
              <Field label={t('emergency.hours')} error={fe[`contacts.${i}.hours`]}>{(p) => <TextInput {...p} value={r.hours} onChange={(e) => change(i, { hours: e.target.value })} />}</Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={i === 0} aria-label={t('emergency.moveUp', { name: r.name || i + 1 })} onClick={() => move(i, -1)}>↑</Button>
              <Button variant="secondary" disabled={i === rows.length - 1} aria-label={t('emergency.moveDown', { name: r.name || i + 1 })} onClick={() => move(i, 1)}>↓</Button>
              <Button variant="ghost" onClick={() => setRows(rows.filter((_, n) => n !== i))}>{t('emergency.remove', { name: r.name || i + 1 })}</Button>
            </div>
          </fieldset>
        ))}
        {save.isError && !Object.keys(fe).length && <Notice>{errorMessage(t, save.error)}</Notice>}
        {save.isError && Object.keys(fe).length > 0 && <Notice>{t('errors.VALIDATION_FAILED')}</Notice>}
        {saved && <Notice tone="info">{t('emergency.saved')}</Notice>}
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setRows([...rows, blank])}>{t('emergency.add')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Card>
  );
}

export function EmergencyPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['emergency-contacts'], queryFn: () => api.get<{ items: EmergencyContact[] }>('/api/emergency-contacts') });
  return (
    <>
      <PageHeader title={t('emergency.title')} />
      <p className="mb-4 text-muted">{t('emergency.help')}</p>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('emergency.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3" data-testid="emergency-contact">
                <span className="min-w-40 flex-1">
                  <span className="block text-lg font-bold">{c.name}</span>
                  <span className="block text-sm text-muted">
                    {c.role} · {c.hours}
                  </span>
                </span>
                <a href={`tel:${c.phone.replace(/[\s-]/g, '')}`} className="inline-flex min-h-11 items-center text-lg font-bold text-brand-700 underline">
                  <span className="sr-only">{t('emergency.call', { name: c.name })}: </span>
                  {c.phone}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {can('announcements.manage') && q.data && <Editor items={q.data.items} />}
    </>
  );
}
