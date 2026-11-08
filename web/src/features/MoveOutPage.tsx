import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Button, Card, Field, Notice, PageHeader, Select, Spinner, TextArea, TextInput } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, todayYmd } from '../lib/format';
import type { MoveOutPreview } from '../lib/types';

interface Result {
  unitId: string;
  certificate: { id: string; number: string } | null;
  deactivated: boolean;
}

/** FR-56: one page, top to bottom, so no step is forgotten. Nothing changes until the final button. */
export function MoveOutPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['move-out', id], queryFn: () => api.get<MoveOutPreview>(`/api/occupancies/${id}/move-out-preview`), retry: false });

  const [endDate, setEndDate] = useState(todayYmd());
  const [duesNote, setDuesNote] = useState('');
  const [newContact, setNewContact] = useState('');
  const [certificate, setCertificate] = useState(false);
  const [deactivate, setDeactivate] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // BR-03: ticked by default when this was the resident's only home.
  const elsewhere = q.data?.hasOtherActiveOccupancy;
  useEffect(() => {
    if (elsewhere !== undefined) setDeactivate(!elsewhere);
  }, [elsewhere]);

  const confirm = useMutation({
    mutationFn: () =>
      api.post<Result>(`/api/occupancies/${id}/move-out`, {
        endDate,
        expectedBalance: q.data!.balance,
        newBillingContactOccupancyId: newContact || undefined,
        duesNote: duesNote.trim() || undefined,
        issueCertificate: certificate,
        deactivateAccount: deactivate,
      }),
    onSuccess: async (r) => {
      setResult(r);
      await Promise.all(['occupancies', 'unit', 'units', 'unit-certificates', 'dashboard', 'residents'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    },
    onError: (e) => {
      // The money changed since this page was opened: show the new figures before anyone confirms again.
      if (e instanceof ApiError && e.code === 'STALE_PREVIEW') void q.refetch();
    },
  });
  const fields = fieldErrorsOf(t, confirm.error);

  if (result) {
    return (
      <>
        <PageHeader title={t('moveOut.done')} />
        <Card>
          {result.certificate && (
            <p className="mb-3" data-testid="moveout-certificate">
              {t('moveOut.certificateNumber', { number: result.certificate.number })}{' '}
              <a href={`/api/certificates/${result.certificate.id}/pdf`} target="_blank" rel="noopener" className="font-semibold text-accent underline">
                {t('certificate.download')}
              </a>
            </p>
          )}
          <Link to={`/units/${result.unitId}`} className="link-action">
            ← {t('nav.units')}
          </Link>
        </Card>
      </>
    );
  }

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const p = q.data!;
  const owes = p.balance > 0;
  const needsContact = p.occupancy.isBillingContact && p.otherOccupants.length > 0;
  const heir = p.otherOccupants.find((o) => o.occupancyId === newContact);
  const ready = (!owes || duesNote.trim().length >= 3) && (!needsContact || !!newContact);

  return (
    <>
      <div className="mb-2">
        <Link to={`/units/${p.unit.id}`} className="link-action">
          ← {t('units.number')} {p.unit.unitNumber}
        </Link>
      </div>
      <PageHeader title={t('moveOut.title', { name: p.resident.fullName, unit: p.unit.unitNumber })} />
      <div className="max-w-2xl space-y-4">
        <Card>
          <Field label={t('moveOut.date')} error={fields.endDate}>
            {(f) => <TextInput {...f} type="date" required max={todayYmd()} value={endDate} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        </Card>

        <Card>
          <h2 className="mb-2 heading-section">{t('moveOut.dues')}</h2>
          {owes ? (
            <>
              <p className="heading-card text-danger" data-testid="moveout-balance">
                {t('moveOut.owed', { amount: formatBDT(p.balance) })}
              </p>
              <ul className="my-2">
                {p.unpaidBills.map((b) => (
                  <li key={b.id}>
                    <Link to={`/bills/${b.id}`} className="inline-flex min-h-11 items-center underline">
                      {b.kind === 'OPENING_BALANCE' ? t('billing.openingBalance') : monthLabel(b.billingMonth)}: {formatBDT(b.balance)}
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mb-3 text-sm text-muted">{t('moveOut.recordPayment')}</p>
              <Field label={t('moveOut.duesNote')} help={t('moveOut.duesNoteHelp')} error={fields.duesNote}>
                {(f) => <TextArea {...f} rows={2} maxLength={500} value={duesNote} onChange={(e) => setDuesNote(e.target.value)} />}
              </Field>
            </>
          ) : (
            <p className="font-semibold" data-testid="moveout-balance">
              {t('moveOut.noDues')}
            </p>
          )}
          {p.pendingReports.length > 0 && (
            <div className="mt-3">
              <h3 className="font-semibold">{t('moveOut.pendingReports')}</h3>
              <ul className="list-disc ps-6">
                {p.pendingReports.map((r) => (
                  <li key={r.id}>
                    {formatBDT(r.amount)} · {r.reference}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        {p.openRequests.length > 0 && (
          <Card>
            <h2 className="mb-2 heading-card">{t('moveOut.openRequests')}</h2>
            <ul className="list-disc ps-6">
              {p.openRequests.map((r) => (
                <li key={r.id}>
                  <Link to={`/requests/${r.id}`} className="underline">
                    #{r.number} {r.title}
                  </Link>{' '}
                  ({t(`requestStatus.${r.status}`)})
                </li>
              ))}
            </ul>
          </Card>
        )}

        {(needsContact || p.householdMembers.length > 0) && (
          <Card>
            {needsContact && (
              <Field label={t('moveOut.newContact')} error={fields.newBillingContactOccupancyId}>
                {(f) => (
                  <Select {...f} value={newContact} onChange={(e) => setNewContact(e.target.value)}>
                    <option value="">{t('moveOut.choose')}</option>
                    {p.otherOccupants.map((o) => (
                      <option key={o.occupancyId} value={o.occupancyId}>
                        {o.fullName} ({t(`units.type.${o.type}`)})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {p.householdMembers.length > 0 && <p className="mt-2">{t('moveOut.household', { names: p.householdMembers.map((h) => h.fullName).join(', ') })}</p>}
          </Card>
        )}

        <Card>
          {p.canIssueCertificate ? (
            <label className="flex min-h-11 items-center gap-2 font-semibold">
              <input type="checkbox" className="h-5 w-5" checked={certificate} onChange={(e) => setCertificate(e.target.checked)} />
              {t('moveOut.issueCertificate')}
            </label>
          ) : (
            <p className="text-muted">{t('moveOut.certificateUnavailable')}</p>
          )}
          {p.hasOtherActiveOccupancy ? (
            <p className="mt-2 text-muted">{t('moveOut.livesElsewhere')}</p>
          ) : (
            <label className="flex min-h-11 items-center gap-2 font-semibold">
              <input type="checkbox" className="h-5 w-5" checked={deactivate} onChange={(e) => setDeactivate(e.target.checked)} />
              {t('moveOut.deactivate')}
            </label>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 heading-section">{t('moveOut.summary')}</h2>
          <ul className="list-disc space-y-1 ps-6" data-testid="moveout-summary">
            <li>{t('moveOut.sumEnd', { date: formatDate(endDate) })}</li>
            {heir && <li>{t('moveOut.sumContact', { name: heir.fullName })}</li>}
            {p.householdMembers.length > 0 && <li>{t('moveOut.household', { names: p.householdMembers.map((h) => h.fullName).join(', ') })}</li>}
            {p.otherOccupants.length === 0 && <li>{t('moveOut.sumVacant')}</li>}
            {owes && <li>{t('moveOut.sumDues', { amount: formatBDT(p.balance) })}</li>}
            {certificate && <li>{t('moveOut.sumCertificate')}</li>}
            {deactivate && !p.hasOtherActiveOccupancy && <li>{t('moveOut.sumDeactivate')}</li>}
          </ul>
          {confirm.isError && Object.keys(fields).length === 0 && (
            <div className="mt-3">
              <Notice>{errorMessage(t, confirm.error)}</Notice>
            </div>
          )}
          <Button variant="danger" className="mt-4" disabled={confirm.isPending || !ready} onClick={() => confirm.mutate()}>
            {t('moveOut.confirm')}
          </Button>
        </Card>
      </div>
    </>
  );
}
