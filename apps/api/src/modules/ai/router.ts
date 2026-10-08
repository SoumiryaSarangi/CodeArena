import { Inject, Injectable, Optional } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { LOGGER } from '../../telemetry/logger';
import { type AiSettings, aiSettings, budgetFor } from './ai.config';
import { AiLedger } from './ledger';
import { GeminiProvider } from './providers/gemini';
import { groqProvider } from './providers/openai-compatible';
import {
  type CompleteRequest,
  type CompleteResult,
  type ModelRef,
  type Provider,
  ProviderError,
  type ProviderName,
  modelKey,
} from './types';

export const AI_PROVIDERS = Symbol('AI_PROVIDERS');
export const AI_SLEEP = Symbol('AI_SLEEP');

const tracer = trace.getTracer('api');
const meter = metrics.getMeter('api');
const calls = meter.createCounter('ca_ai_calls_total', {
  description: 'AI calls by task, model, outcome',
});
const tokens = meter.createCounter('ca_ai_tokens_total', {
  description: 'AI tokens by feature and direction',
});
const latency = meter.createHistogram('ca_ai_latency_ms', {
  description: 'AI call latency',
  unit: 'ms',
});

/** Rough token count of the input: 4 characters per token, used only to reserve budget before a call. */
const estimateInput = (req: CompleteRequest) =>
  Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Providers that have a key; the others' models are skipped. */
export function providersFromConfig(c: Pick<Config, 'GROQ_API_KEY' | 'GEMINI_API_KEY'>) {
  const out: Partial<Record<ProviderName, Provider>> = {};
  if (c.GROQ_API_KEY) out.groq = groqProvider(c.GROQ_API_KEY);
  if (c.GEMINI_API_KEY) out.gemini = new GeminiProvider(c.GEMINI_API_KEY);
  return out;
}

/**
 * SD-§12.1: one entry point for every model call. For a task it walks the configured chain; per model it
 * checks the cool-down and the daily budget (reserving tokens atomically), calls the provider, retries
 * 429/5xx/network errors honouring `retry-after` (or moves on when the wait is too long), and falls back to
 * the next model. Every call is logged and counted (FR-AI-10); budgets and per-feature usage are in the ledger.
 */
@Injectable()
export class AiRouter {
  readonly settings: AiSettings;
  private readonly providers: Partial<Record<ProviderName, Provider>>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(AiLedger) private readonly ledger: AiLedger,
    @Inject(LOGGER) private readonly log: Logger,
    @Optional() @Inject(AI_PROVIDERS) providers?: Partial<Record<ProviderName, Provider>>,
    @Optional() @Inject(AI_SLEEP) sleep?: (ms: number) => Promise<void>,
  ) {
    this.settings = aiSettings(config);
    this.providers = providers ?? providersFromConfig(config);
    this.sleep = sleep ?? defaultSleep;
  }

  /** True if at least one configured provider appears in some chain (otherwise AI is switched off). */
  get available() {
    return Object.values(this.settings.routes).some((chain) =>
      chain.some((m) => this.providers[m.provider]),
    );
  }

  /** Per-user limit for a feature (FR-AI-06): ProblemError 'rate-limited' when exceeded. */
  async guardUser(feature: string, userId: string, perHour = this.settings.userPerHour) {
    const r = await this.ledger.take(`user:${feature}`, userId, perHour, 3600);
    if (!r.ok) {
      throw new ProblemError('rate-limited', `You can use ${feature} ${perHour} times an hour`, {
        headers: { 'Retry-After': String(r.retryAfterS) },
      });
    }
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    return tracer.startActiveSpan('ai.complete', async (span) => {
      span.setAttributes({ 'ai.task': req.task, 'ai.feature': req.feature });
      const started = performance.now();
      try {
        const global = await this.ledger.take('global', 'all', this.settings.globalPerMin, 60);
        if (!global.ok) {
          calls.add(1, { task: req.task, model: 'none', outcome: 'busy' });
          throw new ProblemError('ai-busy', 'AI is busy, try again in a minute', {
            headers: { 'Retry-After': String(global.retryAfterS) },
          });
        }
        const chain = this.settings.routes[req.task];
        const input = estimateInput(req);
        let tried = 0;
        for (const ref of chain) {
          const key = modelKey(ref);
          const provider = this.providers[ref.provider];
          const budget = budgetFor(this.settings, ref);
          if (!provider || !budget) continue;
          if (await this.ledger.isCooling(key)) {
            calls.add(1, { task: req.task, model: key, outcome: 'cooling' });
            tried++;
            continue;
          }
          const reserved = input + req.maxTokens;
          if (!(await this.ledger.reserve(key, reserved, budget))) {
            calls.add(1, { task: req.task, model: key, outcome: 'budget' });
            this.log.info(
              { task: req.task, model: key },
              'ai model budget used up, trying the next',
            );
            tried++;
            continue;
          }
          const result = await this.callWithRetries(provider, ref, req, reserved);
          if (result) {
            const ms = Math.round(performance.now() - started);
            const usage = result.usage;
            await this.ledger.settle(key, reserved, usage.inputTokens + usage.outputTokens);
            await this.ledger.account(req.feature, key, usage);
            calls.add(1, { task: req.task, model: key, outcome: 'ok' });
            tokens.add(usage.inputTokens, { feature: req.feature, direction: 'in' });
            tokens.add(usage.outputTokens, { feature: req.feature, direction: 'out' });
            latency.record(ms, { task: req.task, model: key });
            this.log.info(
              {
                task: req.task,
                feature: req.feature,
                model: key,
                ...usage,
                latencyMs: ms,
                fallbacks: tried,
              },
              'ai call',
            );
            span.setAttributes({ 'ai.model': key, 'ai.fallbacks': tried });
            return { text: result.text, usage, model: key, fallbacks: tried, latencyMs: ms };
          }
          tried++;
        }
        calls.add(1, { task: req.task, model: 'none', outcome: 'exhausted' });
        this.log.warn({ task: req.task, feature: req.feature }, 'ai: no model could answer');
        throw new ProblemError('ai-busy', 'AI is busy, try again later');
      } finally {
        span.end();
      }
    });
  }

  /** Calls one model, retrying transient failures; null means "give up on this model". */
  private async callWithRetries(
    provider: Provider,
    ref: ModelRef,
    req: CompleteRequest,
    reserved: number,
  ) {
    const key = modelKey(ref);
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.complete(ref.model, req);
      } catch (err) {
        const e =
          err instanceof ProviderError ? err : new ProviderError((err as Error).message, undefined);
        const wait = e.retryAfterMs ?? 500 * 2 ** attempt;
        const canRetry =
          e.transient && attempt < this.settings.maxRetries && wait <= this.settings.retryMaxWaitMs;
        this.log.warn(
          { model: key, status: e.status, attempt, retryInMs: canRetry ? wait : null },
          'ai provider error',
        );
        if (canRetry) {
          await this.sleep(wait);
          continue;
        }
        calls.add(1, { task: req.task, model: key, outcome: `error-${e.status ?? 'network'}` });
        await this.ledger.release(key, reserved);
        if (e.transient && e.retryAfterMs) await this.ledger.coolDown(key, e.retryAfterMs);
        return null;
      }
    }
  }
}
