import { describe, expect, it } from 'vitest';
import { GeminiProvider } from './providers/gemini';
import { groqProvider } from './providers/openai-compatible';
import { loadConfig } from '../../config/config';
import { providersFromConfig } from './router';
import { ProviderError, parseRetryAfter } from './types';

const reply = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });
const req = {
  messages: [
    { role: 'system' as const, content: 'rules' },
    { role: 'user' as const, content: 'hello' },
  ],
  maxTokens: 50,
};

describe('AI-01: providers', () => {
  it('Groq: sends the OpenAI chat shape with a bearer key and reads text and usage', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = groqProvider('KEY', async (url, init) => {
      seen = { url: String(url), init: init! };
      return reply({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      });
    });
    const r = await p.complete('llama-3.1-8b-instant', { ...req, json: true });
    expect(r).toEqual({ text: 'hi', usage: { inputTokens: 11, outputTokens: 3 } });
    expect(seen!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer KEY');
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toMatchObject({
      model: 'llama-3.1-8b-instant',
      max_tokens: 50,
      response_format: { type: 'json_object' },
    });
    expect(body.messages).toHaveLength(2);
  });

  it('Groq reasoning models: low effort and room for thinking; an empty answer is an error, not a hint', async () => {
    let body: Record<string, unknown> = {};
    const p = groqProvider('K', async (_url, init) => {
      body = JSON.parse(String(init!.body));
      return reply({ choices: [{ message: { content: '' } }] });
    });
    await expect(p.complete('openai/gpt-oss-120b', req)).rejects.toMatchObject({ status: 502 });
    expect(body).toMatchObject({ reasoning_effort: 'low', max_tokens: 650 });
    await p.complete('llama-x', req).catch(() => {});
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(50);
  });

  it('Gemini: system prompt goes to systemInstruction, the key to a header (never the URL)', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new GeminiProvider('GKEY', async (url, init) => {
      seen = { url: String(url), init: init! };
      return reply({
        candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      });
    });
    const r = await p.complete('gemini-2.5-flash', req);
    expect(r).toEqual({ text: 'ab', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(seen!.url).not.toContain('GKEY');
    expect((seen!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('GKEY');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('rules');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('a 429 carries the retry-after wait; a dropped connection is transient; a 400 is not', async () => {
    const limited = groqProvider('K', async () =>
      reply({}, { status: 429, headers: { 'retry-after': '7' } }),
    );
    await expect(limited.complete('m', req)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 7000,
      transient: true,
    });
    const down = groqProvider('K', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(down.complete('m', req)).rejects.toMatchObject({
      status: undefined,
      transient: true,
    });
    const bad = groqProvider('K', async () => reply({}, { status: 400 }));
    const err = await bad.complete('m', req).catch((e: ProviderError) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(false);
  });

  it('retry-after: seconds, an HTTP date, or nothing', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(
      parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')),
    ).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('AI-01: a provider is on only when it has a real key (the placeholder counts as none)', () => {
    expect(Object.keys(providersFromConfig({}))).toEqual([]);
    expect(
      Object.keys(providersFromConfig({ GROQ_API_KEY: 'not-configured', GEMINI_API_KEY: 'AIza1' })),
    ).toEqual(['gemini']);
    expect(Object.keys(providersFromConfig({ GROQ_API_KEY: 'gsk_1' }))).toEqual(['groq']);
  });

  it('AI-02 follow-up: with a relay configured, both providers call it (same paths, shared secret) instead of the providers', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const rec = async (url: URL | RequestInfo, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return reply({
        choices: [{ message: { content: 'x' } }],
        candidates: [{ content: { parts: [{ text: 'x' }] } }],
      });
    };
    const globalFetch = globalThis.fetch;
    globalThis.fetch = rec as typeof fetch;
    try {
      const p = providersFromConfig({
        GROQ_API_KEY: 'gsk_1',
        GEMINI_API_KEY: 'AIza1',
        AI_RELAY_URL: 'https://web.example/',
        AI_RELAY_SECRET: 'r'.repeat(32),
      });
      await p.groq!.complete('llama-3.1-8b-instant', req);
      await p.gemini!.complete('gemini-2.5-flash', req);
    } finally {
      globalThis.fetch = globalFetch;
    }
    expect(seen.map((s) => s.url)).toEqual([
      'https://web.example/relay/ai/groq/openai/v1/chat/completions',
      'https://web.example/relay/ai/gemini/v1beta/models/gemini-2.5-flash:generateContent',
    ]);
    for (const s of seen) expect(s.headers['x-relay-secret']).toBe('r'.repeat(32));
    expect(seen[0]!.headers.Authorization).toBe('Bearer gsk_1');
    expect(seen[1]!.headers['x-goog-api-key']).toBe('AIza1');
  });

  it('without both a relay URL and a secret, the providers are called directly (no secret header)', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      seen = { url: String(url), headers: init!.headers as Record<string, string> };
      return reply({ choices: [{ message: { content: 'x' } }] });
    }) as typeof fetch;
    try {
      const p = providersFromConfig({ GROQ_API_KEY: 'gsk_1', AI_RELAY_URL: 'https://web.example' });
      await p.groq!.complete('llama-3.1-8b-instant', req);
    } finally {
      globalThis.fetch = globalFetch;
    }
    expect(seen!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(seen!.headers['x-relay-secret']).toBeUndefined();
  });

  it('the placeholder values are accepted by the config and count as "no relay"', async () => {
    const c = loadConfig({
      NODE_ENV: 'test',
      AI_RELAY_URL: 'not-configured',
      AI_RELAY_SECRET: 'not-configured',
      GROQ_API_KEY: 'gsk_1',
    });
    let url = '';
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (async (u: URL | RequestInfo) => {
      url = String(u);
      return reply({ choices: [{ message: { content: 'x' } }] });
    }) as typeof fetch;
    try {
      await providersFromConfig(c).groq!.complete('m', req);
    } finally {
      globalThis.fetch = globalFetch;
    }
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  });
});
