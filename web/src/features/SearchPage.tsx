import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { BillStatusChip } from '../components/BillStatusChip';
import { RequestStatusChip } from '../components/RequestBits';
import { Card, Chip, Field, Notice, PageHeader, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { monthLabel } from '../lib/format';
import type { SearchResults } from '../lib/types';

function Group({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <Card className="!p-0">
      <h2 className="border-b border-line px-4 py-2 text-lg font-bold">{title}</h2>
      <ul className="divide-y divide-line" data-testid={testId}>
        {children}
      </ul>
    </Card>
  );
}

const row = 'flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 hover:bg-brand-50';

/** FR-30: one box. What it finds depends on what this person may open; the server decides that. */
export function SearchPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const text = params.get('q') ?? '';
  const term = useDebounced(text.trim());
  const q = useQuery({
    queryKey: ['search', term],
    enabled: term.length >= 2,
    queryFn: () => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(term)}`),
  });
  const r = q.data;
  const nothing = r && r.residents.length + r.units.length + r.bills.length + r.requests.length === 0;

  return (
    <>
      <PageHeader title={t('search.title')} />
      <div className="mb-4 max-w-xl">
        <Field label={t('search.label')} help={t('search.help')}>
          {(p) => <TextInput {...p} type="search" autoFocus value={text} maxLength={60} onChange={(e) => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })} />}
        </Field>
      </div>
      {term.length === 1 && <p className="text-muted">{t('search.tooShort')}</p>}
      {q.isFetching && !r && <Spinner />}
      {q.isError && <Notice>{errorMessage(t, q.error)}</Notice>}
      {nothing && <p className="py-6 text-muted">{t('search.none')}</p>}
      {r && (
        <div className="space-y-4">
          {r.residents.length > 0 && (
            <Group title={t('search.residents')} testId="search-residents">
              {r.residents.map((x) => (
                <li key={x.id}>
                  <Link to={`/residents/${x.id}`} className={row}>
                    <span className="font-semibold">{x.fullName}</span>
                    <span className="text-muted">{x.phone}</span>
                    {!x.isActive && <Chip>{t('search.inactive')}</Chip>}
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {r.units.length > 0 && (
            <Group title={t('search.units')} testId="search-units">
              {r.units.map((x) => (
                <li key={x.id}>
                  <Link to={`/units/${x.id}`} className={row}>
                    <span className="font-semibold">{x.unitNumber}</span>
                    <span className="text-muted">
                      {t('units.floor')} {x.floor}
                    </span>
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {r.bills.length > 0 && (
            <Group title={t('search.bills')} testId="search-bills">
              {r.bills.map((x) => (
                <li key={x.id}>
                  <Link to={`/bills/${x.id}`} className={row}>
                    <span className="font-semibold">{x.unitNumber}</span>
                    <span>{x.kind === 'OPENING_BALANCE' ? t('billing.openingBalance') : monthLabel(x.billingMonth)}</span>
                    <span className="font-semibold">{formatBDT(x.balance)}</span>
                    <BillStatusChip status={x.status} />
                  </Link>
                </li>
              ))}
            </Group>
          )}
          {r.requests.length > 0 && (
            <Group title={t('search.requests')} testId="search-requests">
              {r.requests.map((x) => (
                <li key={x.id}>
                  <Link to={`/requests/${x.id}`} className={row}>
                    <span className="font-semibold">#{x.number}</span>
                    <span className="min-w-0 flex-1 break-words">{x.title}</span>
                    <span className="text-muted">{x.unit?.unitNumber ?? t('maintenance.noUnit')}</span>
                    <RequestStatusChip status={x.status} />
                  </Link>
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </>
  );
}
