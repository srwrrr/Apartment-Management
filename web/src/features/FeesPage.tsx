import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatBDT } from '@apt/shared';
import { Card, Notice, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { FeeItem } from '../lib/types';
import { FeeEditor } from './FeeEditor';

interface FeesResponse {
  defaults: FeeItem[];
  units: { unitId: string; unitNumber: string; fees: FeeItem[] }[];
}

/** FR-32: the building-wide fees that every generated bill starts from. */
export function FeesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const q = useQuery({ queryKey: ['fees'], queryFn: () => api.get<FeesResponse>('/api/fees') });
  const save = useMutation({
    mutationFn: (fees: FeeItem[]) => api.put<FeesResponse>('/api/fees/defaults', { fees }),
    onSuccess: (data) => {
      qc.setQueryData(['fees'], data);
      setSaved(true);
    },
    onMutate: () => setSaved(false),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Notice>{errorMessage(t, q.error)}</Notice>;
  const data = q.data!;

  return (
    <>
      <PageHeader title={t('fees.title')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 heading-section">{t('fees.defaultsTitle')}</h2>
          <p className="mb-1 text-sm text-muted">{t('fees.defaultsHelp')}</p>
          <p className="mb-4 text-sm font-semibold">{t('fees.futureOnly')}</p>
          <FeeEditor initial={data.defaults} saving={save.isPending} saved={saved} error={save.error} onSave={(fees) => save.mutate(fees)} />
        </Card>
        <Card>
          <h2 className="mb-3 heading-section">{t('fees.overrides')}</h2>
          {data.units.length === 0 ? (
            <p className="text-muted">{t('fees.noOverrides')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.units.map((u) => (
                <li key={u.unitId} className="py-3">
                  <Link to={`/units/${u.unitId}`} className="heading-card text-accent underline">
                    {u.unitNumber}
                  </Link>
                  <p className="text-sm text-muted">{u.fees.map((f) => `${t(`chargeTypes.${f.chargeType}`)} ${formatBDT(f.amount)}`).join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
