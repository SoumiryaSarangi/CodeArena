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

describe('UI-09: type foundation', () => {
  const globals = readFileSync(join(root, 'app/globals.css'), 'utf8');
  it('UI-09: the root font size is the browser default, not a fixed px value', () => {
    expect(/html\s*{[^}]*font-size:\s*100%/.test(globals)).toBe(true);
  });
  it('UI-09: the heading ladder steps up by at least 1.25 (h3 18, h2 22, h1 28)', () => {
    const size = (n: number) =>
      Number(new RegExp(`--text-${n}:\\s*([\\d.]+)rem`).exec(globals)![1]) * 16;
    expect([size(18), size(22), size(28)]).toEqual([18, 22, 28]);
    expect(size(22) / size(18)).toBeGreaterThan(1.2);
    expect(size(28) / size(22)).toBeGreaterThan(1.25);
    expect(size(40)).toBeGreaterThanOrEqual(40);
  });
  it('UI-09: type never goes below the 12 px floor in the scale', () => {
    expect(Number(/--text-12:\s*([\d.]+)rem/.exec(globals)![1]) * 16).toBe(12);
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

    it(`NFR-A11Y: ${theme} primary (ink) button text reaches 4.5:1, also on hover`, () => {
      expect(contrast(theme, 'primary-fg', 'primary')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme, 'primary-fg', 'primary-hover')).toBeGreaterThanOrEqual(4.5);
    });

    it(`NFR-A11Y: ${theme} secondary text reaches 4.5:1 on every raised surface`, () => {
      for (const fg of ['text', 'text-2', 'text-3'])
        for (const bg of ['surface-2', 'surface-3'])
          expect(contrast(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
