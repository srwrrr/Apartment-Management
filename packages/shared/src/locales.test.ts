import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './permissions';
import { ACTIVITY_ACTIONS } from './validation';
import en from './locales/en.json';
import bn from './locales/bn.json';

function keys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

// Placeholders like {{name}} must be identical in both languages or the sentence breaks.
function leaves(obj: unknown, prefix = ''): [string, string][] {
  if (typeof obj === 'string') return [[prefix, obj]];
  if (typeof obj !== 'object' || obj === null) return [];
  return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('FR-47 translations', () => {
  it('every activity log action has a sentence', () => {
    const leaf = (o: unknown, path: string[]) => path.reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);
    for (const a of ACTIVITY_ACTIONS) {
      expect(typeof leaf(en, ['activity', 'actions', ...a.split('.')]), a).toBe('string');
    }
  });

  it('Bangla has exactly the same keys as English', () => {
    const e = new Set(keys(en));
    const b = new Set(keys(bn));
    expect([...e].filter((k) => !b.has(k))).toEqual([]);
    expect([...b].filter((k) => !e.has(k))).toEqual([]);
  });

  it('no translation is empty', () => {
    for (const [k, v] of [...leaves(en), ...leaves(bn)]) expect(v.trim(), k).not.toBe('');
  });

  it('placeholders match between languages', () => {
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
    const bnMap = new Map(leaves(bn));
    for (const [k, v] of leaves(en)) expect(ph(bnMap.get(k) ?? ''), k).toBe(ph(v));
  });

  it('every staff permission has a label in both languages', () => {
    for (const p of PERMISSIONS) {
      expect((en.permissions as Record<string, string>)[p], p).toBeTruthy();
      expect((bn.permissions as Record<string, string>)[p], p).toBeTruthy();
    }
  });
});
