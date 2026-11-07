import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, Field, Notice, PageHeader, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { GroupDetail, GroupRow } from '../lib/types';

/** FR-36. */
export function GroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['groups'], queryFn: () => api.get<{ items: GroupRow[] }>('/api/groups') });
  const create = useMutation({
    mutationFn: () => api.post<GroupDetail>('/api/groups', { name }),
    onSuccess: async (g) => {
      await qc.invalidateQueries({ queryKey: ['groups'] });
      navigate(`/groups/${g.id}`);
    },
  });
  const fe = fieldErrorsOf(t, create.error);
  return (
    <>
      <PageHeader title={t('groups.title')} />
      <p className="mb-4 text-muted">{t('groups.help')}</p>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-4 text-muted">{t('groups.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {q.data!.items.map((g) => (
              <li key={g.id} data-testid="group">
                <Link to={`/groups/${g.id}`} className="block min-h-14 px-4 py-3 hover:bg-brand-50">
                  <span className="block text-lg font-semibold">{g.name}</span>
                  <span className="block text-sm text-muted">{g.members === 1 ? t('groups.oneMember') : t('groups.memberCount', { count: g.members })}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card className="mt-4">
        <h2 className="mb-3 text-xl font-bold">{t('groups.new')}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="min-w-56 flex-1">
            <Field label={t('groups.name')} error={fe.name}>{(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          </div>
          <Button type="submit" disabled={create.isPending || !name.trim()}>{t('groups.create')}</Button>
        </form>
        {create.isError && !Object.keys(fe).length && <div className="mt-3"><Notice>{errorMessage(t, create.error)}</Notice></div>}
      </Card>
    </>
  );
}

export function GroupDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim());
  const q = useQuery({ queryKey: ['group', id], queryFn: () => api.get<GroupDetail>(`/api/groups/${id}`) });
  const found = useQuery({
    queryKey: ['group-residents', search],
    enabled: search.length > 0,
    queryFn: () => api.get<{ items: { id: string; fullName: string }[] }>(`/api/groups/residents?q=${encodeURIComponent(search)}`),
  });
  const refresh = (g: GroupDetail) => {
    qc.setQueryData(['group', id], g);
    void qc.invalidateQueries({ queryKey: ['groups'] });
  };
  const rename = useMutation({
    mutationFn: () => api.patch<GroupDetail>(`/api/groups/${id}`, { name }),
    onSuccess: (g) => {
      refresh(g);
      setName(null);
    },
  });
  const setMembers = useMutation({ mutationFn: (userIds: string[]) => api.put<GroupDetail>(`/api/groups/${id}/members`, { userIds }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/groups/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['groups'] });
      navigate('/groups');
    },
  });
  const fe = fieldErrorsOf(t, rename.error);

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const g = q.data!;
  const ids = g.members.map((m) => m.id);
  return (
    <>
      <p className="mb-2">
        <Link to="/groups" className="font-semibold text-brand-700 underline">← {t('groups.title')}</Link>
      </p>
      <PageHeader title={g.name}>
        <Button variant="secondary" onClick={() => setName(g.name)}>{t('groups.rename')}</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(t('groups.confirmDelete'))) remove.mutate();
          }}
        >
          {t('groups.delete')}
        </Button>
      </PageHeader>
      {name !== null && (
        <Card className="mb-4">
          <form
            className="flex flex-wrap items-end gap-3"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              rename.mutate();
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label={t('groups.name')} error={fe.name}>{(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            </div>
            <Button type="submit" disabled={rename.isPending}>{t('common.save')}</Button>
            <Button variant="secondary" onClick={() => setName(null)}>{t('common.cancel')}</Button>
          </form>
        </Card>
      )}
      <Card>
        <h2 className="mb-3 text-xl font-bold">{t('groups.members')}</h2>
        {g.members.length === 0 ? (
          <p className="text-muted">{t('groups.noMembers')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {g.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-2" data-testid="group-member">
                <span className="min-w-40 flex-1 font-semibold">{m.fullName}</span>
                {!m.isActive && <Chip>{t('groups.inactive')}</Chip>}
                <Button variant="ghost" disabled={setMembers.isPending} onClick={() => setMembers.mutate(ids.filter((x) => x !== m.id))}>
                  {t('groups.remove', { name: m.fullName })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Field label={t('groups.search')}>{(p) => <TextInput {...p} value={term} onChange={(e) => setTerm(e.target.value)} />}</Field>
        </div>
        {found.data && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {found.data.items
              .filter((r) => !ids.includes(r.id))
              .map((r) => (
                <li key={r.id}>
                  <Button variant="secondary" disabled={setMembers.isPending} onClick={() => setMembers.mutate([...ids, r.id])}>
                    {t('groups.add', { name: r.fullName })}
                  </Button>
                </li>
              ))}
          </ul>
        )}
        {setMembers.isError && <div className="mt-3"><Notice>{errorMessage(t, setMembers.error)}</Notice></div>}
      </Card>
    </>
  );
}
