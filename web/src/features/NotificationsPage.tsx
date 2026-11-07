import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatBDT } from '@apt/shared';
import { Button, Card, Notice, PageHeader, Pagination, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate, formatDateTime } from '../lib/format';
import type { NotificationItem, NotificationList } from '../lib/types';

/** The sentence for a notification, written in the reader's language from the facts stored with it (FR-25, FR-47). */
export function notificationText(t: TFunction, n: Pick<NotificationItem, 'type' | 'params'>): string {
  const p = { ...n.params } as Record<string, unknown>;
  if (typeof p.amount === 'number') p.amount = formatBDT(p.amount);
  if (typeof p.dueDate === 'string') p.dueDate = formatDate(p.dueDate);
  if (typeof p.date === 'string') p.date = formatDate(p.date);
  if (n.type === 'REQUEST_UPDATE') {
    if (typeof p.status === 'string') return t('notifications.text.REQUEST_UPDATE_STATUS', { ...p, status: t(`requestStatus.${p.status}`) });
    if (p.note) return t('notifications.text.REQUEST_UPDATE_NOTE', p);
  }
  if (n.type === 'REQUEST_ASSIGNED' && !p.unit) return t('notifications.text.REQUEST_ASSIGNED_COMMON', p); // a scheduled job has no unit
  return t(`notifications.text.${n.type}`, p);
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/api/notifications/unread-count'),
    refetchInterval: 60_000,
    select: (d) => d.unread,
  });
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useQuery({
    queryKey: ['notifications', 'list', page, unreadOnly],
    queryFn: () => api.get<NotificationList>(`/api/notifications?page=${page}${unreadOnly ? '&unread=true' : ''}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: refresh });

  return (
    <>
      <PageHeader title={t('notifications.title')}>
        <Button variant="secondary" disabled={!list.data?.unread || readAll.isPending} onClick={() => readAll.mutate()}>
          {t('notifications.markAllRead')}
        </Button>
      </PageHeader>
      <label className="mb-4 flex min-h-11 items-center gap-2 font-semibold">
        <input type="checkbox" className="h-5 w-5" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setPage(1); }} />
        {t('notifications.unreadOnly')}
      </label>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Notice>{errorMessage(t, list.error)}</Notice>
      ) : list.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('notifications.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {list.data!.items.map((n) => (
              <li key={n.id} data-testid="notification" className={n.readAt ? '' : 'bg-brand-50'}>
                <Link to={n.link} onClick={() => !n.readAt && readOne.mutate(n.id)} className="flex min-h-14 flex-col gap-1 px-4 py-3 hover:bg-brand-100">
                  <span className={n.readAt ? '' : 'font-bold'}>
                    {!n.readAt && <span className="me-2 inline-block rounded-full bg-brand-600 px-2 py-0.5 text-sm font-semibold text-white">{t('notifications.unread')}</span>}
                    {notificationText(t, n)}
                  </span>
                  <span className="text-sm text-muted">{formatDateTime(n.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
    </>
  );
}
