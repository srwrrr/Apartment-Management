import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Select, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, todayYmd, ymd } from '../lib/format';
import type { Occupancy, Page, ResidentSummary, Unit } from '../lib/types';
import { OpeningBalanceSection, UnitFeesSection } from './UnitMoneySections';
import { UnitFormModal, unitStatusTone } from './UnitsPage';

function AssignForm({ unit }: { unit: Unit }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ResidentSummary | null>(null);
  const [type, setType] = useState<'OWNER' | 'TENANT'>('TENANT');
  const [startDate, setStartDate] = useState(todayYmd());
  const [contact, setContact] = useState(false);
  const term = useDebounced(search.trim());

  const results = useQuery({
    queryKey: ['resident-search', term],
    enabled: term.length >= 2 && !picked,
    queryFn: () => api.get<Page<ResidentSummary>>(`/api/residents?active=true&pageSize=8&q=${encodeURIComponent(term)}`),
  });

  const assign = useMutation({
    mutationFn: () =>
      api.post(`/api/units/${unit.id}/occupancies`, { residentId: picked?.id, type, startDate, isBillingContact: contact || undefined }),
    onSuccess: async () => {
      setPicked(null);
      setSearch('');
      setContact(false);
      await qc.invalidateQueries({ queryKey: ['occupancies', unit.id] });
      await qc.invalidateQueries({ queryKey: ['unit', unit.id] });
    },
  });
  const fields = fieldErrorsOf(t, assign.error);

  if (!unit.isAvailable) return <Notice tone="info">{t('units.unavailableNote')}</Notice>;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        assign.mutate();
      }}
    >
      <h3 className="text-lg font-semibold">{t('units.assign')}</h3>
      {assign.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, assign.error)}</Notice>}
      <Field label={t('units.resident')} error={fields.residentId}>
        {(p) =>
          picked ? (
            <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-page px-3 py-2">
              <span className="font-semibold">{picked.fullName}</span>
              <Button variant="ghost" onClick={() => setPicked(null)}>
                {t('common.edit')}
              </Button>
            </div>
          ) : (
            <>
              <TextInput {...p} type="search" placeholder={t('units.searchResident')} value={search} onChange={(e) => setSearch(e.target.value)} />
              {results.data && results.data.items.length > 0 && (
                <ul className="mt-1 divide-y divide-line rounded-lg border border-line bg-white">
                  {results.data.items.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="flex min-h-11 w-full flex-wrap justify-between gap-2 px-3 py-2 text-start hover:bg-brand-50" onClick={() => setPicked(r)}>
                        <span className="font-semibold">{r.fullName}</span>
                        <span className="text-muted">{r.phone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {results.data && results.data.items.length === 0 && <p className="mt-1 text-sm text-muted">{t('common.noResults')}</p>}
            </>
          )
        }
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.type')}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as 'OWNER' | 'TENANT')}>
              <option value="TENANT">{t('units.type.TENANT')}</option>
              <option value="OWNER">{t('units.type.OWNER')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('units.startDate')} error={fields.startDate}>
          {(p) => <TextInput {...p} type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />}
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-3 font-semibold">
        <input type="checkbox" className="size-5" checked={contact} onChange={(e) => setContact(e.target.checked)} />
        {t('units.billingContact')}
      </label>
      <Button type="submit" disabled={!picked || !startDate || assign.isPending}>
        {t('common.add')}
      </Button>
    </form>
  );
}

function EndStayModal({ unitId, stay, others, onClose }: { unitId: string; stay: Occupancy; others: Occupancy[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [endDate, setEndDate] = useState(todayYmd());
  const [nextContact, setNextContact] = useState('');
  const needsContact = stay.isBillingContact && others.length > 0;
  const end = useMutation({
    mutationFn: () => api.patch(`/api/occupancies/${stay.id}`, { endDate, ...(nextContact && { newBillingContactOccupancyId: nextContact }) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['occupancies', unitId] });
      await qc.invalidateQueries({ queryKey: ['unit', unitId] });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, end.error);
  return (
    <Modal title={t('units.endStayTitle')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          end.mutate();
        }}
      >
        <p className="font-semibold">{stay.resident?.fullName}</p>
        {end.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, end.error)}</Notice>}
        <Field label={t('units.endDate')} error={fields.endDate} help={t('units.endStayHelp')}>
          {(p) => <TextInput {...p} type="date" required min={ymd(stay.startDate)} value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
        </Field>
        {needsContact && (
          <Field label={t('units.newBillingContact')} error={fields.newBillingContactOccupancyId}>
            {(p) => (
              <Select {...p} value={nextContact} onChange={(e) => setNextContact(e.target.value)}>
                <option value="">{t('units.autoContact')}</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.resident?.fullName} ({t(`units.type.${o.type}`)})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={!endDate || end.isPending}>
            {t('units.endStay')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function UnitDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState<Occupancy | null>(null);

  const unit = useQuery({ queryKey: ['unit', id], queryFn: () => api.get<Unit>(`/api/units/${id}`) });
  const stays = useQuery({
    queryKey: ['occupancies', id],
    enabled: can('residents.manage'),
    queryFn: () => api.get<{ items: Occupancy[] }>(`/api/units/${id}/occupancies`),
  });
  const makeContact = useMutation({
    mutationFn: (occId: string) => api.patch(`/api/occupancies/${occId}`, { isBillingContact: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['occupancies', id] }),
  });

  if (unit.isLoading) return <Spinner />;
  if (unit.isError) return <Notice>{errorMessage(t, unit.error)}</Notice>;
  const u = unit.data!;
  const all = stays.data?.items ?? [];
  const current = all.filter((o) => !o.endDate);

  return (
    <>
      <div className="mb-2">
        <Link to="/units" className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline">
          ← {t('nav.units')}
        </Link>
      </div>
      <PageHeader title={`${t('units.number')} ${u.unitNumber}`}>
        {can('units.manage') && <Button variant="secondary" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3">
            <Chip tone={unitStatusTone[u.status]}>{t(`units.status.${u.status}`)}</Chip>
          </div>
          <dl className="grid grid-cols-2 gap-3">
            <div><dt className="text-sm text-muted">{t('units.floor')}</dt><dd className="font-semibold">{u.floor}</dd></div>
            <div><dt className="text-sm text-muted">{t('units.bedrooms')}</dt><dd className="font-semibold">{u.bedrooms ?? '–'}</dd></div>
            <div><dt className="text-sm text-muted">{t('units.size')}</dt><dd className="font-semibold">{u.sizeSqft ?? '–'}</dd></div>
          </dl>
        </Card>
        {can('residents.manage') && (
          <Card>
            <AssignForm unit={u} />
          </Card>
        )}
      </div>

      {can('residents.manage') && (
        <Card className="mt-4">
          <h2 className="mb-3 text-xl font-bold">{t('units.history')}</h2>
          {stays.isLoading ? (
            <Spinner />
          ) : stays.isError ? (
            <Notice>{errorMessage(t, stays.error)}</Notice>
          ) : all.length === 0 ? (
            <p className="text-muted">{t('units.noHistory')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {all.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <div className="min-w-40 flex-1">
                    <Link to={`/residents/${o.resident?.id}`} className="font-semibold text-brand-700 underline">
                      {o.resident?.fullName}
                    </Link>
                    <p className="text-sm text-muted">
                      {formatDate(o.startDate)} – {o.endDate ? formatDate(o.endDate) : t('units.present')}
                    </p>
                  </div>
                  <Chip tone="blue">{t(`units.type.${o.type}`)}</Chip>
                  {!o.endDate && o.isBillingContact && <Chip tone="green">{t('units.billingContact')}</Chip>}
                  {!o.endDate && (
                    <div className="flex flex-wrap gap-2">
                      {!o.isBillingContact && (
                        <Button variant="secondary" disabled={makeContact.isPending} onClick={() => makeContact.mutate(o.id)}>
                          {t('units.makeBillingContact')}
                        </Button>
                      )}
                      <Button variant="secondary" onClick={() => setEnding(o)}>
                        {t('units.endStay')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {makeContact.isError && <div className="mt-3"><Notice>{errorMessage(t, makeContact.error)}</Notice></div>}
        </Card>
      )}
      {can('billing.manage') && <UnitFeesSection unitId={id} />}
      {user?.role === 'ADMIN' && <OpeningBalanceSection unitId={id} />}
      {editing && <UnitFormModal unit={u} onClose={() => setEditing(false)} />}
      {ending && <EndStayModal unitId={id} stay={ending} others={current.filter((o) => o.id !== ending.id)} onClose={() => setEnding(null)} />}
    </>
  );
}
