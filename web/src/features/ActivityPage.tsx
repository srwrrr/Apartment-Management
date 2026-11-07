import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ACTIVITY_ACTIONS, formatBDT } from '@apt/shared';
import { Card, Field, Notice, PageHeader, Pagination, Select, Spinner, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import type { ActivityEntry, Page } from '../lib/types';

const MONEY = ['amount', 'total', 'balance', 'reported'];
const show = (key: string, v: unknown) =>
  key === 'publishAt' && typeof v === 'string' ? formatDateTime(v) : typeof v === 'number' && MONEY.includes(key) ? formatBDT(v) : v === null ? '–' : Array.isArray(v) ? v.join(', ') : String(v);

/** The facts of an entry as a short line: "unit: 4B · floor: 7 → 8". */
export function detailLine(details: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v === null || v === undefined || k === 'paymentId' || k === 'fromReport' || k === 'newBillingContactOccupancyId') continue;
    if (k === 'changes') {
      for (const [f, pair] of Object.entries(v as Record<string, [unknown, unknown]>)) parts.push(`${f}: ${show(f, pair[0])} → ${show(f, pair[1])}`);
    } else if (typeof v !== 'object' || Array.isArray(v)) parts.push(`${k}: ${show(k, v)}`);
  }
  return parts.join(' · ');
}

const whoDidIt = (t: TFunction, e: ActivityEntry) => e.actor?.fullName ?? (e.action === 'login.failed' ? t('activity.notLoggedIn') : t('activity.system'));

/** Where an entry's subject can be opened, if it has a page of its own. */
function linkFor(e: ActivityEntry): string | null {
  if (!e.entityId) return null;
  if (e.entityType === 'bill' && !e.action.startsWith('opening_balance.delete')) return `/bills/${e.entityId}`;
  if (e.entityType === 'request') return `/requests/${e.entityId}`;
  if (e.entityType === 'announcement') return `/announcements/${e.entityId}`;
  if (e.entityType === 'unit') return `/units/${e.entityId}`;
  return null;
}

export function ActivityRow({ e }: { e: ActivityEntry }) {
  const { t } = useTranslation();
  const line = detailLine(e.details);
  const link = linkFor(e);
  return (
    <li className="px-4 py-3" data-testid="activity">
      <p>
        <span className="font-semibold">{whoDidIt(t, e)}</span> · {t(`activity.actions.${e.action}`)}
        {link && (
          <>
            {' '}
            <Link to={link} className="font-semibold text-brand-700 underline">
              {t('activity.open')}
            </Link>
          </>
        )}
      </p>
      {line && <p className="break-words text-sm">{line}</p>}
      <p className="text-sm text-muted">
        {formatDateTime(e.createdAt)}
        {e.ip ? ` · ${e.ip}` : ''}
      </p>
    </li>
  );
}

/** FR-34. */
export function ActivityPage() {
  const { t } = useTranslation();
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const actors = useQuery({ queryKey: ['activity-actors'], queryFn: () => api.get<{ items: { id: string; fullName: string }[] }>('/api/activity/actors') });

  const params = new URLSearchParams({ page: String(page) });
  if (actorId) params.set('actorId', actorId);
  if (action) params.set('action', action);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const q = useQuery({ queryKey: ['activity', params.toString()], queryFn: () => api.get<Page<ActivityEntry>>(`/api/activity?${params}`) });
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <>
      <PageHeader title={t('activity.title')} />
      <p className="mb-3 text-muted">{t('activity.help')}</p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('activity.person')}>
          {(p) => (
            <Select {...p} value={actorId} onChange={(e) => change(setActorId)(e.target.value)}>
              <option value="">{t('activity.everyone')}</option>
              {actors.data?.items.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('activity.action')}>
          {(p) => (
            <Select {...p} value={action} onChange={(e) => change(setAction)(e.target.value)}>
              <option value="">{t('activity.allActions')}</option>
              {ACTIVITY_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`activity.actions.${a}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('activity.from')}>{(p) => <TextInput {...p} type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} />}</Field>
        <Field label={t('activity.to')}>{(p) => <TextInput {...p} type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} />}</Field>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('activity.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((e) => (
              <ActivityRow key={e.id} e={e} />
            ))}
          </ul>
        </Card>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
    </>
  );
}
