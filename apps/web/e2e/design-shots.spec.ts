import { test, type Browser, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';
import { brow, stubContests } from './stub-contests';

/**
 * UI-08 design audit harness. NOT part of the normal suite: it only runs with DESIGN_SHOTS=1.
 *
 *   DESIGN_SHOTS=1 pnpm --filter web exec playwright test e2e/design-shots.spec.ts --workers=2
 *
 * Opens each of the 18 screens (S01 to S18) with the same stubbed data the functional specs use, at 1280 and 390 px in
 * dark and light, and writes a JPEG plus a JSON of measured styles (font sizes, colours, small targets, overflow) to
 * docs/design/screens/. The evaluators (impeccable audit and critique, the Emil skills) work from those files.
 * It changes no product code.
 */
const ON = process.env.DESIGN_SHOTS === '1';
const OUT = resolve(
  process.env.DESIGN_SHOTS_OUT ?? resolve(__dirname, '../../../docs/design/screens'),
);
const DATA = `${OUT}/data`;
const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
const THEMES = ['dark', 'light'] as const;

test.skip(!ON, 'set DESIGN_SHOTS=1 to produce the design audit screenshots');
test.describe.configure({ timeout: 90_000 });

const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };
const monaco = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** What the page looks like in numbers: the evidence the evaluators cannot get from a picture alone. */
function sample() {
  // built from parts: the design-token test forbids colour functions in source files; this runs in the browser, so it lives here
  const TRANSPARENT = ['rgba', '(0, 0, 0, 0)'].join('');
  const top = (m: Map<string, number>, n = 8) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const sizes = new Map<string, number>();
  const weights = new Map<string, number>();
  const families = new Map<string, number>();
  const textColours = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();
  let elements = 0;
  let gradients = 0;
  const small: { tag: string; text: string; w: number; h: number }[] = [];
  document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    elements++;
    const cs = getComputedStyle(el);
    if (
      el.childNodes.length &&
      [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())
    ) {
      bump(sizes, cs.fontSize);
      bump(weights, cs.fontWeight);
      bump(families, cs.fontFamily.split(',')[0]!.trim());
      bump(textColours, cs.color);
    }
    if (cs.backgroundColor !== TRANSPARENT) bump(backgrounds, cs.backgroundColor);
    if (cs.backgroundImage.includes('gradient')) gradients++;
    if (cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
    if (cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
    if (
      el.matches('a[href],button,input,select,textarea,[role=tab],[role=button]') &&
      (r.height < 32 || r.width < 32)
    )
      small.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? '').trim().slice(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
  });
  const headings = [...document.querySelectorAll<HTMLElement>('h1,h2,h3')]
    .slice(0, 12)
    .map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: (h.textContent ?? '').trim().slice(0, 50),
      size: getComputedStyle(h).fontSize,
      weight: getComputedStyle(h).fontWeight,
    }));
  return {
    url: location.pathname,
    viewport: { w: innerWidth, h: innerHeight },
    pageHeight: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    elements,
    gradients,
    fontSizes: top(sizes),
    fontWeights: top(weights),
    fontFamilies: top(families),
    textColours: top(textColours),
    backgrounds: top(backgrounds),
    radii: top(radii),
    shadows: top(shadows, 4),
    headings,
    smallTargets: { count: small.length, examples: small.slice(0, 10) },
    interactive: document.querySelectorAll('a[href],button,input,select,textarea,[role=tab]')
      .length,
  };
}

async function capture(
  page: Page,
  id: string,
  name: string,
  size: { width: number },
  theme: string,
  tag = '',
) {
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' }); // the dev-tools badge is not part of the product
  await page.waitForTimeout(900); // layout and fonts settle
  mkdirSync(DATA, { recursive: true });
  const base = `${id}-${name}${tag}-${size.width}-${theme}`;
  await page.screenshot({ path: `${OUT}/${base}.jpg`, type: 'jpeg', quality: 80, fullPage: true });
  writeFileSync(`${DATA}/${base}.json`, JSON.stringify(await page.evaluate(sample), null, 2));
}

/** One screen: how to stub its data, where to go, and what shows it is ready. */
interface Screen {
  id: string;
  name: string;
  open: (page: Page) => Promise<void>;
  /** More states of the same screen (a tab, a panel), each captured as its own image. */
  extras?: { tag: string; when?: (width: number) => boolean; run: (page: Page) => Promise<void> }[];
}

const narrow = (w: number) => w < 1024;
const tab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name, exact: true }).click();
};

const SUBMISSION = {
  id: 'D1',
  problemSlug: 'sum-two-numbers',
  problemTitle: 'Two Numbers, One Total',
  language: 'cpp17',
  status: 'done',
  verdict: 'AC',
  timeMs: 40,
  memKb: 2048,
  failedTest: null,
  lane: 'practice',
  createdAt: '2026-10-06T10:00:00.000Z',
  source: '#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}\n',
  problemVersion: 1,
  runVersion: 1,
  compileLog: null,
  tests: [1, 2, 3].map((no) => ({
    no,
    verdict: 'AC',
    timeMs: no * 3,
    memKb: 1500,
    checkerMsg: null,
  })),
  journey: {
    submittedAt: '2026-10-06T10:00:00.000Z',
    judgedAt: '2026-10-06T10:00:04.200Z',
    workerId: 'judge-2',
    steps: [
      { phase: 'claimed', at: '2026-10-06T10:00:01.800Z' },
      { phase: 'compiling', at: '2026-10-06T10:00:01.900Z' },
      { phase: 'running', at: '2026-10-06T10:00:03.500Z' },
      { phase: 'done', at: '2026-10-06T10:00:04.100Z' },
    ],
  },
};

const RUN = '33333333-3333-4333-8333-333333333333';
const CL = '44444444-4444-4444-8444-444444444441';
const S = ['1', '2', '3'].map((n) => `44444444-4444-4444-8444-44444444444${n}`);
const CONTEST = '55555555-5555-4555-8555-555555555555';
const PROBLEM = '66666666-6666-4666-8666-666666666666';

async function integrity(page: Page, names: string[] = ['asha', 'ben', 'chen']) {
  await stubApi(page, { role: 'admin' });
  const member = (
    i: number,
    handle: string,
    language: string,
    verdict: string,
    source: string,
  ) => ({
    submissionId: S[i]!,
    handle,
    language,
    verdict,
    submittedAt: new Date(Date.UTC(2026, 9, 10, 13, 40 + i * 10)).toISOString(),
    source,
  });
  await page.route(`**/api/admin/plag/runs/${RUN}`, (r) =>
    json(r, {
      id: RUN,
      contestId: CONTEST,
      status: 'done',
      params: {},
      metrics: {},
      startedAt: '2026-10-10T15:00:00Z',
      finishedAt: '2026-10-10T15:05:00Z',
      clusters: [
        {
          id: CL,
          problemId: PROBLEM,
          problemSlug: 'chai-bill',
          size: 3,
          maxScore: 0.91,
          status: 'open',
        },
      ],
    }),
  );
  await page.route(`**/api/admin/plag/clusters/${CL}`, (r) =>
    json(r, {
      id: CL,
      runId: RUN,
      contestId: CONTEST,
      problemId: PROBLEM,
      problemSlug: 'chai-bill',
      maxScore: 0.91,
      status: 'open',
      members: [
        member(0, names[0]!, 'cpp17', 'AC', 'int main() { return 0; }\n'),
        member(1, names[1]!, 'cpp17', 'AC', 'int main() { return 0; } // b\n'),
        member(2, names[2]!, 'python3', 'WA', 'print(1)\n'),
      ],
      pairs: [
        { subA: S[0], subB: S[1], fpScore: 0.91, embScore: 0.95, combined: 0.91 },
        { subA: S[0], subB: S[2], fpScore: 0.5, embScore: 0.6, combined: 0.55 },
      ],
      signals: [
        {
          handle: names[0]!,
          pastes: [{ size: 800, at: '2026-10-10T13:41:00Z' }],
          focusLosses: 3,
          openedAt: '2026-10-10T13:35:00Z',
          timeToAcMinutes: 28,
          styleShift: 0.41,
          canary: true,
        },
        {
          handle: names[1]!,
          pastes: [],
          focusLosses: 0,
          openedAt: null,
          timeToAcMinutes: null,
          styleShift: null,
          canary: null,
        },
        {
          handle: names[2]!,
          pastes: [],
          focusLosses: 1,
          openedAt: '2026-10-10T13:50:00Z',
          timeToAcMinutes: null,
          styleShift: 0.05,
          canary: false,
        },
      ],
      decisions: [],
    }),
  );
  await page.goto(`/admin/integrity/${RUN}`);
  await page.getByRole('heading').first().waitFor();
}

const SCREENS: Screen[] = [
  {
    id: 'S01',
    name: 'landing',
    open: async (page) => {
      await stubApi(page, { signedIn: false });
      await stubContests(page, { startsInSec: 3600 });
      await page.goto('/');
    },
  },
  {
    id: 'S02',
    name: 'signin',
    open: async (page) => {
      await stubApi(page, { signedIn: false });
      await page.goto('/signin');
    },
  },
  {
    id: 'S02',
    name: 'onboarding',
    open: async (page) => {
      await stubApi(page, { handle: null });
      await page.goto('/onboarding');
    },
  },
  {
    id: 'S03',
    name: 'home',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, { startsInSec: 3600 });
      await page.goto('/home');
    },
  },
  {
    id: 'S04',
    name: 'practice',
    open: async (page) => {
      await stubApi(page);
      // the problem list the practice spec uses (the default stub answers an empty list)
      const items = [
        ['peak-reading', 'Peak Reading', 800, ['implementation', 'arrays'], 91.2, 'solved'],
        ['sum-two-numbers', 'Two Numbers, One Total', 800, ['implementation', 'math'], 74.5, 'new'],
        ['maze-runner', 'Maze Runner', 1200, ['bfs', 'graphs', 'grids'], 40.1, 'new'],
        ['hop-distances', 'Hop Distances', 1300, ['bfs', 'graphs'], null, 'attempted'],
        ['spell-fixer', 'Spell Fixer', 1600, ['dp', 'strings', 'strings2', 'x', 'y'], 12.0, 'new'],
      ].map(([slug, title, difficulty, tags, acceptance, status]) => ({
        slug,
        title,
        difficulty,
        tags,
        practicePoints: (difficulty as number) / 100,
        acceptance,
        status,
      }));
      await page.route('**/api/problems?**', (r) => json(r, { items, nextCursor: null }));
      await page.route('**/api/problems/tags', (r) =>
        json(r, {
          items: [
            { tag: 'bfs', count: 2 },
            { tag: 'dp', count: 1 },
            { tag: 'graphs', count: 2 },
          ],
        }),
      );
      await page.goto('/practice');
      await page.locator('tbody tr').first().waitFor();
    },
  },
  {
    id: 'S05',
    name: 'workspace',
    open: async (page) => {
      await stubApi(page);
      await page.goto('/p/sum-two-numbers');
      // from 1024 px the editor sits beside the statement; below that it is behind the Code tab
      if (!narrow(page.viewportSize()!.width)) await monaco(page);
    },
    extras: [
      {
        tag: '-code',
        when: narrow,
        run: async (p) => {
          await tab('Code')(p);
          await monaco(p);
        },
      },
      { tag: '-console', when: narrow, run: tab('Console') },
    ],
  },
  {
    id: 'S06',
    name: 'submission',
    open: async (page) => {
      const { state } = await stubApi(page);
      state.details.D1 = SUBMISSION;
      await page.goto('/s/D1');
      await monaco(page);
    },
  },
  {
    id: 'S07',
    name: 'contests',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page);
      await page.goto('/contests');
    },
  },
  {
    id: 'S08',
    name: 'lobby',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, { startsInSec: 3600, registered: true });
      await page.goto('/c/warm-up-1');
    },
  },
  {
    id: 'S09',
    name: 'arena',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, RUNNING);
      await page.goto('/c/warm-up-1/A');
      if (!narrow(page.viewportSize()!.width)) await monaco(page);
    },
    extras: [
      {
        tag: '-code',
        when: narrow,
        run: async (p) => {
          await tab('Code')(p);
          await monaco(p);
        },
      },
      { tag: '-console', when: narrow, run: tab('Console') },
    ],
  },
  {
    id: 'S10',
    name: 'board',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, RUNNING);
      await page.goto('/c/warm-up-1/board');
    },
  },
  {
    id: 'S11',
    name: 'results',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, {
        startsInSec: -4 * 3600,
        durationMin: 120,
        finalized: true,
        reviews: 'mixed',
      });
      await page.goto('/c/warm-up-1/results');
    },
  },
  {
    id: 'S12',
    name: 'profile',
    open: async (page) => {
      await stubApi(page);
      await stubContests(page, { startsInSec: 3600 });
      await page.goto('/u/riya_k');
    },
  },
  {
    id: 'S13',
    name: 'interview-list',
    open: async (page) => {
      await stubApi(page, { handle: 'meera' });
      await page.route('**/api/rooms', (r) =>
        json(r, {
          items: [
            {
              id: randomUUID(),
              role: 'interviewer',
              status: 'open',
              language: 'cpp17',
              durationMin: 45,
              problem: { slug: 'chai-bill', title: 'Chai Bill' },
              createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
              expiresAt: new Date(Date.now() + 85 * 60_000).toISOString(),
              memberCount: 2,
              suggestions: true,
            },
            {
              id: randomUUID(),
              role: 'candidate',
              status: 'closed',
              language: 'python3',
              durationMin: 60,
              problem: null,
              createdAt: new Date(Date.now() - 86_400_000).toISOString(),
              expiresAt: new Date(Date.now() - 80_000_000).toISOString(),
              memberCount: 2,
              suggestions: true,
            },
          ],
        }),
      );
      await page.goto('/interview');
    },
  },
  {
    id: 'S15',
    name: 'admin-problem',
    open: async (page) => {
      await stubApi(page, { role: 'setter' });
      await stubAdmin(page);
      await page.goto('/admin/problems/hop-distances');
      await page.getByRole('tab', { name: 'Overview' }).waitFor();
    },
    extras: [
      {
        tag: '-statement',
        run: async (p) => {
          await tab('Statement')(p);
          await monaco(p);
        },
      },
      { tag: '-tests', run: tab('Tests') },
      { tag: '-validation', run: tab('Solutions & Validation') },
    ],
  },
  {
    id: 'S16',
    name: 'ops',
    open: async (page) => {
      await stubApi(page, { role: 'admin' });
      await stubAdmin(page);
      const st = await stubContests(page, RUNNING);
      st.published = true;
      st.problemPuts.push({
        items: [
          { label: 'A', slug: 'hop-distances' },
          { label: 'B', slug: 'lantern-lighting' },
        ],
      });
      await page.goto('/admin/contests/11111111-1111-4111-8111-111111111111/ops');
      await page.getByRole('heading', { name: 'Queue and judges' }).waitFor();
    },
  },
  { id: 'S17', name: 'integrity', open: integrity },
  {
    id: 'S18',
    name: 'status',
    open: async (page) => {
      await stubApi(page, { signedIn: false });
      await page.goto('/status');
    },
  },
];

async function context(
  browser: Browser,
  size: (typeof SIZES)[number],
  theme: (typeof THEMES)[number],
) {
  return browser.newContext({ viewport: size, colorScheme: theme, reducedMotion: 'reduce' });
}

for (const screen of SCREENS)
  for (const size of SIZES)
    for (const theme of THEMES)
      test(`${screen.id} ${screen.name} ${size.width} ${theme}`, async ({ browser }) => {
        const ctx = await context(browser, size, theme);
        const page = await ctx.newPage();
        await screen.open(page);
        // not fatal: if a screen renders without the app shell, the picture shows it
        await page
          .locator('#main')
          .waitFor({ timeout: 5000 })
          .catch(() => undefined);
        await capture(page, screen.id, screen.name, size, theme);
        for (const extra of screen.extras ?? []) {
          if (extra.when && !extra.when(size.width)) continue;
          await extra.run(page);
          await capture(page, screen.id, screen.name, size, theme, extra.tag);
        }
        await ctx.close();
      });

// ---- S14: the replay, from a real Yjs log served in the server's binary format -----------------------------------
const ROOM = randomUUID();
const START = Date.UTC(2026, 9, 10, 14, 0, 0);

function recorded() {
  const src = new Y.Doc({ gc: false });
  const log: { kind: number; seq: number; ts: number; bytes: Uint8Array }[] = [];
  let now = START;
  src.on('update', (u: Uint8Array) =>
    log.push({ kind: 1, seq: log.length + 1, ts: now, bytes: u }),
  );
  const text = src.getText('code');
  for (const ch of '#include <iostream>\nint main() {\n  std::cout << 42;\n}\n') {
    now += 100;
    text.insert(text.length, ch);
  }
  return { log, end: now + 500 };
}

async function replay(page: Page) {
  const S = recorded();
  const frame = (recs: typeof S.log) => {
    const parts: Buffer[] = [];
    for (const r of recs) {
      const h = Buffer.alloc(17);
      h.writeUInt8(r.kind, 0);
      h.writeUInt32BE(r.seq, 1);
      h.writeDoubleBE(r.ts, 5);
      h.writeUInt32BE(r.bytes.length, 13);
      parts.push(h, Buffer.from(r.bytes));
    }
    return Buffer.concat(parts);
  };
  await stubApi(page, { handle: 'meera' });
  await page.route(`**/api/rooms/${ROOM}`, (r) =>
    json(r, {
      id: ROOM,
      role: 'interviewer',
      status: 'closed',
      language: 'cpp17',
      durationMin: 45,
      problem: { slug: 'chai-bill', title: 'Chai Bill' },
      createdAt: new Date(START - 5000).toISOString(),
      expiresAt: new Date(START + 9e6).toISOString(),
      memberCount: 2,
      suggestions: true,
      members: [
        { handle: 'meera', role: 'interviewer' },
        { handle: 'asha', role: 'candidate' },
      ],
    }),
  );
  await page.route(`**/api/rooms/${ROOM}/timeline`, (r) =>
    json(r, {
      startedAt: new Date(START - 1000).toISOString(),
      endedAt: new Date(S.end).toISOString(),
      durationMs: S.end - START + 1000,
      updates: S.log.length,
      lastSeq: S.log.length,
      checkpointEvery: 200,
      eventsCut: false,
      events: [
        { seq: 1, ts: new Date(START - 1000).toISOString(), kind: 'join', by: 'meera' },
        { seq: 2, ts: new Date(START + 500).toISOString(), kind: 'join', by: 'asha' },
        {
          seq: 3,
          ts: new Date(START + 3000).toISOString(),
          kind: 'run',
          by: 'asha',
          mode: 'run',
          verdict: 'AC',
          runId: randomUUID(),
        },
        { seq: 4, ts: new Date(S.end).toISOString(), kind: 'leave', by: 'asha' },
      ],
    }),
  );
  await page.route(`**/api/rooms/${ROOM}/playback?**`, (r) => {
    const q = new URL(r.request().url()).searchParams;
    const toTs = q.get('toTs');
    const upTo = toTs
      ? (S.log.filter((x) => x.ts <= Date.parse(toTs)).at(-1)?.seq ?? 0)
      : S.log.length;
    const recs = S.log.filter((x) => x.seq <= upTo);
    return r.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      headers: { 'X-Playback-From-Seq': '0', 'X-Playback-To-Seq': String(upTo) },
      body: frame(recs),
    });
  });
  await page.route(`**/api/rooms/${ROOM}/notes`, (r) =>
    json(r, {
      body: 'Strong start. Asked about edge cases late.',
      updatedAt: '2026-10-10T14:30:00.000Z',
    }),
  );
  await page.route(`**/api/rooms/${ROOM}/summary`, (r) =>
    json(r, { status: 'none', bodyMd: null, usedNotes: null, generatedAt: null, model: null }),
  );
  await page.goto(`/r/${ROOM}/replay`);
  await monaco(page);
  await page.getByRole('slider', { name: 'Position in the session' }).press('End');
}

for (const size of SIZES)
  for (const theme of THEMES)
    test(`S14 replay ${size.width} ${theme}`, async ({ browser }) => {
      const ctx = await context(browser, size, theme);
      const page = await ctx.newPage();
      await replay(page);
      await capture(page, 'S14', 'replay', size, theme);
      await ctx.close();
    });

// ---- S13: the live pad, against the real collab server (as e2e/pad.spec.ts) ---------------------------------------
// the dev server is started with NEXT_PUBLIC_COLLAB_URL on this port (playwright.config.ts): do not run this next to e2e/pad.spec.ts
const PORT = Number(process.env.COLLAB_E2E_PORT ?? 1299);
const TOKEN = 'd'.repeat(40);
let authApi: Server | undefined;
let collab: ChildProcess | undefined;
const tickets = new Map<string, object>();
const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      r(true);
    });
    s.on('error', () => r(false));
  });

test.describe('S13 pad', () => {
  test.beforeAll(async () => {
    if (!ON) return;
    authApi = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        const who = tickets.get((JSON.parse(raw || '{}') as { ticket?: string }).ticket ?? '');
        if (!who || req.headers['x-service-token'] !== TOKEN) return void res.writeHead(401).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(who));
      });
    });
    await new Promise<void>((r) => authApi!.listen(0, '127.0.0.1', r));
    const apiPort = (authApi.address() as { port: number }).port;
    collab = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
      cwd: resolve(__dirname, '../../collab'),
      env: {
        ...process.env,
        PORT: String(PORT),
        API_URL: `http://127.0.0.1:${apiPort}`,
        COLLAB_SERVICE_TOKEN: TOKEN,
        COLLAB_MEMORY: '1',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100 && !(await portOpen(PORT)); i++)
      await new Promise((r) => setTimeout(r, 100));
  });
  test.afterAll(async () => {
    collab?.kill();
    await new Promise((r) => authApi?.close(r));
  });

  for (const size of SIZES)
    for (const theme of THEMES)
      test(`S13 pad ${size.width} ${theme}`, async ({ browser }) => {
        const ctx = await context(browser, size, theme);
        const page = await ctx.newPage();
        const room = randomUUID();
        await stubApi(page, { handle: 'meera' });
        await page.route(`**/api/rooms/${room}`, (r) =>
          json(r, {
            id: room,
            role: 'interviewer',
            status: 'open',
            language: 'cpp17',
            durationMin: 45,
            problem: { slug: 'chai-bill', title: 'Chai Bill' },
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 85 * 60_000).toISOString(),
            memberCount: 2,
            suggestions: true,
            members: [
              { handle: 'meera', role: 'interviewer' },
              { handle: 'asha', role: 'candidate' },
            ],
          }),
        );
        await page.route('**/api/problems/chai-bill', (r) =>
          json(r, {
            slug: 'chai-bill',
            title: 'Chai Bill',
            statementMd: '# Chai Bill\n\nPrint the bill.\n',
          }),
        );
        await page.route(`**/api/rooms/${room}/notes`, (r) =>
          json(r, { body: '', updatedAt: null }),
        );
        await page.route(`**/api/rooms/${room}/runs`, (r) => json(r, { items: [] }));
        await page.route('**/api/realtime/ticket', (r) => {
          const ticket = `t-${randomUUID()}`;
          tickets.set(ticket, {
            userId: randomUUID(),
            name: 'meera',
            role: 'interviewer',
            readOnly: false,
            expiresAt: Date.now() + 3_600_000,
            colorIndex: 0,
          });
          return json(r, { ticket, expiresAt: Date.now() + 60_000 });
        });
        await page.goto(`/r/${room}`);
        await monaco(page);
        await page.locator('.monaco-editor').first().click();
        await page.keyboard.type('#include <iostream>\nint main() {\n  std::cout << 42;\n}', {
          delay: 5,
        });
        await capture(page, 'S13', 'pad', size, theme);
        await ctx.close();
      });
});

// ---- break-ui: worst-case data on S03, S06, S08, S10, S12, S17 (stubs only, no product code) -----------------------
const LONG = 'a_very_long_handle_that_keeps_going_and_going_2026_campus_cohort';
const CJK = '李小龍_Алексей_مرحبا';
const WORST: { id: string; name: string; open: (page: Page) => Promise<void> }[] = [
  {
    id: 'S03',
    name: 'home',
    open: async (page) => {
      const { state } = await stubApi(page, { handle: LONG });
      state.home.continuePracticing = Array.from({ length: 14 }, (_, i) => ({
        slug: `p-${i}`,
        title:
          i % 2
            ? 'A problem title that is much longer than any card was designed to hold, on purpose'
            : '🔥 解く: 配列の和',
        solved: i % 3 === 0,
        lastVerdict: ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'SE'][i % 8],
      }));
      await stubContests(page, { startsInSec: 3600 });
      await page.goto('/home');
    },
  },
  {
    id: 'S06',
    name: 'submission',
    open: async (page) => {
      const { state } = await stubApi(page);
      state.details.D1 = {
        ...SUBMISSION,
        problemTitle:
          'A problem title that is far too long for a heading and wraps over several lines on a phone',
        verdict: 'WA',
        failedTest: 57,
        timeMs: 99_999,
        memKb: 2_147_483_647,
        compileLog: 'error: '.repeat(400),
        tests: Array.from({ length: 60 }, (_, i) => ({
          no: i + 1,
          verdict: i === 56 ? 'WA' : 'AC',
          timeMs: i * 17,
          memKb: 1500 + i,
          checkerMsg:
            i === 56 ? 'expected 123456789012345678 found 123456789012345679 '.repeat(4) : null,
        })),
        source: ('int very_long_identifier_name_' + 'x'.repeat(200) + ' = 0;\n').repeat(40),
      };
      await page.goto('/s/D1');
      await monaco(page);
    },
  },
  {
    id: 'S08',
    name: 'lobby',
    open: async (page) => {
      await stubApi(page, { handle: LONG });
      await stubContests(page, { startsInSec: 3600, registered: true });
      await page.goto('/c/warm-up-1');
    },
  },
  {
    id: 'S10',
    name: 'board',
    open: async (page) => {
      await stubApi(page, { handle: CJK });
      const st = await stubContests(page, RUNNING);
      st.board.rows = [
        brow('u1', CJK, { A: { acMinute: 3, first: true }, B: { acMinute: 9999, attempts: 98 } }),
        brow('u2', LONG, { A: { acMinute: 14, attempts: 1234 }, B: { pending: 987 } }),
        brow('u3', 'x', { A: { attempts: 3 } }),
        ...Array.from({ length: 150 }, (_, i) =>
          brow(
            `n${i}`,
            `student_${i}_${'z'.repeat(i % 20)}`,
            i % 4 ? { A: { acMinute: 20 + i } } : {},
          ),
        ),
      ];
      await page.goto('/c/warm-up-1/board');
    },
  },
  {
    id: 'S12',
    name: 'profile',
    open: async (page) => {
      const { state } = await stubApi(page);
      state.profile.handle = LONG;
      state.profile.rating = 99_999;
      (state.profile.solved as { total: number }).total = 12_345;
      (state.profile.solved as { byTag: unknown }).byTag = Array.from({ length: 40 }, (_, i) => ({
        tag: i % 2 ? `a-really-long-tag-name-for-wrapping-${i}` : `tag${i}`,
        count: i * 37,
      }));
      await stubContests(page, { startsInSec: 3600 });
      await page.goto(`/u/${LONG}`);
    },
  },
  { id: 'S17', name: 'integrity', open: (page) => integrity(page, [LONG, CJK, 'x']) },
];

for (const screen of WORST)
  for (const size of SIZES)
    test(`worst-case ${screen.id} ${screen.name} ${size.width}`, async ({ browser }) => {
      const ctx = await context(browser, size, 'dark');
      const page = await ctx.newPage();
      await screen.open(page);
      await page
        .locator('#main')
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
      await capture(page, screen.id, screen.name, size, 'dark', '-worst');
      await ctx.close();
    });
