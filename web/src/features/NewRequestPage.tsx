import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { REQUEST_CATEGORIES } from '@apt/shared';
import { PhotoPicker } from '../components/Photos';
import { Button, Card, Field, Notice, PageHeader, Select, Spinner, TextArea, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import { todayYmd, ymd } from '../lib/format';
import type { MyProfile, RequestDetail } from '../lib/types';

/** FR-16, FR-17: a resident reports a problem. Their name and apartment are added by the system. */
export function NewRequestPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const profile = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<MyProfile>('/api/me/profile') });

  const [category, setCategory] = useState('PLUMBING');
  const [location, setLocation] = useState('UNIT');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [unitId, setUnitId] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  // Only a hint for the form: the server decides which apartments really count.
  const today = todayYmd();
  const units = (profile.data?.occupancies ?? []).filter((o) => !o.endDate || ymd(o.endDate) >= today).map((o) => o.unit);

  const send = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('category', category);
      form.set('location', location);
      form.set('title', title);
      form.set('description', description);
      if (units.length > 1 && unitId) form.set('unitId', unitId);
      for (const f of files) form.append('photos', f);
      return api.postForm<RequestDetail>('/api/requests', form);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['my-requests'] });
      navigate(`/requests/${r.id}`, { replace: true });
    },
  });
  const fields = fieldErrorsOf(t, send.error);

  if (profile.isLoading) return <Spinner />;

  return (
    <>
      <div className="mb-2">
        <Link to="/requests" className="link-action">
          ← {t('maintenance.mineTitle')}
        </Link>
      </div>
      <PageHeader title={t('maintenance.report')} />
      <p className="mb-4 max-w-2xl text-muted">{t('maintenance.newIntro')}</p>
      <Card className="max-w-2xl">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          {send.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, send.error)}</Notice>}
          {units.length === 0 && <Notice>{t('fieldErrors.NO_ACTIVE_UNIT')}</Notice>}

          {units.length === 1 && (
            <p>
              <span className="text-sm text-muted">{t('maintenance.unit')}: </span>
              <span className="font-bold">{units[0]!.unitNumber}</span>
            </p>
          )}
          {units.length > 1 && (
            <Field label={t('maintenance.unit')} error={fields.unitId}>
              {(p) => (
                <Select {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} required>
                  <option value="">{t('maintenance.selectUnit')}</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unitNumber}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('maintenance.category')} error={fields.category}>
              {(p) => (
                <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
                  {REQUEST_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`requestCategory.${c}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('maintenance.location')} error={fields.location}>
              {(p) => (
                <Select {...p} value={location} onChange={(e) => setLocation(e.target.value)}>
                  <option value="UNIT">{t('maintenance.locationUNIT')}</option>
                  <option value="COMMON_AREA">{t('maintenance.locationCOMMON_AREA')}</option>
                </Select>
              )}
            </Field>
          </div>

          <Field label={t('maintenance.titleLabel')} help={t('maintenance.titleHelp')} error={fields.title}>
            {(p) => <TextInput {...p} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label={t('maintenance.description')} error={fields.description}>
            {(p) => <TextArea {...p} required maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Field label={t('maintenance.photos')} help={t('maintenance.photosHelp')}>
            {(p) => <PhotoPicker id={p.id} files={files} onChange={setFiles} error={fields.photos} />}
          </Field>

          <Button type="submit" disabled={send.isPending || units.length === 0 || (units.length > 1 && !unitId) || !title.trim() || !description.trim()}>
            {send.isPending ? t('maintenance.sending') : t('maintenance.submit')}
          </Button>
        </form>
      </Card>
    </>
  );
}
