import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, Chip, Field, Notice, PageHeader, Pagination, Spinner, TextInput, useDebounced } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { Page } from '../lib/types';
import { useAuth } from '../app/auth';

interface Entry {
  id: string;
  type: 'OWNER' | 'TENANT';
  resident: { id: string; fullName: string; phone: string };
  unit: { id: string; unitNumber: string; floor: number };
}

/** FR-08: who lives in which unit. Phone numbers are tap-to-call links (UI-09). */
export function DirectoryPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const search = useDebounced(q.trim());
  const query = useQuery({
    queryKey: ['directory', search, page],
    queryFn: () => api.get<Page<Entry>>(`/api/directory?page=${page}&q=${encodeURIComponent(search)}`),
  });

  return (
    <>
      <PageHeader title={t('directory.title')} />
      <p className="mb-4 text-muted">{t('directory.help')}</p>
      <div className="mb-4 max-w-md">
        <Field label={t('common.search')}>
          {(p) => (
            <TextInput
              {...p}
              type="search"
              placeholder={t('directory.searchPlaceholder')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          )}
        </Field>
      </div>
      {query.isLoading ? (
        <Spinner />
      ) : query.isError ? (
        <Notice>{errorMessage(t, query.error)}</Notice>
      ) : query.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('directory.empty')}</p>
      ) : (
        <Card className="!p-0">
          <ul className="divide-y divide-line">
            {query.data!.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="min-w-14 text-xl font-bold">
                  {can('units.manage') || can('residents.manage') ? (
                    <Link to={`/units/${e.unit.id}`} className="text-brand-700 underline">
                      {e.unit.unitNumber}
                    </Link>
                  ) : (
                    e.unit.unitNumber
                  )}
                </span>
                <span className="min-w-40 flex-1 font-semibold">{e.resident.fullName}</span>
                <Chip tone="blue">{t(`units.type.${e.type}`)}</Chip>
                <a
                  href={`tel:${e.resident.phone}`}
                  aria-label={t('directory.call', { name: e.resident.fullName })}
                  className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline"
                >
                  {e.resident.phone}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
    </>
  );
}
