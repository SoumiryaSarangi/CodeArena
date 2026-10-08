import { type Provider, ProviderError, parseRetryAfter } from '../types';

type Fetch = typeof fetch;

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Google AI Studio `generateContent` over HTTP (free tier). The key goes in a header, never the URL. */
export class GeminiProvider implements Provider {
  readonly name = 'gemini' as const;
  private readonly doFetch: Fetch;

  constructor(
    private readonly apiKey: string,
    fetchImpl?: Fetch,
    private readonly baseUrl = GEMINI_BASE_URL,
    private readonly extraHeaders: Record<string, string> = {},
  ) {
    this.doFetch = fetchImpl ?? ((...a) => fetch(...a));
  }

  async complete(
    model: string,
    req: Parameters<Provider['complete']>[1],
    signal?: AbortSignal,
  ): ReturnType<Provider['complete']> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    let res: Response;
    try {
      res = await this.doFetch(
        `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
            ...this.extraHeaders,
          },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: {
              maxOutputTokens: req.maxTokens,
              temperature: req.temperature ?? 0.2,
              ...(req.json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
          signal: signal ?? AbortSignal.timeout(30_000),
        },
      );
    } catch (err) {
      throw new ProviderError(`gemini request failed: ${(err as Error).message}`, undefined);
    }
    if (!res.ok) {
      throw new ProviderError(
        `gemini answered ${res.status}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const body = (await res.json().catch(() => null)) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    } | null;
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!text) throw new ProviderError('gemini sent no text', 502);
    return {
      text,
      usage: {
        inputTokens: body?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
