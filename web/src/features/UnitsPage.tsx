import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Pagination, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { Page, Unit } from '../lib/types';

export const unitStatusTone = { OCCUPIED: 'green', VACANT: 'blue', UNAVAILABLE: 'gray' } as const;

const toNum = (v: string) => (v.trim() === '' ? null : Number(v));

export function UnitFormModal({ unit, onClose }: { unit?: Unit; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    unitNumber: unit?.unitNumber ?? '',
    floor: unit ? String(unit.floor) : '',
    sizeSqft: unit?.sizeSqft != null ? String(unit.sizeSqft) : '',
    bedrooms: unit?.bedrooms != null ? String(unit.bedrooms) : '',
    isAvailable: unit?.isAvailable ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        unitNumber: form.unitNumber.trim(),
        floor: toNum(form.floor),
        sizeSqft: toNum(form.sizeSqft),
        bedrooms: toNum(form.bedrooms),
        ...(unit && { isAvailable: form.isAvailable }),
      };
      return unit ? api.patch<Unit>(`/api/units/${unit.id}`, body) : api.post<Unit>('/api/units', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['units'] });
      await qc.invalidateQueries({ queryKey: ['unit'] });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, save.error);
  const set = (k: 'unitNumber' | 'floor' | 'sizeSqft' | 'bedrooms') => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal title={unit ? t('units.edit') : t('units.new')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, save.error)}</Notice>}
        <Field label={t('units.number')} error={fields.unitNumber}>
          {(p) => <TextInput {...p} required maxLength={10} value={form.unitNumber} onChange={set('unitNumber')} />}
        </Field>
        <Field label={t('units.floor')} error={fields.floor}>
          {(p) => <TextInput {...p} required type="number" inputMode="numeric" value={form.floor} onChange={set('floor')} />}
        </Field>
        <Field label={t('units.size')} error={fields.sizeSqft} optional>
          {(p) => <TextInput {...p} type="number" inputMode="numeric" value={form.sizeSqft} onChange={set('sizeSqft')} />}
        </Field>
        <Field label={t('units.bedrooms')} error={fields.bedrooms} optional>
          {(p) => <TextInput {...p} type="number" inputMode="numeric" value={form.bedrooms} onChange={set('bedrooms')} />}
        </Field>
        {unit && (
          <label className="flex min-h-11 items-center gap-3 font-semibold">
            <input type="checkbox" className="size-5" checked={form.isAvailable} onChange={(e) => setForm((f) => ({ ...f, isAvailable: e.target.checked }))} />
            {t('units.available')}
          </label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending || !form.unitNumber || form.floor === ''}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function UnitsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const search = useDebounced(q.trim());
  const query = useQuery({
    queryKey: ['units', search, page],
    queryFn: () => api.get<Page<Unit>>(`/api/units?page=${page}&q=${encodeURIComponent(search)}`),
  });

  return (
    <>
      <PageHeader title={t('units.title')}>{can('units.manage') && <Button onClick={() => setAdding(true)}>{t('units.add')}</Button>}</PageHeader>
      {!can('units.manage') && <div className="mb-4"><Notice tone="info">{t('units.viewOnly')}</Notice></div>}
      <div className="mb-4 max-w-sm">
        <Field label={t('common.search')}>
          {(p) => (
            <TextInput
              {...p}
              type="search"
              placeholder={t('units.searchPlaceholder')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
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
            {query.data!.items.map((u) => (
              <li key={u.id}>
                <Link to={`/units/${u.id}`} className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-hover">
                  <span className="min-w-16 heading-section">{u.unitNumber}</span>
                  <span className="text-muted">
                    {t('units.floor')} {u.floor}
                    {u.bedrooms != null && ` · ${u.bedrooms} ${t('units.bedrooms')}`}
                  </span>
                  <span className="ms-auto">
                    <Chip tone={unitStatusTone[u.status]}>{t(`units.status.${u.status}`)}</Chip>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
      {adding && <UnitFormModal onClose={() => setAdding(false)} />}
    </>
  );
}
