import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrast, ownTokens, themeTokens, type Theme } from './tokens';

const root = fileURLToPath(new URL('..', import.meta.url));

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    // `public` holds vendored assets (Monaco, copied at install), not our code.
    if (['node_modules', '.next', 'tests', 'public'].includes(f)) return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });

const THEMES: Theme[] = ['dark', 'light'];

describe('F-07: design tokens', () => {
  it('F-07: no hard-coded colours, gradients or default Tailwind palette classes outside tokens.css', () => {
    const banned = [
      /#[0-9a-fA-F]{3,8}\b/, // hex
      /\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/, // colour functions
      /gradient\(/, // no gradients
      /\b(bg|text|border|ring|fill|stroke|from|via|to)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/,
    ];
    const offenders: string[] = [];
    for (const file of sources(root)) {
      if (file.endsWith('tokens.css')) continue;
      // Monaco takes literal colours and cannot read CSS variables; UI_UX §14 lists these values.
      if (file.endsWith('monaco-theme.ts')) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // A leading comment line may quote a value; real usages are what we police.
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        for (const re of banned)
          if (re.test(line)) offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('F-07: light overrides every literal dark token (only var() aliases may be inherited)', () => {
    const light = ownTokens('light');
    const missing = Object.entries(ownTokens('dark'))
      .filter(([k, v]) => !v.startsWith('var(') && !k.startsWith('shadow') && !(k in light))
      .map(([k]) => k);
    expect(missing).toEqual([]);
    expect(Object.keys(light).filter((k) => !(k in ownTokens('dark')))).toEqual([]);
  });

  it('F-07: every token mapped into Tailwind exists in tokens.css', () => {
    const globals = readFileSync(join(root, 'app/globals.css'), 'utf8');
    const defined = new Set(Object.keys(themeTokens('dark')));
    const used = [...globals.matchAll(/--color-[\w-]+:\s*var\(--([\w-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((u) => !defined.has(u))).toEqual([]);
  });
});

describe('NFR-A11Y: contrast (WCAG 1.4.3 / 1.4.11)', () => {
  const surfaces = ['bg', 'surface-1'];
  for (const theme of THEMES) {
    it(`NFR-A11Y: ${theme} text tokens reach 4.5:1 on bg and surface-1`, () => {
      for (const fg of [
        'text',
        'text-2',
        'text-3',
        'accent',
        'danger',
        'warning',
        'success',
        'info',
      ])
        for (const bg of surfaces)
          expect(contrast(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`NFR-A11Y: ${theme} verdict colours reach 4.5:1 on bg and surface-1`, () => {
      for (const v of ['ac', 'wa', 'tle', 'mle', 're', 'ce', 'ole', 'se'])
        for (const bg of surfaces)
          expect(contrast(theme, `v-${v}`, bg), `v-${v} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`NFR-A11Y: ${theme} control borders and focus ring reach 3:1`, () => {
      expect(contrast(theme, 'border-control', 'bg')).toBeGreaterThanOrEqual(3);
      expect(contrast(theme, 'focus', 'bg')).toBeGreaterThanOrEqual(3);
    });

    it(`NFR-A11Y: ${theme} accent button text reaches 4.5:1`, () => {
      expect(contrast(theme, 'accent-fg', 'accent')).toBeGreaterThanOrEqual(4.5);
    });
  }
});
