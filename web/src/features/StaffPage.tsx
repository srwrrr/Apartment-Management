import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PERMISSIONS } from '@apt/shared';
import { Button, Card, Chip, Field, Modal, Notice, PageHeader, Spinner, TempPasswordModal, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { StaffMember } from '../lib/types';

function PermissionBoxes({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-semibold">{t('common.permissions')}</legend>
      <p className="mb-2 text-sm text-muted">{t('staff.permissionsHelp')}</p>
      {PERMISSIONS.map((p) => (
        <label key={p} className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={value.includes(p)}
            onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
          />
          {t(`permissions.${p}`)}
        </label>
      ))}
    </fieldset>
  );
}

function StaffFormModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { loginId: string; tempPassword: string }) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', loginId: '', phone: '' });
  const [permissions, setPermissions] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api.post<{ staff: StaffMember; tempPassword: string }>('/api/staff', { ...form, permissions }),
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ['staff'] });
      onCreated({ loginId: data.staff.loginId, tempPassword: data.tempPassword });
      onClose();
    },
  });
  const fields = fieldErrorsOf(t, create.error);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal title={t('staff.new')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.isError && Object.keys(fields).length === 0 && <Notice>{errorMessage(t, create.error)}</Notice>}
        <Field label={t('residents.fullName')} error={fields.fullName}>
          {(p) => <TextInput {...p} required value={form.fullName} onChange={set('fullName')} />}
        </Field>
        <Field label={t('auth.loginId')} error={fields.loginId}>
          {(p) => <TextInput {...p} required autoCapitalize="none" value={form.loginId} onChange={set('loginId')} />}
        </Field>
        <Field label={t('common.phone')} error={fields.phone}>
          {(p) => <TextInput {...p} required type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} />}
        </Field>
        <PermissionBoxes value={permissions} onChange={setPermissions} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending || !form.fullName || !form.loginId || !form.phone}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PermissionsModal({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [permissions, setPermissions] = useState(member.permissions);
  const save = useMutation({
    mutationFn: () => api.put(`/api/staff/${member.id}/permissions`, { permissions }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
  });
  return (
    <Modal title={`${t('staff.editPermissions')}: ${member.fullName}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Notice>{errorMessage(t, save.error)}</Notice>}
        <PermissionBoxes value={permissions} onChange={setPermissions} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function StaffPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [temp, setTemp] = useState<{ loginId: string; tempPassword: string } | null>(null);

  const q = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ items: StaffMember[] }>('/api/staff') });
  const toggle = useMutation({
    mutationFn: (m: StaffMember) => api.post(`/api/staff/${m.id}/${m.isActive ? 'deactivate' : 'reactivate'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }),
  });
  const reset = useMutation({
    mutationFn: (m: StaffMember) => api.post<{ tempPassword: string }>(`/api/users/${m.id}/reset-password`).then((r) => ({ loginId: m.loginId, tempPassword: r.tempPassword })),
    onSuccess: setTemp,
  });

  return (
    <>
      <PageHeader title={t('staff.title')}>
        <Button onClick={() => setAdding(true)}>{t('staff.add')}</Button>
      </PageHeader>
      {(toggle.isError || reset.isError) && <div className="mb-4"><Notice>{errorMessage(t, toggle.error ?? reset.error)}</Notice></div>}
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <Notice>{errorMessage(t, q.error)}</Notice>
      ) : q.data!.items.length === 0 ? (
        <p className="py-6 text-muted">{t('staff.empty')}</p>
      ) : (
        <div className="space-y-3">
          {q.data!.items.map((m) => (
            <Card key={m.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold">{m.fullName}</h2>
                  <p className="text-sm text-muted">
                    {m.loginId} · {m.phone}
                  </p>
                </div>
                <Chip tone={m.isActive ? 'green' : 'gray'}>{m.isActive ? t('common.active') : t('common.inactive')}</Chip>
              </div>
              <ul className="my-3 flex flex-wrap gap-2">
                {m.permissions.length === 0 ? (
                  <li className="text-sm text-muted">{t('staff.noPermissions')}</li>
                ) : (
                  m.permissions.map((p) => (
                    <li key={p}>
                      <Chip tone="blue">{t(`permissions.${p}`, { defaultValue: p })}</Chip>
                    </li>
                  ))
                )}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setEditing(m)}>
                  {t('staff.editPermissions')}
                </Button>
                <Button variant="secondary" disabled={reset.isPending} onClick={() => reset.mutate(m)}>
                  {t('staff.resetPassword')}
                </Button>
                <Button variant={m.isActive ? 'danger' : 'primary'} disabled={toggle.isPending} onClick={() => toggle.mutate(m)}>
                  {m.isActive ? t('staff.deactivate') : t('staff.reactivate')}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {adding && <StaffFormModal onClose={() => setAdding(false)} onCreated={setTemp} />}
      {editing && <PermissionsModal member={editing} onClose={() => setEditing(null)} />}
      {temp && <TempPasswordModal loginId={temp.loginId} password={temp.tempPassword} onClose={() => setTemp(null)} />}
    </>
  );
}
