import type { Page, Route } from '@playwright/test';

/**
 * The contest endpoints (C-01) for UI tests, on top of `stubApi`. Like the real server it decides
 * the state from its own clock, which a test can skew from the browser's (`clockSkewMs`).
 */
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });

const RULES = {
  penaltyMinutes: 20,
  ceCountsAsAttempt: false,
  langMultipliers: { c: 1, cpp17: 1, cpp20: 1, java21: 2, node: 2, python3: 3 },
  rated: true,
  lateRegistration: true,
};

import { rankRows } from '../lib/board';

type Cell = { attempts: number; acMinute: number | null; pending: number; first: boolean };
type BRow = {
  userId: string;
  handle: string;
  solved: number;
  penalty: number;
  lastAcMinute: number | null;
  score: number;
  cells: Record<string, Cell>;
};
const cell = (over: Partial<Cell> = {}): Cell => ({
  attempts: 0,
  acMinute: null,
  pending: 0,
  first: false,
  ...over,
});
/** A board row whose score orders the way the packed score does for these tiny inputs. */
export const brow = (
  userId: string,
  handle: string,
  cells: Record<string, Partial<Cell>>,
): BRow => {
  const full = Object.fromEntries(Object.entries(cells).map(([l, c]) => [l, cell(c)]));
  const solved = Object.values(full).filter((c) => c.acMinute !== null);
  const penalty = solved.reduce((n, c) => n + c.acMinute! + 20 * c.attempts, 0);
  return {
    userId,
    handle,
    solved: solved.length,
    penalty,
    lastAcMinute: solved.length ? Math.max(...solved.map((c) => c.acMinute!)) : null,
    score: solved.length * 1e6 - penalty,
    cells: full,
  };
};

export interface ContestStub {
  /** What `/board` answers; tests change it between requests. */
  board: { version: number; frozen: boolean; rows: BRow[] };
  boardRequests: number;
  registers: string[];
  created: Record<string, unknown>[];
  patches: Record<string, unknown>[];
  problemPuts: Record<string, unknown>[];
  registered: boolean;
  published: boolean;
}

export async function stubContests(
  page: Page,
  opts: {
    /** Seconds until the lobby contest starts (negative: already running). */
    startsInSec?: number;
    durationMin?: number;
    /** Server clock minus browser clock. */
    clockSkewMs?: number;
    registered?: boolean;
    publishError?: boolean;
    noLateRegistration?: boolean;
  } = {},
): Promise<ContestStub> {
  const o = { startsInSec: 3600, durationMin: 120, clockSkewMs: 0, ...opts };
  const st: ContestStub = {
    board: {
      version: 1,
      frozen: false,
      rows: [
        brow('u9', 'amy', { A: { acMinute: 12, first: true }, B: { acMinute: 40, attempts: 2 } }),
        brow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { pending: 1 } }),
        brow('u7', 'zed', { A: { attempts: 3 } }),
        brow('u8', 'bob', {}),
      ],
    },
    boardRequests: 0,
    registers: [],
    created: [],
    patches: [],
    problemPuts: [],
    registered: opts.registered ?? false,
    published: false,
  };
  // Fixed at the first request so the contest keeps its schedule while the test runs.
  const t0 = Date.now();
  const startsAt = () => new Date(t0 + o.clockSkewMs + o.startsInSec * 1000);
  const endsAt = () => new Date(startsAt().getTime() + o.durationMin * 60_000);
  const serverNow = () => new Date(Date.now() + o.clockSkewMs);
  const stateNow = () =>
    serverNow() < startsAt() ? 'scheduled' : serverNow() < endsAt() ? 'running' : 'ended';

  const summary = (
    slug: string,
    title: string,
    state: string,
    startMs: number,
    mins: number,
    reg: boolean,
  ) => ({
    slug,
    title,
    state,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + mins * 60_000).toISOString(),
    freezeAt: null,
    problemCount: 3,
    registeredCount: 12,
    registered: reg,
  });
  const detail = () => ({
    slug: 'warm-up-1',
    title: 'CodeArena Warm-up #1',
    state: stateNow(),
    startsAt: startsAt().toISOString(),
    endsAt: endsAt().toISOString(),
    freezeAt: new Date(endsAt().getTime() - 30 * 60_000).toISOString(),
    problemCount: 3,
    registeredCount: st.registered ? 13 : 12,
    registered: st.registered,
    description: 'Six problems, two hours. Good luck!',
    rules: opts.noLateRegistration ? { ...RULES, lateRegistration: false } : RULES,
    serverNow: serverNow().toISOString(),
    canRegister:
      !st.registered &&
      (stateNow() === 'scheduled' || (stateNow() === 'running' && !opts.noLateRegistration)),
  });

  await page.route('**/api/contests', (r) =>
    json(r, {
      serverNow: serverNow().toISOString(),
      items: [
        summary('live-now', 'Live Now Cup', 'running', Date.now() - 20 * 60_000, 120, false),
        summary(
          'warm-up-1',
          'CodeArena Warm-up #1',
          'scheduled',
          Date.now() + 3 * 86_400_000,
          120,
          st.registered,
        ),
        summary('old-one', 'Old One', 'ended', Date.now() - 9 * 86_400_000, 120, true),
      ],
    }),
  );
  await page.route('**/api/contests/warm-up-1', (r) => json(r, detail()));
  await page.route('**/api/contests/live-now/register', (r) => {
    st.registers.push('live-now');
    return json(r, { ...detail(), slug: 'live-now', registered: true }, 201);
  });
  await page.route('**/api/contests/warm-up-1/register', (r) => {
    st.registers.push('warm-up-1');
    st.registered = true;
    return json(r, detail(), 201);
  });
  await page.route(/\/api\/contests\/warm-up-1\/problems\/[A-Z]$/, (r) => {
    const label = r.request().url().split('/').at(-1)!;
    if (stateNow() === 'scheduled') {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/not-found',
          title: 'Not found',
          status: 404,
          code: 'not-found',
        },
        404,
      );
    }
    if (!st.registered) {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'forbidden',
          detail: 'Register for the contest to see its problems',
        },
        403,
      );
    }
    const title = label === 'A' ? 'Chai Bill' : 'Lantern Lighting';
    return json(r, {
      label,
      title,
      slug: label === 'A' ? 'chai-bill' : 'lantern-lighting',
      difficulty: 800,
      limits: { timeMs: 500, memMb: 256, outputKb: 1024 },
      statementMd: `# ${title}\n\nGiven $n$ cups, print the bill.\n\n## Input\n\nOne integer.\n\n## Output\n\nOne integer.\n\n## Notes\n\nNothing special for ${label}.\n`,
      samples: [{ in: '2\n', out: '10\n' }],
      testsCount: 12,
      checker: { kind: 'tokens' },
    });
  });
  await page.route('**/api/contests/warm-up-1/problems', (r) => {
    if (stateNow() === 'scheduled') {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/not-found',
          title: 'Not found',
          status: 404,
          code: 'not-found',
        },
        404,
      );
    }
    if (!st.registered) {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'forbidden',
          detail: 'Register for the contest to see its problems',
        },
        403,
      );
    }
    return json(r, {
      serverNow: serverNow().toISOString(),
      items: [
        {
          label: 'A',
          title: 'Chai Bill',
          slug: 'chai-bill',
          difficulty: 800,
          limits: { timeMs: 500, memMb: 256, outputKb: 1024 },
        },
        {
          label: 'B',
          title: 'Lantern Lighting',
          slug: 'lantern-lighting',
          difficulty: 1000,
          limits: { timeMs: 500, memMb: 256, outputKb: 1024 },
        },
      ],
    });
  });

  await page.route('**/api/contests/warm-up-1/board', (r) => {
    st.boardRequests += 1;
    const rows = rankRows(st.board.rows);
    return json(r, {
      contestId: 'cid-1',
      serverNow: serverNow().toISOString(),
      version: st.board.version,
      frozen: st.board.frozen,
      problems: ['A', 'B'].map((label) => ({
        label,
        solvedCount: rows.filter((x) => x.cells[label]?.acMinute != null).length,
        firstSolverId: rows.find((x) => x.cells[label]?.first)?.userId ?? null,
      })),
      rows,
    });
  });

  // ---- admin ----
  const admin = () => ({
    id: '11111111-1111-4111-8111-111111111111',
    ...detail(),
    state: st.published ? stateNow() : 'draft',
    problems: st.problemPuts.length
      ? (st.problemPuts.at(-1) as { items: { label: string; slug: string }[] }).items.map((i) => ({
          label: i.label,
          slug: i.slug,
          title: 'Hop Distances',
          version: 1,
          validationStatus: 'passed',
        }))
      : [],
  });
  await page.route('**/api/admin/contests', (r) => {
    if (r.request().method() === 'POST') {
      st.created.push(r.request().postDataJSON() as Record<string, unknown>);
      return json(r, admin(), 201);
    }
    return json(r, {
      serverNow: serverNow().toISOString(),
      items: [
        {
          id: admin().id,
          ...summary(
            'warm-up-1',
            'CodeArena Warm-up #1',
            st.published ? 'scheduled' : 'draft',
            Date.now() + 3 * 86_400_000,
            120,
            false,
          ),
        },
      ],
    });
  });
  await page.route('**/api/admin/contests/11111111-1111-4111-8111-111111111111', (r) => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      st.patches.push(body);
      if (body.published === true) {
        if (opts.publishError) {
          return json(
            r,
            {
              type: 'https://codearena.dev/errors/validation',
              title: 'Validation failed',
              status: 400,
              code: 'validation',
              detail: 'Every problem version must pass validation first',
              errors: [
                {
                  path: 'problems.hop-distances',
                  message: 'validation is pending; run Validate in the problem setter',
                },
              ],
            },
            400,
          );
        }
        st.published = true;
      }
      if (body.published === false) st.published = false;
    }
    return json(r, admin());
  });
  await page.route('**/api/admin/contests/11111111-1111-4111-8111-111111111111/problems', (r) => {
    st.problemPuts.push(r.request().postDataJSON() as Record<string, unknown>);
    return json(r, admin());
  });
  return st;
}
