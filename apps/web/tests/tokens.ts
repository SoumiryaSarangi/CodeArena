import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../app/tokens.css', import.meta.url)), 'utf8');

export type Theme = 'dark' | 'light';

/** Parses `--name: value;` declarations of one theme block from tokens.css. */
/** Raw declarations of one block (light only holds overrides; it sits on the same <html> as the dark base). */
export function ownTokens(theme: Theme): Record<string, string> {
  const selector = theme === 'dark' ? ":root,\n[data-theme='dark']" : "[data-theme='light']";
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`theme block not found: ${theme}`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

/** Effective tokens: the light block overrides the dark base, as it does on <html>. */
export function themeTokens(theme: Theme): Record<string, string> {
  return theme === 'dark' ? ownTokens('dark') : { ...ownTokens('dark'), ...ownTokens('light') };
}

const resolve = (t: Record<string, string>, name: string): string => {
  const v = t[name];
  if (!v) throw new Error(`missing token --${name}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  return ref ? resolve(t, ref[1]!) : v;
};

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
};

/** WCAG 2.x contrast ratio between two tokens of one theme. */
export function contrast(theme: Theme, fg: string, bg: string): number {
  const t = themeTokens(theme);
  const [a, b] = [luminance(resolve(t, fg)), luminance(resolve(t, bg))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
