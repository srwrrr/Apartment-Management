import type { TFunction } from 'i18next';
import { ApiError } from './api';

/** A sentence for an error, in the user's language. */
export function errorMessage(t: TFunction, error: unknown): string {
  const code = error instanceof ApiError ? error.code : 'INTERNAL';
  return t(`errors.${code}`, { defaultValue: t('errors.INTERNAL') });
}

/** A sentence for one form field's error code. Unknown validation codes fall back to a generic message. */
export function fieldMessage(t: TFunction, code: string): string {
  return t(`fieldErrors.${code}`, {
    defaultValue: code.startsWith('INVALID') ? t('fieldErrors.INVALID') : t('errors.VALIDATION_FAILED'),
  });
}

/** Field errors from a failed request, as { field: sentence }. */
export function fieldErrorsOf(t: TFunction, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(error.fields).map(([f, e]) => [f, fieldMessage(t, e.code)]));
}
