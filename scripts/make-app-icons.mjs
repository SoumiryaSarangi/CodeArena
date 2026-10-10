// Draws the home-screen icons from the "ca" monogram of apps/web/app/icon.svg and writes the PNGs:
//   apps/web/app/apple-icon.png           180 px, full-bleed square (iOS rounds the corners itself)
//   apps/web/public/icons/icon-192.png    192 px, rounded tile            (manifest, purpose "any")
//   apps/web/public/icons/icon-512.png    512 px, rounded tile            (manifest, purpose "any")
//   apps/web/public/icons/icon-maskable-512.png  512 px, full-bleed, the letters inside the 80 % safe circle
// Colours are the dark theme's --surface-1, --text and --accent read from tokens.css (the one place colours live).
// Run: node scripts/make-app-icons.mjs   (needs the repo's Playwright Chromium)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'apps/web/app/tokens.css'), 'utf8');
const dark = css.slice(css.indexOf(':root'), css.indexOf("[data-theme='light']"));
const token = (n) => new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`).exec(dark)[1];
const bg = token('surface-1'),
  ink = token('text'),
  acc = token('accent');

// The monogram on the 32 grid (same geometry as the favicon), scaled about the centre.
const mark = (
  scale,
) => `<g transform="translate(16 16) scale(${scale}) translate(-16 -16)" fill="none" stroke-width="3.6" stroke-linecap="round">
<path stroke="${ink}" d="M12.36 12.04A5.6 5.6 0 1 0 12.36 19.96"/><circle stroke="${ink}" cx="23.2" cy="16" r="5.6"/>
<path stroke="${acc}" d="M28.8 10.6v10.8"/></g>`;
const svg = (size, { rounded, scale }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
<rect width="32" height="32" ${rounded ? 'rx="7"' : ''} fill="${bg}"/>${mark(scale)}</svg>`;

const jobs = [
  ['apps/web/app/apple-icon.png', 180, { rounded: false, scale: 0.69 }],
  ['apps/web/public/icons/icon-192.png', 192, { rounded: true, scale: 0.78 }],
  ['apps/web/public/icons/icon-512.png', 512, { rounded: true, scale: 0.78 }],
  ['apps/web/public/icons/icon-maskable-512.png', 512, { rounded: false, scale: 0.69 }],
];
const browser = await chromium.launch();
for (const [file, size, opts] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(size, opts)}</body>`);
  const png = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  writeFileSync(join(root, file), png);
  await page.close();
  console.log('wrote', file, size);
}
await browser.close();
