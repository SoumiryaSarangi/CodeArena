import { describe, expect, it } from 'vitest';
import { GeminiProvider } from './providers/gemini';
import { groqProvider } from './providers/openai-compatible';
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
});
