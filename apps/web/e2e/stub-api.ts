import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * A stand-in for the API and the realtime stream, so UI behaviour is tested in isolation (the API's
 * own tests cover the data, and the live spec covers the two together).
 *
 * `window.__sse` replaces EventSource: the test pushes events at chosen moments, so every step of a
 * submission (queued, claimed, tests, verdict) can be looked at, and a dropped connection simulated.
 */
export const SAMPLE_PROBLEM = {
  slug: 'sum-two-numbers',
  title: 'Two Numbers, One Total',
  difficulty: 800,
  practicePoints: 8,
  tags: ['implementation', 'math'],
  version: 1,
  testsCount: 4,
  statementMd:
    '# Two Numbers, One Total\n\nGiven $a$ and $b$, print $a + b$.\n\n## Input\n\nTwo integers, $-10^{18} \\le a, b \\le 10^{18}$.\n\n## Output\n\nOne integer.\n\n## Notes\n\nFits in 64 bits.\n',
  samples: [
    { in: '2 3\n', out: '5\n' },
    { in: '10 -4\n', out: '6\n' },
  ],
  limits: { timeMs: 1000, memMb: 256, outputKb: 1024 },
  checker: { kind: 'tokens' },
};

export interface Calls {
  submissions: { body: Record<string, unknown>; headers: Record<string, string> }[];
  runs: { body: Record<string, unknown>; headers: Record<string, string> }[];
  tickets: string[][];
  refreshes: number;
  patchMe: Record<string, unknown>[];
  hints: { level: number }[];
  ratings: { id: string; helpful: boolean }[];
}

export interface StubOptions {
  signedIn?: boolean;
  handle?: string | null;
  /** Answer the next submit with 429. */
  rateLimit?: { retryAfter: number };
  /** Answer this many submits with 503 (the API is restarting) before accepting one. */
  unavailable?: number;
  /** The Coach tab (UI-06). `off` switches hints off with that message; `reply` makes the next unlock fail busy or answer a nudge. */
  hints?: { off?: string; reply?: 'busy' | 'nudge'; practicePoints?: number | null };
  /** The signed-in user's role (default user). */
  role?: 'user' | 'setter' | 'admin';
  /** Taken handles for the availability check. */
  takenHandles?: string[];
  /** Handles that look free but are taken by the time you save (a race): saving answers 409. */
  racedHandles?: string[];
}

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    headers,
    body: JSON.stringify(body),
  });

export async function stubApi(page: Page, opts: StubOptions = {}) {
  const o = { signedIn: true, handle: 'riya_k' as string | null, ...opts };
  const calls: Calls = {
    submissions: [],
    runs: [],
    tickets: [],
    refreshes: 0,
    patchMe: [],
    hints: [],
    ratings: [],
  };
  const state = {
    rateLimit: o.rateLimit,
    unavailable: o.unavailable ?? 0,
    hintReply: o.hints?.reply,
    delivered: {} as Record<number, { id: string; text: string; helpful: boolean | null }>,
    handle: o.handle,
    /** What `GET /api/runs/:id` answers, by run id; anything else is a plain successful run. */
    runResults: {} as Record<string, object>,
    /** What `GET /api/submissions/:id` answers, by id. */
    details: {} as Record<string, object>,
    /** What `GET /api/me/home` and `GET /api/users/:handle/profile` answer (UI-05). */
    home: {
      nextContest: {
        slug: 'warm-up-1',
        title: 'CodeArena Warm-up #1',
        startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000 + 7_200_000).toISOString(),
        state: 'scheduled',
        registered: false,
      },
      continuePracticing: [
        {
          slug: 'sum-two-numbers',
          title: 'Two Numbers, One Total',
          solved: true,
          lastVerdict: 'AC',
        },
        { slug: 'fractional-loot', title: 'Fractional Loot', solved: false, lastVerdict: 'WA' },
      ],
      warmUps: [],
    } as Record<string, unknown>,
    profile: {
      handle: 'riya_k',
      avatarUrl: null,
      rating: 1493,
      joinedAt: '2026-09-01T10:00:00.000Z',
      solved: {
        total: 7,
        byDifficulty: [
          { label: 'Under 1000', count: 4 },
          { label: '1000–1399', count: 2 },
          { label: '1400–1799', count: 1 },
          { label: '1800 and up', count: 0 },
        ],
        byTag: [
          { tag: 'math', count: 5 },
          { tag: 'greedy', count: 3 },
        ],
      },
      activity: {
        from: new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10),
        total: 15,
        days: [
          { date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), count: 9 },
          { date: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10), count: 4 },
          { date: new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10), count: 2 },
        ],
      },
    } as Record<string, unknown>,
    /** What `GET /api/status` answers (O-02). */
    status: {
      serverNow: new Date().toISOString(),
      overall: 'ok',
      components: [
        { id: 'api', label: 'API', state: 'ok', detail: 'Answering requests' },
        { id: 'database', label: 'Database', state: 'ok', detail: 'Reachable' },
        { id: 'queue', label: 'Judging queue', state: 'ok', detail: 'Jobs are being picked up' },
        { id: 'judges', label: 'Judges', state: 'ok', detail: '2 judges reporting' },
        {
          id: 'realtime',
          label: 'Live updates',
          state: 'ok',
          detail: 'Verdicts and scoreboards stream live',
        },
        { id: 'pad', label: 'Interview pad', state: 'planned', detail: 'Not released yet' },
      ],
      queue: [
        { lane: 'contest', depth: 0 },
        { lane: 'interactive', depth: 0 },
        { lane: 'practice', depth: 3 },
        { lane: 'rejudge', depth: 0 },
      ],
      p50Ms: 1200,
      p95Ms: 3400,
      totals: { submissionsJudged: 1234, contestsHosted: 2 },
    } as Record<string, unknown>,
  };

  const context: BrowserContext = page.context();
  await context.addCookies([
    { name: 'ca_csrf', value: 'c'.repeat(43), url: 'http://localhost:3123' },
  ]);

  await page.addInitScript(() => {
    type Listener = (e: { data: string; lastEventId: string }) => void;
    class FakeEventSource {
      listeners: Record<string, Listener> = {};
      readyState = 0;
      closed = false;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        w.__sse.sources.push(this);
        setTimeout(() => {
          if (this.closed) return;
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
      addEventListener(type: string, fn: Listener) {
        this.listeners[type] = fn;
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
    }
    const w = window as unknown as {
      __sse: {
        sources: FakeEventSource[];
        emit: (part: string, type: string, id: string, data: unknown) => number;
        drop: (part: string) => void;
        urls: () => string[];
      };
      EventSource: unknown;
    };
    w.__sse = {
      sources: [],
      emit(part, type, id, envelope) {
        let n = 0;
        for (const s of w.__sse.sources)
          if (!s.closed && s.url.includes(part)) {
            s.listeners[type]?.({ data: JSON.stringify(envelope), lastEventId: id });
            n++;
          }
        return n;
      },
      drop(part) {
        for (const s of w.__sse.sources) if (!s.closed && s.url.includes(part)) s.onerror?.();
      },
      urls: () => w.__sse.sources.map((s) => s.url),
    };
    w.EventSource = FakeEventSource;
  });

  await page.route('**/api/problems?**', (r) => json(r, { items: [], nextCursor: null }));
  await page.route('**/api/problems/tags', (r) => json(r, { items: [] }));
  await page.route('**/api/status', (r) => json(r, state.status));
  await page.route('**/api/me/home', (r) => json(r, state.home));
  await page.route('**/api/users/*/profile', (r) => {
    const handle = decodeURIComponent(r.request().url().split('/').at(-2)!);
    return handle === 'ghost'
      ? json(r, { code: 'not-found', title: 'Not found', status: 404, type: 'x' }, 404)
      : json(r, { ...state.profile, handle });
  });
  await page.route('**/api/health/live', (r) => json(r, { status: 'ok' }));
  await page.route('**/api/auth/refresh', (r) => {
    calls.refreshes++;
    return o.signedIn
      ? json(r, { accessToken: 'tok', expiresAt: Date.now() + 15 * 60_000 })
      : json(r, { code: 'unauthorized', title: 'Unauthorized', status: 401, type: 'x' }, 401);
  });
  await page.route('**/api/auth/logout', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/me', (r) => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      calls.patchMe.push(body);
      if ([...(o.takenHandles ?? []), ...(o.racedHandles ?? [])].includes(String(body.handle)))
        return json(
          r,
          { code: 'handle-taken', title: 'Handle already taken', status: 409, type: 'x' },
          409,
        );
      state.handle = String(body.handle);
      return json(r, { id: 'u1' });
    }
    return json(r, {
      id: 'u1',
      handle: state.handle,
      name: 'Riya',
      email: 'riya@example.test',
      avatarUrl: null,
      role: o.role ?? 'user',
      rating: 1400,
      defaultLanguage: 'cpp17',
    });
  });
  await page.route('**/api/handles/*/available', (r) => {
    const h = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2)!);
    return json(
      r,
      o.takenHandles?.includes(h) ? { available: false, reason: 'taken' } : { available: true },
    );
  });
  await page.route('**/api/problems/sum-two-numbers', (r) => json(r, SAMPLE_PROBLEM));
  await page.route('**/api/problems/nope', (r) =>
    json(r, { code: 'not-found', title: 'Not found', status: 404, type: 'x' }, 404),
  );
  await page.route('**/api/realtime/ticket', (r) => {
    calls.tickets.push((r.request().postDataJSON() as { topics: string[] }).topics);
    return json(r, { ticket: `ticket-${calls.tickets.length}`, expiresAt: Date.now() + 60_000 });
  });
  const hintPoints = o.hints?.practicePoints === undefined ? 100 : o.hints.practicePoints;
  const hintState = () => {
    const pct = state.delivered[3] ? 50 : state.delivered[2] ? 25 : state.delivered[1] ? 10 : 0;
    return {
      enabled: !o.hints?.off,
      disabledReason: o.hints?.off ?? null,
      levels: ([1, 2, 3] as const).map((level) => {
        const d = state.delivered[level];
        return {
          level,
          status: d
            ? 'delivered'
            : level === 1 || state.delivered[level - 1]
              ? 'available'
              : 'locked',
          costPercent: [10, 25, 50][level - 1],
          hintId: d?.id ?? null,
          text: d?.text ?? null,
          helpful: d?.helpful ?? null,
        };
      }),
      practicePoints: hintPoints,
      effectivePoints: hintPoints === null ? null : Math.round((hintPoints * (100 - pct)) / 100),
      penaltyPercent: pct,
      remainingThisHour: 10 - calls.hints.length,
    };
  };
  await page.route('**/api/hints?**', (r) => json(r, hintState()));
  await page.route('**/api/hints', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const { level } = r.request().postDataJSON() as { level: 1 | 2 | 3 };
    calls.hints.push({ level });
    if (state.hintReply === 'busy') {
      state.hintReply = undefined;
      return json(
        r,
        {
          code: 'ai-busy',
          title: 'AI is busy',
          detail: 'Hints are busy, try again in a minute.',
          status: 503,
          type: 'x',
        },
        503,
      );
    }
    if (state.hintReply === 'nudge') {
      state.hintReply = undefined;
      return json(r, { hint: null, nudge: 'Write and run an attempt first, then ask again.' });
    }
    const id = `00000000-0000-4000-8000-00000000000${level}`;
    state.delivered[level] = {
      id,
      text: `Hint text for level ${level}: think about **sorting**.`,
      helpful: null,
    };
    return json(r, {
      hint: {
        id,
        level,
        text: state.delivered[level].text,
        penaltyPercent: [10, 25, 50][level - 1],
        cached: false,
        generic: false,
      },
      nudge: null,
    });
  });
  await page.route('**/api/hints/*/rating', (r) => {
    const body = r.request().postDataJSON() as { helpful: boolean };
    const id = r.request().url().split('/').at(-2)!;
    calls.ratings.push({ id, helpful: body.helpful });
    for (const d of Object.values(state.delivered)) if (d.id === id) d.helpful = body.helpful;
    return r.fulfill({ status: 204 });
  });
  await page.route('**/api/submissions?**', (r) =>
    json(r, {
      items: [
        {
          id: 'old-1',
          problemSlug: 'sum-two-numbers',
          problemTitle: 'Two Numbers, One Total',
          language: 'cpp17',
          status: 'done',
          verdict: 'WA',
          timeMs: 12,
          memKb: 2000,
          failedTest: 3,
          lane: 'practice',
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    }),
  );
  await page.route('**/api/submissions', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    calls.submissions.push({ body: r.request().postDataJSON(), headers: r.request().headers() });
    if (state.unavailable) {
      state.unavailable--;
      return json(r, { code: 'internal', title: 'Unavailable', status: 503, type: 'x' }, 503);
    }
    if (state.rateLimit) {
      const { retryAfter } = state.rateLimit;
      state.rateLimit = undefined;
      return json(
        r,
        {
          code: 'rate-limited',
          title: 'Too many requests',
          status: 429,
          type: 'x',
          instance: 'req-1',
        },
        429,
        {
          'Retry-After': String(retryAfter),
        },
      );
    }
    return json(r, { id: 'S1', lane: 'practice', position: 3, etaSeconds: 5 }, 201);
  });
  await page.route(/\/api\/submissions\/[\w-]+$/, (r) => {
    const id = r.request().url().split('/').at(-1)!;
    const d =
      state.details[id] ??
      (id === 'S1'
        ? { id: 'S1', verdict: 'AC', status: 'done', tests: [], compileLog: null }
        : null);
    return d
      ? json(r, d)
      : json(
          r,
          { code: 'not-found', title: 'Not found', status: 404, type: 'x', instance: 'req-404' },
          404,
        );
  });
  await page.route('**/api/runs', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON() as { sampleIds?: number[] };
    calls.runs.push({ body, headers: r.request().headers() });
    const ids = (body.sampleIds ? [...new Set(body.sampleIds)] : [0]).map(
      (_, i) => `R${calls.runs.length}-${i + 1}`,
    );
    return json(r, { runId: ids[0], runIds: ids }, 201);
  });
  await page.route(/\/api\/runs\/R[\w-]+$/, (r) => {
    const id = r.request().url().split('/').at(-1)!;
    return json(
      r,
      state.runResults[id] ?? {
        id,
        status: 'done',
        verdict: 'AC',
        timeMs: 5,
        memKb: 1000,
        output: '5\n',
        stderr: null,
        compileLog: null,
        expected: null,
        matches: null,
      },
    );
  });
  return { calls, state };
}

/** Pushes one SSE event to whoever listens on a topic containing `part`. */
export const emit = (
  page: Page,
  part: string,
  type: string,
  id: string,
  data: unknown,
  topic = `sub:${part}`,
) =>
  page.evaluate(
    ([p, t, i, env]) =>
      (
        window as unknown as {
          __sse: { emit: (a: string, b: string, c: string, d: unknown) => number };
        }
      ).__sse.emit(p, t, i, env),
    [part, type, id, { topic, type, ts: Date.now(), data }] as const,
  );

export const drop = (page: Page, part: string) =>
  page.evaluate(
    (p) => (window as unknown as { __sse: { drop: (a: string) => void } }).__sse.drop(p),
    part,
  );

export const sseUrls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sse: { urls: () => string[] } }).__sse.urls());

export const progress = (id: string, phase: string, extra: object = {}) => ({
  submissionId: id,
  runVersion: 1,
  phase,
  workerId: 'judge-2',
  ts: Date.now(),
  ...extra,
});

export const runVerdict = (id: string, verdict = 'AC') => ({
  submissionId: id,
  runVersion: 1,
  status: 'done',
  verdict,
  timeMs: 5,
  memKb: 1000,
  failedTest: null,
});
