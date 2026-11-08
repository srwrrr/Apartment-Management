import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, Field, Notice, PageHeader, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate } from '../lib/format';
import type { MyProfile } from '../lib/types';

export function ProfilePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<MyProfile>('/api/me/profile') });
  const [form, setForm] = useState({ phone: '', altPhone: '', emergencyContactName: '', emergencyContactPhone: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setForm({
      phone: q.data.phone,
      altPhone: q.data.profile?.altPhone ?? '',
      emergencyContactName: q.data.profile?.emergencyContactName ?? '',
      emergencyContactPhone: q.data.profile?.emergencyContactPhone ?? '',
    });
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.patch<MyProfile>('/api/me/profile', form),
    onSuccess: (data) => {
      qc.setQueryData(['my-profile'], data);
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
  const p = q.data!;

  return (
    <>
      <PageHeader title={t('profile.title')} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-1 heading-section">{p.fullName}</h2>
          <p className="mb-4 text-muted">{p.loginId}</p>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <h3 className="text-lg font-semibold">{t('profile.contact')}</h3>
            <p className="text-sm text-muted">{t('profile.contactHelp')}</p>
            {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
            {saved && <Notice tone="info">{t('profile.saved')}</Notice>}
            <Field label={t('common.phone')} error={fields.phone}>
              {(a) => <TextInput {...a} type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} />}
            </Field>
            <Field label={t('residents.altPhone')} error={fields.altPhone} optional>
              {(a) => <TextInput {...a} type="tel" inputMode="tel" value={form.altPhone} onChange={set('altPhone')} />}
            </Field>
            <Field label={t('residents.emergencyName')} error={fields.emergencyContactName} optional>
              {(a) => <TextInput {...a} value={form.emergencyContactName} onChange={set('emergencyContactName')} />}
            </Field>
            <Field label={t('residents.emergencyPhone')} error={fields.emergencyContactPhone} optional>
              {(a) => <TextInput {...a} type="tel" inputMode="tel" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />}
            </Field>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </form>
        </Card>
        <Card>
          <h2 className="mb-3 heading-section">{t('profile.yourStays')}</h2>
          {p.occupancies.length === 0 ? (
            <p className="text-muted">{t('home.noUnits')}</p>
          ) : (
            <ul className="space-y-3">
              {p.occupancies.map((o) => (
                <li key={o.id} className="tile">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="heading-section">{o.unit.unitNumber}</span>
                    <Chip tone="blue">{t(`units.type.${o.type}`)}</Chip>
                    {!o.endDate && <Chip tone="green">{t('common.active')}</Chip>}
                  </div>
                  <p className="text-sm text-muted">
                    {t('units.floor')} {o.unit.floor}
                    {o.unit.bedrooms != null && ` · ${t('units.bedrooms')} ${o.unit.bedrooms}`}
                    {o.unit.sizeSqft != null && ` · ${o.unit.sizeSqft} ${t('units.size')}`}
                  </p>
                  <p className="text-sm text-muted">
                    {formatDate(o.startDate)} – {o.endDate ? formatDate(o.endDate) : t('units.present')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
