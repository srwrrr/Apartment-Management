import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function woff2(pkg: string, file: string): string {
  const path = require.resolve(`${pkg}/files/${file}`);
  return fs.readFileSync(path).toString('base64');
}

let css: string | null = null;

/**
 * `@font-face` rules with the fonts embedded as data: URIs, so PDFs render identically everywhere
 * and the page never needs network access. Noto Sans Bengali shapes conjunct letters correctly (NFR-28).
 */
export function fontCss(): string {
  if (css) return css;
  const face = (family: string, weight: number, data: string, range?: string) =>
    `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data}) format('woff2');${range ? `unicode-range:${range};` : ''}}`;
  css = [
    face('Noto Sans', 400, woff2('@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff2')),
    face('Noto Sans', 700, woff2('@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff2')),
    face('Noto Sans Bengali', 400, woff2('@fontsource/noto-sans-bengali', 'noto-sans-bengali-bengali-400-normal.woff2')),
    face('Noto Sans Bengali', 700, woff2('@fontsource/noto-sans-bengali', 'noto-sans-bengali-bengali-700-normal.woff2')),
  ].join('\n');
  return css;
}
