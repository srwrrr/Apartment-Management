import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { REQUEST_CATEGORIES } from '@apt/shared';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Select, Spinner, TextArea, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { formatDate } from '../lib/format';
import type { ScheduledTask, UpcomingTask } from '../lib/types';

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['scheduled-tasks'] }), qc.invalidateQueries({ queryKey: ['scheduled-upcoming'] })]);
}

function TaskForm({ task, onClose }: { task: ScheduledTask | null; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [category, setCategory] = useState<string>(task?.category ?? REQUEST_CATEGORIES[0]);
  const [intervalMonths, setInterval] = useState(String(task?.intervalMonths ?? 1));
  const [nextDueDate, setNextDueDate] = useState(task?.nextDueDate ?? '');
  const [assignee, setAssignee] = useState(task?.defaultAssignee?.id ?? '');
  const staff = useQuery({ queryKey: ['assignees'], queryFn: () => api.get<{ items: { id: string; fullName: string }[] }>('/api/requests/assignees') });

  const save = useMutation({
    mutationFn: () => {
      const body = { title, description, category, intervalMonths: Number(intervalMonths), nextDueDate, defaultAssigneeId: assignee || null };
      return task ? api.patch(`/api/scheduled-tasks/${task.id}`, body) : api.post('/api/scheduled-tasks', body);
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const fe = fieldErrorsOf(t, save.error);
  return (
    <Modal title={task ? t('scheduled.edit') : t('scheduled.new')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t('scheduled.fieldTitle')} error={fe.title}>{(p) => <TextInput {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('scheduled.fieldDescription')} error={fe.description}>{(p) => <TextArea {...p} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label={t('scheduled.category')} error={fe.category}>
          {(p) => (
            <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
              {REQUEST_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`requestCategory.${c}`)}</option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('scheduled.interval')} error={fe.intervalMonths}>{(p) => <TextInput {...p} type="number" min={1} max={24} value={intervalMonths} onChange={(e) => setInterval(e.target.value)} />}</Field>
          <Field label={t('scheduled.nextDue')} error={fe.nextDueDate}>{(p) => <TextInput {...p} type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />}</Field>
        </div>
        <Field label={t('scheduled.assignee')} error={fe.defaultAssigneeId}>
          {(p) => (
            <Select {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{t('scheduled.noAssignee')}</option>
              {staff.data?.items.map((s) => (
                <option key={s.id} value={s.id}>{s.fullName}</option>
              ))}
            </Select>
          )}
        </Field>
        {save.isError && !Object.keys(fe).length && <Notice>{errorMessage(t, save.error)}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** FR-49. */
export function ScheduledTasksPage() {
  const { t } = useTranslation();
  const refresh = useRefresh();
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const q = useQuery({ queryKey: ['scheduled-tasks'], queryFn: () => api.get<{ items: ScheduledTask[] }>('/api/scheduled-tasks') });
  const upcoming = useQuery({ queryKey: ['scheduled-upcoming'], queryFn: () => api.get<{ items: UpcomingTask[] }>('/api/scheduled-tasks/upcoming') });
  const toggle = useMutation({
    mutationFn: (x: ScheduledTask) => api.post(`/api/scheduled-tasks/${x.id}/${x.isPaused ? 'resume' : 'pause'}`),
    onSuccess: refresh,
  });
  return (
    <>
      <PageHeader title={t('scheduled.title')}>
        <Button onClick={() => setEditing('new')}>{t('scheduled.new')}</Button>
      </PageHeader>
      <p className="mb-4 text-muted">{t('scheduled.help')}</p>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-4 text-muted">{t('scheduled.empty')}</p>
      ) : (
        <Card className="card-flush">
          <ul className="divide-y divide-line">
            {q.data!.items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="scheduled-task">
                <span className="min-w-48 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-semibold">{x.title}</span>
                    {x.isPaused && <Chip>{t('scheduled.paused')}</Chip>}
                  </span>
                  <span className="block text-sm text-muted">
                    {t(`requestCategory.${x.category}`)} · {x.intervalMonths === 1 ? t('scheduled.everyMonth') : t('scheduled.every', { count: x.intervalMonths })} · {t('scheduled.nextOn', { date: formatDate(x.nextDueDate) })}
                    {x.defaultAssignee ? ` · ${x.defaultAssignee.fullName}` : ''}
                  </span>
                </span>
                <Button variant="secondary" onClick={() => setEditing(x)}>{t('common.edit')}</Button>
                <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate(x)}>
                  {x.isPaused ? t('scheduled.resume') : t('scheduled.pause')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {toggle.isError && <div className="mt-3"><Notice>{errorMessage(t, toggle.error)}</Notice></div>}
      <Card className="mt-4">
        <h2 className="mb-3 heading-section">{t('scheduled.upcoming')}</h2>
        {upcoming.data && upcoming.data.items.length === 0 ? (
          <p className="text-muted">{t('scheduled.noneUpcoming')}</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="upcoming">
            {upcoming.data?.items.map((u) => (
              <li key={`${u.taskId}-${u.dueDate}`} className="flex flex-wrap justify-between gap-x-3 py-2">
                <span className="font-semibold">{u.title}</span>
                <span className="text-muted">
                  {formatDate(u.dueDate)}
                  {u.assignee ? ` · ${u.assignee}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <TaskForm task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
