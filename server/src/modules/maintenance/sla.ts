import type { RequestPriority } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/** BR-17 / BR-18: how long things may take. The administrator can change these in the settings table. */
export interface Sla {
  highHours: number;
  mediumHours: number;
  lowHours: number;
  reviewDeadlineHours: number;
  autoCloseDays: number;
}

const DEFAULTS: Record<keyof Sla, [key: string, value: number]> = {
  highHours: ['slaHighHours', 24],
  mediumHours: ['slaMediumHours', 72],
  lowHours: ['slaLowHours', 168],
  reviewDeadlineHours: ['reviewDeadlineHours', 48],
  autoCloseDays: ['autoCloseDays', 7],
};

export async function getSla(): Promise<Sla> {
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.values(DEFAULTS).map(([k]) => k) } } });
  const stored = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const pick = (name: keyof Sla) => {
    const [key, fallback] = DEFAULTS[name];
    const v = stored.get(key);
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    highHours: pick('highHours'),
    mediumHours: pick('mediumHours'),
    lowHours: pick('lowHours'),
    reviewDeadlineHours: pick('reviewDeadlineHours'),
    autoCloseDays: pick('autoCloseDays'),
  };
}

export const slaHours = (sla: Sla, priority: RequestPriority): number =>
  priority === 'HIGH' ? sla.highHours : priority === 'MEDIUM' ? sla.mediumHours : sla.lowHours;
