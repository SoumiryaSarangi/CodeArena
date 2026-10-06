import { describe, expect, it } from 'vitest';
import { ApiError, AuthClient, apiFetch } from '@/lib/api';
import { RealtimeConnection, type EventSourceLike, type RealtimeEvent } from '@/lib/realtime';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });

/** A fetch that answers from a script and records every call. */
function scripted(answers: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answers(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('UI-02: access token handling (FR-AUTH-04/05)', () => {
  it('refreshes with the CSRF header and keeps the token for next time', async () => {
    let t = 0;
    const f = scripted(() => json({ accessToken: 'A1', expiresAt: 900_000 }));
    const c = new AuthClient(
      f.fn,
      () => t,
      () => 'csrf-1',
    );
    expect(await c.accessToken()).toBe('A1');
    expect(await c.accessToken()).toBe('A1');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('/api/auth/refresh');
    expect((f.calls[0]!.init!.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1');
    t = 850_000; // under a minute left: refresh again
    f.calls.length = 0;
    await c.accessToken();
    expect(f.calls).toHaveLength(1);
  });

  it('shares one refresh between concurrent callers (each refresh rotates the cookie)', async () => {
    const f = scripted(() => json({ accessToken: 'A', expiresAt: Date.now() + 900_000 }));
    const c = new AuthClient(f.fn, Date.now, () => 'x');
    const got = await Promise.all([c.accessToken(), c.accessToken(), c.accessToken()]);
    expect(got).toEqual(['A', 'A', 'A']);
    expect(f.calls.filter((x) => x.url === '/api/auth/refresh')).toHaveLength(1);
  });

  it('a refused refresh means guest, and is not retried on every request', async () => {
    let t = 0;
    const f = scripted(() => json({ code: 'unauthorized' }, { status: 401 }));
    const c = new AuthClient(
      f.fn,
      () => t,
      () => 'x',
    );
    expect(await c.accessToken()).toBeNull();
    expect(await c.accessToken()).toBeNull();
    expect(await c.accessToken()).toBeNull();
    expect(f.calls).toHaveLength(1);
    t = 31_000;
    await c.accessToken();
    expect(f.calls).toHaveLength(2);
  });

  it('fetches a CSRF cookie first if there is none, and a network failure keeps the old token', async () => {
    let csrf: string | null = null;
    const f = scripted((url) => {
      if (url === '/api/health/live') {
        csrf = 'fresh';
        return json({});
      }
      return json({ accessToken: 'B', expiresAt: Date.now() + 900_000 });
    });
    const c = new AuthClient(f.fn, Date.now, () => csrf);
    expect(await c.accessToken()).toBe('B');
    expect(f.calls.map((x) => x.url)).toEqual(['/api/health/live', '/api/auth/refresh']);

    let t = 0;
    let down = false;
    const g = scripted(() => {
      if (down) throw new TypeError('offline');
      return json({ accessToken: 'C', expiresAt: 100_000 });
    });
    const c2 = new AuthClient(
      g.fn,
      () => t,
      () => 'x',
    );
    expect(await c2.accessToken()).toBe('C');
    down = true;
    t = 90_000;
    expect(await c2.accessToken()).toBe('C'); // offline: keep what we have
  });
});

describe('UI-02: apiFetch', () => {
  const signedIn = (token = 'T1') =>
    ({
      accessToken: async () => token,
      refresh: async () => 'T2',
      clear() {},
    }) as unknown as AuthClient;

  it('sends the bearer token, JSON body and Idempotency-Key', async () => {
    const f = scripted(() => json({ id: '1' }, { status: 201 }));
    const r = await apiFetch(
      'POST',
      '/submissions',
      { a: 1 },
      { idempotencyKey: 'k' },
      signedIn(),
      f.fn,
    );
    expect(r).toEqual({ id: '1' });
    const h = f.calls[0]!.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer T1');
    expect(h['Idempotency-Key']).toBe('k');
    expect(h['Content-Type']).toBe('application/json');
    expect(f.calls[0]!.init!.body).toBe('{"a":1}');
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    let n = 0;
    const f = scripted((_u, init) => {
      n++;
      const bearer = (init!.headers as Record<string, string>).Authorization;
      return bearer === 'Bearer T2'
        ? json({ ok: true })
        : json({ code: 'unauthorized' }, { status: 401 });
    });
    expect(await apiFetch('GET', '/me', undefined, {}, signedIn(), f.fn)).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('turns problem+json into an ApiError with request id, Retry-After and field errors', async () => {
    const f = scripted(() =>
      json(
        {
          code: 'rate-limited',
          detail: 'Retry in 8s',
          instance: 'req-9',
          errors: [{ path: 'x', message: 'bad' }],
        },
        {
          status: 429,
          headers: { 'Retry-After': '8', 'Content-Type': 'application/problem+json' },
        },
      ),
    );
    const err = await apiFetch('POST', '/submissions', {}, {}, signedIn(), f.fn).catch(
      (e) => e as ApiError,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      code: 'rate-limited',
      requestId: 'req-9',
      retryAfter: 8,
    });
    expect((err as ApiError).errors).toEqual([{ path: 'x', message: 'bad' }]);
  });

  it('required auth fails fast for a guest, without calling the API', async () => {
    const guest = {
      accessToken: async () => null,
      refresh: async () => null,
      clear() {},
    } as unknown as AuthClient;
    const f = scripted(() => json({}));
    await expect(
      apiFetch('POST', '/runs', {}, { auth: 'required' }, guest, f.fn),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(0);
  });

  it('a dropped connection is a friendly network error', async () => {
    const f = scripted(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(apiFetch('GET', '/x', undefined, {}, signedIn(), f.fn)).rejects.toMatchObject({
      code: 'network',
    });
  });
});

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: { data: string; lastEventId: string }) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string; lastEventId: string }) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, id: string, data: object) {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId: id });
  }
}

describe('UI-02: realtime connection (FR-RT-01/02)', () => {
  const setup = (over: { online?: boolean; ticketFails?: () => boolean } = {}) => {
    FakeSource.all = [];
    let n = 0;
    const events: RealtimeEvent[] = [];
    const states: string[] = [];
    const tickets: string[] = [];
    const conn = new RealtimeConnection(
      ['sub:abc'],
      (e) => events.push(e),
      (s) => states.push(s),
      {
        getTicket: async () => {
          if (over.ticketFails?.()) throw new Error('no ticket');
          const t = `ticket-${++n}`;
          tickets.push(t);
          return t;
        },
        createSource: (url) => new FakeSource(url),
        backoffMs: [5, 10],
        random: () => 0.5,
        isOnline: () => over.online ?? true,
      },
    );
    return { conn, events, states, tickets };
  };
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it('connects with a ticket, and delivers parsed events with their id', async () => {
    const { conn, events, states } = setup();
    conn.start();
    await tick(5);
    const es = FakeSource.all[0]!;
    expect(es.url).toBe('/api/sse?ticket=ticket-1&topics=sub%3Aabc');
    es.onopen!();
    es.emit('submission.progress', '5-0', {
      topic: 'sub:abc',
      type: 'submission.progress',
      ts: 1,
      data: { phase: 'claimed' },
    });
    es.listeners.get('submission.progress')!({ data: 'not json', lastEventId: '5-1' });
    expect(states).toEqual(['connected']);
    expect(events).toEqual([
      {
        id: '5-0',
        topic: 'sub:abc',
        type: 'submission.progress',
        ts: 1,
        data: { phase: 'claimed' },
      },
    ]);
    conn.close();
  });

  it('after a drop it fetches a NEW ticket and resumes from the last event id', async () => {
    const { conn, states, tickets } = setup();
    conn.start();
    await tick(5);
    const first = FakeSource.all[0]!;
    first.onopen!();
    first.emit('submission.progress', '7-3', {
      topic: 'sub:abc',
      type: 'submission.progress',
      ts: 1,
      data: {},
    });
    first.onerror!();
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    await tick(40);
    const second = FakeSource.all[1]!;
    expect(tickets).toEqual(['ticket-1', 'ticket-2']);
    expect(second.url).toContain('ticket=ticket-2');
    expect(second.url).toContain('lastEventId=7-3');
    second.onopen!();
    expect(states.at(-1)).toBe('connected');
    conn.close();
  });

  it('backs off between attempts and keeps trying when tickets cannot be fetched', async () => {
    let failing = true;
    const { conn, states } = setup({ ticketFails: () => failing });
    conn.start();
    await tick(40);
    expect(states).toEqual(['reconnecting']);
    expect(FakeSource.all).toHaveLength(0);
    failing = false;
    await tick(40);
    expect(FakeSource.all.length).toBeGreaterThanOrEqual(1);
    conn.close();
  });

  it('says offline only when the browser is offline and attempts keep failing', async () => {
    const { conn, states } = setup({ online: false, ticketFails: () => true });
    conn.start();
    await tick(60);
    expect(states).toEqual(['reconnecting', 'offline']);
    conn.close();
  });

  it('close() stops everything: no more sources, no more timers', async () => {
    const { conn } = setup();
    conn.start();
    await tick(5);
    FakeSource.all[0]!.onerror!();
    conn.close();
    await tick(40);
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(true);
  });
});
