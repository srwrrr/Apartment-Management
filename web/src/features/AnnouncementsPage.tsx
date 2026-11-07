import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ANNOUNCEMENT_CATEGORIES } from '@apt/shared';
import { useAuth } from '../app/auth';
import { Button, Card, Chip, Field, Notice, PageHeader, Pagination, Select, Spinner, TextArea, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import type { AnnouncementDetail, AnnouncementRow, Page, Unit } from '../lib/types';

function CategoryChips({ a }: { a: Pick<AnnouncementRow, 'category' | 'isImportant'> }) {
  const { t } = useTranslation();
  return (
    <>
      {a.isImportant && <Chip tone="red">{t('announcements.important')}</Chip>} <Chip tone="blue">{t(`announcements.category.${a.category}`)}</Chip>
    </>
  );
}

export function AnnouncementsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can('announcements.manage');
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState(false);
  const q = useQuery({
    queryKey: ['announcements', page, archived],
    queryFn: () => api.get<Page<AnnouncementRow>>(`/api/announcements?page=${page}${manage && archived ? '&archived=true' : ''}`),
  });
  return (
    <>
      <PageHeader title={t('announcements.title')}>
        {manage && (
          <Link to="/announcements/new" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700">
            {t('announcements.new')}
          </Link>
        )}
      </PageHeader>
      {manage && (
        <label className="mb-4 flex min-h-11 items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              setPage(1);
            }}
          />
          {t('announcements.showArchived')}
        </label>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('announcements.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((a) => (
              <li key={a.id} data-testid="announcement">
                <Link to={`/announcements/${a.id}`} className="block min-h-14 px-4 py-3 hover:bg-brand-50">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`text-lg ${manage || a.read ? 'font-semibold' : 'font-bold'}`}>{a.title}</span>
                    {!manage && !a.read && <Chip tone="green">{t('announcements.unread')}</Chip>}
                    <CategoryChips a={a} />
                    {a.archivedAt && <Chip>{t('announcements.archived')}</Chip>}
                  </span>
                  {a.preview && <span className="mt-1 block text-muted">{a.preview}</span>}
                  <span className="mt-1 block text-sm text-muted">
                    {t('announcements.published', { date: formatDate(a.publishedAt), author: a.author })}
                    {manage && typeof a.recipients === 'number' && <> · {t('announcements.readBy', { read: a.read as number, recipients: a.recipients })}</>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
    </>
  );
}

function ReadStatus({ id }: { id: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['announcement-reads', id],
    queryFn: () => api.get<{ recipients: number; read: number; unread: { id: string; fullName: string; units: string | null }[] }>(`/api/announcements/${id}/reads`),
  });
  if (!q.data) return null;
  return (
    <Card className="mt-4">
      <h2 className="text-lg font-bold" data-testid="read-summary">
        {t('announcements.readBy', { read: q.data.read, recipients: q.data.recipients })}
      </h2>
      {q.data.unread.length === 0 ? (
        <p className="mt-2 text-muted">{t('announcements.everyoneRead')}</p>
      ) : (
        <>
          <h3 className="mt-3 font-semibold">{t('announcements.notReadYet')}</h3>
          <ul className="mt-1 list-disc ps-6">
            {q.data.unread.map((u) => (
              <li key={u.id}>
                {u.fullName}
                {u.units && <span className="text-muted"> ({u.units})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function EditForm({ a, onDone }: { a: AnnouncementDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [title, setTitle] = useState(a.title);
  const [body, setBody] = useState(a.body);
  const [category, setCategory] = useState(a.category);
  const [important, setImportant] = useState(a.isImportant);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/announcements/${a.id}`, { title, body, category, isImportant: important }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['announcement', a.id] });
      await qc.invalidateQueries({ queryKey: ['announcements'] });
      onDone();
    },
  });
  const fe = fieldErrorsOf(t, save.error);
  return (
    <Card>
      <h2 className="mb-2 text-xl font-bold">{t('announcements.editTitle')}</h2>
      <p className="mb-3 text-muted">{t('announcements.editNote')}</p>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('announcements.fieldTitle')} error={fe.title}>
          {(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label={t('announcements.fieldBody')} error={fe.body}>
          {(p) => <TextArea {...p} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}
        </Field>
        <Field label={t('announcements.fieldCategory')}>
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {ANNOUNCEMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`announcements.category.${c}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex min-h-11 items-center gap-2 font-semibold">
          <input type="checkbox" className="h-5 w-5" checked={important} onChange={(e) => setImportant(e.target.checked)} />
          {t('announcements.fieldImportant')}
        </label>
        {save.isError && !Object.keys(fe).length && <Notice>{errorMessage(t, save.error)}</Notice>}
        <div className="flex gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t('common.save')}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function AnnouncementDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { can } = useAuth();
  const manage = can('announcements.manage');
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['announcement', id], queryFn: () => api.get<AnnouncementDetail>(`/api/announcements/${id}`) });

  // A resident opening it counts as reading it (FR-26); the bell and the list then update.
  const markRead = useMutation({
    mutationFn: () => api.post(`/api/announcements/${id}/read`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['announcements'] });
    },
  });
  const unreadNow = !manage && !!q.data && !q.data.read;
  useEffect(() => {
    if (unreadNow) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadNow]);

  const archive = useMutation({
    mutationFn: () => api.post(`/api/announcements/${id}/archive`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['announcement', id] });
      await qc.invalidateQueries({ queryKey: ['announcements'] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const a = q.data!;
  return (
    <>
      <p className="mb-2">
        <Link to="/announcements" className="font-semibold text-brand-700 underline">
          ← {t('announcements.title')}
        </Link>
      </p>
      {editing ? (
        <EditForm a={a} onDone={() => setEditing(false)} />
      ) : (
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <CategoryChips a={a} />
            {a.archivedAt && <Chip>{t('announcements.archived')}</Chip>}
          </div>
          <h1 className="text-2xl font-bold">{a.title}</h1>
          <p className="mb-4 text-sm text-muted">
            {t('announcements.published', { date: formatDateTime(a.publishedAt), author: a.author })}
            {a.editedAt && <> · {t('announcements.edited', { date: formatDateTime(a.editedAt) })}</>}
          </p>
          <p className="whitespace-pre-wrap text-lg">{a.body}</p>
          {manage && a.audience && (
            <p className="mt-4 text-sm text-muted">
              {t('announcements.sentTo')}: {t(`announcements.audienceType.${a.audience.type}`)}
              {a.audience.type === 'UNITS' && <> — {t('announcements.sentToUnits', { units: a.audience.units.map((u) => u.unitNumber).join(', ') })}</>}
              {a.audience.type === 'FLOORS' && <> — {t('announcements.sentToFloors', { floors: a.audience.floors.join(', ') })}</>}
            </p>
          )}
          {manage && !a.archivedAt && (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              <Button
                variant="danger"
                disabled={archive.isPending}
                onClick={() => {
                  if (window.confirm(t('announcements.confirmArchive'))) archive.mutate();
                }}
              >
                {t('announcements.archive')}
              </Button>
            </div>
          )}
        </Card>
      )}
      {manage && <ReadStatus id={id} />}
    </>
  );
}

type AudienceType = 'ALL' | 'OWNERS' | 'TENANTS' | 'FLOORS' | 'UNITS';

export function NewAnnouncementPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<(typeof ANNOUNCEMENT_CATEGORIES)[number]>('GENERAL');
  const [important, setImportant] = useState(false);
  const [type, setType] = useState<AudienceType>('ALL');
  const [floorsText, setFloorsText] = useState('');
  const [units, setUnits] = useState<{ id: string; unitNumber: string }[]>([]);
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term);

  const floors = floorsText.split(/[,\s]+/).filter(Boolean).map(Number);
  const floorsValid = floors.length > 0 && floors.every((f) => Number.isInteger(f));
  const audience =
    type === 'UNITS' ? (units.length ? { type, unitIds: units.map((u) => u.id) } : null) : type === 'FLOORS' ? (floorsValid ? { type, floors } : null) : { type };

  const found = useQuery({
    queryKey: ['unit-search', debounced],
    enabled: type === 'UNITS' && debounced.length > 0,
    queryFn: () => api.get<Page<Unit>>(`/api/units?pageSize=8&q=${encodeURIComponent(debounced)}`),
  });
  const reach = useQuery({
    queryKey: ['audience-preview', JSON.stringify(audience)],
    enabled: audience !== null,
    queryFn: () => api.post<{ count: number }>('/api/announcements/audience-preview', { audience }),
  });

  const publish = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/announcements', { title, body, category, isImportant: important, audience }),
    onSuccess: async (a) => {
      await qc.invalidateQueries({ queryKey: ['announcements'] });
      navigate(`/announcements/${a.id}`);
    },
  });
  const fe = fieldErrorsOf(t, publish.error);

  return (
    <>
      <PageHeader title={t('announcements.new')} />
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (audience) publish.mutate();
          }}
        >
          <Field label={t('announcements.fieldTitle')} error={fe.title}>
            {(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label={t('announcements.fieldBody')} error={fe.body}>
            {(p) => <TextArea {...p} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}
          </Field>
          <Field label={t('announcements.fieldCategory')}>
            {(p) => (
              <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                {ANNOUNCEMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`announcements.category.${c}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex min-h-11 items-center gap-2 font-semibold">
            <input type="checkbox" className="h-5 w-5" checked={important} onChange={(e) => setImportant(e.target.checked)} />
            {t('announcements.fieldImportant')}
          </label>

          <Field label={t('announcements.audience')} error={fe.audience}>
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value as AudienceType)}>
                {(['ALL', 'OWNERS', 'TENANTS', 'FLOORS', 'UNITS'] as const).map((a) => (
                  <option key={a} value={a}>
                    {t(`announcements.audienceType.${a}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'FLOORS' && (
            <Field label={t('announcements.floors')} help={t('announcements.floorsHelp')}>
              {(p) => <TextInput {...p} inputMode="numeric" value={floorsText} onChange={(e) => setFloorsText(e.target.value)} />}
            </Field>
          )}
          {type === 'UNITS' && (
            <div className="space-y-2">
              <Field label={t('announcements.unitsSearch')}>{(p) => <TextInput {...p} value={term} onChange={(e) => setTerm(e.target.value)} />}</Field>
              {found.data && (
                <ul className="flex flex-wrap gap-2">
                  {found.data.items
                    .filter((u) => !units.some((x) => x.id === u.id))
                    .map((u) => (
                      <li key={u.id}>
                        <Button variant="secondary" onClick={() => setUnits([...units, { id: u.id, unitNumber: u.unitNumber }])}>
                          + {u.unitNumber}
                        </Button>
                      </li>
                    ))}
                </ul>
              )}
              <ul className="flex flex-wrap gap-2">
                {units.map((u) => (
                  <li key={u.id}>
                    <Button variant="ghost" aria-label={t('announcements.removeUnit', { unit: u.unitNumber })} onClick={() => setUnits(units.filter((x) => x.id !== u.id))}>
                      {u.unitNumber} ✕
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {audience && reach.data && (
            <p className="font-semibold" data-testid="reach">
              {reach.data.count > 0 ? t('announcements.reach', { count: reach.data.count }) : t('announcements.reachNobody')}
            </p>
          )}
          {publish.isError && !Object.keys(fe).length && <Notice>{errorMessage(t, publish.error)}</Notice>}
          <Button type="submit" disabled={publish.isPending || !audience}>
            {t('announcements.publish')}
          </Button>
        </form>
      </Card>
    </>
  );
}
