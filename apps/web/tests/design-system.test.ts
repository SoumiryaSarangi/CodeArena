import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrast, contrastOnTint, ownTokens, themeTokens, type Theme } from './tokens';

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

  it('F-07: light overrides every literal dark token (only values derived with var() may be inherited)', () => {
    const light = ownTokens('light');
    const missing = Object.entries(ownTokens('dark'))
      // derived values (var(...) inside) follow each theme by themselves; shadow and the blur radius are not colours
      .filter(([k, v]) => !v.includes('var(') && !/^(shadow|glass-blur)/.test(k) && !(k in light))
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

    it(`NFR-A11Y: ${theme} secondary text and verdict colours reach 4.5:1 on every raised surface`, () => {
      for (const fg of [
        'text',
        'text-2',
        'text-3',
        ...['ac', 'wa', 'tle', 'mle', 're', 'ce', 'ole'].map((v) => `v-${v}`),
      ])
        for (const bg of ['surface-2', 'surface-3'])
          expect(contrast(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('UI-11: editor theme', () => {
  it('UI-11: Monaco bracket colours come from the palette, not its gold/orchid/blue defaults (AUDIT 17)', async () => {
    const { defineThemes } = await import('@/lib/monaco-theme');
    const themes: Record<string, { colors: Record<string, string> }> = {};
    defineThemes({
      editor: {
        defineTheme: (n: string, t: { colors: Record<string, string> }) => (themes[n] = t),
      },
    } as never);
    for (const name of ['ca-dark', 'ca-light']) {
      const c = themes[name]!.colors;
      for (let i = 1; i <= 6; i++)
        expect(c[`editorBracketHighlight.foreground${i}`], `${name} bracket ${i}`).toBe(
          c['editor.foreground'],
        );
    }
  });
});

describe('UI-13: no gradients on screen, and a usable scrubber', () => {
  const globals = readFileSync(join(root, 'app/globals.css'), 'utf8');
  it('UI-13: the diff editor hatch pattern is switched off (AUDIT 16)', () => {
    expect(
      /\.monaco-diff-editor \.diagonal-fill\s*{[^}]*background-image:\s*none/.test(globals),
    ).toBe(true);
  });
  it('UI-13: the replay scrubber has a 44 px tall hit area (AUDIT 18)', () => {
    expect(/\.scrubber\s*{[^}]*height:\s*2\.75rem/.test(globals)).toBe(true);
  });
});

describe('UI-14: UI_UX.md and the code agree', () => {
  const doc = readFileSync(join(root, '../../docs/UI_UX.md'), 'utf8');
  const globals = readFileSync(join(root, 'app/globals.css'), 'utf8');

  /** `--name:value;` pairs of one theme block of the §5.1 code fence. */
  const docTokens = (theme: 'dark' | 'light') => {
    const fence = /### 5\.1[\s\S]*?```css\n([\s\S]*?)```/.exec(doc)![1]!;
    const at = fence.indexOf(theme === 'dark' ? '[data-theme="dark"] {' : '[data-theme="light"] {');
    const end = theme === 'dark' ? fence.indexOf('[data-theme="light"]') : fence.length;
    const body = fence.slice(fence.indexOf('{', at) + 1, end);
    return Object.fromEntries(
      [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().toLowerCase()]),
    );
  };
  const codeTokens = (theme: Theme) =>
    Object.fromEntries(
      Object.entries(ownTokens(theme))
        .filter(([k]) => !/^(dur|ease)-/.test(k))
        .map(([k, v]) => [k, v.toLowerCase()]),
    );

  for (const theme of THEMES)
    it(`UI-14: §5.1 lists exactly the ${theme} tokens of tokens.css, with the same values`, () => {
      expect(docTokens(theme)).toEqual(codeTokens(theme));
    });

  it('UI-14: §5.2 lists every type token of globals.css with its size and line height in px', () => {
    const rows = [...doc.matchAll(/\| `--text-(\d+)` \| (\d+) \/ (\d+) \|/g)].map((m) => [
      m[1]!,
      Number(m[2]),
      Number(m[3]),
    ]);
    const code = [
      ...globals.matchAll(
        /--text-(\d+):\s*([\d.]+)rem;\s*--text-\d+--line-height:\s*([\d.]+)rem;/g,
      ),
    ].map((m) => [m[1]!, Math.round(Number(m[2]) * 16), Math.round(Number(m[3]) * 16)]);
    expect(rows).toEqual(code);
  });

  it('UI-14: §5.3 states the radii of globals.css', () => {
    for (const [name, px] of [
      ['sm', 4],
      ['md', 6],
      ['lg', 8],
    ] as const) {
      expect(globals).toContain(`--radius-${name}: ${px}px`);
      expect(doc).toContain(`--radius-${name} ${px}px`);
    }
  });
});

describe('UI-15: round 2 tokens, wordmark and motion', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const TIERS = ['newcomer', 'pupil', 'specialist', 'expert', 'master'];

  for (const theme of THEMES) {
    it(`UI-15: ${theme} wordmark colours reach 4.5:1 on the top bar (surface-1)`, () => {
      for (const t of ['wordmark-code', 'wordmark-arena', 'wordmark-dot'])
        expect(contrast(theme, t, 'surface-1'), t).toBeGreaterThanOrEqual(4.5);
    });
    it(`UI-15: ${theme} tier and difficulty colours reach 4.5:1 on every surface`, () => {
      for (const t of [...TIERS.map((n) => `tier-${n}`), 'diff-easy', 'diff-medium', 'diff-hard'])
        for (const bg of ['bg', 'surface-1', 'surface-2', 'surface-3'])
          expect(contrast(theme, t, bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('UI-15: dark verdict badges (text on its own 14% tint) reach 4.5:1 on every surface, the pending one included', () => {
    for (const v of ['pending', 'ac', 'wa', 'tle', 'mle', 're', 'ce', 'ole'])
      for (const bg of ['surface-1', 'surface-2', 'surface-3'])
        expect(
          contrastOnTint('dark', `v-${v}`, bg, 0.14),
          `v-${v} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
  });

  it('UI-15: the wordmark font is loaded only by the top bar, is tiny, and the name keeps its spelling and accessible name', () => {
    const users = sources(root)
      .filter((f) => /\.(tsx?)$/.test(f) && readFileSync(f, 'utf8').includes('wordmark.woff2'))
      .map((f) => relative(root, f));
    expect(users).toEqual(['components/shell/top-bar.tsx']);
    expect(statSync(join(root, 'app/fonts/wordmark.woff2')).size).toBeLessThan(5 * 1024);
    const bar = read('components/shell/top-bar.tsx');
    expect(bar).toContain('aria-label="codearena"');
    expect(bar).toMatch(/>\s*code\s*</);
    expect(bar).toMatch(/>\s*arena\s*</);
  });

  it('UI-15: the button transition names real CSS properties and presses with `scale`', () => {
    const button = read('components/ui/button.tsx');
    expect(button).not.toContain('transition-[colors');
    expect(button).toContain('transition-[color,background-color,border-color,scale]');
    expect(button).toContain('active:scale-[0.97]');
  });

  it('UI-15: frosted chrome falls back to opaque without backdrop-filter or with reduced transparency', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/@supports \(backdrop-filter: blur\(1px\)\)\s*{\s*\.glass/);
    expect(css).toMatch(
      /prefers-reduced-transparency: reduce\)\s*{\s*\.glass[^}]*backdrop-filter: none/,
    );
    // never on the editor, board or tables
    for (const f of [
      'components/code-editor.tsx',
      'components/contests/scoreboard.tsx',
      'components/data-table.tsx',
    ])
      expect(read(f), f).not.toMatch(/\bglass\b|backdrop-/);
  });

  it('UI-15: reduced motion keeps a short fade for overlays instead of removing all feedback', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*{\s*\.animate-pop-in[\s\S]*animation-duration: 100ms/,
    );
  });

  it('UI-15: the viewport colours the browser bar from the tokens, and no hex literal is in the layout', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain("tokenValue('surface-1', 'dark')");
    expect(layout).toContain("tokenValue('surface-1', 'light')");
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('UI-20: favicon', () => {
  it('UI-20: app/icon.svg exists and uses the accent and surface tokens of both themes', () => {
    const svg = readFileSync(join(root, 'app/icon.svg'), 'utf8').toLowerCase();
    for (const theme of THEMES) {
      const t = themeTokens(theme);
      for (const name of ['surface-1', 'accent']) expect(svg).toContain(t[name]!.toLowerCase());
    }
  });
});
