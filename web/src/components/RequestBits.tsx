import { useTranslation } from 'react-i18next';
import { Chip } from './ui';
import type { RequestPriority, RequestStatus } from '../lib/types';

const statusTone = { SUBMITTED: 'gray', UNDER_REVIEW: 'blue', IN_PROGRESS: 'amber', RESOLVED: 'green', CLOSED: 'gray', REJECTED: 'red', CANCELLED: 'gray' } as const;
const priorityTone = { LOW: 'gray', MEDIUM: 'amber', HIGH: 'red' } as const;

/** Status is always shown as text; colour only reinforces it (UI-06). */
export function RequestStatusChip({ status }: { status: RequestStatus }) {
  const { t } = useTranslation();
  return <Chip tone={statusTone[status]}>{t(`requestStatus.${status}`)}</Chip>;
}

export function PriorityChip({ priority }: { priority: RequestPriority | null }) {
  const { t } = useTranslation();
  return priority ? <Chip tone={priorityTone[priority]}>{t(`requestPriority.${priority}`)}</Chip> : null;
}

export function OverdueChip() {
  const { t } = useTranslation();
  return <Chip tone="red">{t('maintenance.overdue')}</Chip>;
}
