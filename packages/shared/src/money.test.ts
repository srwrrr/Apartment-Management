import { describe, expect, it } from 'vitest';
import { formatBDT, parseTaka } from './money';

describe('BR-15 money format', () => {
  it('formats with 2 decimals', () => {
    expect(formatBDT(1250000)).toBe('৳ 12,500.00');
    expect(formatBDT(5)).toBe('৳ 0.05');
    expect(formatBDT(0)).toBe('৳ 0.00');
  });
  it('uses lakh grouping', () => {
    expect(formatBDT(12500000)).toBe('৳ 1,25,000.00');
    expect(formatBDT(1000000000)).toBe('৳ 1,00,00,000.00');
  });
  it('handles negatives', () => {
    expect(formatBDT(-250000)).toBe('-৳ 2,500.00');
  });
  it('rejects non-integers', () => {
    expect(() => formatBDT(10.5)).toThrow();
  });
});

describe('parseTaka', () => {
  it('parses valid amounts to poisha', () => {
    expect(parseTaka('12,500')).toBe(1250000);
    expect(parseTaka('৳ 12,500.5')).toBe(1250050);
    expect(parseTaka('0.07')).toBe(7);
  });
  it('rejects invalid amounts', () => {
    expect(parseTaka('abc')).toBeNull();
    expect(parseTaka('1.234')).toBeNull();
    expect(parseTaka('-5')).toBeNull();
    expect(parseTaka('')).toBeNull();
  });
});
