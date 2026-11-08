import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../app/auth';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Spinner, TempPasswordModal, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, todayYmd } from '../lib/format';
import type { ResidentDetail } from '../lib/types';
import { ResidentFormModal } from './ResidentsPage';

function DeactivateModal({ resident, onClose }: { resident: ResidentDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const openStays = resident.occupancies.filter((o) => !o.endDate);
  const [endDate, setEndDate] = useState(todayYmd());
  const run = useMutation({
    mutationFn: () => api.post<ResidentDetail>(`/api/residents/${resident.id}/deactivate`, openStays.length ? { endDate } : {}),
    onSuccess: async (data) => {
      qc.setQueryData(['resident', resident.id], data);
      await qc.invalidateQueries({ queryKey: ['residents'] });
      await qc.invalidateQueries({ queryKey: ['units'] });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, run.error);
  return (
    <Modal title={t('residents.deactivateTitle', { name: resident.fullName })} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p>{t('residents.deactivateHelp')}</p>
        {run.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
        {openStays.length > 0 && (
          <Field label={t('residents.moveOutDate')} error={fields.endDate} help={t('residents.moveOutHelp')}>
            {(p) => <TextInput {...p} type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={run.isPending || (openStays.length > 0 && !endDate)}>
            {t('residents.deactivate')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ResidentDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['resident', id], queryFn: () => api.get<ResidentDetail>(`/api/residents/${id}`) });
  const reactivate = useMutation({
    mutationFn: () => api.post<ResidentDetail>(`/api/residents/${id}/reactivate`),
    onSuccess: async (data) => {
      qc.setQueryData(['resident', id], data);
      await qc.invalidateQueries({ queryKey: ['residents'] });
    },
  });
  const reset = useMutation({
    mutationFn: () => api.post<{ tempPassword: string }>(`/api/users/${id}/reset-password`),
    onSuccess: (data) => setTemp(data.tempPassword),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const r = q.data!;

  return (
    <>
      <div className="mb-2">
        <Link to="/residents" className="link-action">
          ← {t('nav.residents')}
        </Link>
      </div>
      <PageHeader title={r.fullName}>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {t('common.edit')}
        </Button>
        {user?.role === 'ADMIN' && (
          <Button variant="secondary" disabled={reset.isPending} onClick={() => reset.mutate()}>
            {t('residents.resetPassword')}
          </Button>
        )}
        {r.isActive ? (
          <Button variant="danger" onClick={() => setDeactivating(true)}>
            {t('residents.deactivate')}
          </Button>
        ) : (
          <Button disabled={reactivate.isPending} onClick={() => reactivate.mutate()}>
            {t('residents.reactivate')}
          </Button>
        )}
      </PageHeader>
      {(reset.isError || reactivate.isError) && <div className="mb-4"><Notice>{errorMessage(t, reset.error ?? reactivate.error)}</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3">
            <Chip tone={r.isActive ? 'green' : 'gray'}>{r.isActive ? t('common.active') : t('common.inactive')}</Chip>
          </div>
          <dl className="space-y-3">
            <div><dt className="text-sm text-muted">{t('auth.loginId')}</dt><dd className="font-semibold">{r.loginId}</dd></div>
            <div><dt className="text-sm text-muted">{t('common.phone')}</dt><dd className="font-semibold">{r.phone}</dd></div>
            {r.profile?.altPhone && <div><dt className="text-sm text-muted">{t('residents.altPhone')}</dt><dd className="font-semibold">{r.profile.altPhone}</dd></div>}
            {(r.profile?.emergencyContactName || r.profile?.emergencyContactPhone) && (
              <div>
                <dt className="text-sm text-muted">{t('residents.emergencyName')}</dt>
                <dd className="font-semibold">{[r.profile?.emergencyContactName, r.profile?.emergencyContactPhone].filter(Boolean).join(' · ')}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card>
          <h2 className="mb-3 heading-section">{t('residents.stays')}</h2>
          {r.occupancies.length === 0 ? (
            <p className="text-muted">{t('residents.noUnit')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {r.occupancies.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <Link to={`/units/${o.unit.id}`} className="heading-section text-accent underline">
                    {o.unit.unitNumber}
                  </Link>
                  <Chip tone="blue">{t(`units.type.${o.type}`)}</Chip>
                  {!o.endDate && o.isBillingContact && <Chip tone="green">{t('units.billingContact')}</Chip>}
                  <span className="ms-auto text-sm text-muted">
                    {formatDate(o.startDate)} – {o.endDate ? formatDate(o.endDate) : t('units.present')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {editing && <ResidentFormModal resident={r} onClose={() => setEditing(false)} />}
      {deactivating && <DeactivateModal resident={r} onClose={() => setDeactivating(false)} />}
      {temp && <TempPasswordModal loginId={r.loginId} password={temp} onClose={() => setTemp(null)} />}
    </>
  );
}
