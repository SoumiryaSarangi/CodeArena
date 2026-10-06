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
}

export interface StubOptions {
  signedIn?: boolean;
  handle?: string | null;
  /** Answer the next submit with 429. */
  rateLimit?: { retryAfter: number };
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
  const calls: Calls = { submissions: [], runs: [], tickets: [], refreshes: 0, patchMe: [] };
  const state = {
    rateLimit: o.rateLimit,
    handle: o.handle,
    /** What `GET /api/runs/:id` answers, by run id; anything else is a plain successful run. */
    runResults: {} as Record<string, object>,
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
      role: 'user',
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
  await page.route('**/api/submissions/S1', (r) =>
    json(r, { id: 'S1', verdict: 'AC', status: 'done', tests: [], compileLog: null }),
  );
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
