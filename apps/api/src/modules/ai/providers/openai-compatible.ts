import { type Provider, ProviderError, type ProviderName, parseRetryAfter } from '../types';

type Fetch = typeof fetch;

const REASONING_HEADROOM = 600;
const reasons = (model: string) => /gpt-oss/.test(model);

interface Options {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Extra request headers (the relay's shared secret). */
  headers?: Record<string, string>;
}

/** Chat-completions over HTTP, the shape Groq (and many others) speak. No SDK: one fetch. */
export class OpenAiCompatibleProvider implements Provider {
  readonly name: ProviderName;
  private readonly doFetch: Fetch;

  constructor(private readonly o: Options) {
    this.name = o.name;
    this.doFetch = o.fetch ?? ((...a) => fetch(...a));
  }

  async complete(
    model: string,
    req: Parameters<Provider['complete']>[1],
    signal?: AbortSignal,
  ): ReturnType<Provider['complete']> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.o.apiKey}`,
          ...this.o.headers,
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          // gpt-oss and other reasoning models spend completion tokens on thinking first: keep the effort low and
          // leave room, or the visible answer comes back empty.
          max_tokens: req.maxTokens + (reasons(model) ? REASONING_HEADROOM : 0),
          ...(reasons(model) ? { reasoning_effort: 'low' } : {}),
          temperature: req.temperature ?? 0.2,
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: signal ?? AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new ProviderError(`${this.name} request failed: ${(err as Error).message}`, undefined);
    }
    if (!res.ok) {
      throw new ProviderError(
        `${this.name} answered ${res.status}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '')
      throw new ProviderError(`${this.name} sent no text`, 502);
    return {
      text,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const groqProvider = (
  apiKey: string,
  fetchImpl?: Fetch,
  opts: { baseUrl?: string; headers?: Record<string, string> } = {},
) =>
  new OpenAiCompatibleProvider({
    name: 'groq',
    baseUrl: opts.baseUrl ?? GROQ_BASE_URL,
    apiKey,
    fetch: fetchImpl,
    headers: opts.headers,
  });
