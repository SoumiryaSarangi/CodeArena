#!/usr/bin/env node
// Regenerates the two blocks of docs/UI_UX.md that mirror the code (UI-15):
//   §5.1  the token block, from apps/web/app/tokens.css
//   §5.2  the type table's sizes and line heights, from apps/web/app/globals.css (descriptions are kept)
// `node scripts/sync-ui-ux.mjs` rewrites the file; `--check` only reports drift (exit 1). The drift tests in
// apps/web/tests/design-system.test.ts compare the same things, so run this after any token or type change.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');
const check = process.argv.includes('--check');

const css = read('apps/web/app/tokens.css');
const lightAt = css.indexOf("[data-theme='light']");
const pairs = (block) =>
  [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .filter((m) => !/^(dur|ease)-/.test(m[1]))
    .map((m) => [
      m[1],
      /^#[0-9a-f]{6}$/i.test(m[2].trim()) ? m[2].trim().toUpperCase() : m[2].trim(),
    ]);
const wrap = (list) => {
  const lines = [];
  let line = [];
  for (const [k, v] of list) {
    line.push(`--${k}:${v};`);
    if (line.join(' ').length > 78) {
      lines.push(`  ${line.join(' ')}`);
      line = [];
    }
  }
  if (line.length) lines.push(`  ${line.join(' ')}`);
  return lines.join('\n');
};
const dark = pairs(css.slice(css.indexOf('{'), lightAt));
const light = pairs(css.slice(css.indexOf('{', lightAt)));
const fence = `\`\`\`css\n:root, [data-theme="dark"] {\n${wrap(dark)}\n}\n[data-theme="light"] {\n${wrap(light)}\n}\n\`\`\``;

const globals = read('apps/web/app/globals.css');
const sizes = [
  ...globals.matchAll(/--text-(\d+):\s*([\d.]+)rem;\s*--text-\d+--line-height:\s*([\d.]+)rem;/g),
].map((m) => [m[1], Math.round(Number(m[2]) * 16), Math.round(Number(m[3]) * 16)]);

let doc = read('docs/UI_UX.md');
const before = doc;
doc = doc.replace(/(### 5\.1[\s\S]*?)```css\n[\s\S]*?```/, (_, head) => `${head}${fence}`);

const rowRe = /^\| `--text-(\d+)` \| \d+ \/ \d+ \| (.*)$/gm;
const rest = new Map();
for (const m of doc.matchAll(rowRe)) rest.set(m[1], m[2]);
const rows = sizes.map(
  ([n, px, lh]) =>
    `| \`--text-${n}\` | ${px} / ${lh} | ${rest.get(n) ?? '400 | (describe the use) |'}`,
);
const first = doc.search(/^\| `--text-\d+` \| \d+ \/ \d+ \|/m);
const lastRow = [...doc.matchAll(/^\| `--text-\d+` \| \d+ \/ \d+ \|.*$/gm)].at(-1);
if (first >= 0 && lastRow) {
  doc = doc.slice(0, first) + rows.join('\n') + doc.slice(lastRow.index + lastRow[0].length);
}

if (doc === before) {
  console.log('docs/UI_UX.md already matches the code.');
} else if (check) {
  console.error('docs/UI_UX.md differs from tokens.css / globals.css: run `pnpm ui-ux:sync`.');
  process.exit(1);
} else {
  writeFileSync(`${root}docs/UI_UX.md`, doc);
  console.log('docs/UI_UX.md updated (§5.1 tokens, §5.2 type table).');
}
