import { useTranslation } from 'react-i18next';
import { Chip } from './ui';
import type { BillStatus } from '../lib/types';

const tone = { PAID: 'green', PARTIALLY_PAID: 'blue', UNPAID: 'gray', OVERDUE: 'red' } as const;

/** Always text first; the colour only reinforces it (UI-06). */
export function BillStatusChip({ status }: { status: BillStatus }) {
  const { t } = useTranslation();
  return <Chip tone={tone[status]}>{t(`billStatus.${status}`)}</Chip>;
}
