import type { TFunction } from 'i18next';
import { formatBDT } from '@apt/shared';
import { ApiError } from './api';

/** A sentence for an error, in the user's language. */
export function errorMessage(t: TFunction, error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'INTERNAL';
  return t(`errors.${code}`, { defaultValue: t('errors.INTERNAL') });
}

// Amounts travel as whole poisha; sentences show them as taka.
const MONEY_PARAMS = ['balance', 'amount', 'total'];
function readable(params: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ...params };
  for (const k of MONEY_PARAMS) if (typeof out[k] === 'number') out[k] = formatBDT(out[k]);
  return out;
}

/** A sentence for one form field's error code. Unknown validation codes fall back to a generic message. */
export function fieldMessage(t: TFunction, code: string, params?: Record<string, unknown>): string {
  return t(`fieldErrors.${code}`, {
    ...readable(params),
    defaultValue: code.startsWith('INVALID') ? t('fieldErrors.INVALID') : t('errors.VALIDATION_FAILED'),
  });
}

/** Field errors from a failed request, as { field: sentence }. */
export function fieldErrorsOf(t: TFunction, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(error.fields).map(([f, e]) => [f, fieldMessage(t, e.code, e.params)]));
}
