import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../app/manifest';
import { themeTokens } from './tokens';

const root = new URL('..', import.meta.url).pathname;
/** Width and height from a PNG's IHDR chunk. */
const size = (file: string) => {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('UI-25: home-screen icons and the web app manifest', () => {
  it('UI-25: the manifest names the app, uses the dark surface token and lists real icons of the sizes it says', () => {
    const m = manifest();
    expect(m.name).toBe('CodeArena');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    const surface = themeTokens('dark')['surface-1']!;
    expect(m.background_color?.toLowerCase()).toBe(surface.toLowerCase());
    expect(m.theme_color?.toLowerCase()).toBe(surface.toLowerCase());
    for (const icon of m.icons ?? []) {
      const file = join(root, 'public', icon.src!);
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = icon.sizes!.split('x').map(Number);
      expect(size(file)).toEqual([w, h]);
    }
  });

  it('UI-25: there is a maskable icon and a plain one at 192 and 512 px', () => {
    const icons = manifest().icons ?? [];
    expect(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const s of ['192x192', '512x512'])
      expect(icons.some((i) => i.purpose === 'any' && i.sizes === s)).toBe(true);
  });

  it('UI-25: the Apple touch icon is 180 px (Next links app/apple-icon.png by itself)', () => {
    expect(size(join(root, 'app/apple-icon.png'))).toEqual([180, 180]);
  });
});
