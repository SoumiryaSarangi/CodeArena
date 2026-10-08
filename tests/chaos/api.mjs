// A small HTTP client for the drills: sign in the fake users, submit, read verdicts, and the admin calls.
import { randomBytes } from 'node:crypto';
import { now, sleep } from './lib.mjs';

export function makeClient(apiUrl) {
  const csrf = randomBytes(32).toString('base64url');
  const base = apiUrl.replace(/\/$/, '');

  async function call(method, path, { token, body, cookie, timeoutMs = 15_000 } = {}) {
    return fetch(`${base}/api${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        cookie: `ca_csrf=${csrf}${cookie ? `; ${cookie}` : ''}`,
        'x-csrf-token': csrf,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  const json = async (res) => (res.ok ? res.json() : null);

  /** A session for a seeded user: the refresh token becomes an access token. */
  async function login(u) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await call('POST', '/auth/refresh', { cookie: `ca_rt=${u.refreshToken}` });
      if (res.ok) {
        u.token = (await res.json()).accessToken;
        u.tokenAt = now();
        return u;
      }
      if (res.status !== 429) throw new Error(`login ${u.handle}: HTTP ${res.status}`);
      await sleep(1500);
    }
    throw new Error(`login ${u.handle}: rate limited`);
  }

  /** One contest submission. Never throws: a refused or failed call is a result (the API may be down). */
  async function submit(u, { label, language, source }, contestSlug) {
    const t0 = now();
    try {
      const res = await call('POST', '/submissions', {
        token: u.token,
        body: { contestSlug, label, language, source },
        timeoutMs: 10_000,
      });
      const body = res.ok ? await res.json() : null;
      return { status: res.status, id: body?.id ?? null, ms: now() - t0 };
    } catch (e) {
      return { status: 0, id: null, ms: now() - t0, error: String(e.message ?? e) };
    }
  }

  const mine = async (u) =>
    (await json(await call('GET', '/submissions?limit=100', { token: u.token })))?.items ?? [];
  const ready = async () => {
    try {
      return (await call('GET', '/health/ready', { timeoutMs: 3000 })).status === 200;
    } catch {
      return false;
    }
  };

  const admin = (a) => ({
    board: async (slug) => json(await call('GET', `/contests/${slug}/board`, { token: a.token })),
    rebuild: async (contestId) =>
      json(await call('POST', `/admin/contests/${contestId}/rebuild-board`, { token: a.token })),
    ops: async () => json(await call('GET', '/admin/ops/summary', { token: a.token })),
    dlq: async () => (await json(await call('GET', '/admin/dlq', { token: a.token })))?.items ?? [],
    requeue: async (entryId) => call('POST', `/admin/dlq/${entryId}/requeue`, { token: a.token }),
    submission: async (id) => json(await call('GET', `/submissions/${id}`, { token: a.token })),
    contest: async (slug) => json(await call('GET', `/contests/${slug}`, { token: a.token })),
  });

  /** A live-update listener on one topic that reconnects like the browser does, and keeps score. */
  function listen(u, topic) {
    const stats = { connected: 0, reconnects: 0, errors: 0, eventTimes: [], stop: false };
    (async () => {
      let everConnected = false;
      while (!stats.stop) {
        try {
          const tr = await call('POST', '/realtime/ticket', {
            token: u.token,
            body: { topics: [topic] },
          });
          if (!tr.ok) throw new Error(`ticket ${tr.status}`);
          const { ticket } = await tr.json();
          const res = await fetch(
            `${base}/api/sse?ticket=${ticket}&topics=${encodeURIComponent(topic)}`,
            {
              headers: { accept: 'text/event-stream' },
            },
          );
          if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
          if (everConnected) stats.reconnects++;
          everConnected = true;
          stats.connected++;
          let buf = '';
          const dec = new TextDecoder();
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (/^event:/m.test(frame)) stats.eventTimes.push(now());
            }
            if (stats.stop) break;
          }
          stats.connected--;
        } catch {
          stats.errors++;
        }
        if (!stats.stop) await sleep(1000);
      }
    })();
    return stats;
  }

  return { call, login, submit, mine, ready, admin, listen, base };
}
