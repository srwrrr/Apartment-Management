import crypto from 'node:crypto';

// No look-alike characters (0/O, 1/l/I) because these are read aloud or copied by hand.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';

const pick = (chars: string) => chars[crypto.randomInt(chars.length)]!;

/** Temporary password handed over in person (no email/SMS in v1). Always has a letter and a digit (BR-02). */
export function generateTempPassword(length = 10): string {
  const all = LETTERS + DIGITS;
  const chars = [pick(LETTERS), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
