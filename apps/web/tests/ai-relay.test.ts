import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, relayAi } from '../lib/ai-relay';

const SECRET = 'a'.repeat(32);
const env = { AI_RELAY_SECRET: SECRET };
const groq = { provider: 'groq', path: ['openai', 'v1', 'chat', 'completions'] };
const gemini = {
  provider: 'gemini',
  path: ['v1beta', 'models', 'gemini-2.5-flash:generateContent'],
};

const post = (headers: Record<string, string> = {}, body = '{"x":1}') =>
  new Request('https://web.test/relay/ai/x', {
    method: 'POST',
    headers: { 'x-relay-secret': SECRET, 'content-type': 'application/json', ...headers },
    body,
  });

/** Records what the relay sent upstream. */
const spy = (status = 200, headers: Record<string, string> = {}, body = '{"ok":true}') => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { calls, fn };
};

describe('AI egress relay (AI-02 follow-up)', () => {
  it('forwards a Groq call to the fixed host with the key, and returns status, body and retry-after', async () => {
    const s = spy(429, {
      'retry-after': '7',
      'content-type': 'application/json',
      'set-cookie': 'x=1',
    });
    const res = await relayAi(
      post({ authorization: 'Bearer gsk_k', cookie: 'sess=1' }),
      groq,
      env,
      s.fn,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('{"ok":true}');
    expect(s.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const sent = s.calls[0]!.init.headers as Headers;
    expect(sent.get('authorization')).toBe('Bearer gsk_k');
    expect(sent.get('x-relay-secret')).toBeNull(); // our secret never leaves
    expect(sent.get('cookie')).toBeNull();
    expect(s.calls[0]!.init.body).toBe('{"x":1}');
  });

  it('forwards a Gemini call with its key header', async () => {
    const s = spy();
    const res = await relayAi(post({ 'x-goog-api-key': 'AIza_k' }), gemini, env, s.fn);
    expect(res.status).toBe(200);
    expect(s.calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect((s.calls[0]!.init.headers as Headers).get('x-goog-api-key')).toBe('AIza_k');
  });

  it('401 without the right secret (and nothing goes upstream); 503 when no secret is configured', async () => {
    const s = spy();
    expect((await relayAi(post({ 'x-relay-secret': 'wrong' }), groq, env, s.fn)).status).toBe(401);
    expect(
      (
        await relayAi(
          new Request('https://web.test/x', { method: 'POST', body: '{}' }),
          groq,
          env,
          s.fn,
        )
      ).status,
    ).toBe(401);
    expect((await relayAi(post({ 'x-relay-secret': SECRET + 'x' }), groq, env, s.fn)).status).toBe(
      401,
    );
    expect((await relayAi(post(), groq, {}, s.fn)).status).toBe(503);
    expect(
      (await relayAi(post({ 'x-relay-secret': 'short' }), groq, { AI_RELAY_SECRET: 'short' }, s.fn))
        .status,
    ).toBe(503);
    expect(s.calls).toHaveLength(0);
  });

  it('only the two chat paths exist: other providers, paths, traversal and hosts are 404', async () => {
    const s = spy();
    for (const route of [
      { provider: 'openai', path: ['v1', 'chat', 'completions'] },
      { provider: 'groq', path: ['openai', 'v1', 'models'] },
      { provider: 'groq', path: ['openai', 'v1', 'chat', 'completions', 'x'] },
      { provider: 'groq', path: ['..', 'admin'] },
      { provider: 'groq', path: ['openai', 'v1', 'chat', 'completions?a=b'] },
      { provider: 'gemini', path: ['v1beta', 'models', '../x:generateContent'] },
      { provider: 'gemini', path: ['v1beta', 'models', 'm:streamGenerateContent'] },
      { provider: '//evil.test', path: ['openai', 'v1', 'chat', 'completions'] },
    ]) {
      expect((await relayAi(post(), route, env, s.fn)).status, JSON.stringify(route)).toBe(404);
    }
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a body over the cap, by header and by size', async () => {
    const s = spy();
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    expect((await relayAi(post({}, big), groq, env, s.fn)).status).toBe(413);
    expect(
      (await relayAi(post({ 'content-length': String(MAX_BODY_BYTES + 5) }), groq, env, s.fn))
        .status,
    ).toBe(413);
    expect(s.calls).toHaveLength(0);
  });

  it('an unreachable upstream is a 502, and redirects are not followed', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect((await relayAi(post(), groq, env, down)).status).toBe(502);
    const s = spy();
    await relayAi(post(), groq, env, s.fn);
    expect(s.calls[0]!.init.redirect).toBe('error');
  });
});
