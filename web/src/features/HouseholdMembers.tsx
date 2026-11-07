import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Chip, Field, Modal, Notice, TempPasswordModal, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { errorMessage, fieldErrorsOf } from '../lib/errors';
import type { Occupancy } from '../lib/types';

function AddMember({ occupancyId, unitId, onClose, onAdded }: { occupancyId: string; unitId: string; onClose: () => void; onAdded: (loginId: string, password: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', relation: '', loginId: '', phone: '' });
  const add = useMutation({
    mutationFn: () => api.post<{ member: { user: { loginId: string } }; tempPassword: string }>(`/api/occupancies/${occupancyId}/members`, form),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['occupancies', unitId] });
      onAdded(r.member.user.loginId, r.tempPassword);
    },
  });
  const fe = fieldErrorsOf(t, add.error);
  const text = (key: keyof typeof form) => ({ value: form[key], onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }) });
  return (
    <Modal title={t('household.add')} onClose={onClose}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <p className="text-muted">{t('household.help')}</p>
        <Field label={t('household.name')} error={fe.fullName}>{(p) => <TextInput {...p} {...text('fullName')} />}</Field>
        <Field label={t('household.relation')} help={t('household.relationHelp')} error={fe.relation}>{(p) => <TextInput {...p} {...text('relation')} />}</Field>
        <Field label={t('household.loginId')} error={fe.loginId}>{(p) => <TextInput {...p} autoCapitalize="none" {...text('loginId')} />}</Field>
        <Field label={t('household.phone')} error={fe.phone}>{(p) => <TextInput {...p} inputMode="tel" {...text('phone')} />}</Field>
        {add.isError && !Object.keys(fe).length && <Notice>{errorMessage(t, add.error)}</Notice>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={add.isPending}>{t('common.add')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** FR-54: the family members on one stay. */
export function HouseholdMembers({ stay, unitId }: { stay: Occupancy; unitId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ loginId: string; password: string } | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/household-members/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['occupancies', unitId] }),
  });
  const members = stay.household ?? [];
  const active = !stay.endDate;
  if (!active && members.length === 0) return null;
  return (
    <div className="w-full border-s-2 border-line ps-3" data-testid="household">
      <h3 className="font-semibold">{t('household.title')}</h3>
      {members.length === 0 ? (
        <p className="text-sm text-muted">{t('household.none')}</p>
      ) : (
        <ul>
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 py-1" data-testid="household-member">
              <span className="font-semibold">{m.user.fullName}</span>
              <span className="text-sm text-muted">{m.relation}</span>
              {m.removedAt ? (
                <Chip>{t('household.removed')}</Chip>
              ) : (
                <Button
                  variant="ghost"
                  disabled={remove.isPending}
                  aria-label={`${t('household.remove')}: ${m.user.fullName}`}
                  onClick={() => {
                    if (window.confirm(t('household.confirmRemove', { name: m.user.fullName }))) remove.mutate(m.id);
                  }}
                >
                  {t('household.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.isError && <Notice>{errorMessage(t, remove.error)}</Notice>}
      {active && (
        <Button variant="secondary" className="mt-1" onClick={() => setAdding(true)}>
          {t('household.add')}
        </Button>
      )}
      {adding && (
        <AddMember
          occupancyId={stay.id}
          unitId={unitId}
          onClose={() => setAdding(false)}
          onAdded={(loginId, password) => {
            setAdding(false);
            setCreated({ loginId, password });
          }}
        />
      )}
      {created && <TempPasswordModal loginId={created.loginId} password={created.password} onClose={() => setCreated(null)} />}
    </div>
  );
}
