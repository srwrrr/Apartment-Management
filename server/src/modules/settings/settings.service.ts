import { z } from 'zod';
import { settingsUpdateSchema } from '@apt/shared';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { todayDhaka } from '../../lib/dates';

export interface Settings {
  buildingName: string;
  goLiveDate: string; // YYYY-MM-DD
  defaultDueDay: number; // BR-10: 1 to 28, so it exists in every month
}

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const due = Number(m.get('defaultDueDay'));
  return {
    buildingName: m.get('buildingName') || 'My Building',
    goLiveDate: m.get('goLiveDate') || todayDhaka(),
    defaultDueDay: Number.isInteger(due) && due >= 1 && due <= 28 ? due : 10,
  };
}

/** Anyone logged in may know the building's name (it is shown in the page header). */
export async function getPublicSettings() {
  return { buildingName: (await getSettings()).buildingName };
}

export async function updateSettings(patch: z.infer<typeof settingsUpdateSchema>): Promise<Settings> {
  if (patch.goLiveDate !== undefined) {
    // Opening balances are dated from the go-live date; moving it afterwards would put them in the wrong month (BR-22).
    const current = await getSettings();
    if (patch.goLiveDate !== current.goLiveDate) {
      const locked = await prisma.bill.count({ where: { kind: 'OPENING_BALANCE' } });
      if (locked > 0) throw new ApiError(409, 'GO_LIVE_LOCKED');
    }
  }
  const entries: [string, string][] = [];
  if (patch.buildingName !== undefined) entries.push(['buildingName', patch.buildingName]);
  if (patch.goLiveDate !== undefined) entries.push(['goLiveDate', patch.goLiveDate]);
  if (patch.defaultDueDay !== undefined) entries.push(['defaultDueDay', String(patch.defaultDueDay)]);
  await prisma.$transaction(
    entries.map(([key, value]) => prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })),
  );
  return getSettings();
}
