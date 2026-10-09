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
  examMode: false,
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

type Clar = {
  id: string;
  problemLabel: string | null;
  question: string;
  answer: string | null;
  isPublic: boolean;
  mine: boolean;
  createdAt: string;
  answeredAt: string | null;
  askerId: string;
  askerHandle: string;
};

export interface ContestStub {
  /** Clarifications: what the contestant lists (`mine` ones plus public answers) and the admin inbox. */
  clarifications: Clar[];
  asked: Record<string, unknown>[];
  answered: { id: string; body: Record<string, unknown> }[];
  announced: string[];
  announcements: { id: string; body: string; createdAt: string }[];
  /** What `/board` answers; tests change it between requests. */
  board: { version: number; frozen: boolean; rows: BRow[] };
  /** What `/board?view=frozen` answers (the resolver's starting point); the live rows when unset. */
  frozenRows?: BRow[];
  boardRequests: number;
  /** AI reviews (AI-03): what `GET /reviews` lists, which submissions were opened, and the ratings sent. */
  reviews: {
    items: Record<string, unknown>[];
    opened: string[];
    ratings: { id: string; helpful: boolean }[];
    /** Opening a queued review answers `queued` (AI is busy) instead of writing it. */
    busy: boolean;
  };
  /** Operations console (C-07). */
  ops: {
    summary: Record<string, unknown>;
    dlq: Record<string, unknown>[];
    hidden: Record<string, boolean>;
    canary: Record<string, boolean>;
    extended: number[];
    rejudged: Record<string, unknown>[];
    rebuilds: number;
    requeued: string[];
    finalized: boolean;
    finalizes: number;
    recomputes: number;
    /** What `/results` and the finalize call answer. */
    changes: {
      userId: string;
      handle: string;
      rank: number;
      oldRating: number;
      newRating: number;
      delta: number;
    }[];
    /** Make the next extend fail with this message. */
    extendError?: string;
  };
  registers: string[];
  created: Record<string, unknown>[];
  patches: Record<string, unknown>[];
  problemPuts: Record<string, unknown>[];
  registered: boolean;
  published: boolean;
  /** Exam mode (C-10): what the server would have stored for the viewer, and what was called. */
  exam: {
    strikes: number;
    finishedAt: string | null;
    finishReason: 'self' | 'left-window' | null;
    leaves: number;
    finishes: number;
    reopened: string[];
    /** Others in the ops console list. */
    others: {
      userId: string;
      handle: string;
      leaveCount: number;
      finishedAt: string | null;
      finishReason: string | null;
    }[];
  };
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
    /** The contest is final (C-08). */
    finalized?: boolean;
    publishError?: boolean;
    noLateRegistration?: boolean;
    /** The contest has exam mode (C-10). */
    exam?: boolean;
    /** AI reviews for the viewer (AI-03): `mixed` = A ready, B queued; `none` = nothing submitted. */
    reviews?: 'mixed' | 'none';
    /** Opening a queued review answers `queued`. */
    reviewsBusy?: boolean;
    /** The canary sentence the contest problem carries (IN-02). */
    canary?: string;
  } = {},
): Promise<ContestStub> {
  const o = { startsInSec: 3600, durationMin: 120, clockSkewMs: 0, ...opts };
  const st: ContestStub = {
    reviews: {
      items:
        o.reviews === 'mixed'
          ? [
              {
                reviewId: '00000000-0000-4000-8000-0000000000a1',
                submissionId: '00000000-0000-4000-8000-0000000000b1',
                label: 'A',
                problemSlug: 'sum-two-numbers',
                problemTitle: 'Two Numbers, One Total',
                verdict: 'AC',
                failedTest: null,
                status: 'ready',
                contentMd:
                  '### Complexity\nLinear in the input size.\n### Edge cases you missed\nNone found.\n### Compared with the intended approach\nSame idea.\n### Readability\nName the **loop** variable.',
                helpful: null,
                hasEditorial: true,
              },
              {
                reviewId: '00000000-0000-4000-8000-0000000000a2',
                submissionId: '00000000-0000-4000-8000-0000000000b2',
                label: 'B',
                problemSlug: 'fractional-loot',
                problemTitle: 'Fractional Loot',
                verdict: 'WA',
                failedTest: 4,
                status: 'queued',
                contentMd: null,
                helpful: null,
                hasEditorial: true,
              },
            ]
          : [],
      opened: [],
      ratings: [],
      busy: Boolean(o.reviewsBusy),
    },
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
    ops: {
      summary: {
        serverNow: new Date().toISOString(),
        lanes: [
          { lane: 'contest', depth: 2 },
          { lane: 'interactive', depth: 0 },
          { lane: 'practice', depth: 5 },
          { lane: 'rejudge', depth: 0 },
        ],
        workers: [
          {
            id: 'judge-1',
            lanes: ['contest', 'practice'],
            busy: 1,
            concurrency: 2,
            ageMs: 1500,
            uptimeMs: 3_600_000,
            restarts5m: 0,
            lastRestartAgoMs: null,
          },
          {
            id: 'judge-2',
            lanes: ['contest'],
            busy: 0,
            concurrency: 2,
            ageMs: 14000,
            uptimeMs: 40_000,
            restarts5m: 3,
            lastRestartAgoMs: 40_000,
          },
        ],
        p50Ms: 1200,
        p95Ms: 3400,
        submissionsPerMin: 4.2,
        dlq: 1,
      },
      dlq: [
        {
          entryId: '1700000000000-0',
          reason: 'crash-loop',
          error: 'worker died 3 times',
          lane: 'contest',
          submissionId: 'aaaaaaaa-1111-4111-8111-111111111111',
          workerId: 'judge-1',
          at: null,
        },
      ],
      hidden: {},
      canary: {},
      extended: [],
      rejudged: [],
      rebuilds: 0,
      requeued: [],
      finalized: false,
      finalizes: 0,
      recomputes: 0,
      changes: [
        { userId: 'u9', handle: 'amy', rank: 1, oldRating: 1400, newRating: 1432, delta: 32 },
        { userId: 'u1', handle: 'riya_k', rank: 2, oldRating: 1500, newRating: 1493, delta: -7 },
        { userId: 'u7', handle: 'zed', rank: 3, oldRating: 1300, newRating: 1300, delta: 0 },
      ],
    },
    clarifications: [
      {
        id: 'q1',
        problemLabel: 'B',
        question: 'Is the grid always square?',
        answer: null,
        isPublic: false,
        mine: false,
        createdAt: '2026-10-10T13:10:00.000Z',
        answeredAt: null,
        askerId: 'u9',
        askerHandle: 'amy',
      },
      {
        id: 'q2',
        problemLabel: null,
        question: 'Can we leave the room?',
        answer: 'Yes, quietly.',
        isPublic: true,
        mine: false,
        createdAt: '2026-10-10T13:05:00.000Z',
        answeredAt: '2026-10-10T13:06:00.000Z',
        askerId: 'u7',
        askerHandle: 'zed',
      },
    ],
    asked: [],
    answered: [],
    announced: [],
    announcements: [],
    registers: [],
    created: [],
    patches: [],
    problemPuts: [],
    registered: opts.registered ?? false,
    published: false,
    exam: {
      strikes: 0,
      finishedAt: null,
      finishReason: null,
      leaves: 0,
      finishes: 0,
      reopened: [],
      others: [],
    },
  };
  // Fixed at the first request so the contest keeps its schedule while the test runs.
  const t0 = Date.now();
  const startsAt = () => new Date(t0 + o.clockSkewMs + o.startsInSec * 1000);
  const endsAt = () => new Date(startsAt().getTime() + o.durationMin * 60_000);
  const serverNow = () => new Date(Date.now() + o.clockSkewMs);
  const stateNow = () =>
    st.ops.finalized || opts.finalized
      ? 'finalized'
      : serverNow() < startsAt()
        ? 'scheduled'
        : serverNow() < endsAt()
          ? 'running'
          : 'ended';

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
    id: 'cid-1',
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
    rules: {
      ...RULES,
      lateRegistration: !opts.noLateRegistration,
      examMode: !!opts.exam,
    },
    exam:
      opts.exam && st.registered
        ? {
            finishedAt: st.exam.finishedAt,
            finishReason: st.exam.finishReason,
            strikes: st.exam.strikes,
            maxStrikes: 3,
          }
        : null,
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
    if (opts.exam && st.exam.finishedAt && stateNow() === 'running') {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/contest-finished',
          title: 'You have finished this test',
          status: 403,
          code: 'contest-finished',
        },
        403,
      );
    }
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
      canaryText: opts.canary ?? null,
      statementMd: `# ${title}\n\nGiven $n$ cups, print the bill.\n\n## Input\n\nOne integer.\n\n## Output\n\nOne integer.\n\n## Notes\n\nNothing special for ${label}.\n`,
      samples: [{ in: '2\n', out: '10\n' }],
      testsCount: 12,
      checker: { kind: 'tokens' },
    });
  });
  await page.route('**/api/contests/warm-up-1/problems', (r) => {
    if (opts.exam && st.exam.finishedAt && stateNow() === 'running') {
      return json(
        r,
        {
          type: 'https://codearena.dev/errors/contest-finished',
          title: 'You have finished this test',
          status: 403,
          code: 'contest-finished',
        },
        403,
      );
    }
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

  const boardJson = (r: Route, source: BRow[]) => {
    const rows = rankRows(source);
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
  };
  await page.route('**/api/contests/warm-up-1/board', (r) => {
    st.boardRequests += 1;
    return boardJson(r, st.board.rows);
  });
  await page.route(/\/api\/contests\/warm-up-1\/board\?view=frozen$/, (r) =>
    boardJson(r, st.frozenRows ?? st.board.rows),
  );

  const strip = (c: Clar) => {
    const { askerId, askerHandle, ...rest } = c;
    void askerId;
    void askerHandle;
    return rest;
  };
  await page.route('**/api/contests/warm-up-1/clarifications', (r) => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON() as { problemLabel?: string | null; question: string };
      st.asked.push(body);
      const item: Clar = {
        id: `mine-${st.asked.length}`,
        problemLabel: body.problemLabel ?? null,
        question: body.question,
        answer: null,
        isPublic: false,
        mine: true,
        createdAt: new Date().toISOString(),
        answeredAt: null,
        askerId: 'u1',
        askerHandle: 'riya_k',
      };
      st.clarifications.push(item);
      return json(r, strip(item), 201);
    }
    return json(r, {
      items: st.clarifications.filter((c) => c.mine || (c.isPublic && c.answer)).map(strip),
    });
  });
  await page.route('**/api/contests/warm-up-1/announcements', (r) =>
    json(r, { items: st.announcements }),
  );
  await page.route(
    '**/api/admin/contests/11111111-1111-4111-8111-111111111111/clarifications',
    (r) => json(r, { items: st.clarifications }),
  );
  await page.route('**/api/admin/clarifications/*/answer', (r) => {
    const id = r.request().url().split('/').at(-2)!;
    const body = r.request().postDataJSON() as { answer: string; isPublic: boolean };
    st.answered.push({ id, body });
    const c = st.clarifications.find((x) => x.id === id)!;
    Object.assign(c, {
      answer: body.answer,
      isPublic: body.isPublic,
      answeredAt: new Date().toISOString(),
    });
    return json(r, c);
  });
  await page.route(
    '**/api/admin/contests/11111111-1111-4111-8111-111111111111/announcements',
    (r) => {
      const body = r.request().postDataJSON() as { body: string };
      st.announced.push(body.body);
      return json(
        r,
        {
          id: `n${st.announced.length}`,
          body: body.body,
          createdAt: new Date().toISOString(),
          reached: 3,
          registered: 12,
        },
        201,
      );
    },
  );

  // ---- exam mode (C-10): mirrors the server's counting, including the 2 s debounce ----
  let lastLeave = 0;
  await page.route('**/api/contests/warm-up-1/leave', (r) => {
    st.exam.leaves++;
    const now = Date.now();
    if (st.exam.finishedAt || now - lastLeave < 2000) {
      return json(r, {
        strikes: st.exam.strikes,
        remaining: Math.max(0, 3 - st.exam.strikes),
        finished: !!st.exam.finishedAt,
        counted: false,
      });
    }
    lastLeave = now;
    st.exam.strikes++;
    if (st.exam.strikes >= 3) {
      st.exam.finishedAt = new Date().toISOString();
      st.exam.finishReason = 'left-window';
    }
    return json(r, {
      strikes: st.exam.strikes,
      remaining: Math.max(0, 3 - st.exam.strikes),
      finished: !!st.exam.finishedAt,
      counted: true,
    });
  });
  await page.route('**/api/contests/warm-up-1/finish', (r) => {
    st.exam.finishes++;
    if (!st.exam.finishedAt) {
      st.exam.finishedAt = new Date().toISOString();
      st.exam.finishReason = 'self';
    }
    return json(r, detail());
  });
  await page.route('**/api/admin/contests/11111111-1111-4111-8111-111111111111/exam', (r) =>
    json(r, {
      items: [
        ...st.exam.others,
        ...(st.exam.strikes > 0 || st.exam.finishedAt
          ? [
              {
                userId: 'u-me',
                handle: 'me',
                leaveCount: st.exam.strikes,
                finishedAt: st.exam.finishedAt,
                finishReason: st.exam.finishReason,
              },
            ]
          : []),
      ],
    }),
  );
  await page.route(
    '**/api/admin/contests/11111111-1111-4111-8111-111111111111/participants/*/reopen',
    (r) => {
      const userId = r.request().url().split('/').at(-2)!;
      st.exam.reopened.push(userId);
      st.exam.others = st.exam.others.map((o) =>
        o.userId === userId ? { ...o, leaveCount: 0, finishedAt: null, finishReason: null } : o,
      );
      return r.fulfill({ status: 204 });
    },
  );

  // ---- admin ----
  const admin = () => ({
    ...detail(),
    id: '11111111-1111-4111-8111-111111111111',
    state: st.published ? stateNow() : 'draft',
    problems: st.problemPuts.length
      ? (st.problemPuts.at(-1) as { items: { label: string; slug: string }[] }).items.map((i) => ({
          label: i.label,
          problemId: `pid-${i.label}`,
          slug: i.slug,
          title: 'Hop Distances',
          version: 1,
          validationStatus: 'passed',
          hidden: st.ops.hidden[i.label] ?? false,
          canaryOn: st.ops.canary[i.label] ?? false,
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
  // ---- operations (C-07) ----
  const ID = '11111111-1111-4111-8111-111111111111';
  await page.route('**/api/admin/ops/summary', (r) => json(r, st.ops.summary));
  await page.route('**/api/admin/dlq', (r) => json(r, { items: st.ops.dlq }));
  await page.route('**/api/admin/dlq/*/requeue', (r) => {
    const entry = r.request().url().split('/').at(-2)!;
    st.ops.requeued.push(entry);
    st.ops.dlq = st.ops.dlq.filter((d) => d.entryId !== entry);
    return json(r, { lane: 'contest' });
  });
  await page.route(`**/api/admin/contests/${ID}/extend`, (r) => {
    if (st.ops.extendError) {
      const message = st.ops.extendError;
      st.ops.extendError = undefined;
      return json(r, { code: 'validation', title: message, status: 400, type: 'x' }, 400);
    }
    const { minutes } = r.request().postDataJSON() as { minutes: number };
    st.ops.extended.push(minutes);
    return json(r, {
      endsAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      announcementId: 'n1',
    });
  });
  await page.route(`**/api/admin/contests/${ID}/rebuild-board`, (r) => {
    st.ops.rebuilds += 1;
    return json(r, { version: 7 });
  });
  await page.route(`**/api/admin/contests/${ID}/problems/*/visibility`, (r) => {
    const label = r.request().url().split('/').at(-2)!;
    const { hidden } = r.request().postDataJSON() as { hidden: boolean };
    st.ops.hidden[label] = hidden;
    return json(r, { hidden });
  });
  await page.route(`**/api/admin/contests/${ID}/problems/*/canary`, (r) => {
    const label = r.request().url().split('/').at(-2)!;
    const { enabled } = r.request().postDataJSON() as { enabled: boolean };
    st.ops.canary[label] = enabled;
    return json(r, { enabled });
  });
  await page.route('**/api/admin/rejudge', (r) => {
    st.ops.rejudged.push(r.request().postDataJSON() as Record<string, unknown>);
    return json(r, { queued: 3, skipped: 1, truncated: false });
  });

  // ---- AI reviews (AI-03) ----
  await page.route('**/api/reviews?**', (r) => json(r, { items: st.reviews.items }));
  await page.route('**/api/reviews/by-submission/*', (r) => {
    const sid = r.request().url().split('/').at(-1)!;
    st.reviews.opened.push(sid);
    const item = st.reviews.items.find((i) => i.submissionId === sid)!;
    if (item.status !== 'ready' && !st.reviews.busy) {
      item.status = 'ready';
      item.contentMd =
        '### Complexity\nQuadratic.\n### Edge cases you missed\nTest 4.\n### Compared with the intended approach\nUse sorting.\n### Readability\nFine.';
    }
    return json(r, {
      status: item.status,
      reviewId: item.reviewId,
      contentMd: item.contentMd,
      helpful: item.helpful,
    });
  });
  await page.route('**/api/reviews/*/rating', (r) => {
    const id = r.request().url().split('/').at(-2)!;
    const body = r.request().postDataJSON() as { helpful: boolean };
    st.reviews.ratings.push({ id, helpful: body.helpful });
    const item = st.reviews.items.find((i) => i.reviewId === id);
    if (item) item.helpful = body.helpful;
    return r.fulfill({ status: 204 });
  });

  // ---- finalising and ratings (C-08) ----
  await page.route('**/api/contests/warm-up-1/results', (r) =>
    st.ops.finalized || opts.finalized
      ? json(r, { serverNow: serverNow().toISOString(), rated: true, changes: st.ops.changes })
      : json(r, { code: 'not-found', title: 'Not found', status: 404, type: 'x' }, 404),
  );
  await page.route(`**/api/admin/contests/${ID}/finalize`, (r) => {
    st.ops.finalizes += 1;
    st.ops.finalized = true;
    return json(r, { rated: true, changes: st.ops.changes.length });
  });
  await page.route(`**/api/admin/contests/${ID}/recompute-ratings`, (r) => {
    st.ops.recomputes += 1;
    return json(r, { differing: 0, changes: st.ops.changes.length });
  });
  await page.route('**/api/users/*/ratings', (r) => {
    const handle = decodeURIComponent(r.request().url().split('/').at(-2)!);
    if (handle === 'ghost') {
      return json(r, { code: 'not-found', title: 'Not found', status: 404, type: 'x' }, 404);
    }
    if (handle === 'newbie') return json(r, { handle, rating: 1400, history: [] });
    return json(r, {
      handle,
      rating: 1493,
      history: [
        {
          contestSlug: 'c-one',
          contestTitle: 'Contest One',
          endedAt: '2026-09-01T12:00:00Z',
          rank: 4,
          oldRating: 1400,
          newRating: 1450,
          delta: 50,
        },
        {
          contestSlug: 'c-two',
          contestTitle: 'Contest Two',
          endedAt: '2026-09-15T12:00:00Z',
          rank: 9,
          oldRating: 1450,
          newRating: 1420,
          delta: -30,
        },
        {
          contestSlug: 'warm-up-1',
          contestTitle: 'Warm-up #1',
          endedAt: '2026-10-10T15:30:00Z',
          rank: 2,
          oldRating: 1420,
          newRating: 1493,
          delta: 73,
        },
      ],
    });
  });

  return st;
}
