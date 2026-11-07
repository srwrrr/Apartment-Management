import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { REQUEST_CATEGORIES, REQUEST_PRIORITIES, REQUEST_STATUSES } from '@apt/shared';
import { useAuth } from '../app/auth';
import { OverdueChip, PriorityChip, RequestStatusChip } from '../components/RequestBits';
import { Button, Card, Field, Notice, PageHeader, Pagination, Select, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/format';
import type { Page, RequestRow } from '../lib/types';

function assigneeName(r: RequestRow): string | null {
  return typeof r.assignedTo === 'string' ? r.assignedTo : (r.assignedTo?.fullName ?? null);
}

function RequestItem({ r, showSubmitter }: { r: RequestRow; showSubmitter?: boolean }) {
  const { t } = useTranslation();
  const who = assigneeName(r);
  return (
    <li>
      <Link to={`/requests/${r.id}`} className="block px-4 py-3 hover:bg-brand-50">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-bold text-muted">#{r.number}</span>
          <span className="min-w-40 flex-1 text-lg font-bold">{r.title}</span>
          <span className="flex flex-wrap items-center gap-2">
            {r.overdue && <OverdueChip />}
            <PriorityChip priority={r.priority} />
            <RequestStatusChip status={r.status} />
          </span>
        </span>
        <span className="mt-1 block text-sm text-muted">
          {t('maintenance.unit')} {r.unit.unitNumber} · {t(`requestCategory.${r.category}`, { defaultValue: r.category })} · {formatDate(r.createdAt)}
          {showSubmitter && r.submittedBy ? ` · ${r.submittedBy}` : ''}
          {who ? ` · ${t('maintenance.assignedTo')}: ${who}` : ''}
        </span>
      </Link>
    </li>
  );
}

function ResidentRequests() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-requests'], queryFn: () => api.get<{ items: RequestRow[] }>('/api/me/requests') });
  return (
    <>
      <PageHeader title={t('maintenance.mineTitle')}>
        <Link to="/requests/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">
          {t('maintenance.report')}
        </Link>
      </PageHeader>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('maintenance.noRequests')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((r) => (
              <RequestItem key={r.id} r={r} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** Staff who only work on what is assigned to them (FR-19, FR-20). */
function MyTasks() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['my-tasks'], queryFn: () => api.get<{ items: RequestRow[] }>('/api/me/tasks') });
  return (
    <>
      <PageHeader title={t('maintenance.tasksTitle')} />
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('maintenance.noTasks')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((r) => (
              <RequestItem key={r.id} r={r} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

const emptyFilters = { status: '', category: '', priority: '', assigned: '', overdue: false, q: '', from: '', to: '', sort: 'newest' };

/** FR-18, FR-22: everything, with filters, for staff who look after maintenance. */
function AllRequests() {
  const { t } = useTranslation();
  const [f, setF] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const search = useDebounced(f.q.trim());
  const set = (patch: Partial<typeof emptyFilters>) => {
    setF((x) => ({ ...x, ...patch }));
    setPage(1);
  };

  const params = new URLSearchParams({ page: String(page), sort: f.sort });
  if (f.status) params.set('status', f.status);
  if (f.category) params.set('category', f.category);
  if (f.priority) params.set('priority', f.priority);
  if (f.assigned) params.set('assignedTo', f.assigned);
  if (f.overdue) params.set('overdue', 'true');
  if (search) params.set('q', search);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const list = useQuery({ queryKey: ['requests', params.toString()], queryFn: () => api.get<Page<RequestRow>>(`/api/requests?${params}`) });

  const quick = (label: string, active: boolean, apply: () => void) => (
    <Button variant={active ? 'primary' : 'secondary'} aria-pressed={active} onClick={apply}>
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('maintenance.title')} />
      <div className="mb-3 flex flex-wrap gap-2">
        {quick(t('maintenance.newOnly'), f.status === 'SUBMITTED' && f.sort === 'oldest', () => set({ ...emptyFilters, status: 'SUBMITTED', sort: 'oldest' }))}
        {quick(t('maintenance.overdueOnly'), f.overdue, () => set({ ...emptyFilters, overdue: true }))}
        {quick(t('maintenance.assignedMe'), f.assigned === 'me', () => set({ ...emptyFilters, assigned: 'me' }))}
        <Button variant="ghost" onClick={() => set(emptyFilters)}>
          {t('maintenance.clearFilters')}
        </Button>
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('maintenance.filterStatus')}>
          {(p) => (
            <Select {...p} value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t('maintenance.all')}</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`requestStatus.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('maintenance.filterCategory')}>
          {(p) => (
            <Select {...p} value={f.category} onChange={(e) => set({ category: e.target.value })}>
              <option value="">{t('maintenance.all')}</option>
              {REQUEST_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`requestCategory.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('maintenance.filterPriority')}>
          {(p) => (
            <Select {...p} value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
              <option value="">{t('maintenance.all')}</option>
              {REQUEST_PRIORITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`requestPriority.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('maintenance.filterAssigned')}>
          {(p) => (
            <Select {...p} value={f.assigned} onChange={(e) => set({ assigned: e.target.value })}>
              <option value="">{t('maintenance.all')}</option>
              <option value="me">{t('maintenance.assignedMe')}</option>
              <option value="none">{t('maintenance.assignedNone')}</option>
            </Select>
          )}
        </Field>
        <Field label={t('common.search')}>
          {(p) => <TextInput {...p} type="search" placeholder={t('maintenance.search')} value={f.q} onChange={(e) => set({ q: e.target.value })} />}
        </Field>
        <Field label={t('maintenance.fromDate')}>
          {(p) => <TextInput {...p} type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />}
        </Field>
        <Field label={t('maintenance.toDate')}>
          {(p) => <TextInput {...p} type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />}
        </Field>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Notice>{errorMessage(t, list.error)}</Notice>
      ) : list.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('maintenance.noRequests')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {list.data!.items.map((r) => (
              <RequestItem key={r.id} r={r} showSubmitter />
            ))}
          </ul>
        </Card>
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
    </>
  );
}

/** Residents see their own requests; maintenance staff see everything; other staff see their tasks. */
export function RequestsPage() {
  const { user, can } = useAuth();
  if (user?.role === 'RESIDENT') return <ResidentRequests />;
  const seesAll = user?.role === 'ADMIN' || ['maintenance.view_all', 'maintenance.review', 'maintenance.assign'].some((p) => can(p as 'maintenance.review'));
  return seesAll ? <AllRequests /> : <MyTasks />;
}
