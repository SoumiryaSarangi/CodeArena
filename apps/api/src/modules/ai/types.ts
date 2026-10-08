/** What the AI layer is asked to do. Each task has its own model chain (SD-§12.1). */
export const AI_TASKS = [
  'sufficiency',
  'hint_main',
  'code_removal',
  'review',
  'room_summary',
  'leak_judge',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export type ProviderName = 'groq' | 'gemini' | 'fake';

/** One model on one provider. The budget key is `provider:model`. */
export interface ModelRef {
  provider: ProviderName;
  model: string;
}
export const modelKey = (m: ModelRef) => `${m.provider}:${m.model}`;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** What a caller asks the router for. `feature` names who is spending tokens (hint, review, eval...). */
export interface CompleteRequest {
  task: AiTask;
  feature: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Answer as JSON (providers that support it). */
  json?: boolean;
}

export interface CompleteResult {
  text: string;
  usage: Usage;
  /** `provider:model` that answered. */
  model: string;
  /** How many models were tried before this one answered (0 = the primary). */
  fallbacks: number;
  latencyMs: number;
}

/** One provider's raw call: no budgets, no retries (the router owns those). */
export interface Provider {
  readonly name: ProviderName;
  complete(
    model: string,
    req: Pick<CompleteRequest, 'messages' | 'maxTokens' | 'temperature' | 'json'>,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: Usage }>;
}

/** A failed provider call. `retryAfterMs` comes from the `retry-after` header on 429/503. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  /** Worth trying the same model again after a wait. */
  get transient() {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}

/** `retry-after` is seconds or an HTTP date; returns milliseconds or undefined. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}
