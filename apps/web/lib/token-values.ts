import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A token's value for one theme, read from `app/tokens.css` (server side only), for the few places that need
 * a literal colour and cannot use a CSS variable (the browser's `theme-color`). tokens.css stays the only
 * place colours are written.
 */
export function tokenValue(name: string, theme: 'dark' | 'light'): string {
  const css = readFileSync(join(process.cwd(), 'app/tokens.css'), 'utf8');
  const at = theme === 'dark' ? css.indexOf(':root') : css.indexOf("[data-theme='light']");
  const end = theme === 'dark' ? css.indexOf("[data-theme='light']") : css.length;
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css.slice(at, end));
  if (!m) throw new Error(`token --${name} has no literal value in the ${theme} theme`);
  return m[1]!;
}
