import { z } from 'zod';
import type { Config } from '../../config/config';
import { AI_TASKS, type AiTask, type ModelRef, modelKey } from './types';

/**
 * Task → model chain, primary first (SD-§12.1). Switching or reordering providers is a config change:
 * set `AI_ROUTES` (JSON) to override any task; no code changes.
 */
export const DEFAULT_ROUTES: Record<AiTask, ModelRef[]> = {
  sufficiency: [
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'gemini', model: 'gemini-flash-lite-latest' },
  ],
  hint_main: [
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'gemini', model: 'gemini-3.5-flash' },
  ],
  code_removal: [
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'gemini', model: 'gemini-flash-lite-latest' },
  ],
  review: [
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
    { provider: 'gemini', model: 'gemini-3.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
  ],
  room_summary: [
    { provider: 'gemini', model: 'gemini-3.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
  ],
  leak_judge: [
    { provider: 'gemini', model: 'gemini-3.5-flash' },
    { provider: 'groq', model: 'openai/gpt-oss-120b' },
  ],
};

export interface Budget {
  tokensPerDay: number;
  requestsPerDay: number;
}

/**
 * Daily budgets per `provider:model`, kept below the free-tier limits (SD-§12.3: the limits are per
 * organisation and change, and so do the models: verify both live). A model with no entry here is not called at all.
 * Override with `AI_BUDGETS` (JSON).
 */
export const DEFAULT_BUDGETS: Record<string, Budget> = {
  'groq:openai/gpt-oss-120b': { tokensPerDay: 150_000, requestsPerDay: 900 },
  'groq:openai/gpt-oss-20b': { tokensPerDay: 150_000, requestsPerDay: 900 },
  'gemini:gemini-3.5-flash': { tokensPerDay: 400_000, requestsPerDay: 180 },
  'gemini:gemini-flash-lite-latest': { tokensPerDay: 400_000, requestsPerDay: 400 },
};

const modelRef = z.object({
  provider: z.enum(['groq', 'gemini', 'fake']),
  model: z.string().min(1),
});
const routesSchema = z.object(
  Object.fromEntries(AI_TASKS.map((t) => [t, z.array(modelRef).min(1).optional()])),
);
const budgetsSchema = z.record(
  z.string(),
  z.object({
    tokensPerDay: z.number().int().positive(),
    requestsPerDay: z.number().int().positive(),
  }),
);

export interface AiSettings {
  routes: Record<AiTask, ModelRef[]>;
  budgets: Record<string, Budget>;
  /** All AI calls together, per minute (below the provider's own requests/minute). */
  globalPerMin: number;
  /** Default per-user limit for an AI feature that has no stricter one (hints use 10). */
  userPerHour: number;
  /** Extra tries on the same model after a 429/5xx/network error. */
  maxRetries: number;
  /** A `retry-after` longer than this moves on to the next model instead of waiting. */
  retryMaxWaitMs: number;
}

export type AiEnv = Pick<
  Config,
  | 'AI_ROUTES'
  | 'AI_BUDGETS'
  | 'AI_GLOBAL_PER_MIN'
  | 'AI_USER_PER_HOUR'
  | 'AI_MAX_RETRIES'
  | 'AI_RETRY_MAX_WAIT_MS'
>;

/** Defaults plus the `AI_ROUTES` / `AI_BUDGETS` overrides; a malformed override fails at start. */
export function aiSettings(env: AiEnv): AiSettings {
  const routes = { ...DEFAULT_ROUTES };
  if (env.AI_ROUTES) {
    const over = routesSchema.parse(JSON.parse(env.AI_ROUTES));
    for (const t of AI_TASKS) if (over[t]) routes[t] = over[t] as ModelRef[];
  }
  const budgets = {
    ...DEFAULT_BUDGETS,
    ...(env.AI_BUDGETS ? budgetsSchema.parse(JSON.parse(env.AI_BUDGETS)) : {}),
  };
  return {
    routes,
    budgets,
    globalPerMin: env.AI_GLOBAL_PER_MIN,
    userPerHour: env.AI_USER_PER_HOUR,
    maxRetries: env.AI_MAX_RETRIES,
    retryMaxWaitMs: env.AI_RETRY_MAX_WAIT_MS,
  };
}

export const budgetFor = (s: AiSettings, m: ModelRef): Budget | undefined => s.budgets[modelKey(m)];
