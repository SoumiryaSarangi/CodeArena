// Builds the candidate marks (SVG files) and the comparison sheet (sheet.html -> sheet.png).
// Run: node docs/design/logo/build.mjs   (needs the repo's Playwright Chromium for the picture)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Theme colours: the values of --text, --accent and --surface-1 in apps/web/app/tokens.css.
const T = {
  dark: { ink: '#ececee', acc: '#6d8bff', bg: '#111316', line: '#2a2e35', dim: '#a4a9b2' },
  light: { ink: '#14161a', acc: '#2f49d9', bg: '#ffffff', line: '#dfe2e7', dim: '#566070' },
};

// Every mark is drawn on a 32 x 32 grid. Classes: fi/si = ink fill/stroke, fa/sa = accent fill/stroke.
const MARKS = [
  {
    id: 'lanes',
    name: 'Lanes',
    idea: 'An arena track seen from above: the outer lane is the contest lane, the inner one practice. One lane is open, and the accent dot is a submission leaving it for the judge.',
    svg: `<rect class="si" x="3.2" y="7.2" width="25.6" height="17.6" rx="8.8" fill="none" stroke-width="2.4" pathLength="100" stroke-dasharray="88 12" stroke-dashoffset="63" stroke-linecap="round"/>
<rect class="si" x="8.4" y="11.6" width="15.2" height="8.8" rx="4.4" fill="none" stroke-width="2.4"/>
<circle class="fa" cx="28.8" cy="16" r="2.6"/>`,
  },
  {
    id: 'ring',
    name: 'Ring',
    idea: 'The submission wire bent into an arena ring: five segments (queued, claimed, compiling, running, verdict), the last one in the accent. The product\'s own signature, and a circle for the arena.',
    svg: `<path class="si" fill="none" stroke-width="3.2" stroke-linecap="round" d="M10.25 6.04A11.5 11.5 0 0 1 21.75 6.04"/>
<path class="si" fill="none" stroke-width="3.2" stroke-linecap="round" d="M23.70 7.45A11.5 11.5 0 0 1 27.25 18.39"/>
<path class="si" fill="none" stroke-width="3.2" stroke-linecap="round" d="M26.51 20.68A11.5 11.5 0 0 1 17.20 27.44"/>
<path class="si" fill="none" stroke-width="3.2" stroke-linecap="round" d="M14.80 27.44A11.5 11.5 0 0 1 5.49 20.68"/>
<path class="sa" fill="none" stroke-width="3.2" stroke-linecap="round" d="M4.75 18.39A11.5 11.5 0 0 1 8.30 7.45"/>`,
  },
  {
    id: 'arch',
    name: 'Arch',
    idea: 'An A drawn as an arena archway with a starting line across it, and the accent dot waiting under the arch. One continuous stroke.',
    svg: `<path class="si" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M6.5 28V16a9.5 9.5 0 0 1 19 0v12"/>
<path class="sa" fill="none" stroke-width="3" stroke-linecap="round" d="M11.5 21.5h9"/>
<circle class="fa" cx="16" cy="14.2" r="2.2"/>`,
  },
  {
    id: 'box',
    name: 'Box',
    idea: 'The sandbox as an isometric box (the drawing style of the Hairline library this project already uses). The top face is the accent, a submission inside it.',
    svg: `<path class="si" fill="none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" d="M16 5.5 25.5 11v11L16 28.5 6.5 22V11Z M6.5 11 16 16.5 25.5 11 M16 16.5v12"/>
<path class="sa" fill="none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" d="M16 5.5 25.5 11 16 16.5 6.5 11Z"/>
<circle class="fa" cx="16" cy="11" r="1.9"/>`,
  },
  {
    id: 'monogram',
    name: 'ca',
    idea: 'A one-stroke monogram: an open c beside an a whose stem is the accent, the same caret bar that ends the current wordmark.',
    svg: `<path class="si" fill="none" stroke-width="2.8" stroke-linecap="round" d="M12.36 12.04A5.6 5.6 0 1 0 12.36 19.96"/>
<circle class="si" cx="23.2" cy="16" r="5.6" fill="none" stroke-width="2.8"/>
<path class="sa" fill="none" stroke-width="2.8" stroke-linecap="round" d="M28.8 10.6v10.8"/>`,
  },
];

const style = (t) => `.fi{fill:${t.ink}}.fa{fill:${t.acc}}.si{stroke:${t.ink}}.sa{stroke:${t.acc}}`;
const file = (m) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<style>.fi{fill:${T.light.ink}}.fa{fill:${T.light.acc}}.si{stroke:${T.light.ink}}.sa{stroke:${T.light.acc}}@media (prefers-color-scheme:dark){${style(T.dark)}}</style>
${m.svg}
</svg>
`;
mkdirSync(join(here, 'candidates'), { recursive: true });
for (const m of MARKS) writeFileSync(join(here, 'candidates', `${m.id}.svg`), file(m));

const inline = (m, px) => `<svg viewBox="0 0 32 32" width="${px}" height="${px}" aria-hidden="true">${m.svg}</svg>`;

// The wordmark: Space Grotesk Bold cut to the nine letters (same file the site uses), "code" in the accent.
const word = (extra = '') =>
  `<span class="word"><span class="acc">code</span><span class="ink">arena</span>${extra}</span>`;
// A text-only twist: the o of "code" becomes an arena seen from above with a contestant in it.
const twist = `<span class="word"><span class="acc">c</span><svg class="o" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke-width="3.1" class="sa"/><circle cx="10" cy="10" r="2.1" class="fi"/></svg><span class="acc">de</span><span class="ink">arena</span></span>`;
const current = word('<span class="caret"></span>');

const nav = (themeName, markHtml, wordHtml) => {
  const t = T[themeName];
  return `<div class="nav t-${themeName}" style="--bg:${t.bg};--line:${t.line};--ink:${t.ink};--acc:${t.acc};--dim:${t.dim}"><div class="lockup">${markHtml}${wordHtml}</div><span class="fake">Systems normal</span><span class="btn">Sign in</span></div>`;
};
const swatch = (themeName, html) => {
  const t = T[themeName];
  return `<div class="sw t-${themeName}" style="--bg:${t.bg};--line:${t.line};--ink:${t.ink};--acc:${t.acc}">${html}</div>`;
};

const cards = [
  { name: 'Current', idea: 'The wordmark in the top bar today: lowercase, "code" in the blue, a caret bar. Shown for comparison.', mark: '', word: current, big: '' },
  ...MARKS.map((m) => ({ name: m.name, idea: m.idea, mark: inline(m, 24), word: word(), big: inline(m, 88), fav: m })),
  { name: 'Open o (text only)', idea: 'No symbol: the o of "code" is an arena seen from above with a contestant in it. The quietest option, and it keeps the wordmark the only thing in the bar.', mark: '', word: twist, big: '' },
];

const html = `<!doctype html><meta charset="utf-8"><title>CodeArena logo candidates</title>
<style>
@font-face{font-family:WM;src:url(../../../apps/web/app/fonts/wordmark.woff2) format("woff2");font-weight:700}
*{box-sizing:border-box}
body{margin:0;padding:32px;background:#f4f5f7;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#14161a}
h1{font-size:22px;margin:0 0 4px}p.lead{margin:0 0 24px;color:#566070;max-width:62ch}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.card{background:#fff;border:1px solid #dfe2e7;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
.card h2{margin:0;font-size:16px}.card p{margin:0;color:#566070;font-size:13px}
.nav{display:flex;align-items:center;gap:16px;height:48px;padding:0 14px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
.lockup{display:flex;align-items:center;gap:8px;margin-right:auto}
.word{font:700 20px/1 WM,ui-sans-serif,system-ui;letter-spacing:-.01em;display:inline-flex;align-items:center}
.acc{color:var(--acc)}.ink{color:var(--ink)}
.caret{display:inline-block;width:.12em;height:1em;margin-left:.1em;background:var(--acc);border-radius:1px}
.fake{font-size:12px;color:var(--dim)}.btn{font-size:12px;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 10px}
.fi{fill:var(--ink)}.fa{fill:var(--acc)}.si{stroke:var(--ink)}.sa{stroke:var(--acc)}
svg.o{width:.62em;height:.62em;margin:0 .02em;overflow:visible}
.row{display:flex;gap:10px;align-items:stretch}
.sw{flex:1;display:flex;align-items:center;justify-content:center;gap:14px;min-height:112px;background:var(--bg);border:1px solid var(--line);border-radius:8px}
</style>
<h1>CodeArena: logo candidates</h1>
<p class="lead">Each card shows the mark beside the existing wordmark in the real 48 px top bar (dark and light), then large, and at the 32 px and 16 px sizes of a browser tab. Colours are the site's own tokens; no gradients.</p>
<div class="grid">
${cards
  .map(
    (c) => `<section class="card"><h2>${c.name}</h2><p>${c.idea}</p>
${nav('dark', c.mark, c.word)}
${nav('light', c.mark, c.word)}
${
  c.big
    ? `<div class="row">${swatch('dark', c.big)}${swatch('light', c.big)}${swatch('dark', inline(c.fav, 32) + inline(c.fav, 16))}${swatch('light', inline(c.fav, 32) + inline(c.fav, 16))}</div>`
    : ''
}
</section>`,
  )
  .join('\n')}
</div>`;
writeFileSync(join(here, 'sheet.html'), html);
console.log('wrote', MARKS.length, 'svgs and sheet.html');
