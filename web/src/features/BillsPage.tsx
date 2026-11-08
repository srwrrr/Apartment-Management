import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BILL_STATUSES, MANUAL_CHARGE_TYPES, formatBDT, parseTaka } from '@apt/shared';
import { useAuth } from '../app/auth';
import { BillStatusChip } from '../components/BillStatusChip';
import { Button, Card, Field, Modal, Notice, PageHeader, Pagination, Select, Spinner, TextInput, useDebounced } from '../components/ui';
import { MonthInput } from '../components/MonthInput';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, monthLabel, thisMonth } from '../lib/format';
import type { BillDetail, BillList, BillRow, Page, Unit } from '../lib/types';

/** One bill as a row: unit, month, due date, balance and status. */
function BillRowLink({ bill, showUnit = true }: { bill: BillRow; showUnit?: boolean }) {
  const { t } = useTranslation();
  const label = bill.kind === 'OPENING_BALANCE' ? t('billing.openingBalance') : monthLabel(bill.billingMonth);
  return (
    <li>
      <Link to={`/bills/${bill.id}`} className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-hover">
        {showUnit && <span className="min-w-14 heading-section">{bill.unit.unitNumber}</span>}
        <span className="min-w-36 flex-1">
          <span className="block font-semibold">{label}</span>
          <span className="block text-sm text-muted">{t('billing.dueOn', { date: formatDate(bill.dueDate) })}</span>
        </span>
        <span className="text-end">
          <span className="block font-bold">{formatBDT(bill.balance)}</span>
          <span className="block text-sm text-muted">/ {formatBDT(bill.total)}</span>
        </span>
        <BillStatusChip status={bill.status} />
      </Link>
    </li>
  );
}

function ResidentBills() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const balance = useQuery({ queryKey: ['my-balance'], queryFn: () => api.get<{ outstanding: number; overdueBills: number; openBills: number }>('/api/me/billing/balance') });
  const bills = useQuery({ queryKey: ['my-bills', page], queryFn: () => api.get<BillList>(`/api/me/billing/bills?page=${page}`) });

  return (
    <>
      <PageHeader title={t('billing.mineTitle')} />
      {balance.data && (
        <Card className="mb-4">
          {balance.data.outstanding > 0 ? (
            <>
              <p className="text-muted">{t('billing.youOwe')}</p>
              <p className="text-3xl font-bold" data-testid="outstanding">{formatBDT(balance.data.outstanding)}</p>
              {balance.data.overdueBills > 0 && <p className="mt-1 font-semibold text-danger">{t('billing.overdueCount', { count: balance.data.overdueBills })}</p>}
            </>
          ) : (
            <p className="font-semibold">{t('billing.allPaid')}</p>
          )}
        </Card>
      )}
      {bills.isLoading ? (
        <Spinner />
      ) : bills.isError ? (
        <Notice>{errorMessage(t, bills.error)}</Notice>
      ) : bills.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('billing.noBills')}</p>
      ) : (
        <Card className="card-flush">
          <ul className="divide-y divide-line">
            {bills.data!.items.map((b) => (
              <BillRowLink key={b.id} bill={b} showUnit={false} />
            ))}
          </ul>
        </Card>
      )}
      {bills.data && <Pagination page={bills.data.page} pageSize={bills.data.pageSize} total={bills.data.total} onPage={setPage} />}
    </>
  );
}

const emptyCharge = { type: 'SERVICE', amount: '', description: '' };

function NewBillModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [unit, setUnit] = useState<Unit | null>(null);
  const [month, setMonth] = useState(thisMonth());
  const [charge, setCharge] = useState(emptyCharge);
  const [localError, setLocalError] = useState('');
  const term = useDebounced(search.trim());

  const units = useQuery({
    queryKey: ['unit-search', term],
    enabled: term.length >= 1 && !unit,
    queryFn: () => api.get<Page<Unit>>(`/api/units?pageSize=8&q=${encodeURIComponent(term)}`),
  });
  const create = useMutation({
    mutationFn: () => api.post<BillDetail>('/api/bills', { unitId: unit?.id, month, charges: [{ type: charge.type, amount: parseTaka(charge.amount), description: charge.description.trim() || t(`chargeTypes.${charge.type}`) }] }),
    onSuccess: async (bill) => {
      await qc.invalidateQueries({ queryKey: ['bills'] });
      navigate(`/bills/${bill.id}`);
    },
  });
  const fields = fieldErrorsOf(t, create.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parseTaka(charge.amount) === null) return setLocalError(t('fieldErrors.INVALID'));
    setLocalError('');
    create.mutate();
  }

  return (
    <Modal title={t('billing.newBillTitle')} onClose={onClose}>
      <form className="space-y-4" noValidate onSubmit={submit}>
        <p className="text-sm text-muted">{t('billing.newBillHelp')}</p>
        {create.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, create.error)}</Notice>}
        <Field label={t('billing.unit')} error={fields.unitId}>
          {(p) =>
            unit ? (
              <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line bg-raised px-3 py-2">
                <span className="font-semibold">{unit.unitNumber}</span>
                <Button variant="ghost" onClick={() => setUnit(null)}>
                  {t('common.edit')}
                </Button>
              </div>
            ) : (
              <>
                <TextInput {...p} type="search" placeholder={t('units.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />
                {units.data && units.data.items.length > 0 && (
                  <ul className="mt-1 divide-y divide-line rounded-xl border border-line bg-panel">
                    {units.data.items.map((u) => (
                      <li key={u.id}>
                        <button type="button" className="flex min-h-11 w-full items-center justify-between px-3 py-2 text-start hover:bg-hover" onClick={() => setUnit(u)}>
                          <span className="font-semibold">{u.unitNumber}</span>
                          <span className="text-muted">{t(`units.status.${u.status}`)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          }
        </Field>
        <Field label={t('billing.month')} error={fields.month}>
          {(p) => <MonthInput {...p} required value={month} onChange={(e) => setMonth(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('billing.chargeType')}>
            {(p) => (
              <Select {...p} value={charge.type} onChange={(e) => setCharge((c) => ({ ...c, type: e.target.value }))}>
                {MANUAL_CHARGE_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {t(`chargeTypes.${ty}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('billing.amount')} help={t('billing.amountHelp')} error={localError || fields['charges.0.amount']}>
            {(p) => <TextInput {...p} inputMode="decimal" required value={charge.amount} onChange={(e) => setCharge((c) => ({ ...c, amount: e.target.value }))} />}
          </Field>
        </div>
        <Field label={t('billing.description')} optional>
          {(p) => <TextInput {...p} maxLength={200} value={charge.description} onChange={(e) => setCharge((c) => ({ ...c, description: e.target.value }))} />}
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending || !unit || !charge.amount}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function StaffBills() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [sp] = useSearchParams(); // the dues report links here with ?q=unit
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [month, setMonth] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const search = useDebounced(q.trim());
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const params = new URLSearchParams({ page: String(page) });
  if (status) params.set('status', status);
  if (/^\d{4}-\d{2}$/.test(month)) params.set('month', month);
  if (kind) params.set('kind', kind);
  if (search) params.set('q', search);
  const bills = useQuery({ queryKey: ['bills', params.toString()], queryFn: () => api.get<BillList>(`/api/bills?${params}`) });

  return (
    <>
      <PageHeader title={t('billing.title')}>
        {can('billing.manage') && (
          <>
            <Link to="/bills/generate" className="btn btn-primary">
              {t('billing.generate')}
            </Link>
            <Button variant="secondary" onClick={() => setCreating(true)}>
              {t('billing.newBill')}
            </Button>
          </>
        )}
      </PageHeader>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('billing.status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
              <option value="">{t('billing.allStatuses')}</option>
              {BILL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`billStatus.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('billing.filterMonth')}>
          {(p) => <MonthInput {...p} value={month} onChange={(e) => reset(setMonth)(e.target.value)} />}
        </Field>
        <Field label={t('billing.unit')}>
          {(p) => <TextInput {...p} type="search" value={q} onChange={(e) => reset(setQ)(e.target.value)} />}
        </Field>
        <Field label={t('common.type')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => reset(setKind)(e.target.value)}>
              <option value="">{t('billing.allKinds')}</option>
              <option value="REGULAR">{t('billing.kindRegular')}</option>
              <option value="OPENING_BALANCE">{t('billing.kindOpening')}</option>
            </Select>
          )}
        </Field>
      </div>
      {bills.data && bills.data.total > 0 && (
        <p className="mb-3 font-semibold" data-testid="sums">
          {t('billing.sums', { total: formatBDT(bills.data.sums.total), paid: formatBDT(bills.data.sums.paid), balance: formatBDT(bills.data.sums.balance) })}
        </p>
      )}
      {bills.isLoading ? (
        <Spinner />
      ) : bills.isError ? (
        <Notice>{errorMessage(t, bills.error)}</Notice>
      ) : bills.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('billing.noBills')}</p>
      ) : (
        <Card className="card-flush">
          <ul className="divide-y divide-line">
            {bills.data!.items.map((b) => (
              <BillRowLink key={b.id} bill={b} />
            ))}
          </ul>
        </Card>
      )}
      {bills.data && <Pagination page={bills.data.page} pageSize={bills.data.pageSize} total={bills.data.total} onPage={setPage} />}
      {creating && <NewBillModal onClose={() => setCreating(false)} />}
    </>
  );
}

/** Bills: residents see their own, billing staff see everyone's (FR-12, FR-13). */
export function BillsPage() {
  const { user } = useAuth();
  return user?.role === 'RESIDENT' ? <ResidentBills /> : <StaffBills />;
}
