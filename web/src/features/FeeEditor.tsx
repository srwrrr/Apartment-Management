import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RECURRING_CHARGE_TYPES, parseTaka } from '@apt/shared';
import { Button, Field, Notice, TextInput } from '../components/ui';
import { takaString } from '../lib/format';
import type { FeeItem } from '../lib/types';

/**
 * One row per fee type: an amount in taka and an optional description. An empty amount means "not set"
 * (the building-wide fee applies, for a unit). Used for the building defaults and for a single unit (FR-32).
 */
export function FeeEditor({
  initial,
  saving,
  saved,
  error,
  onSave,
}: {
  initial: FeeItem[];
  saving: boolean;
  saved: boolean;
  error?: unknown;
  onSave: (fees: FeeItem[]) => void;
}) {
  const { t } = useTranslation();
  const start = (type: string) => initial.find((f) => f.chargeType === type);
  const [rows, setRows] = useState(() =>
    Object.fromEntries(RECURRING_CHARGE_TYPES.map((ty) => [ty, { amount: start(ty) ? takaString(start(ty)!.amount) : '', description: start(ty)?.description ?? '' }])),
  );
  const [bad, setBad] = useState<string[]>([]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const invalid: string[] = [];
    const fees: FeeItem[] = [];
    for (const ty of RECURRING_CHARGE_TYPES) {
      const r = rows[ty]!;
      if (r.amount.trim() === '') continue;
      const poisha = parseTaka(r.amount);
      if (poisha === null || poisha <= 0) invalid.push(ty);
      else fees.push({ chargeType: ty, amount: poisha, description: r.description.trim() || t(`chargeTypes.${ty}`) });
    }
    setBad(invalid);
    if (invalid.length === 0) onSave(fees);
  }

  return (
    <form className="space-y-4" noValidate onSubmit={submit}>
      {saved && <Notice tone="info">{t('fees.saved')}</Notice>}
      {error != null && <Notice>{t('errors.VALIDATION_FAILED')}</Notice>}
      {RECURRING_CHARGE_TYPES.map((ty) => (
        <div key={ty} className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr] sm:items-end">
          <p className="font-semibold sm:pb-3">{t(`chargeTypes.${ty}`)}</p>
          <Field label={t('fees.amount')} error={bad.includes(ty) ? t('fieldErrors.INVALID') : undefined}>
            {(p) => (
              <TextInput
                {...p}
                inputMode="decimal"
                placeholder={t('fees.empty')}
                value={rows[ty]!.amount}
                onChange={(e) => setRows((r) => ({ ...r, [ty]: { ...r[ty]!, amount: e.target.value } }))}
                data-testid={`fee-${ty}`}
              />
            )}
          </Field>
          <Field label={t('fees.description')} optional>
            {(p) => (
              <TextInput {...p} maxLength={200} value={rows[ty]!.description} onChange={(e) => setRows((r) => ({ ...r, [ty]: { ...r[ty]!, description: e.target.value } }))} />
            )}
          </Field>
        </div>
      ))}
      <Button type="submit" disabled={saving}>
        {t('common.save')}
      </Button>
    </form>
  );
}
