import { type Provider, ProviderError, type ProviderName, parseRetryAfter } from '../types';

type Fetch = typeof fetch;

interface Options {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  timeoutMs?: number;
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model,
          messages: req.messages,
          max_tokens: req.maxTokens,
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
    if (typeof text !== 'string') throw new ProviderError(`${this.name} sent no text`, 502);
    return {
      text,
      usage: {
        inputTokens: body?.usage?.prompt_tokens ?? 0,
        outputTokens: body?.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export const groqProvider = (apiKey: string, fetchImpl?: Fetch) =>
  new OpenAiCompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey,
    fetch: fetchImpl,
  });
