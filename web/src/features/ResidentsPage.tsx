import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, TempPasswordModal, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { Page, ResidentDetail, ResidentSummary } from '../lib/types';

export interface ResidentForm {
  fullName: string;
  loginId: string;
  phone: string;
  altPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
}

export function ResidentFormModal({
  resident,
  onClose,
  onCreated,
}: {
  resident?: ResidentDetail;
  onClose: () => void;
  onCreated?: (r: { loginId: string; tempPassword: string }) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<ResidentForm>({
    fullName: resident?.fullName ?? '',
    loginId: resident?.loginId ?? '',
    phone: resident?.phone ?? '',
    altPhone: resident?.profile?.altPhone ?? '',
    emergencyContactName: resident?.profile?.emergencyContactName ?? '',
    emergencyContactPhone: resident?.profile?.emergencyContactPhone ?? '',
  });
  const save = useMutation({
    // Creating returns the one-time temporary password; editing returns nothing extra.
    mutationFn: async (): Promise<{ loginId: string; tempPassword: string } | null> => {
      if (resident) {
        await api.patch<ResidentDetail>(`/api/residents/${resident.id}`, form);
        return null;
      }
      const res = await api.post<{ resident: ResidentDetail; tempPassword: string }>('/api/residents', form);
      return { loginId: res.resident.loginId, tempPassword: res.tempPassword };
    },
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ['residents'] });
      await qc.invalidateQueries({ queryKey: ['resident'] });
      if (created) onCreated?.(created);
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, save.error);
  const set = (k: keyof ResidentForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal title={resident ? t('residents.edit') : t('residents.new')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
        <Field label={t('residents.fullName')} error={fields.fullName}>
          {(p) => <TextInput {...p} required autoComplete="off" value={form.fullName} onChange={set('fullName')} />}
        </Field>
        <Field label={t('auth.loginId')} error={fields.loginId}>
          {(p) => <TextInput {...p} required autoCapitalize="none" autoComplete="off" value={form.loginId} onChange={set('loginId')} />}
        </Field>
        <Field label={t('common.phone')} error={fields.phone}>
          {(p) => <TextInput {...p} required type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} />}
        </Field>
        <Field label={t('residents.altPhone')} error={fields.altPhone} optional>
          {(p) => <TextInput {...p} type="tel" inputMode="tel" value={form.altPhone} onChange={set('altPhone')} />}
        </Field>
        <Field label={t('residents.emergencyName')} error={fields.emergencyContactName} optional>
          {(p) => <TextInput {...p} value={form.emergencyContactName} onChange={set('emergencyContactName')} />}
        </Field>
        <Field label={t('residents.emergencyPhone')} error={fields.emergencyContactPhone} optional>
          {(p) => <TextInput {...p} type="tel" inputMode="tel" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending || !form.fullName || !form.loginId || !form.phone}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ResidentsPage() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ loginId: string; tempPassword: string } | null>(null);
  const search = useDebounced(q.trim());

  const query = useQuery({
    queryKey: ['residents', search, active, page],
    queryFn: () => api.get<Page<ResidentSummary>>(`/api/residents?page=${page}&q=${encodeURIComponent(search)}${active ? `&active=${active}` : ''}`),
  });

  return (
    <>
      <PageHeader title={t('residents.title')}>
        <Button onClick={() => setAdding(true)}>{t('residents.add')}</Button>
      </PageHeader>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label={t('common.search')}>
          {(p) => (
            <TextInput
              {...p}
              type="search"
              placeholder={t('residents.searchPlaceholder')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          )}
        </Field>
        <Field label={t('common.status')}>
          {(p) => (
            <Select
              {...p}
              value={active}
              onChange={(e) => {
                setActive(e.target.value as '' | 'true' | 'false');
                setPage(1);
              }}
            >
              <option value="">{t('common.all')}</option>
              <option value="true">{t('common.active')}</option>
              <option value="false">{t('common.inactive')}</option>
            </Select>
          )}
        </Field>
      </div>
      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <Notice>{errorMessage(t, query.error)}</Notice>
      ) : query.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('common.noResults')}</p>
      ) : (
        <Card className="card-flush">
          <ul className="divide-y divide-line">
            {query.data!.items.map((r) => (
              <li key={r.id}>
                <Link to={`/residents/${r.id}`} className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-hover">
                  <span className="min-w-40 flex-1">
                    <span className="block heading-card">{r.fullName}</span>
                    <span className="block text-sm text-muted">{r.phone}</span>
                  </span>
                  <span className="text-muted">
                    {r.occupancies.length === 0 ? t('residents.noUnit') : r.occupancies.map((o) => o.unit.unitNumber).join(', ')}
                  </span>
                  <Chip tone={r.isActive ? 'green' : 'gray'}>{r.isActive ? t('common.active') : t('common.inactive')}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
      {adding && <ResidentFormModal onClose={() => setAdding(false)} onCreated={setTemp} />}
      {temp && <TempPasswordModal loginId={temp.loginId} password={temp.tempPassword} onClose={() => setTemp(null)} />}
    </>
  );
}
