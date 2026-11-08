import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { REQUEST_PRIORITIES } from '@apt/shared';
import { useAuth } from '../app/auth';
import { PhotoGrid, PhotoPicker } from '../components/Photos';
import { OverdueChip, PriorityChip, RequestStatusChip } from '../components/RequestBits';
import { Button, Card, Chip, Field, Notice, PageHeader, Select, Spinner, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import type { RequestDetail, RequestStatus, RequestUpdateEntry } from '../lib/types';

/** After any change, show the new state and refresh the lists that mention it. */
function useRefresh(id: string) {
  const qc = useQueryClient();
  return async (r?: RequestDetail) => {
    if (r) qc.setQueryData(['request', id], r);
    await Promise.all(['requests', 'my-requests', 'my-tasks'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };
}

const OPEN: RequestStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS'];

// ------------------------------------------------------------ one status change

/** A button that opens a small form asking for a note (a reason, or what was done), then makes the change. */
function NoteAction({ req, to, label, noteLabel, variant = 'secondary', confirmLabel }: { req: RequestDetail; to: RequestStatus; label: string; noteLabel: string; variant?: 'primary' | 'secondary' | 'danger'; confirmLabel?: string }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const run = useMutation({
    mutationFn: () => api.post<RequestDetail>(`/api/requests/${req.id}/transition`, { to, note: note.trim() }),
    onSuccess: async (r) => {
      setOpen(false);
      setNote('');
      await refresh(r);
    },
  });
  const fields = fieldErrorsOf(t, run.error);
  if (!open) {
    return (
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form
      className="w-full space-y-3 tile"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        run.mutate();
      }}
    >
      {run.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, run.error)}</Notice>}
      <Field label={noteLabel} error={fields.note}>
        {(p) => <TextArea {...p} rows={3} required maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={run.isPending || !note.trim()}>
          {confirmLabel ?? label}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** A button that makes a change straight away (optionally after asking "are you sure"). */
function QuickAction({ req, to, label, variant = 'primary', confirm }: { req: RequestDetail; to: RequestStatus; label: string; variant?: 'primary' | 'secondary' | 'danger'; confirm?: string }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const run = useMutation({
    mutationFn: () => api.post<RequestDetail>(`/api/requests/${req.id}/transition`, { to }),
    onSuccess: (r) => refresh(r),
  });
  return (
    <>
      <Button
        variant={variant}
        disabled={run.isPending}
        onClick={() => {
          if (!confirm || window.confirm(confirm)) run.mutate();
        }}
      >
        {label}
      </Button>
      {run.isError && (
        <div className="w-full">
          <Notice>{errorMessage(t, run.error)}</Notice>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------------- resident

function ResidentActions({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  if (req.status === 'SUBMITTED') {
    return (
      <Card>
        <h2 className="mb-3 heading-section">{t('maintenance.actions')}</h2>
        <div className="flex flex-wrap gap-2">
          <QuickAction req={req} to="CANCELLED" variant="danger" label={t('maintenance.cancel')} confirm={t('maintenance.confirmCancel')} />
        </div>
      </Card>
    );
  }
  if (req.status === 'RESOLVED') {
    return (
      <Card>
        <h2 className="mb-2 heading-section">{t('maintenance.actions')}</h2>
        <p className="mb-3">{t('maintenance.resolvedQuestion')}</p>
        <div className="flex flex-wrap gap-2">
          <QuickAction req={req} to="CLOSED" label={t('maintenance.fixed')} />
          <NoteAction req={req} to="IN_PROGRESS" label={t('maintenance.notFixed')} noteLabel={t('maintenance.reopenNote')} confirmLabel={t('maintenance.sendReopen')} />
        </div>
      </Card>
    );
  }
  return null;
}

// -------------------------------------------------------------------- staff

function PriorityControl({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const [value, setValue] = useState(req.priority ?? '');
  const save = useMutation({
    mutationFn: () => api.patch<RequestDetail>(`/api/requests/${req.id}/priority`, { priority: value }),
    onSuccess: (r) => refresh(r),
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('maintenance.priority')}>
        {(p) => (
          <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="" disabled>
              {t('maintenance.priorityNotSet')}
            </option>
            {REQUEST_PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {t(`requestPriority.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button variant="secondary" disabled={save.isPending || !value || value === req.priority} onClick={() => save.mutate()}>
        {t('maintenance.savePriority')}
      </Button>
      {save.isError && (
        <div className="w-full">
          <Notice>{errorMessage(t, save.error)}</Notice>
        </div>
      )}
    </div>
  );
}

function AssignControl({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const [staffId, setStaffId] = useState('');
  const people = useQuery({ queryKey: ['assignees'], queryFn: () => api.get<{ items: { id: string; fullName: string }[] }>('/api/requests/assignees') });
  const assign = useMutation({
    mutationFn: () => api.post<RequestDetail>(`/api/requests/${req.id}/assign`, { staffId }),
    onSuccess: async (r) => {
      setStaffId('');
      await refresh(r);
    },
  });
  const fields = fieldErrorsOf(t, assign.error);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('maintenance.assignTo')} error={fields.staffId}>
        {(p) => (
          <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">{t('maintenance.choosePerson')}</option>
            {(people.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button variant="secondary" disabled={assign.isPending || !staffId} onClick={() => assign.mutate()}>
        {t('maintenance.assign')}
      </Button>
      {assign.isError && Object.keys(fields).length === 0 && (
        <div className="w-full">
          <Notice>{errorMessage(t, assign.error)}</Notice>
        </div>
      )}
    </div>
  );
}

function StaffActions({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const reviewer = can('maintenance.review');
  const assigner = can('maintenance.assign');
  const worker = isAdmin || req.assignedTo?.id === user?.id;
  const open = OPEN.includes(req.status);
  if (!open) return null;

  const rows: ReactNode[] = [];
  if (reviewer) rows.push(<PriorityControl key="priority" req={req} />);
  if (assigner) rows.push(<AssignControl key="assign" req={req} />);

  const buttons: ReactNode[] = [];
  if (reviewer && req.status === 'SUBMITTED') buttons.push(<QuickAction key="review" req={req} to="UNDER_REVIEW" label={t('maintenance.startReview')} />);
  if (worker && req.status === 'UNDER_REVIEW') buttons.push(<QuickAction key="start" req={req} to="IN_PROGRESS" label={t('maintenance.startWork')} />);
  if (worker && req.status === 'IN_PROGRESS') buttons.push(<NoteAction key="resolve" req={req} to="RESOLVED" variant="primary" label={t('maintenance.resolve')} noteLabel={t('maintenance.resolveNote')} />);
  if (reviewer && (req.status === 'SUBMITTED' || req.status === 'UNDER_REVIEW')) {
    buttons.push(<NoteAction key="reject" req={req} to="REJECTED" variant="danger" label={t('maintenance.reject')} noteLabel={t('maintenance.rejectReason')} confirmLabel={t('maintenance.confirmReject')} />);
  }
  if (rows.length === 0 && buttons.length === 0) return null;

  return (
    <Card>
      <h2 className="mb-3 heading-section">{t('maintenance.staffActions')}</h2>
      <div className="space-y-4">
        {rows}
        {buttons.length > 0 && <div className="flex flex-wrap gap-2">{buttons}</div>}
      </div>
    </Card>
  );
}

function NoteForm({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = useState(false);
  const add = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('note', note);
      form.set('isInternal', String(internal));
      for (const f of files) form.append('photos', f);
      return api.postForm<RequestDetail>(`/api/requests/${req.id}/notes`, form);
    },
    onSuccess: async (r) => {
      setNote('');
      setFiles([]);
      setInternal(false); // each internal note is a deliberate choice, never carried over to the next one
      setSaved(true);
      await refresh(r);
    },
  });
  const fields = fieldErrorsOf(t, add.error);
  return (
    <Card>
      <h2 className="mb-3 heading-section">{t('maintenance.addNote')}</h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setSaved(false);
          add.mutate();
        }}
      >
        {saved && <Notice tone="info">{t('maintenance.noteSaved')}</Notice>}
        {add.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, add.error)}</Notice>}
        <Field label={t('maintenance.noteLabel')} error={fields.note}>
          {(p) => <TextArea {...p} rows={3} required maxLength={1000} value={note} onChange={(e) => { setSaved(false); setNote(e.target.value); }} />}
        </Field>
        <label className="flex min-h-11 items-center gap-3 font-semibold">
          <input type="checkbox" className="size-5" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          {t('maintenance.internal')}
        </label>
        <Field label={t('maintenance.photos')}>{(p) => <PhotoPicker id={p.id} files={files} onChange={setFiles} error={fields.photos} />}</Field>
        <Button type="submit" disabled={add.isPending || !note.trim()}>
          {t('maintenance.sendNote')}
        </Button>
      </form>
    </Card>
  );
}

// ----------------------------------------------------------------- timeline

function Timeline({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const status = (v: string | null) => (v ? t(`requestStatus.${v}`, { defaultValue: v }) : '');
  const priority = (v: string | null) => (v ? t(`requestPriority.${v}`, { defaultValue: v }) : t('maintenance.priorityNotSet'));

  const headline = (u: RequestUpdateEntry): string | null => {
    switch (u.kind) {
      case 'STATUS_CHANGE':
        return u.fromValue === null ? t('maintenance.changeSubmitted') : t('maintenance.changeStatus', { from: status(u.fromValue), to: status(u.toValue) });
      case 'PRIORITY_CHANGE':
        return t('maintenance.changePriority', { from: priority(u.fromValue), to: priority(u.toValue) });
      case 'ASSIGNMENT':
        return u.fromValue ? t('maintenance.changeAssignmentFrom', { from: u.fromValue, to: u.toValue }) : t('maintenance.changeAssignment', { to: u.toValue });
      default:
        return null;
    }
  };

  return (
    <Card>
      <h2 className="mb-3 heading-section">{t('maintenance.timeline')}</h2>
      <ol className="space-y-4" data-testid="timeline">
        {req.updates.map((u) => (
          <li key={u.id} className="border-s-4 border-line ps-3" data-testid="update">
            <p className="text-sm text-muted">
              <span className="font-semibold text-ink">{u.author ?? t('maintenance.system')}</span> · {formatDateTime(u.createdAt)}
              {u.isInternal && (
                <span className="ms-2">
                  <Chip tone="amber">{t('maintenance.internalBadge')}</Chip>
                </span>
              )}
            </p>
            {headline(u) && <p className="font-semibold">{headline(u)}</p>}
            {u.note && <p className="whitespace-pre-wrap">{u.note}</p>}
            <PhotoGrid photos={u.photos} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ------------------------------------------------------- rating (FR-50, BR-26)

function RatingForm({ req }: { req: RequestDetail }) {
  const { t } = useTranslation();
  const refresh = useRefresh(req.id);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const send = useMutation({ mutationFn: () => api.post<RequestDetail>(`/api/requests/${req.id}/rating`, { stars, comment }), onSuccess: refresh });
  return (
    <Card>
      <h2 className="heading-section">{t('rating.title')}</h2>
      <p className="mb-3 text-muted">{t('rating.help')}</p>
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <fieldset>
          <legend className="mb-1 font-semibold">{t('rating.stars')}</legend>
          <div className="flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-xl border border-line-strong px-2 font-bold transition-colors hover:bg-hover has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2">
                <input type="radio" name="stars" className="sr-only" value={n} checked={stars === n} onChange={() => setStars(n)} />
                <span aria-hidden="true">{n} ★</span>
                <span className="sr-only">{t('rating.star', { count: n })}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('rating.comment')}>{(p) => <TextArea {...p} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
        {send.isError && <Notice>{errorMessage(t, send.error)}</Notice>}
        <Button type="submit" disabled={stars === 0 || send.isPending}>{t('rating.submit')}</Button>
      </form>
    </Card>
  );
}

function RatingCard({ rating, own }: { rating: NonNullable<RequestDetail['rating']>; own: boolean }) {
  const { t } = useTranslation();
  return (
    <Card>
      <h2 className="heading-card">{own ? t('rating.yours') : t('rating.given')}</h2>
      <p className="heading-section" data-testid="rating">{t('rating.star', { count: rating.stars })}</p>
      {rating.comment && <p className="mt-1 whitespace-pre-wrap">{rating.comment}</p>}
    </Card>
  );
}

// --------------------------------------------------------------------- page

export function RequestDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const q = useQuery({ queryKey: ['request', id], queryFn: () => api.get<RequestDetail>(`/api/requests/${id}`) });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const r = q.data!;
  const resident = user?.role === 'RESIDENT';
  const isAssignee = r.assignedTo?.id === user?.id;
  const canNote = !resident && (can('maintenance.review') || isAssignee) && !['CLOSED', 'REJECTED', 'CANCELLED'].includes(r.status);

  return (
    <>
      <div className="mb-2">
        <Link to="/requests" className="link-action">
          ← {resident ? t('maintenance.mineTitle') : user?.role === 'STAFF' && !can('maintenance.view_all') && !can('maintenance.review') && !can('maintenance.assign') ? t('maintenance.tasksTitle') : t('maintenance.title')}
        </Link>
      </div>
      <PageHeader title={r.title} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="font-bold text-muted">{t('maintenance.number', { number: r.number })}</span>
        <RequestStatusChip status={r.status} />
        <PriorityChip priority={r.priority} />
        {r.overdue && <OverdueChip />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-sm text-muted">{t('maintenance.unit')}</dt>
              <dd className="font-bold">{r.unit?.unitNumber ?? t('maintenance.noUnit')}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenance.category')}</dt>
              <dd className="font-bold">{t(`requestCategory.${r.category}`, { defaultValue: r.category })}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenance.location')}</dt>
              <dd className="font-bold">{t(`maintenance.locationShort${r.location}`)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenance.assignedTo')}</dt>
              <dd className="font-bold" data-testid="assignee">
                {r.assignedTo?.fullName ?? t('maintenance.unassigned')}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenance.reportedBy')}</dt>
              <dd className="font-bold">{r.submittedBy?.fullName ?? t('maintenance.system')}</dd>
              {r.submittedBy?.phone && (
                <dd>
                  <a href={`tel:${r.submittedBy.phone}`} className="link-action">
                    {r.submittedBy.phone}
                  </a>
                </dd>
              )}
            </div>
            <div>
              <dt className="text-sm text-muted">{t('maintenance.reportedLabel')}</dt>
              <dd className="font-bold">{formatDate(r.createdAt)}</dd>
              {!resident && OPEN.includes(r.status) && <dd className="text-sm text-muted">{t('maintenance.dueBy', { date: formatDateTime(r.dueAt) })}</dd>}
            </div>
          </dl>
          <p className="mt-4 whitespace-pre-wrap" data-testid="description">
            {r.description}
          </p>
          <div className="mt-3">
            <PhotoGrid photos={r.photos} />
          </div>
        </Card>
        <div className="space-y-4">
          {resident ? <ResidentActions req={r} /> : <StaffActions req={r} />}
          {r.canRate && <RatingForm req={r} />}
          {r.rating && <RatingCard rating={r.rating} own={resident} />}
          {canNote && <NoteForm req={r} />}
          {!OPEN.includes(r.status) && r.status !== 'RESOLVED' && <Notice tone="info">{t('maintenance.finished')}</Notice>}
        </div>
      </div>
      <div className="mt-4">
        <Timeline req={r} />
      </div>
    </>
  );
}
